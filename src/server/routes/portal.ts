// Portal für Benutzer: Ticketsystem wählen, Formular ausfüllen, eigene Tickets ansehen.
import type { App } from '../app.ts';
import { HttpError, RateLimiter, type Router } from '../http/core.ts';
import { canAnywhere } from '../services/rbac.ts';
import { ASSET_CSP } from '../http/security.ts';
import type { AppCtx } from '../server.ts';
import { parseJson } from '../db/db.ts';
import { getSystem, listSystems, publishedBranding, systemVisibleTo, connectorFor, type SystemRow } from '../services/systems.ts';
import { formVisibleTo, getForm, publishedVersion, resolveDefinition, type FormRow } from '../services/forms.ts';
import { getMetadata } from '../services/metadata.ts';
import { customerFor, localEmailTaken, requestsOfUser, submitRequest } from '../services/requests.ts';
import { checkFiles, type IncomingFile } from '../services/files.ts';
import { ConnectorError, type TicketSummary } from '../connectors/types.ts';
import type { FormDefinition } from '../../shared/form.ts';
import { textToHtml } from '../../shared/template.ts';
import { audit } from '../services/audit.ts';
import { approvalDetail, approvalFile, approvalsOfRequests, decide, listForApprover, openCountForApprover, reassign, withdraw } from '../services/approvals.ts';
import { listNotifications, markRead, markReadByLink, unreadCount } from '../services/notifications.ts';
import { log } from '../log.ts';
import { getFeatures } from '../services/features.ts';
import { formNotices } from '../services/itsm.ts';
import { formatHtmlArticle, formatTextArticle, blocksToText } from '../services/article-format.ts';

export const OVERVIEW_COLUMNS = ['number', 'title', 'state', 'priority', 'group', 'created_at', 'updated_at'] as const;

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', auml: 'ä', ouml: 'ö', uuml: 'ü', Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü', szlig: 'ß', euro: '€' };

/** Wandelt HTML aus Zammad in reinen Text. Das Portal zeigt nie fremdes HTML an.
 *  Linear: ein Durchlauf mit indexOf statt Regexen, die bei vielen „<“ ohne „>“ quadratisch würden. */
export function htmlToText(html: string): string {
  const s = html.slice(0, 200_000);
  let out = '';
  let i = 0;
  while (i < s.length) {
    const lt = s.indexOf('<', i);
    if (lt < 0) { out += s.slice(i); break; }
    out += s.slice(i, lt);
    const gt = s.indexOf('>', lt + 1);
    if (gt < 0) { out += s.slice(lt); break; } // kein Tag mehr – Rest ist Text
    const m = /^\/?([a-zA-Z][a-zA-Z0-9]{0,15})/.exec(s.slice(lt + 1, Math.min(gt, lt + 18)));
    i = gt + 1;
    if (!m) continue; // Kommentar, Doctype o. Ä.
    const closing = s[lt + 1] === '/';
    const name = m[1].toLowerCase();
    if (!closing && (name === 'script' || name === 'style' || name === 'head')) {
      const endRe = new RegExp(`</${name}\\s*>`, 'gi');
      endRe.lastIndex = i;
      const e = endRe.exec(s);
      if (!e) break; // nie geschlossen: Rest verwerfen (linear, da danach Schluss)
      i = e.index + e[0].length;
      continue;
    }
    if (name === 'br') out += '\n';
    else if (closing && /^(p|div|li|tr|h[1-6]|blockquote)$/.test(name)) out += '\n';
    else if (!closing && name === 'li') out += '• ';
    else if (closing && (name === 'td' || name === 'th')) out += '\t';
  }
  out = out.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{1,10});/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : '';
    }
    return ENTITIES[e] ?? m;
  });
  // Leerzeichen am Zeilenende entfernen (ohne Regex über lange Leerzeichenfolgen)
  const lines = out.split('\n').map((l) => {
    let e = l.length;
    while (e > 0 && (l[e - 1] === ' ' || l[e - 1] === '\t')) e--;
    return l.slice(0, e);
  });
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Datei immer als Download senden, nie im Browser anzeigen; harmloser Typ verhindert Skriptausführung. */
function sendDownload(ctx: AppCtx, filename: string, data: Buffer | Uint8Array): void {
  const res = ctx.res;
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(filename)}`);
  res.setHeader('Content-Security-Policy', ASSET_CSP);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Length', data.length);
  res.end(data);
  ctx.responded = true;
}

export function registerPortalRoutes(router: Router, app: App): void {
  // Dateien kommen als Base64 im JSON: Gesamtgröße × 4/3 plus 1 MB für die Feldwerte
  const uploadBodyLimit = Math.ceil(app.cfg.upload.maxTotalMb * 4 / 3 + 1) * 1024 * 1024;
  const ticketCache = new Map<string, { at: number; tickets: TicketSummary[] }>();
  const user = { auth: 'user' as const };

  function visibleSystem(ctx: AppCtx, id: string): SystemRow {
    const sys = getSystem(app, id);
    if (!sys || !systemVisibleTo(sys, ctx.user!)) throw new HttpError(404, 'Ticketsystem nicht gefunden', 'not_found');
    return sys;
  }

  function visibleForm(ctx: AppCtx, id: string): { form: FormRow; sys: SystemRow } {
    const form = getForm(app, id);
    if (!form || !formVisibleTo(form, ctx.user!)) throw new HttpError(404, 'Formular nicht gefunden', 'not_found');
    return { form, sys: visibleSystem(ctx, form.system_id) };
  }

  router.get('/api/portal/systems', user, (ctx: AppCtx) => {
    const systems = listSystems(app).filter((s) => systemVisibleTo(s, ctx.user!));
    return {
      systems: systems.map((s) => ({ id: s.id, slug: s.slug, name: s.name, status: s.status, allowReplies: s.allow_replies === 1, branding: publishedBranding(app, s.id) })),
    };
  });

  router.get('/api/portal/systems/:systemId/forms', user, (ctx: AppCtx) => {
    const sys = visibleSystem(ctx, ctx.params.systemId);
    const forms = app.db.all<FormRow>("SELECT f.* FROM forms f WHERE f.system_id = ? AND f.active = 1 AND EXISTS (SELECT 1 FROM form_versions v WHERE v.form_id = f.id AND v.status = 'published') ORDER BY f.sort, f.name", sys.id);
    return { forms: forms.filter((f) => formVisibleTo(f, ctx.user!)).map((f) => ({ id: f.id, slug: f.slug, name: f.name, description: f.description, category: f.category })) };
  });

  router.get('/api/portal/forms/:formId', user, async (ctx: AppCtx) => {
    const { form, sys } = visibleForm(ctx, ctx.params.formId);
    const version = publishedVersion(app, form.id);
    if (!version) throw new HttpError(404, 'Formular nicht gefunden', 'not_found');
    const meta = await getMetadata(app, sys).catch(() => ({ groups: [], states: [], priorities: [], fields: [] }));
    const def = resolveDefinition(parseJson<FormDefinition>(version.definition, { fields: [], settings: {} as any }), sys, meta, ctx.user!, { approvals: getFeatures(app).approvals });
    const u = ctx.user!;
    // Standardwerte aus dem Profil
    const fields = def.fields.map((raw) => {
      // Anzeige der Dateigröße an die Obergrenze des Servers anpassen
      const f = raw.type === 'file' ? { ...raw, maxSizeMb: Math.min(raw.maxSizeMb ?? 10, app.cfg.upload.maxFileMb) } : raw;
      if (!f.defaultFrom) return f;
      const v = f.defaultFrom === 'user.name' ? u.displayName : f.defaultFrom === 'user.email' ? u.email : u.department;
      return { ...f, default: v ?? f.default };
    });
    return {
      form: { id: form.id, name: form.name, description: form.description, version: version.version },
      system: { id: sys.id, name: sys.name, status: sys.status },
      // Bekannte Störungen und Wartungen der Services dieses Formulars („Ich bin auch betroffen“ statt Ticket)
      notices: formNotices(app, ctx.user!, sys.id, def.settings.services),
      definition: { fields, settings: { successText: def.settings.successText ?? '' } },
    };
  });

  router.post('/api/portal/forms/:formId/submit', { auth: 'user', bodyLimit: uploadBodyLimit }, async (ctx: AppCtx) => {
    const { form, sys } = visibleForm(ctx, ctx.params.formId);
    if (sys.status === 'inactive') throw new HttpError(409, 'Ticketsystem ist deaktiviert', 'inactive');
    const version = publishedVersion(app, form.id);
    if (!version) throw new HttpError(404, 'Formular nicht gefunden', 'not_found');
    if (ctx.user!.email && localEmailTaken(app, ctx.user!.id, ctx.user!.email)) {
      throw new HttpError(409, 'Die E-Mail-Adresse dieses lokalen Kontos gehört einem Microsoft-Konto. Bitte mit Microsoft anmelden oder die IT kontaktieren.', 'email_conflict');
    }
    const b = ctx.body as { values?: unknown; files?: unknown; version?: unknown };
    if (b.version !== undefined && b.version !== version.version) throw new HttpError(409, 'Das Formular wurde inzwischen geändert – bitte neu laden', 'form_changed');
    const values = b.values && typeof b.values === 'object' && !Array.isArray(b.values) ? b.values as Record<string, unknown> : {};
    const files = b.files && typeof b.files === 'object' && !Array.isArray(b.files) ? b.files as Record<string, IncomingFile[]> : {};
    const meta = await getMetadata(app, sys).catch(() => ({ groups: [], states: [], priorities: [], fields: [] }));
    const def = resolveDefinition(parseJson<FormDefinition>(version.definition, { fields: [], settings: {} as any }), sys, meta, ctx.user!, { approvals: getFeatures(app).approvals });
    const r = await submitRequest(app, ctx.user!, sys, form, version, def, { values, files });
    ticketCache.delete(`${sys.id}:${ctx.user!.id}`);
    ticketCache.delete(`${r.system.id}:${ctx.user!.id}`);
    audit(app.db, actorOf(ctx), { action: 'request.created', targetType: 'request', targetId: r.id, systemId: r.system.id, details: { form: form.slug, ...(r.system.routed ? { formSystem: sys.id } : {}) } });
    if (r.approval) audit(app.db, actorOf(ctx), { action: 'approval.requested', targetType: 'request', targetId: r.id, systemId: r.system.id, details: { approver: r.approval.email } });
    return {
      created: true, id: r.id, title: r.title, successText: def.settings.successText ?? '',
      system: r.system.routed ? { id: r.system.id, name: r.system.name } : null,
      approval: r.approval ? { email: r.approval.email, name: r.approval.name, known: r.approval.known } : null,
    };
  });

  const actorOf = (ctx: AppCtx) => ({ id: ctx.user!.id, name: ctx.user!.displayName, ip: ctx.ip });

  router.get('/api/portal/requests', user, (ctx: AppCtx) => {
    const names = new Map(listSystems(app).map((s) => [s.id, s.name]));
    const list = requestsOfUser(app, ctx.user!.id);
    const approvals = approvalsOfRequests(app, list.map((r) => r.id));
    return { requests: list.map((r) => ({ ...r, systemName: names.get(r.system_id) ?? '', approval: approvals.get(r.id) ?? null })) };
  });

  router.post('/api/portal/requests/:requestId/withdraw', user, (ctx: AppCtx) => {
    withdraw(app, ctx.user!, actorOf(ctx), ctx.params.requestId);
    ticketCache.clear();
    return { ok: true };
  });

  router.post('/api/portal/requests/:requestId/approver', user, (ctx: AppCtx) => {
    const c = reassign(app, ctx.user!, actorOf(ctx), ctx.params.requestId, (ctx.body as { email?: unknown })?.email);
    return { ok: true, approval: { email: c.email, name: c.name, known: c.known } };
  });

  // ---------------------------------------------------------------- Freigaben durch Vorgesetzte
  router.get('/api/portal/approvals', user, (ctx: AppCtx) => {
    const which = ctx.query.get('status') === 'done' ? 'done' : 'open';
    return { approvals: listForApprover(app, ctx.user!, which), open: openCountForApprover(app, ctx.user!) };
  });

  router.get('/api/portal/approvals/:approvalId', user, (ctx: AppCtx) => {
    const d = approvalDetail(app, ctx.user!, ctx.params.approvalId);
    markReadByLink(app, ctx.user!, `/freigaben/${d.approval.id}`);
    return d;
  });

  router.post('/api/portal/approvals/:approvalId/approve', user, (ctx: AppCtx) => decide(app, ctx.user!, actorOf(ctx), ctx.params.approvalId, 'approve', (ctx.body as { comment?: unknown })?.comment));
  router.post('/api/portal/approvals/:approvalId/reject', user, (ctx: AppCtx) => decide(app, ctx.user!, actorOf(ctx), ctx.params.approvalId, 'reject', (ctx.body as { comment?: unknown })?.comment));

  router.get('/api/portal/approvals/:approvalId/files/:fileId', user, (ctx: AppCtx) => {
    const file = approvalFile(app, ctx.user!, ctx.params.approvalId, ctx.params.fileId);
    sendDownload(ctx, file.filename, file.data);
  });

  // Personen, die sich schon einmal mit Microsoft angemeldet haben – Vorschläge beim Eintippen
  // Vorschläge für die freigebende Person: nur für Microsoft-Konten mit Portal-Recht, ab 3 Zeichen, begrenzt je Konto
  const peopleLimiter = new RateLimiter(30, 0.5);
  router.get('/api/portal/people', user, (ctx: AppCtx) => {
    const u = ctx.user!;
    if (u.kind !== 'entra' || !canAnywhere(u, 'portal.use')) return { people: [] };
    const q = (ctx.query.get('q') ?? '').trim().slice(0, 100);
    if (q.length < 3) return { people: [] };
    if (!peopleLimiter.take(u.id)) throw new HttpError(429, 'Zu viele Suchanfragen – bitte kurz warten', 'rate_limited');
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const rows = app.db.all<{ display_name: string; email: string; department: string | null }>(
      `SELECT display_name, email, department FROM users
        WHERE kind = 'entra' AND disabled = 0 AND email IS NOT NULL AND id <> ?
          AND (display_name LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\')
        ORDER BY display_name LIMIT 8`,
      ctx.user!.id, like, like,
    );
    return { people: rows.map((r) => ({ name: r.display_name, email: r.email.toLowerCase(), department: r.department ?? '' })) };
  });

  // ---------------------------------------------------------------- Benachrichtigungen
  router.get('/api/portal/notifications', user, (ctx: AppCtx) => ({
    notifications: listNotifications(app, ctx.user!), unread: unreadCount(app, ctx.user!), approvalsOpen: openCountForApprover(app, ctx.user!),
  }));

  router.get('/api/portal/notifications/count', user, (ctx: AppCtx) => ({ unread: unreadCount(app, ctx.user!), approvalsOpen: openCountForApprover(app, ctx.user!) }));

  router.post('/api/portal/notifications/read', user, (ctx: AppCtx) => {
    const b = ctx.body as { ids?: unknown };
    const ids = Array.isArray(b?.ids) ? b.ids.filter((x): x is string => typeof x === 'string') : undefined;
    return { marked: markRead(app, ctx.user!, ids), unread: unreadCount(app, ctx.user!) };
  });

  router.get('/api/portal/systems/:systemId/overviews', user, (ctx: AppCtx) => {
    const sys = visibleSystem(ctx, ctx.params.systemId);
    return { overviews: overviewsFor(sys.id) };
  });

  function overviewsFor(systemId: string) {
    const rows = app.db.all<{ id: string; name: string; state_filter: string; columns: string; sort_by: string; sort_dir: string }>(
      'SELECT id, name, state_filter, columns, sort_by, sort_dir FROM overviews WHERE system_id = ? ORDER BY sort, name', systemId,
    );
    const list = rows.length ? rows : [
      { id: 'offen', name: 'Offene Tickets', state_filter: 'open', columns: '["number","title","state","updated_at"]', sort_by: 'updated_at', sort_dir: 'desc' },
      { id: 'erledigt', name: 'Erledigt', state_filter: 'closed', columns: '["number","title","state","updated_at"]', sort_by: 'updated_at', sort_dir: 'desc' },
    ];
    return list.map((o) => ({
      id: o.id, name: o.name, stateFilter: o.state_filter,
      columns: parseJson<string[]>(o.columns, []).filter((c) => (OVERVIEW_COLUMNS as readonly string[]).includes(c)),
      sortBy: (OVERVIEW_COLUMNS as readonly string[]).includes(o.sort_by) ? o.sort_by : 'updated_at',
      sortDir: o.sort_dir === 'asc' ? 'asc' : 'desc',
    }));
  }

  const ticketLoads = new Map<string, Promise<TicketSummary[]>>();
  /**
   * Tickets eines Nutzers. Bis 30 s alt: direkt aus dem Zwischenspeicher. Bis 10 min alt: sofort den
   * gespeicherten Stand liefern und im Hintergrund erneuern (sonst wartet jede Seite alle 30 s auf Zammad).
   * Gleichzeitige Abrufe derselben Liste teilen sich einen Aufruf.
   */
  async function ticketsOf(ctx: AppCtx, sys: SystemRow, refresh: boolean): Promise<TicketSummary[]> {
    const key = `${sys.id}:${ctx.user!.id}`;
    const hit = ticketCache.get(key);
    const age = hit ? Date.now() - hit.at : Infinity;
    if (hit && !refresh && age < 30_000) return hit.tickets;
    if (!ctx.user!.email) return [];
    const u = ctx.user!;
    let load = ticketLoads.get(key);
    if (!load) {
      load = (async () => {
        const customer = await customerFor(app, sys, u.id, u.email!, u.displayName, false);
        const tickets = customer ? await connectorFor(app, sys).listTickets(customer) : [];
        if (ticketCache.size > 5000) ticketCache.clear();
        ticketCache.set(key, { at: Date.now(), tickets });
        return tickets;
      })().finally(() => ticketLoads.delete(key));
      ticketLoads.set(key, load);
    }
    if (hit && !refresh && age < 10 * 60_000) {
      load.catch((err) => log.warn('Tickets im Hintergrund nicht erneuert', { system: sys.slug, error: (err as Error).message }));
      return hit.tickets;
    }
    return load;
  }

  function connectorError(err: unknown): never {
    if (err instanceof ConnectorError) {
      log.warn('Zammad-Fehler', { error: err.message, status: err.status });
      throw new HttpError(502, 'Das Ticketsystem ist gerade nicht erreichbar', 'upstream');
    }
    throw err;
  }

  router.get('/api/portal/systems/:systemId/tickets', user, async (ctx: AppCtx) => {
    const sys = visibleSystem(ctx, ctx.params.systemId);
    const overviews = overviewsFor(sys.id);
    const ov = overviews.find((o) => o.id === ctx.query.get('overview')) ?? overviews[0];
    let tickets: TicketSummary[] = [];
    let unavailable = false;
    try {
      tickets = await ticketsOf(ctx, sys, ctx.query.get('refresh') === '1');
    } catch (err) {
      if (!(err instanceof ConnectorError)) throw err;
      unavailable = true;
      log.warn('Tickets nicht abrufbar', { system: sys.slug, error: err.message });
    }
    const filtered = tickets.filter((t) => ov.stateFilter === 'all' || (ov.stateFilter === 'open' ? !t.closed : t.closed));
    const key = ov.sortBy as keyof TicketSummary;
    const keyMap: Record<string, keyof TicketSummary> = { created_at: 'createdAt', updated_at: 'updatedAt' };
    const k = keyMap[key] ?? key;
    filtered.sort((a, b) => String(a[k] ?? '').localeCompare(String(b[k] ?? ''), 'de', { numeric: true }) * (ov.sortDir === 'asc' ? 1 : -1));
    const pending = requestsOfUser(app, ctx.user!.id, sys.id).filter((r) => ['awaiting_approval', 'queued', 'sending', 'failed'].includes(r.status));
    return { overview: ov, overviews, tickets: filtered, pending, unavailable };
  });

  router.get('/api/portal/systems/:systemId/tickets/:ticketId', user, async (ctx: AppCtx) => {
    const sys = visibleSystem(ctx, ctx.params.systemId);
    const ticketId = Number.parseInt(ctx.params.ticketId, 10);
    if (!Number.isSafeInteger(ticketId) || ticketId <= 0) throw new HttpError(400, 'Ungültige Ticketnummer');
    try {
      const customer = ctx.user!.email ? await customerFor(app, sys, ctx.user!.id, ctx.user!.email, ctx.user!.displayName, false) : null;
      const detail = customer ? await connectorFor(app, sys).getTicket(customer, ticketId) : null;
      if (!detail) throw new HttpError(404, 'Ticket nicht gefunden', 'not_found');
      return {
        ticket: detail.ticket,
        // Tickets der Organisation sind nur lesbar
        allowReplies: sys.allow_replies === 1 && detail.ticket.customerId === customer!.customerId,
        articles: detail.articles.map((a) => {
          // Aufbereitet für den Verlauf: Zitate früherer Nachrichten abgetrennt, Tabellen als Feldliste (in Zammad unverändert)
          const f = a.contentType.includes('html') ? formatHtmlArticle(a.body) : formatTextArticle(a.body);
          return {
            id: a.id, from: a.from, sender: a.sender, createdAt: a.createdAt,
            text: blocksToText(f.blocks), blocks: f.blocks, quoted: f.quoted,
            attachments: a.attachments,
          };
        }),
      };
    } catch (err) {
      if (err instanceof HttpError) throw err;
      return connectorError(err);
    }
  });

  router.post('/api/portal/systems/:systemId/tickets/:ticketId/reply', { auth: 'user', bodyLimit: uploadBodyLimit }, async (ctx: AppCtx) => {
    const sys = visibleSystem(ctx, ctx.params.systemId);
    if (sys.allow_replies !== 1) throw new HttpError(403, 'Antworten über das Portal sind für dieses System deaktiviert', 'forbidden');
    if (sys.status !== 'active') throw new HttpError(409, 'Ticketsystem ist gerade in Wartung', 'maintenance');
    const ticketId = Number.parseInt(ctx.params.ticketId, 10);
    if (!Number.isSafeInteger(ticketId) || ticketId <= 0) throw new HttpError(400, 'Ungültige Ticketnummer');
    const b = ctx.body as { text?: unknown; files?: unknown };
    const text = typeof b.text === 'string' ? b.text.replace(/\r\n/g, '\n').trim() : '';
    if (!text) throw new HttpError(422, 'Bitte eine Nachricht eingeben', 'validation');
    if (text.length > 10000) throw new HttpError(422, 'Nachricht zu lang (max. 10.000 Zeichen)', 'validation');
    const files = Array.isArray(b.files) ? b.files.slice(0, 6) as IncomingFile[] : [];
    if (Array.isArray(b.files) && b.files.length > 5) throw new HttpError(422, 'Höchstens 5 Dateien', 'validation');
    const checked = await checkFiles(app, files, undefined, app.cfg.upload.maxFileMb * 1024 * 1024);
    if (checked.reduce((n, c) => n + c.data.length, 0) > app.cfg.upload.maxTotalMb * 1024 * 1024) {
      throw new HttpError(413, `Alle Dateien zusammen höchstens ${app.cfg.upload.maxTotalMb} MB`, 'too_large');
    }
    try {
      const customer = ctx.user!.email ? await customerFor(app, sys, ctx.user!.id, ctx.user!.email, ctx.user!.displayName, false) : null;
      if (!customer) throw new HttpError(404, 'Ticket nicht gefunden', 'not_found');
      await connectorFor(app, sys).addReply(customer, ticketId, textToHtml(text), checked.map((c) => ({ filename: c.filename, mime: c.mime, data: c.data })));
    } catch (err) {
      if (err instanceof HttpError) throw err;
      if (err instanceof ConnectorError && err.status === 404) throw new HttpError(404, 'Ticket nicht gefunden', 'not_found');
      return connectorError(err);
    }
    ticketCache.delete(`${sys.id}:${ctx.user!.id}`);
    audit(app.db, { id: ctx.user!.id, name: ctx.user!.displayName, ip: ctx.ip }, { action: 'ticket.reply', targetType: 'ticket', targetId: String(ticketId), systemId: sys.id });
    return { ok: true };
  });

  router.get('/api/portal/systems/:systemId/tickets/:ticketId/articles/:articleId/attachments/:attachmentId', user, async (ctx: AppCtx) => {
    const sys = visibleSystem(ctx, ctx.params.systemId);
    const ids = [ctx.params.ticketId, ctx.params.articleId, ctx.params.attachmentId].map((x) => Number.parseInt(x, 10));
    if (ids.some((n) => !Number.isSafeInteger(n) || n <= 0)) throw new HttpError(400, 'Ungültige Anfrage');
    let file;
    try {
      const customer = ctx.user!.email ? await customerFor(app, sys, ctx.user!.id, ctx.user!.email, ctx.user!.displayName, false) : null;
      file = customer ? await connectorFor(app, sys).getAttachment(customer, ids[0], ids[1], ids[2]) : null;
    } catch (err) {
      return connectorError(err);
    }
    if (!file) throw new HttpError(404, 'Anhang nicht gefunden', 'not_found');
    sendDownload(ctx, file.filename, file.data);
  });

  // Logos und Favicons (öffentlich, auch für die Anmeldeseite)
  router.get('/api/assets/:id', { auth: 'public' }, (ctx: AppCtx) => {
    if (!/^[0-9a-f-]{36}$/.test(ctx.params.id)) throw new HttpError(404, 'Nicht gefunden');
    const a = app.db.get<{ mime: string; data: Uint8Array; sha256: string }>('SELECT mime, data, sha256 FROM assets WHERE id = ?', ctx.params.id);
    if (!a) throw new HttpError(404, 'Nicht gefunden');
    const res = ctx.res;
    const etag = `"${a.sha256.slice(0, 32)}"`;
    res.setHeader('Content-Type', a.mime);
    res.setHeader('Content-Security-Policy', ASSET_CSP);
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
    res.setHeader('ETag', etag);
    if (ctx.req.headers['if-none-match'] === etag) { res.statusCode = 304; res.end(); }
    else { res.statusCode = 200; res.end(Buffer.from(a.data)); }
    ctx.responded = true;
  });
}
