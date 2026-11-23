// Freigabe durch Vorgesetzte (ab 2.0 im Ticket).
//
// Enthält ein Formular das Feld „Freigabe durch Vorgesetzte(n)“, entsteht das Ticket in Zammad sofort – im Status
// „wartet auf Freigabe“ (einstellbar) und mit den Attributen Freigabe = ausstehend, Freigabe durch = E-Mail-Adresse,
// Freigabe bis = Frist. Zammad schickt der freigebenden Person eine E-Mail mit dem Link ins Portal.
// Entschieden wird im Portal: Das Portal prüft live am Ticket, ob die Person freigeben darf, und schreibt die
// Entscheidung ins Ticket (Attribute, Status, Tag, Notiz, E-Mail an die anfragende Person). Im Portal selbst liegt
// nichts mehr außer den Hinweisen an der Glocke.
//
// Wer freigeben darf: genau das Microsoft-Konto, dem die eingetragene E-Mail-Adresse gehört – nie die anfragende
// Person selbst und nie ein lokales Konto. Optional muss die Person Mitglied bestimmter Entra-Gruppen sein
// (Feld-Einstellung approverGroups, gelesen aus der veröffentlichten Formularversion). Für alle anderen gibt es die
// Freigabe nicht (404).
import type { App } from '../app.ts';
import { HttpError } from '../http/core.ts';
import { log } from '../log.ts';
import { activeApproverField, displayValue, isVisible, type FormDefinition, type FormValues } from '../../shared/form.ts';
import { escapeHtml, textToHtml } from '../../shared/template.ts';
import {
  APPROVAL_STATUS_PORTAL, parseTicketRef, ticketRef, type ApprovalStatus, type ZammadMapping,
} from '../../shared/zammad-model.ts';
import type { AuthUser } from './rbac.ts';
import { audit, type Actor } from './audit.ts';
import { markReadByLink, notify } from './notifications.ts';
import { localEmailTaken } from './requests.ts';
import { connectorFor, getSystem, listSystems, type SystemRow } from './systems.ts';
import { getMapping } from './zammad-setup.ts';
import { resolveState } from './zammad-states.ts';
import { getFeatures } from './features.ts';
import { getForm, publishedVersion } from './forms.ts';
import { formatHtmlArticle, formatTextArticle } from './article-format.ts';
import { ConnectorError, type ZTicket } from '../connectors/types.ts';

const COMMENT_MAX = 2000;
const MAX_REASSIGN = 3;
/** Betreff der Notiz bei einem Wechsel der freigebenden Person (daran zählt das Portal die Wechsel) */
const REASSIGN_SUBJECT = 'Freigabe: andere Person';

export interface ApproverChoice { email: string; name: string | null; known: boolean; knownOnly: boolean; groups: string[] | null }

const fmt = (t: number) => new Date(t).toLocaleString('de-DE', { timeZone: 'Europe/Berlin', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
/** Kalendertag in Berlin als JJJJ-MM-TT */
export const berlinDay = (t: number) => new Date(t).toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' });
const dayText = (d: string) => (/^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}` : d);
/** Ende des Frist-Tags (für die Anzeige) */
const dueEnd = (d: string) => { const t = Date.parse(`${d}T23:59:00+01:00`); return Number.isFinite(t) ? t : Date.now(); };

// ------------------------------------------------------------------------------------------ Konten

/** Microsoft-Konto, dem eine E-Mail-Adresse gehört (gesperrte und lokale Konten zählen nicht). */
export function accountForEmail(app: App, email: string): { id: string; name: string; kind: string; groups: string[] } | null {
  const row = app.db.get<{ id: string; display_name: string; kind: string; groups_json: string | null }>(
    "SELECT id, display_name, kind, groups_json FROM users WHERE lower(email) = lower(?) AND disabled = 0 AND kind = 'entra' ORDER BY last_login_at DESC LIMIT 1",
    email,
  );
  return row ? { id: row.id, name: row.display_name, kind: row.kind, groups: parseGroups(row.groups_json) } : null;
}

function parseGroups(json: string | null): string[] {
  try { const v = JSON.parse(json ?? '[]'); return Array.isArray(v) ? v.map(String) : []; } catch { return []; }
}

function inGroups(memberOf: string[], allowed: string[] | null): boolean {
  if (!allowed || !allowed.length) return true;
  const set = new Set(memberOf.map((g) => g.toLowerCase()));
  return allowed.some((g) => set.has(g.toLowerCase()));
}

/** Darf dieses Konto Freigaben über seine E-Mail-Adresse sehen und entscheiden? Nur Microsoft-Konten. */
function approverEmailOf(app: App, user: AuthUser): string | null {
  if (!user.email || user.kind !== 'entra') return null;
  if (localEmailTaken(app, user.id, user.email)) return null;
  return user.email.toLowerCase();
}

/** Portal-Konto zu einem Zammad-Kunden (über die beim Zustellen gemerkte Zuordnung) */
export function userOfCustomer(app: App, systemId: string, customerId: number): { id: string; name: string; email: string | null; department: string | null } | null {
  const r = app.db.get<{ id: string; display_name: string; email: string | null; department: string | null }>(
    'SELECT u.id, u.display_name, u.email, u.department FROM zammad_customers c JOIN users u ON u.id = c.user_id WHERE c.system_id = ? AND c.customer_id = ? LIMIT 1',
    systemId, customerId,
  );
  return r ? { id: r.id, name: r.display_name, email: r.email, department: r.department } : null;
}

// ------------------------------------------------------------------------------------------ Beim Absenden

/** Prüft die eingetragene freigebende Person. Wirft 422 mit Feldfehler, wenn sie nicht in Frage kommt. */
export function checkApprover(app: App, user: AuthUser, fieldId: string, email: string, knownOnly: boolean, groups: string[] | null = null): ApproverChoice {
  const fail = (msg: string): never => { throw new HttpError(422, msg, 'validation', { [fieldId]: msg }); };
  const e = email.toLowerCase();
  if (user.email && e === user.email.toLowerCase()) fail('Sie können Ihre eigene Anfrage nicht selbst freigeben');
  const acc = accountForEmail(app, e);
  if (acc?.id === user.id) fail('Sie können Ihre eigene Anfrage nicht selbst freigeben');
  const restricted = Boolean(groups && groups.length);
  if ((knownOnly || restricted) && !acc) fail('Diese Person hat sich noch nie im Portal angemeldet. Bitte eine andere Person wählen oder sie bitten, sich einmal anzumelden.');
  if (restricted && !inGroups(acc!.groups, groups)) fail('Diese Person darf Anfragen dieses Formulars nicht freigeben. Bitte die zuständige Führungskraft eintragen.');
  return { email: e, name: acc?.name ?? null, known: Boolean(acc), knownOnly: knownOnly || restricted, groups: restricted ? groups : null };
}

/** Freigabe-Angaben einer Einsendung, falls das Formular für diese Eingaben eine Freigabe verlangt. */
export function approverFor(app: App, user: AuthUser, def: FormDefinition, values: FormValues): ApproverChoice | null {
  const f = activeApproverField(def, values);
  if (!f) return null;
  const v = values[f.id];
  if (typeof v !== 'string' || !v) throw new HttpError(422, 'Bitte die freigebende Person angeben', 'validation', { [f.id]: 'Bitte die freigebende Person angeben' });
  return checkApprover(app, user, f.id, v, f.knownOnly === true, f.approverGroups?.length ? f.approverGroups : null);
}

/** Felder, die die freigebende Person im Portal vor dem Absenden nicht sieht, sind im Ticket – nichts zu tun. */
export function approvalFields(m: ZammadMapping, choice: ApproverChoice, now = Date.now(), expireDays = 14): Record<string, unknown> {
  return {
    [m.attrs.approvalStatus]: 'ausstehend',
    [m.attrs.approver]: choice.email,
    [m.attrs.approvalDue]: berlinDay(now + expireDays * 86400_000),
  };
}

/** Nach dem Anlegen des Tickets: E-Mail über Zammad und Hinweis an der Glocke für die freigebende Person. */
export async function announceApproval(app: App, sys: SystemRow, ticket: { id: number; number: string }, title: string, approverEmail: string, requesterName: string, reminder = false): Promise<void> {
  const m = getMapping(app, sys);
  const ref = ticketRef(sys.id, ticket.id);
  const url = `${app.cfg.publicUrl.replace(/\/+$/, '')}/freigaben/${ref}`;
  if (m.approval.emailApprover) {
    try {
      await connectorFor(app, sys).addArticle(ticket.id, {
        type: 'email', to: approverEmail, internal: false,
        subject: `${reminder ? 'Erinnerung: ' : ''}Freigabe erbeten: ${title}`,
        body: `<p>${escapeHtml(requesterName)} bittet um Ihre Freigabe für „${escapeHtml(title)}“ (Ticket ${escapeHtml(ticket.number)}).</p>`
          + `<p><a href="${escapeHtml(url)}">Im Self-Service-Portal ansehen und entscheiden</a></p>`
          + '<p><small>Bitte nicht auf diese E-Mail antworten – entschieden wird im Portal.</small></p>',
      });
    } catch (err) {
      log.warn('E-Mail an die freigebende Person nicht gesendet', { system: sys.slug, ticket: ticket.number, error: (err as Error).message });
    }
  }
  notify(app, {
    to: { email: approverEmail },
    kind: reminder ? 'approval.reminder' : 'approval.requested',
    title: `${reminder ? 'Erinnerung: ' : ''}Freigabe erbeten: ${title}`,
    body: `${requesterName} bittet um Ihre Freigabe (${sys.name}).`,
    link: `/freigaben/${ref}`,
  });
}

// ------------------------------------------------------------------------------------------ Ticket lesen

interface Loaded { sys: SystemRow; m: ZammadMapping; t: ZTicket; status: ApprovalStatus | null; approver: string; due: string }

function statusOf(m: ZammadMapping, t: ZTicket): ApprovalStatus | null {
  const v = String(t.fields[m.attrs.approvalStatus] ?? '');
  return (Object.keys(APPROVAL_STATUS_PORTAL) as ApprovalStatus[]).includes(v as ApprovalStatus) ? v as ApprovalStatus : null;
}

function wrap(sys: SystemRow, m: ZammadMapping, t: ZTicket): Loaded {
  return { sys, m, t, status: statusOf(m, t), approver: String(t.fields[m.attrs.approver] ?? '').toLowerCase(), due: String(t.fields[m.attrs.approvalDue] ?? '').slice(0, 10) };
}

/** Gruppenbindung aus der veröffentlichten Formularversion (Formular gelöscht: keine Bindung) */
function approverGroupsOf(app: App, m: ZammadMapping, t: ZTicket): string[] | null {
  const formId = String(t.fields[m.attrs.form] ?? '');
  if (!/^[0-9a-f-]{36}$/.test(formId) || !getForm(app, formId)) return null;
  const v = publishedVersion(app, formId);
  if (!v) return null;
  try {
    const def = JSON.parse(v.definition) as FormDefinition;
    const groups = def.fields.filter((f) => f.type === 'approver').flatMap((f) => f.approverGroups ?? []);
    return groups.length ? groups : null;
  } catch { return null; }
}

/** Darf `user` dieses Ticket als freigebende Person sehen? */
function mayApprove(app: App, user: AuthUser, email: string, l: Loaded): boolean {
  if (!l.status || l.approver !== email) return false;
  const requester = userOfCustomer(app, l.sys.id, l.t.customerId);
  if (requester?.id === user.id) return false;
  return inGroups(user.groups, approverGroupsOf(app, l.m, l.t));
}

async function forApprover(app: App, user: AuthUser, ref: string): Promise<Loaded> {
  const email = approverEmailOf(app, user);
  const p = parseTicketRef(ref);
  const sys = p ? getSystem(app, p.systemId) : undefined;
  if (!email || !p || !sys || sys.status === 'inactive') throw new HttpError(404, 'Freigabe nicht gefunden', 'not_found');
  const t = await connectorFor(app, sys).getTicketFull(p.ticketId).catch((err) => {
    if (err instanceof ConnectorError && err.status === 404) return null;
    throw err;
  });
  const l = t ? wrap(sys, getMapping(app, sys), t) : null;
  if (!l || !mayApprove(app, user, email, l)) throw new HttpError(404, 'Freigabe nicht gefunden', 'not_found');
  return l;
}

function requesterName(app: App, l: Loaded): string {
  return userOfCustomer(app, l.sys.id, l.t.customerId)?.name ?? String(l.t.fields.customer ?? 'Unbekannt');
}

function publicApproval(app: App, l: Loaded) {
  const decided = l.status && l.status !== 'ausstehend';
  const at = String(l.t.fields[l.m.attrs.approvedAt] ?? '');
  return {
    id: ticketRef(l.sys.id, l.t.id),
    status: l.status ? APPROVAL_STATUS_PORTAL[l.status] : 'pending',
    title: l.t.title,
    ticketNumber: l.t.number,
    systemName: l.sys.name,
    requesterName: requesterName(app, l),
    createdAt: Date.parse(l.t.createdAt) || 0,
    expiresAt: dueEnd(l.due),
    decidedAt: decided ? Date.parse(at) || Date.parse(l.t.updatedAt) || null : null,
    decidedByName: decided && ['genehmigt', 'abgelehnt'].includes(l.status!) ? accountForEmail(app, l.approver)?.name ?? l.approver : null,
    comment: null as string | null,
  };
}

/** Aktive Ticketsysteme mit Freigaben */
const approvalSystems = (app: App) => (getFeatures(app).approvals || true) ? listSystems(app).filter((s) => s.status === 'active') : [];

export async function listForApprover(app: App, user: AuthUser, which: 'open' | 'done') {
  const email = approverEmailOf(app, user);
  if (!email) return [];
  const out: ReturnType<typeof publicApproval>[] = [];
  for (const sys of approvalSystems(app)) {
    const m = getMapping(app, sys);
    try {
      const list = await connectorFor(app, sys).searchTickets({
        [m.attrs.approver]: email,
        [m.attrs.approvalStatus]: which === 'open' ? 'ausstehend' : { operator: 'is not', value: 'ausstehend' },
      }, which === 'open' ? 200 : 50);
      for (const t of list) {
        const l = wrap(sys, m, t);
        if (mayApprove(app, user, email, l)) out.push(publicApproval(app, l));
      }
    } catch (err) {
      log.warn('Freigaben aus Zammad nicht lesbar', { system: sys.slug, error: (err as Error).message });
    }
  }
  return which === 'open' ? out.sort((a, b) => a.createdAt - b.createdAt) : out.sort((a, b) => (b.decidedAt ?? b.createdAt) - (a.decidedAt ?? a.createdAt));
}

const countCache = new Map<string, { at: number; n: number }>();
/** Offene Freigaben für die Glocke (eine Minute zwischengespeichert) */
export async function openCountForApprover(app: App, user: AuthUser): Promise<number> {
  const email = approverEmailOf(app, user);
  if (!email) return 0;
  const hit = countCache.get(user.id);
  if (hit && Date.now() - hit.at < 60_000) return hit.n;
  const n = (await listForApprover(app, user, 'open')).length;
  countCache.set(user.id, { at: Date.now(), n });
  return n;
}
const forgetCounts = () => countCache.clear();

/** Inhalt der Anfrage: erste Nachricht im Ticket (dieselben Felder, die ins Ticket gingen) */
export async function approvalDetail(app: App, user: AuthUser, ref: string) {
  const l = await forApprover(app, user, ref);
  const pending = l.status === 'ausstehend';
  let summary = null;
  let files: { id: string; filename: string; size: number }[] = [];
  if (pending) {
    const first = (await connectorFor(app, l.sys).agentArticles(l.t.id)).find((a) => !a.internal);
    const requester = userOfCustomer(app, l.sys.id, l.t.customerId);
    const formId = String(l.t.fields[l.m.attrs.form] ?? '');
    const form = /^[0-9a-f-]{36}$/.test(formId) ? getForm(app, formId) : undefined;
    const fields: { label: string; value: string; multiline: boolean }[] = [];
    // Freigabe- und Dateifelder stehen nicht im Inhalt (Dateien kommen als Anhänge)
    const skip = new Set<string>();
    const v = form ? publishedVersion(app, form.id) : undefined;
    try { for (const f of v ? (JSON.parse(v.definition) as FormDefinition).fields : []) if (f.type === 'approver' || f.type === 'file') skip.add(f.label); } catch { /* Formular nicht lesbar */ }
    if (first) {
      const blocks = (first.contentType === 'text/html' ? formatHtmlArticle(first.body) : formatTextArticle(first.body)).blocks;
      for (const b of blocks) {
        if (b.t === 'fields') for (const [label, value] of b.rows) if (!skip.has(label)) fields.push({ label, value, multiline: value.includes('\n') });
      }
      files = first.attachments.map((f) => ({ id: `${first.id}-${f.id}`, filename: f.filename, size: f.size }));
    }
    summary = {
      form: form?.name ?? '', system: l.sys.name,
      requester: { name: requester?.name ?? requesterName(app, l), email: requester?.email ?? '', department: requester?.department ?? '' },
      fields,
    };
  }
  return { approval: publicApproval(app, l), summary, files };
}

export async function approvalFile(app: App, user: AuthUser, ref: string, fileId: string): Promise<{ filename: string; data: Buffer }> {
  const l = await forApprover(app, user, ref);
  const m = /^(\d{1,12})-(\d{1,12})$/.exec(fileId);
  if (l.status !== 'ausstehend' || !m) throw new HttpError(404, 'Datei nicht gefunden', 'not_found');
  // Nur Anhänge der ersten Nachricht (der Anfrage selbst)
  const first = (await connectorFor(app, l.sys).agentArticles(l.t.id)).find((a) => !a.internal);
  if (!first || first.id !== Number(m[1])) throw new HttpError(404, 'Datei nicht gefunden', 'not_found');
  const f = await connectorFor(app, l.sys).agentAttachment(l.t.id, first.id, Number(m[2]));
  if (!f) throw new HttpError(404, 'Datei nicht gefunden', 'not_found');
  return { filename: f.filename, data: f.data };
}

// ------------------------------------------------------------------------------------------ Entscheiden

/** Entscheidungen je Ticket nacheinander (Zammad kennt keine bedingten Änderungen) */
const busy = new Set<string>();
async function exclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
  if (busy.has(key)) throw new HttpError(409, 'Über diese Anfrage wird gerade entschieden', 'conflict');
  busy.add(key);
  try { return await fn(); } finally { busy.delete(key); }
}

/** Freigabe beenden: Attribute, Status und Tags im Ticket setzen, Notiz schreiben, Beteiligte informieren. */
async function finish(app: App, l: Loaded, status: Exclude<ApprovalStatus, 'ausstehend'>, note: string, opts: { emailRequester?: string } = {}): Promise<void> {
  const c = connectorFor(app, l.sys);
  const now = new Date();
  await c.updateTicket(l.t.id, {
    state: status === 'genehmigt' ? await resolveState(app, l.sys, l.m, 'new', l.m.approval.approvedState)
      : l.t.closed ? undefined : await resolveState(app, l.sys, l.m, 'closed', l.m.approval.closedState),
    fields: { [l.m.attrs.approvalStatus]: status, [l.m.attrs.approvedAt]: now.toISOString() },
  });
  forgetCounts();
  const steps: Promise<unknown>[] = [];
  for (const tag of l.m.approval.pendingTags) steps.push(c.removeTag(l.t.id, tag));
  if (status === 'genehmigt' && l.m.approval.approvedTag) steps.push(c.addTag(l.t.id, l.m.approval.approvedTag));
  steps.push(c.addArticle(l.t.id, { type: 'note', internal: false, subject: noteSubject[status], body: note }));
  if (opts.emailRequester && l.m.approval.emailRequester) {
    steps.push(c.addArticle(l.t.id, { type: 'email', internal: false, to: opts.emailRequester, subject: `${noteSubject[status]}: ${l.t.title}`, body: note }));
  }
  for (const r of await Promise.allSettled(steps)) {
    if (r.status === 'rejected') log.warn('Freigabe: Nacharbeit im Ticket fehlgeschlagen', { system: l.sys.slug, ticket: l.t.number, error: (r.reason as Error).message });
  }
}

const noteSubject: Record<Exclude<ApprovalStatus, 'ausstehend'>, string> = {
  genehmigt: 'Freigegeben', abgelehnt: 'Freigabe abgelehnt', zurueckgezogen: 'Anfrage zurückgezogen', abgelaufen: 'Freigabe abgelaufen', abgebrochen: 'Freigabe abgebrochen',
};

function assertPending(l: Loaded): void {
  if (l.status !== 'ausstehend' || l.t.closed) throw new HttpError(409, 'Über diese Anfrage wurde bereits entschieden', 'conflict');
  if (l.due && berlinDay(Date.now()) > l.due) throw new HttpError(409, 'Die Frist für diese Freigabe ist abgelaufen', 'conflict');
}

export async function decide(app: App, user: AuthUser, actor: Actor, ref: string, decision: 'approve' | 'reject', rawComment: unknown) {
  const comment = typeof rawComment === 'string' ? rawComment.replace(/\r\n/g, '\n').trim() : '';
  if (comment.length > COMMENT_MAX) throw new HttpError(422, `Höchstens ${COMMENT_MAX} Zeichen`, 'validation', { comment: `Höchstens ${COMMENT_MAX} Zeichen` });
  if (decision === 'reject' && !comment) throw new HttpError(422, 'Bitte kurz begründen, warum Sie ablehnen', 'validation', { comment: 'Bitte kurz begründen, warum Sie ablehnen' });
  return exclusive(ref, async () => {
    const l = await forApprover(app, user, ref);
    assertPending(l);
    const requester = userOfCustomer(app, l.sys.id, l.t.customerId);
    const verb = decision === 'approve' ? 'Freigegeben' : 'Abgelehnt';
    const note = `<p><strong>${verb}</strong> von ${escapeHtml(user.displayName)} (${escapeHtml(user.email ?? '')}) am ${escapeHtml(fmt(Date.now()))}</p>`
      + (comment ? `<p><em>${decision === 'approve' ? 'Hinweis' : 'Begründung'}:</em> ${textToHtml(comment)}</p>` : '');
    await finish(app, l, decision === 'approve' ? 'genehmigt' : 'abgelehnt', note, { emailRequester: requester?.email ?? undefined });
    audit(app.db, actor, { action: decision === 'approve' ? 'approval.approved' : 'approval.rejected', targetType: 'ticket', targetId: ticketRef(l.sys.id, l.t.id), systemId: l.sys.id, details: { ticket: l.t.number } });
    markReadByLink(app, user, `/freigaben/${ref}`);
    if (requester) {
      notify(app, {
        to: { userId: requester.id },
        kind: decision === 'approve' ? 'approval.approved' : 'approval.rejected',
        title: `${verb}: ${l.t.title}`,
        body: decision === 'approve'
          ? `${user.displayName} hat Ihre Anfrage freigegeben. Die IT bearbeitet jetzt Ticket ${l.t.number}.`
          : `${user.displayName} hat Ihre Anfrage abgelehnt: „${comment.slice(0, 300)}${comment.length > 300 ? ' …' : ''}“`,
        link: `/tickets/${l.t.id}?system=${l.sys.id}`,
      });
    }
    log.info(decision === 'approve' ? 'Anfrage freigegeben' : 'Anfrage abgelehnt', { system: l.sys.slug, ticket: l.t.number });
    return { status: decision === 'approve' ? 'approved' : 'rejected' };
  });
}

// ------------------------------------------------------------------------------------------ Anfragende Person

/** Ticket der eigenen Anfrage, die noch auf eine Freigabe wartet */
async function forRequester(app: App, user: AuthUser, requestId: string): Promise<Loaded> {
  const r = /^[0-9a-f-]{36}$/.test(requestId)
    ? app.db.get<{ system_id: string; ticket_id: number | null }>('SELECT system_id, ticket_id FROM requests WHERE id = ? AND user_id = ?', requestId, user.id)
    : undefined;
  const sys = r ? getSystem(app, r.system_id) : undefined;
  if (!r || !sys) throw new HttpError(404, 'Anfrage nicht gefunden', 'not_found');
  if (!r.ticket_id) throw new HttpError(409, 'Die Anfrage ist noch nicht im Ticketsystem – bitte gleich noch einmal versuchen', 'conflict');
  const t = await connectorFor(app, sys).getTicketFull(r.ticket_id);
  if (!t) throw new HttpError(404, 'Anfrage nicht gefunden', 'not_found');
  const l = wrap(sys, getMapping(app, sys), t);
  if (l.status !== 'ausstehend' || t.closed) throw new HttpError(409, 'Die Anfrage wartet nicht mehr auf eine Freigabe', 'conflict');
  return l;
}

export async function withdraw(app: App, user: AuthUser, actor: Actor, requestId: string): Promise<void> {
  const l0 = await forRequester(app, user, requestId);
  await exclusive(ticketRef(l0.sys.id, l0.t.id), async () => {
    const l = await forRequester(app, user, requestId);
    await finish(app, l, 'zurueckgezogen', `<p><strong>Zurückgezogen</strong> von ${escapeHtml(user.displayName)} am ${escapeHtml(fmt(Date.now()))}. Die Anfrage wird nicht bearbeitet.</p>`);
    audit(app.db, actor, { action: 'approval.withdrawn', targetType: 'request', targetId: requestId, systemId: l.sys.id, details: { ticket: l.t.number } });
    notify(app, { to: { email: l.approver }, kind: 'approval.withdrawn', title: `Zurückgezogen: ${l.t.title}`, body: `${user.displayName} hat die Anfrage zurückgezogen. Sie müssen nichts mehr tun.`, link: `/freigaben/${ticketRef(l.sys.id, l.t.id)}` });
  });
}

export async function reassign(app: App, user: AuthUser, actor: Actor, requestId: string, rawEmail: unknown): Promise<ApproverChoice> {
  const email = typeof rawEmail === 'string' ? rawEmail.replace(/\s+/g, '').toLowerCase() : '';
  if (!/^[^\s@<>()[\]\\,;:"]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,63}$/.test(email)) throw new HttpError(422, 'Bitte eine gültige E-Mail-Adresse angeben', 'validation', { email: 'Bitte eine gültige E-Mail-Adresse angeben' });
  const l0 = await forRequester(app, user, requestId);
  return exclusive(ticketRef(l0.sys.id, l0.t.id), async () => {
    const l = await forRequester(app, user, requestId);
    if (email === l.approver) throw new HttpError(422, 'Diese Person ist bereits eingetragen', 'validation', { email: 'Diese Person ist bereits eingetragen' });
    const c = connectorFor(app, l.sys);
    const changes = (await c.agentArticles(l.t.id)).filter((a) => a.subject === REASSIGN_SUBJECT).length;
    if (changes >= MAX_REASSIGN) throw new HttpError(409, `Die freigebende Person wurde schon ${MAX_REASSIGN}-mal geändert. Bitte die Anfrage zurückziehen und neu stellen.`, 'conflict');
    const groups = approverGroupsOf(app, l.m, l.t);
    const formId = String(l.t.fields[l.m.attrs.form] ?? '');
    const v = /^[0-9a-f-]{36}$/.test(formId) ? publishedVersion(app, formId) : undefined;
    let knownOnly = false;
    try { knownOnly = Boolean(v && (JSON.parse(v.definition) as FormDefinition).fields.some((f) => f.type === 'approver' && f.knownOnly === true)); } catch { /* Formular nicht lesbar */ }
    const choice = checkApprover(app, user, 'email', email, knownOnly, groups);
    // Die Frist läuft ab Erstellung weiter – ein Wechsel verlängert sie nicht
    await c.updateTicket(l.t.id, { fields: { [l.m.attrs.approver]: choice.email } });
    forgetCounts();
    await c.addArticle(l.t.id, { type: 'note', internal: false, subject: REASSIGN_SUBJECT, body: `<p>${escapeHtml(user.displayName)} bittet jetzt ${escapeHtml(choice.name ?? choice.email)} um Freigabe.</p>` })
      .catch((err) => log.warn('Notiz zum Wechsel nicht geschrieben', { ticket: l.t.number, error: (err as Error).message }));
    audit(app.db, actor, { action: 'approval.reassigned', targetType: 'request', targetId: requestId, systemId: l.sys.id, details: { ticket: l.t.number } });
    notify(app, { to: { email: l.approver }, kind: 'approval.reassigned', title: `Nicht mehr nötig: ${l.t.title}`, body: `${user.displayName} hat eine andere Person um Freigabe gebeten. Sie müssen nichts mehr tun.`, link: `/freigaben/${ticketRef(l.sys.id, l.t.id)}` });
    await announceApproval(app, l.sys, l.t, l.t.title, choice.email, user.displayName);
    return choice;
  });
}

/** Freigabe-Angaben aus den Tickets der Person (für „Meine Anfragen“) */
export function approvalInfo(app: App, sys: SystemRow, t: ZTicket) {
  const l = wrap(sys, getMapping(app, sys), t);
  if (!l.status) return null;
  const acc = l.approver ? accountForEmail(app, l.approver) : null;
  const pub = publicApproval(app, l);
  return {
    approverEmail: l.approver, approverName: acc?.name ?? null, status: pub.status, decidedAt: pub.decidedAt, decidedByName: pub.decidedByName,
    expiresAt: pub.expiresAt, comment: null, known: Boolean(acc),
  };
}

// ------------------------------------------------------------------------------------------ Fristen (Worker)

/**
 * Wartende Freigaben in allen Ticketsystemen: abgelaufene beenden, einmal erinnern, in Zammad geschlossene als
 * „abgebrochen“ kennzeichnen. Läuft im Worker etwa alle zehn Minuten.
 */
export async function approvalHousekeeping(app: App): Promise<{ expired: number; reminded: number; cancelled: number }> {
  let expired = 0, reminded = 0, cancelled = 0;
  const today = berlinDay(Date.now());
  const remindDays = app.cfg.approval.remindDays;
  for (const sys of listSystems(app).filter((s) => s.status === 'active')) {
    const m = getMapping(app, sys);
    let list: ZTicket[];
    try {
      list = await connectorFor(app, sys).searchTickets({ [m.attrs.approvalStatus]: 'ausstehend' }, 200);
    } catch (err) {
      log.warn('Freigaben: Zammad nicht erreichbar', { system: sys.slug, error: (err as Error).message });
      continue;
    }
    for (const t of list) {
      const l = wrap(sys, m, t);
      const ref = ticketRef(sys.id, t.id);
      const requester = userOfCustomer(app, sys.id, t.customerId);
      try {
        if (t.closed) {
          // In Zammad geschlossen (z. B. von der IT): Freigabe ist damit erledigt
          await exclusive(ref, () => finish(app, l, 'abgebrochen', '<p>Das Ticket wurde in Zammad geschlossen – die Freigabe ist damit beendet.</p>'));
          if (requester) notify(app, { to: { userId: requester.id }, kind: 'request.cancelled', title: `Abgebrochen: ${t.title}`, body: 'Die IT hat Ihre Anfrage geschlossen, bevor sie freigegeben wurde.', link: '/anfragen' });
          notify(app, { to: { email: l.approver }, kind: 'request.cancelled', title: `Abgebrochen: ${t.title}`, body: 'Die IT hat die Anfrage abgebrochen. Sie müssen nichts mehr tun.', link: `/freigaben/${ref}` });
          cancelled++;
          continue;
        }
        if (l.due && today > l.due) {
          const days = app.cfg.approval.expireDays;
          await exclusive(ref, () => finish(app, l, 'abgelaufen',
            `<p>${escapeHtml(accountForEmail(app, l.approver)?.name ?? l.approver)} hat nicht bis ${escapeHtml(dayText(l.due))} entschieden. Die Anfrage wird nicht bearbeitet – bitte bei Bedarf neu stellen.</p>`,
            { emailRequester: requester?.email ?? undefined }));
          if (requester) notify(app, { to: { userId: requester.id }, kind: 'approval.expired', title: `Abgelaufen: ${t.title}`, body: `Ohne Entscheidung innerhalb von ${days} Tagen abgelaufen. Bitte bei Bedarf neu stellen.`, link: '/anfragen' });
          notify(app, { to: { email: l.approver }, kind: 'approval.expired', title: `Abgelaufen: ${t.title}`, body: 'Die Anfrage ist ohne Entscheidung abgelaufen.', link: `/freigaben/${ref}` });
          audit(app.db, { name: 'System' }, { action: 'approval.expired', targetType: 'ticket', targetId: ref, systemId: sys.id, details: { ticket: t.number } });
          expired++;
          continue;
        }
        const created = Date.parse(t.createdAt);
        if (remindDays > 0 && Number.isFinite(created) && Date.now() - created >= remindDays * 86400_000
          && !app.db.get("SELECT 1 FROM zammad_done WHERE system_id = ? AND ticket_id = ? AND kind = 'approval_reminded'", sys.id, t.id)) {
          app.db.run("INSERT OR IGNORE INTO zammad_done (system_id, ticket_id, kind, done_at) VALUES (?, ?, 'approval_reminded', ?)", sys.id, t.id, Date.now());
          await announceApproval(app, sys, t, t.title, l.approver, requester?.name ?? 'Eine Person', true);
          reminded++;
        }
      } catch (err) {
        log.warn('Freigabe: Frist nicht bearbeitet', { system: sys.slug, ticket: t.number, error: (err as Error).message });
      }
    }
  }
  if (expired || reminded || cancelled) log.info('Freigaben: Fristen geprüft', { abgelaufen: expired, erinnert: reminded, abgebrochen: cancelled });
  return { expired, reminded, cancelled };
}

// ------------------------------------------------------------------------------------------ Übergang aus 1.x

/**
 * Anfragen aus 1.x, die noch im Portal auf eine Freigabe warten, gehen jetzt als Ticket „wartet auf Freigabe“
 * nach Zammad. Läuft beim Start; die alte Freigabe-Zeile wird danach gelöscht (der Stand steht im Ticket).
 */
export function upgradeWaitingApprovals(app: App): number {
  const rows = app.db.all<{ id: string; payload: string | null; approver_email: string; approver_name: string | null; expires_at: number }>(
    `SELECT r.id, r.payload, a.approver_email, a.approver_name, a.expires_at FROM requests r JOIN approvals a ON a.request_id = r.id
      WHERE r.status = 'awaiting_approval' AND a.status = 'pending'`,
  );
  let n = 0;
  for (const r of rows) {
    if (!r.payload) continue;
    try {
      const payload = JSON.parse(app.box.decrypt('request', r.payload));
      payload.approval = { email: r.approver_email.toLowerCase(), name: r.approver_name, due: berlinDay(r.expires_at) };
      app.db.tx(() => {
        app.db.run("UPDATE requests SET status = 'queued', payload = ?, next_attempt_at = ?, queued_at = ? WHERE id = ? AND status = 'awaiting_approval'",
          app.box.encrypt('request', JSON.stringify(payload)), Date.now(), Date.now(), r.id);
        app.db.run('DELETE FROM approvals WHERE request_id = ?', r.id);
      });
      n++;
    } catch (err) {
      log.error('Wartende Freigabe nicht übernommen', { request: r.id, error: (err as Error).message });
    }
  }
  if (n) log.info('Wartende Freigaben aus 1.x nach Zammad übergeben', { anzahl: n });
  return n;
}

// ------------------------------------------------------------------------------------------ Abbrechen (Verwaltung)

/** Status, aus denen die Verwaltung eine Anfrage abbrechen kann. "sending" nicht: die Zustellung läuft gerade. */
export const CANCELLABLE = ['failed', 'queued'] as const;

/** Bricht eine noch nicht zugestellte Anfrage ab: Inhalt und Anhänge werden gelöscht, nichts geht an Zammad. */
export function cancelRequest(app: App, admin: AuthUser, actor: Actor, requestId: string, rawReason: unknown, removeFiles: (id: string) => void, openTitle: (t: string) => string): { previous: string } {
  const reason = typeof rawReason === 'string' ? rawReason.replace(/\r\n/g, '\n').trim() : '';
  if (reason.length > COMMENT_MAX) throw new HttpError(422, `Höchstens ${COMMENT_MAX} Zeichen`, 'validation', { reason: `Höchstens ${COMMENT_MAX} Zeichen` });
  const r = app.db.get<{ id: string; user_id: string; system_id: string; title: string; status: string }>('SELECT id, user_id, system_id, title, status FROM requests WHERE id = ?', requestId)!;
  const title = openTitle(r.title);
  const t = Date.now();
  app.db.tx(() => {
    const upd = app.db.run(
      `UPDATE requests SET status = 'cancelled', payload = NULL, purge_after = ?, last_error = ?
        WHERE id = ? AND status IN ('failed', 'queued')`,
      t + app.cfg.retentionDays * 86400_000, `Abgebrochen von ${admin.displayName}${reason ? `: ${reason.slice(0, 300)}` : ''}`, requestId,
    );
    if (!upd.changes) {
      throw new HttpError(409, r.status === 'sending' ? 'Die Anfrage wird gerade zugestellt – bitte gleich noch einmal versuchen' : 'Nur wartende oder fehlgeschlagene Anfragen lassen sich abbrechen. Zugestellte Anfragen schließt die IT in Zammad.', 'conflict');
    }
    app.db.run('UPDATE request_files SET stored = 0 WHERE request_id = ?', requestId);
    audit(app.db, actor, { action: 'request.cancelled', targetType: 'request', targetId: requestId, systemId: r.system_id, details: { vorher: r.status, grundAngegeben: Boolean(reason) } });
  });
  removeFiles(requestId);
  const why = reason ? ` Grund: „${reason.slice(0, 300)}${reason.length > 300 ? ' …' : ''}“` : '';
  notify(app, { to: { userId: r.user_id }, kind: 'request.cancelled', title: `Abgebrochen: ${title}`, body: `Die IT hat Ihre Anfrage abgebrochen. Sie wurde nicht übermittelt.${why}`, link: '/anfragen' });
  log.info('Anfrage abgebrochen', { request: requestId, vorher: r.status });
  return { previous: r.status };
}

export { isVisible, displayValue };
