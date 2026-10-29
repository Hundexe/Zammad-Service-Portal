// Admin-Oberfläche (API). Jede Route prüft ihr Recht – global oder für das Ticketsystem
// aus der URL – und schreibt Änderungen mit Vorher/Nachher ins Audit-Log.
import type { App } from '../app.ts';
import { HttpError, type Router, type RouteOptions } from '../http/core.ts';
import type { AppCtx } from '../server.ts';
import { parseJson, uuid } from '../db/db.ts';
import { sha256 } from '../crypto.ts';
import { audit, diff, verifyAuditChain } from '../services/audit.ts';
import { can, canAnywhere, systemsWith, type AuthUser, type Permissions } from '../services/rbac.ts';
import { ADMIN_PERMISSIONS, GLOBAL_PERMISSIONS, PERMISSION_KEYS, PERMISSIONS } from '../../shared/permissions.ts';
import { connectorFor, getSystem, listSystems, publishedBranding, globalBranding, validateSystemUrl, allowedGroups, type SystemRow } from '../services/systems.ts';
import { getMetadata, releasedAttributes, releasedWithOptions, validateRelease } from '../services/metadata.ts';
import {
  emptyDefinition, getForm, latestVersion, publishVersion, publishedVersion, resolveDefinition, saveDraft, stageFormMeta,
  type FormRow, type FormVersionRow,
} from '../services/forms.ts';
import { validateDefinition, type FormDefinition } from '../../shared/form.ts';
import { contrastWarnings, DEFAULT_BRANDING, validateBranding, type Branding } from '../../shared/branding.ts';
import { checkLogo, decodeBase64Strict, removeRequestFiles } from '../services/files.ts';
import { createLocalUser, emailInUse, getUser, publicUser, resetLocalPassword, toAuthUser, type UserRow } from '../services/users.ts';
import { destroyUserSessions } from '../auth/sessions.ts';
import { retryRequest } from '../services/requests.ts';
import { cancelRequest } from '../services/approvals.ts';
import { applyImport, buildExport, planImport, sameOrigin, summarizePlan } from '../services/transfer.ts';
import { ConnectorError } from '../connectors/types.ts';
import { OVERVIEW_COLUMNS } from './portal.ts';
import { placeholders, templateHtmlProblems } from '../../shared/template.ts';

// ---------------------------------------------------------------- Hilfen

type Body = Record<string, unknown>;

function str(b: Body, k: string, max: number, required = false): string {
  const v = b[k];
  if (v === undefined || v === null || v === '') {
    if (required) throw new HttpError(422, `${k} fehlt`, 'validation', { [k]: 'Pflichtfeld' });
    return '';
  }
  if (typeof v !== 'string' || v.length > max) throw new HttpError(422, `${k} ungültig (max. ${max} Zeichen)`, 'validation', { [k]: 'ungültig' });
  return v.trim();
}

function bool(b: Body, k: string, def: boolean): boolean {
  const v = b[k];
  if (v === undefined) return def;
  if (typeof v !== 'boolean') throw new HttpError(422, `${k} muss ja/nein sein`, 'validation');
  return v;
}

function int(b: Body, k: string, def: number, min = -100000, max = 100000): number {
  const v = b[k];
  if (v === undefined || v === null || v === '') return def;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw new HttpError(422, `${k} muss eine ganze Zahl sein`, 'validation');
  return v;
}

function stringList(b: Body, k: string, maxItems = 100, maxLen = 200): string[] {
  const v = b[k];
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > maxItems || v.some((x) => typeof x !== 'string' || x.length > maxLen)) {
    throw new HttpError(422, `${k} muss eine Liste sein`, 'validation');
  }
  return [...new Set(v.map((x: string) => x.trim()).filter(Boolean))];
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,47}$/;
function slug(b: Body, k: string): string {
  const v = str(b, k, 48, true).toLowerCase();
  if (!SLUG.test(v)) throw new HttpError(422, `${k}: nur a–z, 0–9 und Bindestrich`, 'validation', { [k]: 'ungültig' });
  return v;
}

function actor(ctx: AppCtx) {
  return { id: ctx.user!.id, name: ctx.user!.displayName, ip: ctx.ip };
}

function systemPublic(s: SystemRow) {
  return {
    id: s.id, slug: s.slug, name: s.name, type: s.type, baseUrl: s.base_url, hasToken: Boolean(s.api_token),
    defaultGroup: s.default_group, creationMode: s.creation_mode, status: s.status,
    visibleGroups: parseJson<string[]>(s.visible_groups, []), requireApproval: s.require_approval === 1,
    showOrgTickets: s.show_org_tickets === 1, allowReplies: s.allow_replies === 1,
    closedStates: parseJson<string[]>(s.closed_states, []), portalTag: s.portal_tag, sort: s.sort,
    allowedGroups: allowedGroups(s), hideAgentNames: s.hide_agent_names === 1,
    releasedAttributes: releasedAttributes(s), createdAt: s.created_at, updatedAt: s.updated_at,
  };
}

export function registerAdminRoutes(router: Router, app: App): void {
  const admin = (permission?: string | string[], extra: Partial<RouteOptions> = {}): RouteOptions => ({ auth: 'user', adminNet: true, permission, ...extra });

  function sysOr404(id: string): SystemRow {
    const s = getSystem(app, id);
    if (!s) throw new HttpError(404, 'Ticketsystem nicht gefunden', 'not_found');
    return s;
  }

  function formOr404(systemId: string, formId: string): FormRow {
    const f = getForm(app, formId);
    if (!f || f.system_id !== systemId) throw new HttpError(404, 'Formular nicht gefunden', 'not_found');
    return f;
  }

  /** Systeme, für die der Benutzer irgendein Admin-Recht hat. */
  function adminSystems(user: AuthUser): SystemRow[] {
    return listSystems(app).filter((s) => ADMIN_PERMISSIONS.some((p) => can(user, p, s.id)));
  }

  // ---------------------------------------------------------------- Schutz vor Rechteausweitung
  // Grundregel: Niemand kann Rechte vergeben, entziehen oder übernehmen, die er nicht selbst besitzt.
  // Sonst könnte z. B. jemand mit "Benutzer verwalten" ein Super-Admin-Konto anlegen oder das Passwort
  // eines Super-Admins zurücksetzen und sich damit anmelden.
  const RIGHTS_ERROR = 'Dafür bräuchten Sie selbst mindestens dieselben Rechte (Schutz vor Rechteausweitung)';

  /** Hat der Handelnde jedes Recht der Rolle – global oder für das angegebene System? */
  function coversRole(user: AuthUser, rolePerms: string[], systemId: string | null): boolean {
    const expanded = rolePerms.includes('*') ? PERMISSION_KEYS : rolePerms.filter((p) => PERMISSION_KEYS.includes(p));
    return expanded.every((p) => systemId
      ? GLOBAL_PERMISSIONS.includes(p) || can(user, p, systemId) // globale Rechte wirken pro System ohnehin nicht
      : user.perms.global.has(p));
  }

  /** Hat der Handelnde jedes Recht, das das Zielkonto hat? */
  function coversPerms(user: AuthUser, target: Permissions): boolean {
    for (const p of target.global) if (!user.perms.global.has(p)) return false;
    for (const [sys, set] of target.bySystem) for (const p of set) if (!can(user, p, sys)) return false;
    return true;
  }

  function assertCoversUser(ctx: AppCtx, target: UserRow): void {
    if (target.id === ctx.user!.id) return;
    if (!coversPerms(ctx.user!, toAuthUser(app.db, target).perms)) throw new HttpError(403, RIGHTS_ERROR, 'insufficient_rights');
  }

  /**
   * Die E-Mail-Adresse eines lokalen Kontos verbindet es mit dem Zammad-Kunden dieser Adresse – also mit
   * allen Tickets der Person. Das darf nur, wer selbst alle Rechte hat (Super-Admin).
   */
  function assertMaySetLocalEmail(ctx: AppCtx): void {
    if (!coversRole(ctx.user!, ['*'], null)) {
      throw new HttpError(403, 'Eine E-Mail-Adresse verbindet das lokale Konto mit den Tickets dieser Person in Zammad – das darf nur ein Super-Admin setzen', 'insufficient_rights');
    }
  }

  function assertCoversRole(ctx: AppCtx, rolePerms: string[], systemId: string | null): void {
    if (!coversRole(ctx.user!, rolePerms, systemId)) throw new HttpError(403, RIGHTS_ERROR, 'insufficient_rights');
  }

  function requireAnyAdmin(ctx: AppCtx): void {
    if (!ADMIN_PERMISSIONS.some((p) => canAnywhere(ctx.user, p))) throw new HttpError(403, 'Keine Berechtigung', 'forbidden');
  }

  // ---------------------------------------------------------------- Übersicht
  router.get('/api/admin/overview', admin(), (ctx: AppCtx) => {
    requireAnyAdmin(ctx);
    const systems = adminSystems(ctx.user!);
    const ids = systems.map((s) => s.id);
    const inSys = (col: string) => (ids.length ? `${col} IN (${ids.map(() => '?').join(',')})` : '0');
    const counts = app.db.all<{ status: string; n: number }>(`SELECT status, COUNT(*) n FROM requests WHERE ${inSys('system_id')} AND created_at > ? GROUP BY status`, ...ids, Date.now() - 7 * 86400_000);
    const pendingForms = app.db.all<{ id: string; form_id: string; version: number; name: string; system_id: string }>(
      `SELECT v.id, v.form_id, v.version, f.name, f.system_id FROM form_versions v JOIN forms f ON f.id = v.form_id WHERE v.status = 'pending' AND ${inSys('f.system_id')}`, ...ids,
    ).filter((v) => can(ctx.user, 'form.approve', v.system_id));
    const pendingBranding = app.db.all<{ id: string; system_id: string; version: number }>(
      `SELECT id, system_id, version FROM branding_versions WHERE status = 'pending' AND ${inSys('system_id')}`, ...ids,
    ).filter((v) => can(ctx.user, 'form.approve', v.system_id));
    const warnings: string[] = [];
    if (!app.cfg.entra.enabled) warnings.push('Microsoft-Anmeldung (Entra ID) ist noch nicht eingerichtet.');
    if (app.cfg.entra.enabled && app.cfg.localLogin) warnings.push('Lokale Anmeldung ist noch aktiv. Nach der Einrichtung von Entra ID auf Notfallkonten beschränken oder abschalten (LOCAL_LOGIN_ENABLED=false).');
    if (!app.clamav) warnings.push('Kein Virenscanner (ClamAV) konfiguriert.');
    if (app.cfg.localLogin && !app.cfg.localAdminRequireTotp && !app.cfg.localUserRequireTotp) warnings.push('Lokale Admin-Konten brauchen keine Zwei-Faktor-Anmeldung (LOCAL_ADMIN_REQUIRE_TOTP=false). Das wird nicht empfohlen.');
    if (!app.cfg.lockout.progressive) warnings.push('Die Kontosperre wird bei wiederholten Angriffen nicht länger (LOGIN_LOCK_PROGRESSIVE=false).');
    if (!app.cfg.adminAllowedCidrs.length) warnings.push('Der Admin-Bereich ist nicht auf Admin-Netze beschränkt (ADMIN_ALLOWED_CIDRS).');
    for (const sys of listSystems(app)) {
      if (sys.status !== 'inactive' && !allowedGroups(sys).length) warnings.push(`Ticketsystem „${sys.name}“: keine erlaubten Zammad-Gruppen festgelegt – Formulare können Tickets in jede Gruppe legen, die der API-Benutzer sieht.`);
    }
    const upd = app.db.get<{ updater_seen_at: number | null; latest_version: string | null; current_version: string | null }>('SELECT updater_seen_at, latest_version, current_version FROM update_state WHERE id = 1');
    return {
      version: app.cfg.version,
      systems: systems.map((s) => ({ id: s.id, name: s.name, status: s.status })),
      requests7d: Object.fromEntries(counts.map((c) => [c.status, c.n])),
      failed: app.db.get<{ n: number }>(`SELECT COUNT(*) n FROM requests WHERE status = 'failed' AND ${inSys('system_id')}`, ...ids)?.n ?? 0,
      awaitingApproval: app.db.get<{ n: number }>(`SELECT COUNT(*) n FROM requests WHERE status = 'awaiting_approval' AND ${inSys('system_id')}`, ...ids)?.n ?? 0,
      pendingApprovals: { forms: pendingForms, branding: pendingBranding },
      warnings,
      update: upd,
    };
  });

  router.get('/api/admin/meta', admin(), (ctx: AppCtx) => {
    requireAnyAdmin(ctx);
    return { permissions: PERMISSIONS, overviewColumns: OVERVIEW_COLUMNS };
  });

  // ---------------------------------------------------------------- Ticketsysteme
  router.get('/api/admin/systems', admin(), (ctx: AppCtx) => {
    requireAnyAdmin(ctx);
    return { systems: adminSystems(ctx.user!).map(systemPublic), canCreate: can(ctx.user, 'system.manage', null) };
  });

  async function readSystemBody(b: Body, existing?: SystemRow) {
    const baseUrl = str(b, 'baseUrl', 500, !existing).replace(/\/+$/, '') || existing?.base_url || '';
    const urlProblem = await validateSystemUrl(app, baseUrl);
    if (urlProblem) throw new HttpError(422, urlProblem, 'validation', { baseUrl: urlProblem });
    const status = str(b, 'status', 20) || existing?.status || 'active';
    if (!['active', 'maintenance', 'inactive'].includes(status)) throw new HttpError(422, 'Status ungültig', 'validation');
    const mode = str(b, 'creationMode', 20) || existing?.creation_mode || 'on_behalf_of';
    if (!['on_behalf_of', 'customer_field'].includes(mode)) throw new HttpError(422, 'Anlage-Modus ungültig', 'validation');
    const token = typeof b.apiToken === 'string' && b.apiToken.trim() !== '' ? str(b, 'apiToken', 500) : null;
    // Das gespeicherte Token nie an eine neue Adresse schicken: bei geändertem Ursprung neu eingeben lassen
    if (existing && !token && sameOrigin(existing.base_url, baseUrl) !== true) {
      throw new HttpError(422, 'Die Adresse ändert sich – bitte das API-Token für die neue Adresse eingeben', 'validation', { apiToken: 'Bei neuer Adresse Pflicht' });
    }
    const portalTag = str(b, 'portalTag', 60) || existing?.portal_tag || 'service-portal';
    if (!/^[\p{L}\p{N}_.\- ]{1,60}$/u.test(portalTag)) throw new HttpError(422, 'Tag ungültig', 'validation');
    const allowed = b.allowedGroups === undefined && existing ? allowedGroups(existing) : stringList(b, 'allowedGroups', 200, 160);
    const defaultGroup = str(b, 'defaultGroup', 160) || null;
    if (defaultGroup && allowed.length && !allowed.includes(defaultGroup)) {
      throw new HttpError(422, 'Die Standardgruppe muss in den erlaubten Gruppen stehen', 'validation', { defaultGroup: 'nicht erlaubt' });
    }
    return {
      name: str(b, 'name', 80, !existing) || existing!.name,
      base_url: baseUrl,
      api_token: token ? app.box.encrypt('system-token', token) : existing?.api_token ?? null,
      default_group: defaultGroup,
      creation_mode: mode,
      status,
      visible_groups: JSON.stringify(stringList(b, 'visibleGroups')),
      require_approval: bool(b, 'requireApproval', existing ? existing.require_approval === 1 : false) ? 1 : 0,
      show_org_tickets: bool(b, 'showOrgTickets', existing ? existing.show_org_tickets === 1 : false) ? 1 : 0,
      allow_replies: bool(b, 'allowReplies', existing ? existing.allow_replies === 1 : true) ? 1 : 0,
      closed_states: JSON.stringify(b.closedStates === undefined && existing ? parseJson<string[]>(existing.closed_states, []) : stringList(b, 'closedStates', 50, 80).length ? stringList(b, 'closedStates', 50, 80) : ['closed', 'merged', 'removed']),
      portal_tag: portalTag,
      sort: int(b, 'sort', existing?.sort ?? 0),
      allowed_groups: JSON.stringify(allowed),
      hide_agent_names: bool(b, 'hideAgentNames', existing ? existing.hide_agent_names === 1 : false) ? 1 : 0,
    };
  }

  router.post('/api/admin/systems', admin('system.manage', { stepup: true }), async (ctx: AppCtx) => {
    if (!can(ctx.user, 'system.manage', null)) throw new HttpError(403, 'Neue Ticketsysteme darf nur ein globaler Admin anlegen', 'forbidden');
    const b = ctx.body as Body;
    const s = slug(b, 'slug');
    if (app.db.get('SELECT 1 FROM ticket_systems WHERE slug = ?', s)) throw new HttpError(409, 'Kürzel ist schon vergeben', 'conflict');
    const v = await readSystemBody(b);
    if (!v.api_token) throw new HttpError(422, 'API-Token fehlt', 'validation', { apiToken: 'Pflichtfeld' });
    const id = uuid();
    const t = Date.now();
    app.db.tx(() => {
      app.db.run(
        `INSERT INTO ticket_systems (id, slug, name, type, base_url, api_token, default_group, creation_mode, status, visible_groups, require_approval, show_org_tickets, allow_replies, closed_states, portal_tag, sort, allowed_groups, hide_agent_names, created_at, updated_at)
         VALUES (?, ?, ?, 'zammad', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id, s, v.name, v.base_url, v.api_token, v.default_group, v.creation_mode, v.status, v.visible_groups, v.require_approval, v.show_org_tickets, v.allow_replies, v.closed_states, v.portal_tag, v.sort, v.allowed_groups, v.hide_agent_names, t, t,
      );
      app.db.run("INSERT INTO branding_versions (id, system_id, version, data, status, created_by, created_at, published_at) VALUES (?, ?, 1, ?, 'published', ?, ?, ?)",
        uuid(), id, JSON.stringify({ ...DEFAULT_BRANDING, displayName: v.name }), ctx.user!.id, t, t);
      for (const [i, o] of [['Offene Tickets', 'open'], ['Erledigt', 'closed']].entries()) {
        app.db.run("INSERT INTO overviews (id, system_id, name, state_filter, columns, sort_by, sort_dir, sort, created_at, updated_at) VALUES (?, ?, ?, ?, '[\"number\",\"title\",\"state\",\"updated_at\"]', 'updated_at', 'desc', ?, ?, ?)", uuid(), id, o[0], o[1], i, t, t);
      }
      const def = emptyDefinition();
      app.db.run("INSERT INTO templates (id, system_id, kind, name, content, created_at, updated_at, updated_by) VALUES (?, ?, 'title', 'Standard-Titel', ?, ?, ?, ?)", uuid(), id, def.settings.titleTemplate, t, t, ctx.user!.id);
      app.db.run("INSERT INTO templates (id, system_id, kind, name, content, created_at, updated_at, updated_by) VALUES (?, ?, 'body', 'Standard-Text mit allen Feldern', ?, ?, ?, ?)", uuid(), id, def.settings.bodyTemplate, t, t, ctx.user!.id);
      app.db.run("INSERT INTO templates (id, system_id, kind, name, content, created_at, updated_at, updated_by) VALUES (?, ?, 'success', 'Standard-Bestätigung', ?, ?, ?, ?)", uuid(), id, def.settings.successText ?? '', t, t, ctx.user!.id);
      audit(app.db, actor(ctx), { action: 'system.created', targetType: 'system', targetId: id, systemId: id, details: diff(undefined, { ...v, api_token: v.api_token }) });
    });
    return { created: true, system: systemPublic(getSystem(app, id)!) };
  });

  router.put('/api/admin/systems/:systemId', admin('system.manage', { stepup: true }), async (ctx: AppCtx) => {
    const before = sysOr404(ctx.params.systemId);
    const v = await readSystemBody(ctx.body as Body, before);
    // Vier-Augen-Prinzip abschalten nur mit globalem Recht – sonst könnte der Admin eines Systems es
    // ausschalten, allein veröffentlichen und wieder einschalten
    if (before.require_approval === 1 && v.require_approval === 0 && !can(ctx.user, 'system.manage', null)) {
      throw new HttpError(403, 'Das Vier-Augen-Prinzip kann nur ein globaler Admin abschalten', 'forbidden');
    }
    app.db.run(
      `UPDATE ticket_systems SET name = ?, base_url = ?, api_token = ?, default_group = ?, creation_mode = ?, status = ?, visible_groups = ?, require_approval = ?,
        show_org_tickets = ?, allow_replies = ?, closed_states = ?, portal_tag = ?, sort = ?, allowed_groups = ?, hide_agent_names = ?, updated_at = ? WHERE id = ?`,
      v.name, v.base_url, v.api_token, v.default_group, v.creation_mode, v.status, v.visible_groups, v.require_approval,
      v.show_org_tickets, v.allow_replies, v.closed_states, v.portal_tag, v.sort, v.allowed_groups, v.hide_agent_names, Date.now(), before.id,
    );
    if (v.base_url !== before.base_url || v.api_token !== before.api_token) app.db.run('DELETE FROM zammad_customers WHERE system_id = ?', before.id);
    audit(app.db, actor(ctx), { action: 'system.updated', targetType: 'system', targetId: before.id, systemId: before.id, details: diff(before as any, { ...before, ...v } as any) });
    return { system: systemPublic(getSystem(app, before.id)!) };
  });

  router.delete('/api/admin/systems/:systemId', admin('system.manage', { stepup: true }), (ctx: AppCtx) => {
    if (!can(ctx.user, 'system.manage', null)) throw new HttpError(403, 'Löschen darf nur ein globaler Admin', 'forbidden');
    const s = sysOr404(ctx.params.systemId);
    const open = app.db.get<{ n: number }>("SELECT COUNT(*) n FROM requests WHERE system_id = ? AND status IN ('queued','sending')", s.id)!.n;
    if (open > 0) throw new HttpError(409, `Es warten noch ${open} Anfragen auf Zustellung`, 'conflict');
    const awaiting = app.db.get<{ n: number }>("SELECT COUNT(*) n FROM requests WHERE system_id = ? AND status = 'awaiting_approval'", s.id)!.n;
    if (awaiting > 0) throw new HttpError(409, `Es warten noch ${awaiting} Anfragen auf eine Freigabe durch Vorgesetzte`, 'conflict');
    const requestIds = app.db.all<{ id: string }>('SELECT id FROM requests WHERE system_id = ?', s.id).map((r) => r.id);
    app.db.tx(() => {
      app.db.run('DELETE FROM requests WHERE system_id = ?', s.id);
      app.db.run('DELETE FROM ticket_systems WHERE id = ?', s.id);
      audit(app.db, actor(ctx), { action: 'system.deleted', targetType: 'system', targetId: s.id, details: { name: s.name, slug: s.slug } });
    });
    // Verschlüsselte Anhänge (z. B. fehlgeschlagener Anfragen) mit entfernen
    for (const id of requestIds) removeRequestFiles(app, id);
    return { ok: true };
  });

  router.post('/api/admin/systems/:systemId/test', admin('system.manage'), async (ctx: AppCtx) => {
    const s = sysOr404(ctx.params.systemId);
    let origin = '';
    try { origin = new URL(s.base_url).origin; } catch { /* ungültig */ }
    try {
      const info = await connectorFor(app, s).test();
      audit(app.db, actor(ctx), { action: 'system.tested', targetType: 'system', targetId: s.id, systemId: s.id, details: { adresse: origin, ok: true } });
      return { ok: true, ...info };
    } catch (err) {
      audit(app.db, actor(ctx), { action: 'system.tested', targetType: 'system', targetId: s.id, systemId: s.id, details: { adresse: origin, ok: false } });
      return { ok: false, error: err instanceof ConnectorError ? err.message : 'Verbindung fehlgeschlagen' };
    }
  });

  router.get('/api/admin/systems/:systemId/metadata', admin(['system.manage', 'form.edit', 'attribute.release']), async (ctx: AppCtx) => {
    const s = sysOr404(ctx.params.systemId);
    try {
      const meta = await getMetadata(app, s, ctx.query.get('refresh') === '1');
      return { metadata: meta, released: releasedAttributes(s), releasedResolved: releasedWithOptions(s, meta) };
    } catch (err) {
      throw new HttpError(502, `Zammad nicht erreichbar: ${(err as Error).message}`, 'upstream');
    }
  });

  router.put('/api/admin/systems/:systemId/release', admin('attribute.release'), async (ctx: AppCtx) => {
    const s = sysOr404(ctx.params.systemId);
    const meta = await getMetadata(app, s).catch(() => { throw new HttpError(502, 'Zammad nicht erreichbar', 'upstream'); });
    const { release, errors } = validateRelease((ctx.body as Body).release, meta);
    if (!release) throw new HttpError(422, errors.join('; '), 'validation', errors);
    app.db.run('UPDATE ticket_systems SET released_attributes = ?, updated_at = ? WHERE id = ?', JSON.stringify(release), Date.now(), s.id);
    audit(app.db, actor(ctx), { action: 'attributes.released', targetType: 'system', targetId: s.id, systemId: s.id, details: diff({ freigabe: releasedAttributes(s) }, { freigabe: release }) });
    return { released: release };
  });

  // ---------------------------------------------------------------- Formulare
  function versionInfo(v: FormVersionRow | undefined) {
    const meta = v?.meta ? parseJson<Record<string, unknown> | null>(v.meta, null) : null;
    return v ? {
      id: v.id, version: v.version, status: v.status, note: v.note, createdBy: v.created_by, createdAt: v.created_at, submittedBy: v.submitted_by, approvedBy: v.approved_by, publishedAt: v.published_at,
      pendingMeta: meta ? { name: meta.name, description: meta.description, visibleGroups: parseJson<string[]>(String(meta.visible_groups ?? '[]'), []), active: meta.active === 1 } : null,
    } : null;
  }

  function formPublic(f: FormRow) {
    return {
      id: f.id, systemId: f.system_id, slug: f.slug, name: f.name, description: f.description, category: f.category,
      visibleGroups: parseJson<string[]>(f.visible_groups, []), sort: f.sort, active: f.active === 1, updatedAt: f.updated_at,
      published: versionInfo(publishedVersion(app, f.id)), latest: versionInfo(latestVersion(app, f.id)),
    };
  }

  router.get('/api/admin/systems/:systemId/forms', admin(['form.edit', 'form.publish', 'form.approve']), (ctx: AppCtx) => {
    sysOr404(ctx.params.systemId);
    return { forms: app.db.all<FormRow>('SELECT * FROM forms WHERE system_id = ? ORDER BY sort, name', ctx.params.systemId).map(formPublic) };
  });

  function readFormMeta(b: Body, existing?: FormRow) {
    return {
      name: str(b, 'name', 120, !existing) || existing!.name,
      description: b.description === undefined && existing ? existing.description : str(b, 'description', 1000),
      category: b.category === undefined && existing ? existing.category : str(b, 'category', 80),
      visible_groups: JSON.stringify(b.visibleGroups === undefined && existing ? parseJson<string[]>(existing.visible_groups, []) : stringList(b, 'visibleGroups')),
      sort: int(b, 'sort', existing?.sort ?? 0),
      active: bool(b, 'active', existing ? existing.active === 1 : true) ? 1 : 0,
    };
  }

  router.post('/api/admin/systems/:systemId/forms', admin('form.edit'), (ctx: AppCtx) => {
    const s = sysOr404(ctx.params.systemId);
    const b = ctx.body as Body;
    const sl = slug(b, 'slug');
    if (app.db.get('SELECT 1 FROM forms WHERE system_id = ? AND slug = ?', s.id, sl)) throw new HttpError(409, 'Kürzel ist schon vergeben', 'conflict');
    const m = readFormMeta(b);
    const id = uuid();
    const t = Date.now();
    app.db.tx(() => {
      app.db.run('INSERT INTO forms (id, system_id, slug, name, description, category, visible_groups, sort, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        id, s.id, sl, m.name, m.description, m.category, m.visible_groups, m.sort, m.active, t, t);
      const def = emptyDefinition();
      def.settings.group = s.default_group ?? undefined;
      saveDraft(app, id, def, ctx.user!.id, 'Neu angelegt');
      audit(app.db, actor(ctx), { action: 'form.created', targetType: 'form', targetId: id, systemId: s.id, details: { slug: sl, ...m } });
    });
    return { created: true, form: formPublic(getForm(app, id)!) };
  });

  router.get('/api/admin/systems/:systemId/forms/:formId', admin(['form.edit', 'form.publish', 'form.approve']), (ctx: AppCtx) => {
    const f = formOr404(ctx.params.systemId, ctx.params.formId);
    const versions = app.db.all<FormVersionRow>('SELECT * FROM form_versions WHERE form_id = ? ORDER BY version DESC', f.id);
    const latest = versions[0];
    const names = new Map(app.db.all<{ id: string; display_name: string }>('SELECT id, display_name FROM users').map((u) => [u.id, u.display_name]));
    return {
      form: formPublic(f),
      definition: latest ? parseJson<FormDefinition>(latest.definition, emptyDefinition()) : emptyDefinition(),
      versions: versions.map((v) => ({ ...versionInfo(v), createdByName: names.get(v.created_by ?? '') ?? null, submittedByName: names.get(v.submitted_by ?? '') ?? null, approvedByName: names.get(v.approved_by ?? '') ?? null })),
    };
  });

  router.get('/api/admin/systems/:systemId/forms/:formId/versions/:versionId', admin(['form.edit', 'form.publish', 'form.approve']), (ctx: AppCtx) => {
    const f = formOr404(ctx.params.systemId, ctx.params.formId);
    const v = app.db.get<FormVersionRow>('SELECT * FROM form_versions WHERE id = ? AND form_id = ?', ctx.params.versionId, f.id);
    if (!v) throw new HttpError(404, 'Version nicht gefunden', 'not_found');
    return { version: versionInfo(v), definition: parseJson<FormDefinition>(v.definition, emptyDefinition()) };
  });

  router.put('/api/admin/systems/:systemId/forms/:formId', admin('form.edit'), (ctx: AppCtx) => {
    const f = formOr404(ctx.params.systemId, ctx.params.formId);
    const m = readFormMeta(ctx.body as Body, f);
    const sys = sysOr404(f.system_id);
    const gatedChanged = m.name !== f.name || m.description !== f.description || m.visible_groups !== f.visible_groups || m.active !== f.active;
    if (sys.require_approval === 1 && gatedChanged) {
      // Vier-Augen-Prinzip: was Mitarbeitende sehen (Name, Text, Sichtbarkeit, aktiv) gilt erst nach Freigabe
      app.db.run('UPDATE forms SET category = ?, sort = ?, updated_at = ? WHERE id = ?', m.category, m.sort, Date.now(), f.id);
      try {
        stageFormMeta(app, f.id, { name: m.name, description: m.description, visible_groups: m.visible_groups, active: m.active }, ctx.user!.id);
      } catch (err) {
        throw new HttpError(409, (err as Error).message, 'conflict');
      }
      audit(app.db, actor(ctx), { action: 'form.meta_staged', targetType: 'form', targetId: f.id, systemId: f.system_id, details: diff(f as any, { ...f, ...m } as any) });
      return { form: formPublic(getForm(app, f.id)!), staged: true };
    }
    app.db.run('UPDATE forms SET name = ?, description = ?, category = ?, visible_groups = ?, sort = ?, active = ?, updated_at = ? WHERE id = ?',
      m.name, m.description, m.category, m.visible_groups, m.sort, m.active, Date.now(), f.id);
    audit(app.db, actor(ctx), { action: 'form.updated', targetType: 'form', targetId: f.id, systemId: f.system_id, details: diff(f as any, { ...f, ...m } as any) });
    return { form: formPublic(getForm(app, f.id)!) };
  });

  router.delete('/api/admin/systems/:systemId/forms/:formId', admin('form.publish'), (ctx: AppCtx) => {
    const f = formOr404(ctx.params.systemId, ctx.params.formId);
    app.db.run('DELETE FROM forms WHERE id = ?', f.id);
    audit(app.db, actor(ctx), { action: 'form.deleted', targetType: 'form', targetId: f.id, systemId: f.system_id, details: { name: f.name, slug: f.slug } });
    return { ok: true };
  });

  /** Gruppen, in die ein Formular Tickets legen kann, müssen in der Allowlist des Systems stehen. */
  function groupProblems(s: SystemRow, d: FormDefinition): string[] {
    const allowed = allowedGroups(s);
    if (!allowed.length) return [];
    const out: string[] = [];
    const target = d.settings.group || s.default_group || '';
    if (target && !allowed.includes(target)) out.push(`Gruppe „${target}“ ist für dieses Ticketsystem nicht erlaubt`);
    for (const f of d.fields) {
      if (f.mapping?.target !== 'group') continue;
      const values = f.options?.length ? f.options.map((o) => o.value) : [];
      if (!values.length) { out.push(`Feld „${f.label}“: Gruppe aus freier Eingabe ist nicht erlaubt – nur Auswahlfelder`); continue; }
      for (const v of values) {
        const g = f.mapping.valueMap?.[v] ?? v;
        if (!allowed.includes(g)) out.push(`Feld „${f.label}“: Wert „${v}“ führt in die Gruppe „${g}“, die nicht erlaubt ist`);
      }
    }
    return out;
  }

  function checkDefinition(s: SystemRow, def: unknown): FormDefinition {
    const problems = validateDefinition(def);
    const d = def as FormDefinition;
    if (!problems.length) {
      const released = new Set(releasedAttributes(s).map((a) => a.name));
      for (const f of d.fields) if (f.type === 'zammad' && !released.has(f.attribute!)) problems.push(`Feld „${f.label}“: Zammad-Attribut „${f.attribute}“ ist nicht freigegeben – unter „Zammad-Objekte“ freigeben oder ein normales Auswahlfeld nehmen`);
      // Freie Zuordnung in Zammad-Felder nur in freigegebene Attribute
      for (const f of d.fields) {
        if (f.mapping?.target === 'zammad_field' && f.mapping.name && !released.has(f.mapping.name)) problems.push(`Feld „${f.label}“: Zammad-Feld „${f.mapping.name}“ ist nicht freigegeben (Ticketsystem → Zammad-Felder)`);
      }
      problems.push(...groupProblems(s, d));
      for (const tpl of [d.settings.titleTemplate, d.settings.bodyTemplate]) {
        for (const p of placeholders(tpl)) {
          const root = p.split('.')[0];
          if (!['benutzer', 'formular', 'system', 'anfrage', 'datum', 'alle_felder'].includes(root) && !d.fields.some((f) => f.id === root)) problems.push(`Vorlage: unbekannter Platzhalter {{${p}}}`);
        }
      }
    }
    if (problems.length) throw new HttpError(422, 'Formular enthält Fehler', 'validation', problems);
    // Nur bekannte Schlüssel übernehmen
    return JSON.parse(JSON.stringify({ fields: d.fields, settings: d.settings })) as FormDefinition;
  }

  router.put('/api/admin/systems/:systemId/forms/:formId/draft', admin('form.edit', { bodyLimit: 512 * 1024 }), (ctx: AppCtx) => {
    const s = sysOr404(ctx.params.systemId);
    const f = formOr404(s.id, ctx.params.formId);
    const b = ctx.body as Body;
    const def = checkDefinition(s, b.definition);
    let v: FormVersionRow;
    try { v = saveDraft(app, f.id, def, ctx.user!.id, str(b, 'note', 300)); } catch (err) { throw new HttpError(409, (err as Error).message, 'conflict'); }
    audit(app.db, actor(ctx), { action: 'form.draft_saved', targetType: 'form', targetId: f.id, systemId: s.id, details: { version: v.version } });
    return { version: versionInfo(v) };
  });

  router.post('/api/admin/systems/:systemId/forms/:formId/preview', admin(['form.edit', 'form.publish', 'form.approve'], { bodyLimit: 512 * 1024 }), async (ctx: AppCtx) => {
    const s = sysOr404(ctx.params.systemId);
    formOr404(s.id, ctx.params.formId);
    const problems = validateDefinition((ctx.body as Body).definition);
    if (problems.length) return { problems, definition: null };
    const meta = await getMetadata(app, s).catch(() => ({ groups: [], states: [], priorities: [], fields: [] }));
    return { problems: [], definition: resolveDefinition((ctx.body as Body).definition as FormDefinition, s, meta, null) };
  });

  router.post('/api/admin/systems/:systemId/forms/:formId/publish', admin('form.publish'), (ctx: AppCtx) => {
    const s = sysOr404(ctx.params.systemId);
    const f = formOr404(s.id, ctx.params.formId);
    const v = latestVersion(app, f.id);
    if (!v || v.status !== 'draft') throw new HttpError(409, 'Kein Entwurf zum Veröffentlichen vorhanden', 'conflict');
    checkDefinition(s, parseJson(v.definition, {}));
    if (s.require_approval === 1) {
      app.db.run("UPDATE form_versions SET status = 'pending', submitted_by = ? WHERE id = ?", ctx.user!.id, v.id);
      audit(app.db, actor(ctx), { action: 'form.submitted_for_approval', targetType: 'form', targetId: f.id, systemId: s.id, details: { version: v.version } });
      return { status: 'pending' };
    }
    app.db.run('UPDATE form_versions SET submitted_by = ? WHERE id = ?', ctx.user!.id, v.id);
    publishVersion(app, v, null);
    audit(app.db, actor(ctx), { action: 'form.published', targetType: 'form', targetId: f.id, systemId: s.id, details: { version: v.version } });
    return { status: 'published' };
  });

  // Formulare und Vorlagen eines Ticketsystems als Datei – dasselbe Format, das „Aus Datei übernehmen“ liest.
  // Je Formular die veröffentlichte Version (sonst der neueste Stand).
  router.get('/api/admin/systems/:systemId/form-export', admin(['form.edit', 'template.edit']), (ctx: AppCtx) => {
    const s = sysOr404(ctx.params.systemId);
    const forms = can(ctx.user, 'form.edit', s.id) ? app.db.all<FormRow>('SELECT * FROM forms WHERE system_id = ? ORDER BY sort, name', s.id).flatMap((f) => {
      const v = publishedVersion(app, f.id) ?? latestVersion(app, f.id);
      return v ? [{ slug: f.slug, name: f.name, category: f.category, sort: f.sort, description: f.description, active: f.active === 1, visibleGroups: parseJson<string[]>(f.visible_groups, []), definition: parseJson(v.definition, null) }] : [];
    }) : [];
    const templates = can(ctx.user, 'template.edit', s.id) ? app.db.all<{ kind: string; name: string; content: string }>('SELECT kind, name, content FROM templates WHERE system_id = ? ORDER BY kind, name', s.id) : [];
    return { system: { slug: s.slug, name: s.name }, exportedAt: new Date().toISOString(), forms, templates };
  });

  // Formulare aus einer Datei übernehmen ({forms: [{slug, name, description, category, sort, definition}], templates?: [...]}).
  // Gleiches Kürzel → neue Version (Entwurf, auf Wunsch veröffentlicht); neues Kürzel → neues Formular. Nichts wird gelöscht.
  router.post('/api/admin/systems/:systemId/forms/import', admin(['form.edit', 'template.edit'], { bodyLimit: 5 * 1024 * 1024 }), (ctx: AppCtx) => {
    const s = sysOr404(ctx.params.systemId);
    const b = ctx.body as Body;
    if (Array.isArray(b.forms) && b.forms.length && !can(ctx.user, 'form.edit', s.id)) throw new HttpError(403, 'Zum Übernehmen von Formularen fehlt das Recht „Formulare bearbeiten“', 'forbidden');
    if (Array.isArray(b.templates) && b.templates.length && !can(ctx.user, 'template.edit', s.id)) throw new HttpError(403, 'Zum Übernehmen von Vorlagen fehlt das Recht „Vorlagen bearbeiten“', 'forbidden');
    const dryRun = b.dryRun === true;
    const publish = b.publish === true;
    if (publish && !can(ctx.user, 'form.publish', s.id)) throw new HttpError(403, 'Zum Veröffentlichen fehlt das Recht „Formulare veröffentlichen“', 'forbidden');
    if (b.forms === undefined) b.forms = [];
    if (!Array.isArray(b.forms) || b.forms.length > 200) throw new HttpError(422, 'Formularliste ungültig', 'validation');
    if (b.forms.length === 0 && (!Array.isArray(b.templates) || b.templates.length === 0)) throw new HttpError(422, 'Die Datei enthält weder Formulare noch Vorlagen', 'validation');
    const errors: string[] = [];
    const plan: { slug: string; name: string; action: 'create' | 'update' | 'unchanged'; id: string | null; meta: ReturnType<typeof readFormMeta>; def: FormDefinition | null }[] = [];
    const seen = new Set<string>();
    for (const [i, raw] of (b.forms as unknown[]).entries()) {
      const f = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Body;
      let sl = '';
      try { sl = slug(f, 'slug'); } catch { errors.push(`Formular ${i + 1}: Kürzel ungültig`); continue; }
      if (seen.has(sl)) { errors.push(`Formular „${sl}“ doppelt`); continue; }
      seen.add(sl);
      const existing = app.db.get<FormRow>('SELECT * FROM forms WHERE system_id = ? AND slug = ?', s.id, sl);
      let meta: ReturnType<typeof readFormMeta>;
      try { meta = readFormMeta(f, existing); } catch (err) { errors.push(`Formular „${sl}“: ${(err as Error).message}`); continue; }
      let def: FormDefinition | null = null;
      try { def = checkDefinition(s, f.definition); } catch (err) {
        const d = err instanceof HttpError && Array.isArray(err.details) ? (err.details as string[]).slice(0, 5).join('; ') : (err as Error).message;
        errors.push(`Formular „${sl}“: ${d}`); continue;
      }
      if (existing && latestVersion(app, existing.id)?.status === 'pending') { errors.push(`Formular „${sl}“: eine Version wartet noch auf Freigabe – erst freigeben oder ablehnen`); continue; }
      const cur = existing ? publishedVersion(app, existing.id) : undefined;
      const same = existing && cur && JSON.stringify(parseJson(cur.definition, {})) === JSON.stringify(def)
        && existing.name === meta.name && existing.description === meta.description && existing.category === meta.category && existing.sort === meta.sort;
      plan.push({ slug: sl, name: meta.name, action: !existing ? 'create' : same ? 'unchanged' : 'update', id: existing?.id ?? null, meta, def });
    }
    const templates: { kind: string; name: string; content: string }[] = [];
    if (b.templates !== undefined) {
      if (!Array.isArray(b.templates) || b.templates.length > 100) errors.push('Vorlagen ungültig');
      else for (const tp of b.templates as Body[]) {
        const kind = typeof tp?.kind === 'string' ? tp.kind : '';
        if (!['title', 'body', 'success'].includes(kind) || typeof tp.name !== 'string' || !tp.name.trim() || tp.name.length > 120
          || typeof tp.content !== 'string' || tp.content.length > (kind === 'body' ? 20000 : 1000)) { errors.push('Vorlage ungültig'); continue; }
        if (kind === 'body') { const pr = templateHtmlProblems(tp.content); if (pr.length) { errors.push(`Vorlage „${tp.name.trim()}“: ${pr.join('; ')}`); continue; } }
        templates.push({ kind, name: tp.name.trim(), content: tp.content });
      }
    }
    if (errors.length) throw new HttpError(422, 'Die Datei kann nicht übernommen werden', 'validation', errors.slice(0, 50));
    const summary = {
      forms: plan.map((p) => ({ slug: p.slug, name: p.name, action: p.action })),
      templates: templates.map((tp) => ({ kind: tp.kind, name: tp.name, action: app.db.get('SELECT 1 FROM templates WHERE system_id = ? AND kind = ? AND name = ?', s.id, tp.kind, tp.name) ? 'update' : 'create' })),
      publish: publish ? (s.require_approval === 1 ? 'pending' : 'published') : 'draft',
    };
    if (dryRun) return { plan: summary };
    const t = Date.now();
    app.db.tx(() => {
      for (const p of plan) {
        if (p.action === 'unchanged') continue;
        let id = p.id;
        if (!id) {
          id = uuid();
          app.db.run('INSERT INTO forms (id, system_id, slug, name, description, category, visible_groups, sort, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            id, s.id, p.slug, p.meta.name, p.meta.description, p.meta.category, p.meta.visible_groups, p.meta.sort, p.meta.active, t, t);
        } else if (s.require_approval === 1) {
          // Vier-Augen-Prinzip: sichtbare Angaben erst mit der Freigabe (siehe unten), Kategorie/Reihenfolge sofort
          app.db.run('UPDATE forms SET category = ?, sort = ?, updated_at = ? WHERE id = ?', p.meta.category, p.meta.sort, t, id);
        } else {
          app.db.run('UPDATE forms SET name = ?, description = ?, category = ?, visible_groups = ?, sort = ?, active = ?, updated_at = ? WHERE id = ?',
            p.meta.name, p.meta.description, p.meta.category, p.meta.visible_groups, p.meta.sort, p.meta.active, t, id);
        }
        const v = saveDraft(app, id, p.def!, ctx.user!.id, 'Aus Datei übernommen');
        if (p.id && s.require_approval === 1) {
          app.db.run('UPDATE form_versions SET meta = ? WHERE id = ?', JSON.stringify({ name: p.meta.name, description: p.meta.description, visible_groups: p.meta.visible_groups, active: p.meta.active }), v.id);
        }
        if (publish) {
          if (s.require_approval === 1) app.db.run("UPDATE form_versions SET status = 'pending', submitted_by = ? WHERE id = ?", ctx.user!.id, v.id);
          else { app.db.run('UPDATE form_versions SET submitted_by = ? WHERE id = ?', ctx.user!.id, v.id); publishVersion(app, v, null); }
        }
        audit(app.db, actor(ctx), { action: p.action === 'create' ? 'form.created' : 'form.draft_saved', targetType: 'form', targetId: id, systemId: s.id, details: { slug: p.slug, quelle: 'Datei', veroeffentlicht: publish } });
        if (publish) audit(app.db, actor(ctx), { action: s.require_approval === 1 ? 'form.submitted_for_approval' : 'form.published', targetType: 'form', targetId: id, systemId: s.id, details: { version: v.version, quelle: 'Datei' } });
      }
      for (const tp of templates) {
        const ex = app.db.get<{ id: string }>('SELECT id FROM templates WHERE system_id = ? AND kind = ? AND name = ?', s.id, tp.kind, tp.name);
        if (ex) app.db.run('UPDATE templates SET content = ?, updated_at = ?, updated_by = ? WHERE id = ?', tp.content, t, ctx.user!.id, ex.id);
        else app.db.run('INSERT INTO templates (id, system_id, kind, name, content, created_at, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', uuid(), s.id, tp.kind, tp.name, tp.content, t, t, ctx.user!.id);
        audit(app.db, actor(ctx), { action: ex ? 'template.updated' : 'template.created', targetType: 'template', targetId: ex?.id ?? null, systemId: s.id, details: { art: tp.kind, name: tp.name, quelle: 'Datei' } });
      }
    });
    return { imported: summary };
  });

  router.post('/api/admin/systems/:systemId/forms/:formId/versions/:versionId/approve', admin('form.approve'), (ctx: AppCtx) => {
    const f = formOr404(ctx.params.systemId, ctx.params.formId);
    const v = app.db.get<FormVersionRow>("SELECT * FROM form_versions WHERE id = ? AND form_id = ? AND status = 'pending'", ctx.params.versionId, f.id);
    if (!v) throw new HttpError(404, 'Keine wartende Version', 'not_found');
    if (v.submitted_by === ctx.user!.id || v.created_by === ctx.user!.id) throw new HttpError(403, 'Vier-Augen-Prinzip: Freigeben muss eine andere Person', 'four_eyes');
    publishVersion(app, v, ctx.user!.id);
    audit(app.db, actor(ctx), { action: 'form.approved', targetType: 'form', targetId: f.id, systemId: f.system_id, details: { version: v.version } });
    return { status: 'published' };
  });

  router.post('/api/admin/systems/:systemId/forms/:formId/versions/:versionId/reject', admin('form.approve'), (ctx: AppCtx) => {
    const f = formOr404(ctx.params.systemId, ctx.params.formId);
    const v = app.db.get<FormVersionRow>("SELECT * FROM form_versions WHERE id = ? AND form_id = ? AND status = 'pending'", ctx.params.versionId, f.id);
    if (!v) throw new HttpError(404, 'Keine wartende Version', 'not_found');
    app.db.run("UPDATE form_versions SET status = 'draft', submitted_by = NULL WHERE id = ?", v.id);
    audit(app.db, actor(ctx), { action: 'form.rejected', targetType: 'form', targetId: f.id, systemId: f.system_id, details: { version: v.version, grund: str(ctx.body as Body, 'reason', 300) } });
    return { status: 'draft' };
  });

  router.post('/api/admin/systems/:systemId/forms/:formId/versions/:versionId/restore', admin('form.edit'), (ctx: AppCtx) => {
    const s = sysOr404(ctx.params.systemId);
    const f = formOr404(s.id, ctx.params.formId);
    const v = app.db.get<FormVersionRow>('SELECT * FROM form_versions WHERE id = ? AND form_id = ?', ctx.params.versionId, f.id);
    if (!v) throw new HttpError(404, 'Version nicht gefunden', 'not_found');
    let draft: FormVersionRow;
    try { draft = saveDraft(app, f.id, parseJson<FormDefinition>(v.definition, emptyDefinition()), ctx.user!.id, `Wiederhergestellt aus Version ${v.version}`); } catch (err) { throw new HttpError(409, (err as Error).message, 'conflict'); }
    audit(app.db, actor(ctx), { action: 'form.restored', targetType: 'form', targetId: f.id, systemId: s.id, details: { from: v.version, to: draft.version } });
    return { version: versionInfo(draft) };
  });

  router.post('/api/admin/systems/:systemId/forms/:formId/copy', admin('form.edit'), (ctx: AppCtx) => {
    const s = sysOr404(ctx.params.systemId);
    const f = formOr404(s.id, ctx.params.formId);
    const target = sysOr404(str(ctx.body as Body, 'targetSystemId', 40, true));
    if (!can(ctx.user, 'form.edit', target.id)) throw new HttpError(403, 'Keine Berechtigung für das Ziel-System', 'forbidden');
    let newSlug = f.slug;
    for (let i = 2; app.db.get('SELECT 1 FROM forms WHERE system_id = ? AND slug = ?', target.id, newSlug); i++) newSlug = `${f.slug}-${i}`.slice(0, 48);
    const src = latestVersion(app, f.id);
    const def = parseJson<FormDefinition>(src?.definition, emptyDefinition());
    // Zammad-Felder des Quellsystems passen evtl. nicht zum Ziel – sie bleiben, werden aber beim Speichern geprüft.
    const id = uuid();
    const t = Date.now();
    app.db.tx(() => {
      app.db.run('INSERT INTO forms (id, system_id, slug, name, description, category, visible_groups, sort, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        id, target.id, newSlug, f.name, f.description, f.category, f.visible_groups, f.sort, f.active, t, t);
      saveDraft(app, id, def, ctx.user!.id, `Kopie aus ${s.name}`);
      audit(app.db, actor(ctx), { action: 'form.copied', targetType: 'form', targetId: id, systemId: target.id, details: { from: f.id, fromSystem: s.id } });
    });
    return { created: true, form: formPublic(getForm(app, id)!) };
  });

  // ---------------------------------------------------------------- Vorlagen
  router.get('/api/admin/systems/:systemId/templates', admin(['template.edit', 'form.edit']), (ctx: AppCtx) => {
    sysOr404(ctx.params.systemId);
    return { templates: app.db.all('SELECT id, kind, name, content, updated_at AS updatedAt FROM templates WHERE system_id = ? ORDER BY kind, name', ctx.params.systemId) };
  });

  function readTemplate(b: Body) {
    const kind = str(b, 'kind', 20, true);
    if (!['title', 'body', 'success'].includes(kind)) throw new HttpError(422, 'Art ungültig', 'validation');
    const content = str(b, 'content', kind === 'body' ? 20000 : 1000, true);
    if (kind === 'body') {
      const problems = templateHtmlProblems(content);
      if (problems.length) throw new HttpError(422, `Text-Vorlage: ${problems.join('; ')}`, 'validation', problems);
    }
    return { kind, name: str(b, 'name', 120, true), content };
  }

  router.post('/api/admin/systems/:systemId/templates', admin('template.edit'), (ctx: AppCtx) => {
    const s = sysOr404(ctx.params.systemId);
    const v = readTemplate(ctx.body as Body);
    const id = uuid();
    app.db.run('INSERT INTO templates (id, system_id, kind, name, content, created_at, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', id, s.id, v.kind, v.name, v.content, Date.now(), Date.now(), ctx.user!.id);
    audit(app.db, actor(ctx), { action: 'template.created', targetType: 'template', targetId: id, systemId: s.id, details: v });
    return { created: true, id };
  });

  router.put('/api/admin/systems/:systemId/templates/:templateId', admin('template.edit'), (ctx: AppCtx) => {
    const before = app.db.get<Record<string, unknown>>('SELECT kind, name, content FROM templates WHERE id = ? AND system_id = ?', ctx.params.templateId, ctx.params.systemId);
    if (!before) throw new HttpError(404, 'Vorlage nicht gefunden', 'not_found');
    const v = readTemplate(ctx.body as Body);
    app.db.run('UPDATE templates SET kind = ?, name = ?, content = ?, updated_at = ?, updated_by = ? WHERE id = ?', v.kind, v.name, v.content, Date.now(), ctx.user!.id, ctx.params.templateId);
    audit(app.db, actor(ctx), { action: 'template.updated', targetType: 'template', targetId: ctx.params.templateId, systemId: ctx.params.systemId, details: diff(before, v) });
    return { ok: true };
  });

  router.delete('/api/admin/systems/:systemId/templates/:templateId', admin('template.edit'), (ctx: AppCtx) => {
    const before = app.db.get<Record<string, unknown>>('SELECT kind, name, content FROM templates WHERE id = ? AND system_id = ?', ctx.params.templateId, ctx.params.systemId);
    if (!before) throw new HttpError(404, 'Vorlage nicht gefunden', 'not_found');
    app.db.run('DELETE FROM templates WHERE id = ?', ctx.params.templateId);
    audit(app.db, actor(ctx), { action: 'template.deleted', targetType: 'template', targetId: ctx.params.templateId, systemId: ctx.params.systemId, details: before });
    return { ok: true };
  });

  // ---------------------------------------------------------------- Übersichten
  router.get('/api/admin/systems/:systemId/overviews', admin('overview.edit'), (ctx: AppCtx) => {
    sysOr404(ctx.params.systemId);
    return {
      overviews: app.db.all<Record<string, unknown>>('SELECT * FROM overviews WHERE system_id = ? ORDER BY sort, name', ctx.params.systemId).map((o) => ({
        id: o.id, name: o.name, stateFilter: o.state_filter, columns: parseJson<string[]>(o.columns, []), sortBy: o.sort_by, sortDir: o.sort_dir, sort: o.sort,
      })),
    };
  });

  function readOverview(b: Body) {
    const stateFilter = str(b, 'stateFilter', 10, true);
    if (!['open', 'closed', 'all'].includes(stateFilter)) throw new HttpError(422, 'Filter ungültig', 'validation');
    const columns = stringList(b, 'columns', 10, 20);
    if (!columns.length || columns.some((c) => !(OVERVIEW_COLUMNS as readonly string[]).includes(c))) throw new HttpError(422, 'Spalten ungültig', 'validation');
    const sortBy = str(b, 'sortBy', 20) || 'updated_at';
    if (!(OVERVIEW_COLUMNS as readonly string[]).includes(sortBy)) throw new HttpError(422, 'Sortierung ungültig', 'validation');
    const sortDir = str(b, 'sortDir', 4) || 'desc';
    if (!['asc', 'desc'].includes(sortDir)) throw new HttpError(422, 'Sortierrichtung ungültig', 'validation');
    return { name: str(b, 'name', 80, true), stateFilter, columns, sortBy, sortDir, sort: int(b, 'sort', 0) };
  }

  router.post('/api/admin/systems/:systemId/overviews', admin('overview.edit'), (ctx: AppCtx) => {
    const s = sysOr404(ctx.params.systemId);
    const v = readOverview(ctx.body as Body);
    const id = uuid();
    app.db.run('INSERT INTO overviews (id, system_id, name, state_filter, columns, sort_by, sort_dir, sort, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id, s.id, v.name, v.stateFilter, JSON.stringify(v.columns), v.sortBy, v.sortDir, v.sort, Date.now(), Date.now());
    audit(app.db, actor(ctx), { action: 'overview.created', targetType: 'overview', targetId: id, systemId: s.id, details: v });
    return { created: true, id };
  });

  router.put('/api/admin/systems/:systemId/overviews/:overviewId', admin('overview.edit'), (ctx: AppCtx) => {
    const before = app.db.get<Record<string, unknown>>('SELECT * FROM overviews WHERE id = ? AND system_id = ?', ctx.params.overviewId, ctx.params.systemId);
    if (!before) throw new HttpError(404, 'Übersicht nicht gefunden', 'not_found');
    const v = readOverview(ctx.body as Body);
    app.db.run('UPDATE overviews SET name = ?, state_filter = ?, columns = ?, sort_by = ?, sort_dir = ?, sort = ?, updated_at = ? WHERE id = ?',
      v.name, v.stateFilter, JSON.stringify(v.columns), v.sortBy, v.sortDir, v.sort, Date.now(), ctx.params.overviewId);
    audit(app.db, actor(ctx), { action: 'overview.updated', targetType: 'overview', targetId: ctx.params.overviewId, systemId: ctx.params.systemId, details: diff(before, { ...before, ...v }) });
    return { ok: true };
  });

  router.delete('/api/admin/systems/:systemId/overviews/:overviewId', admin('overview.edit'), (ctx: AppCtx) => {
    const r = app.db.run('DELETE FROM overviews WHERE id = ? AND system_id = ?', ctx.params.overviewId, ctx.params.systemId);
    if (!r.changes) throw new HttpError(404, 'Übersicht nicht gefunden', 'not_found');
    audit(app.db, actor(ctx), { action: 'overview.deleted', targetType: 'overview', targetId: ctx.params.overviewId, systemId: ctx.params.systemId });
    return { ok: true };
  });

  // ---------------------------------------------------------------- Branding
  router.get('/api/admin/systems/:systemId/branding', admin(['branding.edit', 'form.approve']), (ctx: AppCtx) => {
    const s = sysOr404(ctx.params.systemId);
    const versions = app.db.all<{ id: string; version: number; status: string; data: string; created_by: string | null; submitted_by: string | null; created_at: number }>(
      'SELECT * FROM branding_versions WHERE system_id = ? ORDER BY version DESC LIMIT 30', s.id,
    );
    const latest = versions[0];
    const current: Branding = latest ? { ...DEFAULT_BRANDING, ...parseJson<Partial<Branding>>(latest.data, {}) } : publishedBranding(app, s.id);
    return {
      published: publishedBranding(app, s.id),
      latest: latest ? { id: latest.id, version: latest.version, status: latest.status, branding: current, createdBy: latest.created_by, submittedBy: latest.submitted_by } : null,
      warnings: contrastWarnings(current),
      versions: versions.map((v) => ({ id: v.id, version: v.version, status: v.status, createdAt: v.created_at })),
    };
  });

  router.put('/api/admin/systems/:systemId/branding/draft', admin('branding.edit'), (ctx: AppCtx) => {
    const s = sysOr404(ctx.params.systemId);
    const { branding, errors } = validateBranding((ctx.body as Body).branding);
    if (!branding) throw new HttpError(422, errors.join('; '), 'validation', errors);
    for (const id of [branding.logoLightId, branding.logoDarkId, branding.faviconId]) {
      if (id && !app.db.get('SELECT 1 FROM assets WHERE id = ?', id)) throw new HttpError(422, 'Logo nicht gefunden', 'validation');
    }
    const latest = app.db.get<{ id: string; version: number; status: string }>('SELECT id, version, status FROM branding_versions WHERE system_id = ? ORDER BY version DESC LIMIT 1', s.id);
    if (latest?.status === 'pending') throw new HttpError(409, 'Es wartet bereits eine Version auf Freigabe', 'conflict');
    if (latest?.status === 'draft') {
      app.db.run('UPDATE branding_versions SET data = ?, created_by = ?, created_at = ? WHERE id = ?', JSON.stringify(branding), ctx.user!.id, Date.now(), latest.id);
    } else {
      app.db.run("INSERT INTO branding_versions (id, system_id, version, data, status, created_by, created_at) VALUES (?, ?, ?, ?, 'draft', ?, ?)", uuid(), s.id, (latest?.version ?? 0) + 1, JSON.stringify(branding), ctx.user!.id, Date.now());
    }
    audit(app.db, actor(ctx), { action: 'branding.draft_saved', targetType: 'branding', targetId: s.id, systemId: s.id, details: diff(publishedBranding(app, s.id) as any, branding as any) });
    return { warnings: contrastWarnings(branding) };
  });

  function publishBranding(systemId: string, versionId: string, approver: string | null) {
    app.db.tx(() => {
      app.db.run("UPDATE branding_versions SET status = 'archived' WHERE system_id = ? AND status = 'published'", systemId);
      app.db.run("UPDATE branding_versions SET status = 'published', approved_by = ?, published_at = ? WHERE id = ?", approver, Date.now(), versionId);
    });
  }

  router.post('/api/admin/systems/:systemId/branding/publish', admin('branding.edit'), (ctx: AppCtx) => {
    const s = sysOr404(ctx.params.systemId);
    const v = app.db.get<{ id: string; version: number }>("SELECT id, version FROM branding_versions WHERE system_id = ? AND status = 'draft' ORDER BY version DESC LIMIT 1", s.id);
    if (!v) throw new HttpError(409, 'Kein Entwurf vorhanden', 'conflict');
    if (s.require_approval === 1) {
      app.db.run("UPDATE branding_versions SET status = 'pending', submitted_by = ? WHERE id = ?", ctx.user!.id, v.id);
      audit(app.db, actor(ctx), { action: 'branding.submitted_for_approval', targetType: 'branding', targetId: s.id, systemId: s.id, details: { version: v.version } });
      return { status: 'pending' };
    }
    app.db.run('UPDATE branding_versions SET submitted_by = ? WHERE id = ?', ctx.user!.id, v.id);
    publishBranding(s.id, v.id, null);
    audit(app.db, actor(ctx), { action: 'branding.published', targetType: 'branding', targetId: s.id, systemId: s.id, details: { version: v.version } });
    return { status: 'published' };
  });

  router.post('/api/admin/systems/:systemId/branding/versions/:versionId/approve', admin('form.approve'), (ctx: AppCtx) => {
    const v = app.db.get<{ id: string; version: number; submitted_by: string | null; created_by: string | null }>("SELECT * FROM branding_versions WHERE id = ? AND system_id = ? AND status = 'pending'", ctx.params.versionId, ctx.params.systemId);
    if (!v) throw new HttpError(404, 'Keine wartende Version', 'not_found');
    if (v.submitted_by === ctx.user!.id || v.created_by === ctx.user!.id) throw new HttpError(403, 'Vier-Augen-Prinzip: Freigeben muss eine andere Person', 'four_eyes');
    publishBranding(ctx.params.systemId, v.id, ctx.user!.id);
    audit(app.db, actor(ctx), { action: 'branding.approved', targetType: 'branding', targetId: ctx.params.systemId, systemId: ctx.params.systemId, details: { version: v.version } });
    return { status: 'published' };
  });

  router.post('/api/admin/systems/:systemId/branding/versions/:versionId/reject', admin('form.approve'), (ctx: AppCtx) => {
    const r = app.db.run("UPDATE branding_versions SET status = 'draft', submitted_by = NULL WHERE id = ? AND system_id = ? AND status = 'pending'", ctx.params.versionId, ctx.params.systemId);
    if (!r.changes) throw new HttpError(404, 'Keine wartende Version', 'not_found');
    audit(app.db, actor(ctx), { action: 'branding.rejected', targetType: 'branding', targetId: ctx.params.systemId, systemId: ctx.params.systemId });
    return { status: 'draft' };
  });

  function storeAsset(ctx: AppCtx): { id: string } {
    const b = ctx.body as Body;
    const kind = str(b, 'kind', 10, true);
    if (kind !== 'logo' && kind !== 'favicon') throw new HttpError(422, 'Art ungültig', 'validation');
    const { mime, data } = checkLogo(decodeBase64Strict(b.data), kind);
    const hash = sha256(data);
    const existing = app.db.get<{ id: string }>('SELECT id FROM assets WHERE sha256 = ? AND kind = ?', hash, kind);
    if (existing) return existing;
    const id = uuid();
    app.db.run('INSERT INTO assets (id, kind, mime, size, sha256, data, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', id, kind, mime, data.length, hash, data, ctx.user!.id, Date.now());
    audit(app.db, actor(ctx), { action: 'asset.uploaded', targetType: 'asset', targetId: id, systemId: ctx.params.systemId ?? null, details: { kind, mime, size: data.length } });
    return { id };
  }

  router.post('/api/admin/systems/:systemId/assets', admin('branding.edit', { bodyLimit: 2 * 1024 * 1024 }), (ctx: AppCtx) => {
    sysOr404(ctx.params.systemId);
    return { created: true, ...storeAsset(ctx) };
  });

  // Branding der Anmeldeseite (global)
  router.get('/api/admin/settings/branding', admin('settings.manage'), () => ({ branding: globalBranding(app), warnings: contrastWarnings(globalBranding(app)) }));
  router.put('/api/admin/settings/branding', admin('settings.manage'), (ctx: AppCtx) => {
    const { branding, errors } = validateBranding((ctx.body as Body).branding);
    if (!branding) throw new HttpError(422, errors.join('; '), 'validation', errors);
    const before = globalBranding(app);
    app.db.run("INSERT INTO settings (key, value) VALUES ('branding.global', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", JSON.stringify(branding));
    audit(app.db, actor(ctx), { action: 'settings.branding', details: diff(before as any, branding as any) });
    return { warnings: contrastWarnings(branding) };
  });
  router.post('/api/admin/assets', admin('settings.manage', { bodyLimit: 2 * 1024 * 1024 }), (ctx: AppCtx) => ({ created: true, ...storeAsset(ctx) }));

  // ---------------------------------------------------------------- Rollen
  router.get('/api/admin/roles', admin('role.manage'), () => {
    const roles = app.db.all<{ id: string; name: string; description: string; permissions: string; builtin: number }>('SELECT * FROM roles ORDER BY builtin DESC, name');
    const assignments = app.db.all<{ id: string; role_id: string; subject_type: string; subject_value: string; system_id: string | null; created_at: number }>('SELECT * FROM role_assignments ORDER BY created_at');
    const users = new Map(app.db.all<{ id: string; display_name: string; username: string | null; email: string | null }>('SELECT id, display_name, username, email FROM users').map((u) => [u.id, u]));
    const systems = new Map(listSystems(app).map((s) => [s.id, s.name]));
    return {
      roles: roles.map((r) => ({ id: r.id, name: r.name, description: r.description, permissions: parseJson<string[]>(r.permissions, []), builtin: r.builtin === 1 })),
      assignments: assignments.map((a) => {
        const u = a.subject_type === 'user' ? users.get(a.subject_value) : undefined;
        return {
          id: a.id, roleId: a.role_id, subjectType: a.subject_type, subjectValue: a.subject_value,
          subjectLabel: a.subject_type === 'all' ? 'Alle angemeldeten Benutzer' : u ? `${u.display_name}${u.username ? ` (${u.username})` : u.email ? ` (${u.email})` : ''}` : a.subject_value,
          systemId: a.system_id, systemName: a.system_id ? systems.get(a.system_id) ?? '?' : 'Alle Ticketsysteme', createdAt: a.created_at,
        };
      }),
    };
  });

  function readRole(b: Body) {
    const permissions = stringList(b, 'permissions', 50, 40);
    if (permissions.some((p) => p !== '*' && !PERMISSION_KEYS.includes(p))) throw new HttpError(422, 'Unbekanntes Recht', 'validation');
    return { name: str(b, 'name', 80, true), description: str(b, 'description', 300), permissions };
  }

  router.post('/api/admin/roles', admin('role.manage', { stepup: true }), (ctx: AppCtx) => {
    const v = readRole(ctx.body as Body);
    assertCoversRole(ctx, v.permissions, null);
    if (app.db.get('SELECT 1 FROM roles WHERE name = ?', v.name)) throw new HttpError(409, 'Name schon vergeben', 'conflict');
    const id = uuid();
    app.db.run('INSERT INTO roles (id, name, description, permissions, builtin) VALUES (?, ?, ?, ?, 0)', id, v.name, v.description, JSON.stringify(v.permissions));
    audit(app.db, actor(ctx), { action: 'role.created', targetType: 'role', targetId: id, details: v });
    return { created: true, id };
  });

  router.put('/api/admin/roles/:roleId', admin('role.manage', { stepup: true }), (ctx: AppCtx) => {
    const before = app.db.get<{ name: string; description: string; permissions: string; builtin: number }>('SELECT * FROM roles WHERE id = ?', ctx.params.roleId);
    if (!before) throw new HttpError(404, 'Rolle nicht gefunden', 'not_found');
    if (before.builtin) throw new HttpError(409, 'Eingebaute Rollen können nicht geändert werden – bitte eine eigene Rolle anlegen', 'builtin');
    const v = readRole(ctx.body as Body);
    assertCoversRole(ctx, parseJson<string[]>(before.permissions, []), null);
    assertCoversRole(ctx, v.permissions, null);
    app.db.run('UPDATE roles SET name = ?, description = ?, permissions = ? WHERE id = ?', v.name, v.description, JSON.stringify(v.permissions), ctx.params.roleId);
    audit(app.db, actor(ctx), { action: 'role.updated', targetType: 'role', targetId: ctx.params.roleId, details: diff({ ...before, permissions: parseJson(before.permissions, []) }, v) });
    return { ok: true };
  });

  router.delete('/api/admin/roles/:roleId', admin('role.manage', { stepup: true }), (ctx: AppCtx) => {
    const before = app.db.get<{ name: string; builtin: number; permissions: string }>('SELECT * FROM roles WHERE id = ?', ctx.params.roleId);
    if (!before) throw new HttpError(404, 'Rolle nicht gefunden', 'not_found');
    if (before.builtin) throw new HttpError(409, 'Eingebaute Rollen können nicht gelöscht werden', 'builtin');
    assertCoversRole(ctx, parseJson<string[]>(before.permissions, []), null);
    app.db.run('DELETE FROM roles WHERE id = ?', ctx.params.roleId);
    audit(app.db, actor(ctx), { action: 'role.deleted', targetType: 'role', targetId: ctx.params.roleId, details: { name: before.name } });
    return { ok: true };
  });

  function superAdminAssignments(): number {
    return app.db.get<{ n: number }>("SELECT COUNT(*) n FROM role_assignments a JOIN roles r ON r.id = a.role_id WHERE r.name = 'Super-Admin' AND a.system_id IS NULL AND a.subject_type IN ('user', 'group')")!.n;
  }

  router.post('/api/admin/role-assignments', admin('role.manage', { stepup: true }), (ctx: AppCtx) => {
    const b = ctx.body as Body;
    const role = app.db.get<{ id: string; name: string; permissions: string }>('SELECT * FROM roles WHERE id = ?', str(b, 'roleId', 40, true));
    if (!role) throw new HttpError(404, 'Rolle nicht gefunden', 'not_found');
    const subjectType = str(b, 'subjectType', 10, true);
    if (!['user', 'group', 'all'].includes(subjectType)) throw new HttpError(422, 'Art ungültig', 'validation');
    let subjectValue = subjectType === 'all' ? '' : str(b, 'subjectValue', 200, true);
    if (subjectType === 'user') {
      // Benutzer per ID, Benutzername oder E-Mail
      const matches = app.db.all<{ id: string }>('SELECT id FROM users WHERE id = ? OR username = ? OR email = ?', subjectValue, subjectValue, subjectValue.toLowerCase());
      // Mehrdeutig (z. B. lokales Konto und Microsoft-Konto mit derselben E-Mail): lieber ablehnen als das falsche Konto berechtigen
      if (matches.length > 1) throw new HttpError(409, 'Mehrere Konten passen – bitte den Benutzernamen oder die ID angeben', 'ambiguous');
      const u = matches[0];
      if (!u) throw new HttpError(422, 'Benutzer nicht gefunden – Entra-Benutzer erscheinen nach ihrer ersten Anmeldung. Alternativ eine Gruppe zuordnen.', 'validation');
      subjectValue = u.id;
    }
    const systemId = b.systemId ? str(b, 'systemId', 40) : null;
    if (systemId) sysOr404(systemId);
    const perms = parseJson<string[]>(role.permissions, []);
    assertCoversRole(ctx, perms, systemId);
    if (subjectType === 'all' && perms.some((p) => p === '*' || ADMIN_PERMISSIONS.includes(p))) throw new HttpError(422, 'Admin-Rollen können nicht „allen“ zugeordnet werden', 'validation');
    if (systemId && perms.length && perms.every((p) => GLOBAL_PERMISSIONS.includes(p))) throw new HttpError(422, 'Diese Rolle enthält nur globale Rechte und wirkt nicht pro Ticketsystem', 'validation');
    const id = uuid();
    try {
      app.db.run('INSERT INTO role_assignments (id, role_id, subject_type, subject_value, system_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', id, role.id, subjectType, subjectValue, systemId, ctx.user!.id, Date.now());
    } catch {
      throw new HttpError(409, 'Diese Zuordnung gibt es schon', 'conflict');
    }
    audit(app.db, actor(ctx), { action: 'role.assigned', targetType: 'role_assignment', targetId: id, systemId, details: { rolle: role.name, subjectType, subjectValue } });
    return { created: true, id };
  });

  router.delete('/api/admin/role-assignments/:assignmentId', admin('role.manage', { stepup: true }), (ctx: AppCtx) => {
    const a = app.db.get<{ id: string; role_id: string; subject_type: string; subject_value: string; system_id: string | null; name: string; permissions: string }>(
      'SELECT a.*, r.name, r.permissions FROM role_assignments a JOIN roles r ON r.id = a.role_id WHERE a.id = ?', ctx.params.assignmentId,
    );
    if (!a) throw new HttpError(404, 'Zuordnung nicht gefunden', 'not_found');
    assertCoversRole(ctx, parseJson<string[]>(a.permissions, []), a.system_id);
    if (a.name === 'Super-Admin' && a.system_id === null && a.subject_type !== 'all' && superAdminAssignments() <= 1) {
      throw new HttpError(409, 'Die letzte Super-Admin-Zuordnung kann nicht entfernt werden (sonst sperrt sich das Portal aus)', 'last_admin');
    }
    app.db.run('DELETE FROM role_assignments WHERE id = ?', a.id);
    audit(app.db, actor(ctx), { action: 'role.unassigned', targetType: 'role_assignment', targetId: a.id, systemId: a.system_id, details: { rolle: a.name, subjectType: a.subject_type, subjectValue: a.subject_value } });
    return { ok: true };
  });

  // ---------------------------------------------------------------- Benutzer
  router.get('/api/admin/users', admin('user.manage'), (ctx: AppCtx) => {
    const q = (ctx.query.get('q') ?? '').trim().slice(0, 100);
    const like = `%${q.replace(/[%_\\]/g, (c) => '\\' + c)}%`;
    const rows = q
      ? app.db.all<UserRow>("SELECT * FROM users WHERE display_name LIKE ? ESCAPE '\\' OR username LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\' ORDER BY display_name LIMIT 200", like, like, like)
      : app.db.all<UserRow>('SELECT * FROM users ORDER BY kind DESC, display_name LIMIT 200');
    return { users: rows.map(publicUser) };
  });

  router.post('/api/admin/users', admin('user.manage', { stepup: true }), async (ctx: AppCtx) => {
    const b = ctx.body as Body;
    const roleName = str(b, 'role', 80) || 'Benutzer';
    const roleRow = app.db.get<{ permissions: string }>('SELECT permissions FROM roles WHERE name = ?', roleName);
    if (roleName !== 'Benutzer' && !roleRow) throw new HttpError(422, 'Rolle unbekannt', 'validation');
    // Ein neues Konto mit einer Rolle anlegen ist eine Rechtevergabe: nur bis zu den eigenen Rechten
    if (roleName !== 'Benutzer' && !canAnywhere(ctx.user, 'role.manage')) throw new HttpError(403, 'Konten mit Rolle anlegen erfordert zusätzlich das Recht „Rollen und Zuordnungen verwalten“', 'insufficient_rights');
    if (roleRow) assertCoversRole(ctx, parseJson<string[]>(roleRow.permissions, []), null);
    const email = str(b, 'email', 254);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(422, 'E-Mail ungültig', 'validation');
    if (email) assertMaySetLocalEmail(ctx);
    try {
      const created = await createLocalUser(app.db, {
        username: str(b, 'username', 64, true), displayName: str(b, 'displayName', 120), email, department: str(b, 'department', 120),
        roleName: roleName === 'Benutzer' ? undefined : roleName,
      });
      audit(app.db, actor(ctx), { action: 'user.created', targetType: 'user', targetId: created.id, details: { username: created.username, rolle: roleName } });
      // Das Passwort wird genau einmal angezeigt und nirgends gespeichert.
      return { created: true, id: created.id, username: created.username, password: created.password };
    } catch (err) {
      throw new HttpError(422, (err as Error).message, 'validation');
    }
  });

  router.put('/api/admin/users/:userId', admin('user.manage', { stepup: true }), (ctx: AppCtx) => {
    const u = getUser(app.db, ctx.params.userId);
    if (!u) throw new HttpError(404, 'Benutzer nicht gefunden', 'not_found');
    assertCoversUser(ctx, u);
    const b = ctx.body as Body;
    const disabled = bool(b, 'disabled', u.disabled === 1);
    if (disabled && u.id === ctx.user!.id) throw new HttpError(409, 'Das eigene Konto kann nicht deaktiviert werden', 'self');
    const next = {
      display_name: u.kind === 'local' ? str(b, 'displayName', 120) || u.display_name : u.display_name,
      email: u.kind === 'local' ? (b.email === undefined ? u.email : str(b, 'email', 254) || null) : u.email,
      department: b.department === undefined ? u.department : str(b, 'department', 120) || null,
      disabled: disabled ? 1 : 0,
    };
    if (next.email && next.email !== u.email && emailInUse(app.db, next.email, u.id)) throw new HttpError(409, 'Diese E-Mail-Adresse gehört schon einem anderen Konto', 'conflict');
    if (u.kind === 'local' && (next.email ?? null) !== (u.email ?? null) && next.email) assertMaySetLocalEmail(ctx);
    app.db.run('UPDATE users SET display_name = ?, email = ?, department = ?, disabled = ? WHERE id = ?', next.display_name, next.email, next.department, next.disabled, u.id);
    if (disabled) destroyUserSessions(app, u.id);
    audit(app.db, actor(ctx), { action: 'user.updated', targetType: 'user', targetId: u.id, details: diff(u as any, { ...u, ...next } as any) });
    return { user: publicUser(getUser(app.db, u.id)!) };
  });

  router.post('/api/admin/users/:userId/reset-password', admin('user.manage', { stepup: true }), async (ctx: AppCtx) => {
    const u = getUser(app.db, ctx.params.userId);
    if (!u || u.kind !== 'local') throw new HttpError(404, 'Lokales Konto nicht gefunden', 'not_found');
    // Passwort zurücksetzen = Konto übernehmen können. Nur bei Konten mit höchstens den eigenen Rechten.
    assertCoversUser(ctx, u);
    const resetTotp = bool(ctx.body as Body, 'resetTotp', false);
    const password = await resetLocalPassword(app.db, u.id, resetTotp);
    audit(app.db, actor(ctx), { action: 'user.password_reset', targetType: 'user', targetId: u.id, details: { totpZurueckgesetzt: resetTotp } });
    return { username: u.username, password };
  });

  router.post('/api/admin/users/:userId/unlock', admin('user.manage'), (ctx: AppCtx) => {
    const target = getUser(app.db, ctx.params.userId);
    if (target) assertCoversUser(ctx, target);
    const r = app.db.run('UPDATE users SET locked_until = NULL, failed_logins = 0, lock_count = 0 WHERE id = ?', ctx.params.userId);
    if (!r.changes) throw new HttpError(404, 'Benutzer nicht gefunden', 'not_found');
    audit(app.db, actor(ctx), { action: 'user.unlocked', targetType: 'user', targetId: ctx.params.userId });
    return { ok: true };
  });

  // ---------------------------------------------------------------- Anfragen (Zustellung)
  router.get('/api/admin/requests', admin(), (ctx: AppCtx) => {
    const allowed = systemsWith(ctx.user!, 'system.manage');
    if (allowed !== null && allowed.length === 0) throw new HttpError(403, 'Keine Berechtigung', 'forbidden');
    const status = ctx.query.get('status');
    const where: string[] = [];
    const params: string[] = [];
    if (status && ['awaiting_approval', 'queued', 'sending', 'delivered', 'failed', 'rejected', 'withdrawn', 'expired', 'cancelled'].includes(status)) { where.push('r.status = ?'); params.push(status); }
    if (allowed) { where.push(`r.system_id IN (${allowed.map(() => '?').join(',')})`); params.push(...allowed); }
    const rows = app.db.all(
      `SELECT r.id, r.system_id AS systemId, s.name AS systemName, r.title, r.status, r.attempts, r.last_error AS lastError, r.ticket_number AS ticketNumber,
              r.created_at AS createdAt, r.delivered_at AS deliveredAt, r.next_attempt_at AS nextAttemptAt, u.display_name AS userName
         FROM requests r JOIN ticket_systems s ON s.id = r.system_id JOIN users u ON u.id = r.user_id
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY r.created_at DESC LIMIT 200`,
      ...params,
    );
    return { requests: rows };
  });

  router.post('/api/admin/requests/:requestId/retry', admin(), (ctx: AppCtx) => {
    const r = app.db.get<{ system_id: string }>('SELECT system_id FROM requests WHERE id = ?', ctx.params.requestId);
    if (!r || !can(ctx.user, 'system.manage', r.system_id)) throw new HttpError(404, 'Anfrage nicht gefunden', 'not_found');
    if (!retryRequest(app, ctx.params.requestId)) throw new HttpError(409, 'Nur fehlgeschlagene Anfragen mit Inhalt können erneut gesendet werden', 'conflict');
    audit(app.db, actor(ctx), { action: 'request.retry', targetType: 'request', targetId: ctx.params.requestId, systemId: r.system_id });
    return { ok: true };
  });

  router.post('/api/admin/requests/:requestId/cancel', admin(), (ctx: AppCtx) => {
    const r = /^[0-9a-f-]{36}$/.test(ctx.params.requestId) ? app.db.get<{ system_id: string }>('SELECT system_id FROM requests WHERE id = ?', ctx.params.requestId) : undefined;
    if (!r || !can(ctx.user, 'system.manage', r.system_id)) throw new HttpError(404, 'Anfrage nicht gefunden', 'not_found');
    cancelRequest(app, ctx.user!, actor(ctx), ctx.params.requestId, (ctx.body as { reason?: unknown })?.reason);
    return { ok: true };
  });

  // ---------------------------------------------------------------- Export und Import der Ticketsysteme
  function requireGlobalSystemManage(ctx: AppCtx) {
    if (!can(ctx.user, 'system.manage', null)) throw new HttpError(403, 'Export und Import darf nur ein globaler Admin', 'forbidden');
  }
  const exportPassword = (b: Body): string | undefined => {
    const v = b?.password;
    if (v === undefined || v === null || v === '') return undefined;
    if (typeof v !== 'string' || v.length > 200) throw new HttpError(422, 'Passwort ungültig', 'validation', { password: 'ungültig' });
    return v;
  };

  router.post('/api/admin/transfer/export', admin('system.manage', { stepup: true }), async (ctx: AppCtx) => {
    requireGlobalSystemManage(ctx);
    const b = ctx.body as Body;
    const password = b.includeTokens === true ? exportPassword(b) : undefined;
    if (b.includeTokens === true && !password) throw new HttpError(422, 'Für die Zammad-Tokens ist ein Export-Passwort nötig', 'validation', { password: 'Pflichtfeld' });
    const file = await buildExport(app, password);
    audit(app.db, actor(ctx), { action: 'transfer.exported', targetType: 'portal', details: { systeme: file.systems.length, tokens: Boolean(password) } });
    return { file };
  });

  router.post('/api/admin/transfer/preview', admin('system.manage', { bodyLimit: 40 * 1024 * 1024 }), async (ctx: AppCtx) => {
    requireGlobalSystemManage(ctx);
    const b = ctx.body as Body;
    return { plan: summarizePlan(await planImport(app, b.file, exportPassword(b))) };
  });

  router.post('/api/admin/transfer/import', admin('system.manage', { stepup: true, bodyLimit: 40 * 1024 * 1024 }), async (ctx: AppCtx) => {
    requireGlobalSystemManage(ctx);
    const b = ctx.body as Body;
    if (b.confirm !== true) throw new HttpError(422, 'Bitte den Import bestätigen', 'validation');
    const plan = await planImport(app, b.file, exportPassword(b));
    return { imported: applyImport(app, plan, actor(ctx)) };
  });

  // ---------------------------------------------------------------- Audit-Log
  router.get('/api/admin/audit', admin(), (ctx: AppCtx) => {
    const allowed = systemsWith(ctx.user!, 'audit.read');
    if (allowed !== null && allowed.length === 0) throw new HttpError(403, 'Keine Berechtigung', 'forbidden');
    const where: string[] = [];
    const params: (string | number)[] = [];
    const before = Number(ctx.query.get('before') ?? 0);
    if (before > 0) { where.push('seq < ?'); params.push(before); }
    const action = ctx.query.get('action');
    if (action && /^[a-z_.]{1,60}$/.test(action)) { where.push('action LIKE ?'); params.push(action + '%'); }
    const sysFilter = ctx.query.get('systemId');
    if (sysFilter) { where.push('system_id = ?'); params.push(sysFilter); }
    if (allowed) { where.push(`system_id IN (${allowed.map(() => '?').join(',')})`); params.push(...allowed); }
    const limit = Math.min(Number(ctx.query.get('limit') ?? 100) || 100, 500);
    const rows = app.db.all<{ seq: number; at: number; actor_name: string | null; action: string; target_type: string | null; target_id: string | null; system_id: string | null; details: string | null; ip: string | null }>(
      `SELECT seq, at, actor_name, action, target_type, target_id, system_id, details, ip FROM audit_log ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY seq DESC LIMIT ?`,
      ...params, limit,
    );
    return { entries: rows.map((r) => ({ ...r, details: parseJson(r.details, null) })), global: allowed === null };
  });

  router.get('/api/admin/audit/verify', admin('audit.read'), (ctx: AppCtx) => {
    if (!can(ctx.user, 'audit.read', null)) throw new HttpError(403, 'Nur mit globalem Audit-Recht', 'forbidden');
    return verifyAuditChain(app.db);
  });

  router.get('/api/admin/audit/export', admin('audit.read'), (ctx: AppCtx) => {
    if (!can(ctx.user, 'audit.read', null)) throw new HttpError(403, 'Nur mit globalem Audit-Recht', 'forbidden');
    const esc = (v: unknown) => {
      let s = v === null || v === undefined ? '' : String(v);
      if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // Schutz vor CSV-Formel-Injection in Excel
      return `"${s.replace(/"/g, '""')}"`;
    };
    const lines = ['seq;zeit;person;aktion;ziel_typ;ziel_id;system;ip;details;hash'];
    for (const r of app.db.raw.prepare('SELECT * FROM audit_log ORDER BY seq').iterate() as Iterable<Record<string, unknown>>) {
      lines.push([r.seq, new Date(Number(r.at)).toISOString(), r.actor_name, r.action, r.target_type, r.target_id, r.system_id, r.ip, r.details, r.hash].map(esc).join(';'));
    }
    audit(app.db, actor(ctx), { action: 'audit.exported' });
    const body = '﻿' + lines.join('\r\n');
    ctx.res.statusCode = 200;
    ctx.res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    ctx.res.setHeader('Content-Disposition', `attachment; filename="audit-log-${new Date().toISOString().slice(0, 10)}.csv"`);
    ctx.res.setHeader('Cache-Control', 'no-store');
    ctx.res.end(body);
    ctx.responded = true;
  });

  // ---------------------------------------------------------------- Updates
  router.get('/api/admin/updates', admin(['update.read', 'update.install']), () => {
    const state = app.db.get<Record<string, unknown>>('SELECT * FROM update_state WHERE id = 1')!;
    const jobs = app.db.all('SELECT id, requested_by_name AS requestedBy, target_version AS targetVersion, status, log, created_at AS createdAt, started_at AS startedAt, finished_at AS finishedAt FROM update_jobs ORDER BY created_at DESC LIMIT 20');
    const seen = Number(state.updater_seen_at ?? 0);
    return {
      runningVersion: app.cfg.version,
      installMode: app.cfg.installMode,
      currentVersion: state.current_version ?? app.cfg.version,
      latestVersion: state.latest_version,
      available: parseJson<string[]>(state.available, []),
      changelog: state.changelog,
      channel: state.channel,
      checkedAt: state.checked_at,
      lastError: state.last_error,
      updaterOnline: Date.now() - seen < 5 * 60_000,
      jobs,
    };
  });

  router.post('/api/admin/updates/check', admin('update.install'), (ctx: AppCtx) => {
    app.db.run("INSERT INTO settings (key, value) VALUES ('update.check_requested', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", String(Date.now()));
    audit(app.db, actor(ctx), { action: 'update.check_requested' });
    return { ok: true };
  });

  router.post('/api/admin/updates/install', admin('update.install', { stepup: true }), (ctx: AppCtx) => {
    const version = str(ctx.body as Body, 'version', 40, true);
    const state = app.db.get<{ available: string }>('SELECT available FROM update_state WHERE id = 1')!;
    if (!parseJson<string[]>(state.available, []).includes(version)) throw new HttpError(422, 'Version ist nicht verfügbar', 'validation');
    if (app.db.get("SELECT 1 FROM update_jobs WHERE status IN ('requested','running')")) throw new HttpError(409, 'Es läuft bereits ein Update', 'conflict');
    const id = uuid();
    app.db.run("INSERT INTO update_jobs (id, requested_by, requested_by_name, target_version, status, created_at) VALUES (?, ?, ?, ?, 'requested', ?)", id, ctx.user!.id, ctx.user!.displayName, version, Date.now());
    audit(app.db, actor(ctx), { action: 'update.requested', targetType: 'update', targetId: id, details: { version } });
    return { created: true, id };
  });
}
