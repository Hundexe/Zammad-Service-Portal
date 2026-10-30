// Service-Status, Störungen, Wartungen und Probleme.
// Zammad bleibt führend für Tickets: Tickets zu Störungen und Problemen werden dort per Tag markiert
// (inc-0001, prb-0001). Das Portal hält nur die Statusinformation für die Mitarbeitenden und wer betroffen ist.
import type { App } from '../app.ts';
import { parseJson, uuid } from '../db/db.ts';
import { HttpError } from '../http/core.ts';
import { log } from '../log.ts';
import { getFeatures } from './features.ts';
import { notify } from './notifications.ts';
import { connectorFor, getSystem, listSystems, systemVisibleTo, type SystemRow } from './systems.ts';
import type { AuthUser } from './rbac.ts';
import { toAuthUser, type UserRow } from './users.ts';
import {
  INCIDENT_IMPACTS, INCIDENT_STATES, INCIDENT_STATE_LABEL, PROBLEM_STATES, SERVICE_STATUS_LABEL,
  incidentNumber, incidentTag, problemNumber, problemTag, worstStatus,
  type IncidentImpact, type IncidentState, type ProblemState, type ServiceStatus,
} from '../../shared/itsm.ts';

export interface ServiceRow { id: string; system_id: string; name: string; description: string; manual_status: ServiceStatus | null; manual_note: string; sort: number; created_at: number; updated_at: number }
export interface IncidentRow {
  id: string; number: number; system_id: string; title: string; impact: IncidentImpact; major: number; state: IncidentState; locations: string;
  started_at: number; resolved_at: number | null; zammad_ticket_id: number | null; zammad_ticket_number: string | null; problem_id: string | null;
  created_by: string | null; created_at: number; updated_at: number;
}
export interface MaintenanceRow { id: string; system_id: string; title: string; body: string; starts_at: number; ends_at: number; locations: string; cancelled: number; created_by: string | null; created_at: number; updated_at: number }
export interface ProblemRow {
  id: string; number: number; system_id: string; title: string; state: ProblemState; service_id: string | null; description: string; root_cause: string;
  workaround: string; public: number; owner: string; created_by: string | null; created_at: number; updated_at: number;
}

const LIMIT = { title: 200, text: 10_000, name: 120, note: 500 };
const inList = (n: number) => Array.from({ length: n }, () => '?').join(',');

// ------------------------------------------------------------------------------------------ Eingaben prüfen

type Body = Record<string, unknown>;
function text(b: Body, key: string, max: number, required = false): string {
  const v = b[key];
  if (v === undefined || v === null || v === '') { if (required) throw new HttpError(422, `„${key}“ fehlt`, 'validation', { [key]: 'Pflichtfeld' }); return ''; }
  if (typeof v !== 'string') throw new HttpError(422, `„${key}“ ungültig`, 'validation');
  const t = v.trim();
  if (required && !t) throw new HttpError(422, `„${key}“ fehlt`, 'validation', { [key]: 'Pflichtfeld' });
  if (t.length > max) throw new HttpError(422, `„${key}“ höchstens ${max} Zeichen`, 'validation', { [key]: `Höchstens ${max} Zeichen` });
  return t;
}
function time(b: Body, key: string, required = false): number | null {
  const v = b[key];
  if (v === undefined || v === null || v === '') { if (required) throw new HttpError(422, `„${key}“ fehlt`, 'validation', { [key]: 'Pflichtfeld' }); return null; }
  const n = typeof v === 'number' ? v : Date.parse(String(v));
  if (!Number.isFinite(n) || n < Date.UTC(2020, 0, 1) || n > Date.UTC(2100, 0, 1)) throw new HttpError(422, `„${key}“ ist kein gültiger Zeitpunkt`, 'validation', { [key]: 'Ungültiger Zeitpunkt' });
  return n;
}
function oneOf<T extends string>(b: Body, key: string, allowed: readonly T[], fallback?: T): T {
  const v = b[key];
  if ((v === undefined || v === null || v === '') && fallback !== undefined) return fallback;
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) throw new HttpError(422, `„${key}“ ungültig`, 'validation', { [key]: 'Ungültiger Wert' });
  return v as T;
}
function locations(app: App, b: Body): string[] {
  const v = b.locations;
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > 50) throw new HttpError(422, 'Standorte ungültig', 'validation');
  const allowed = new Set(getFeatures(app).locations);
  const list = [...new Set(v.map((x) => (typeof x === 'string' ? x.trim() : '')))];
  const bad = list.filter((x) => !allowed.has(x));
  if (bad.length) throw new HttpError(422, `Unbekannter Standort: ${bad.join(', ')} (Standorte unter Funktionen pflegen)`, 'validation');
  return list;
}
/** Service-IDs müssen zum selben Ticketsystem gehören */
function serviceIds(app: App, systemId: string, b: Body, key = 'serviceIds'): string[] {
  const v = b[key];
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > 100 || v.some((x) => typeof x !== 'string')) throw new HttpError(422, 'Services ungültig', 'validation');
  const ids = [...new Set(v as string[])];
  if (!ids.length) return [];
  const found = app.db.all<{ id: string }>(`SELECT id FROM services WHERE system_id = ? AND id IN (${inList(ids.length)})`, systemId, ...ids);
  if (found.length !== ids.length) throw new HttpError(422, 'Ein Service gehört nicht zu diesem Ticketsystem', 'validation');
  return ids;
}
function nextNumber(app: App, table: 'incidents' | 'problems'): number {
  return (app.db.get<{ n: number | null }>(`SELECT MAX(number) AS n FROM ${table}`)!.n ?? 0) + 1;
}

// ------------------------------------------------------------------------------------------ Services

export function servicesOf(app: App, systemIds: string[]): ServiceRow[] {
  if (!systemIds.length) return [];
  return app.db.all<ServiceRow>(`SELECT * FROM services WHERE system_id IN (${inList(systemIds.length)}) ORDER BY sort, name`, ...systemIds);
}

export function saveService(app: App, systemId: string, b: Body, existing?: ServiceRow): ServiceRow {
  const name = text(b, 'name', LIMIT.name, true);
  const description = text(b, 'description', 1000);
  const manual = b.manualStatus === null || b.manualStatus === '' || b.manualStatus === undefined ? null
    : oneOf(b, 'manualStatus', ['maintenance', 'degraded', 'partial_outage', 'major_outage'] as const);
  const note = text(b, 'manualNote', LIMIT.note);
  const sort = Number.isInteger(b.sort) ? Number(b.sort) : existing?.sort ?? 0;
  const t = Date.now();
  if (existing) {
    app.db.run('UPDATE services SET name = ?, description = ?, manual_status = ?, manual_note = ?, sort = ?, updated_at = ? WHERE id = ?', name, description, manual, manual ? note : '', sort, t, existing.id);
    return app.db.get<ServiceRow>('SELECT * FROM services WHERE id = ?', existing.id)!;
  }
  if (app.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM services WHERE system_id = ?', systemId)!.n >= 200) throw new HttpError(422, 'Höchstens 200 Services je Ticketsystem', 'validation');
  const id = uuid();
  app.db.run('INSERT INTO services (id, system_id, name, description, manual_status, manual_note, sort, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', id, systemId, name, description, manual, manual ? note : '', sort, t, t);
  return app.db.get<ServiceRow>('SELECT * FROM services WHERE id = ?', id)!;
}

/**
 * Services eines Formulars auflösen: IDs dieses Ticketsystems bleiben, Namen (aus Exportdateien) werden zu IDs,
 * Unbekanntes fällt weg (z. B. gelöschte Services oder Dateien aus einem anderen Portal).
 */
export function resolveFormServices(app: App, systemId: string, list: string[] | undefined): string[] | undefined {
  if (!list?.length) return undefined;
  const services = servicesOf(app, [systemId]);
  const out = new Set<string>();
  for (const x of list) {
    const hit = services.find((s) => s.id === x) ?? services.find((s) => s.name.toLowerCase() === String(x).toLowerCase());
    if (hit) out.add(hit.id);
  }
  return out.size ? [...out] : undefined;
}

// ------------------------------------------------------------------------------------------ Zustand

export interface ServiceState { status: ServiceStatus; note: string; incidents: string[]; maintenances: string[] }

/** Zustand je Service: schlimmster aus Handeinstellung, offenen Störungen und laufenden Wartungen. */
export function serviceStates(app: App, services: ServiceRow[], now = Date.now()): Map<string, ServiceState> {
  const out = new Map<string, ServiceState>();
  if (!services.length) return out;
  const f = getFeatures(app);
  const ids = services.map((s) => s.id);
  const inc = f.incidents ? app.db.all<{ service_id: string; id: string; impact: IncidentImpact }>(
    `SELECT s.service_id, i.id, i.impact FROM incident_services s JOIN incidents i ON i.id = s.incident_id WHERE i.state != 'resolved' AND i.started_at <= ? AND s.service_id IN (${inList(ids.length)})`, now, ...ids) : [];
  const mnt = f.maintenance ? app.db.all<{ service_id: string; id: string }>(
    `SELECT s.service_id, m.id FROM maintenance_services s JOIN maintenances m ON m.id = s.maintenance_id WHERE m.cancelled = 0 AND m.starts_at <= ? AND m.ends_at > ? AND s.service_id IN (${inList(ids.length)})`, now, now, ...ids) : [];
  for (const s of services) {
    const mine = inc.filter((x) => x.service_id === s.id);
    const maint = mnt.filter((x) => x.service_id === s.id);
    const list: ServiceStatus[] = [...mine.map((x) => x.impact), ...(maint.length ? ['maintenance' as const] : []), ...(s.manual_status ? [s.manual_status] : [])];
    out.set(s.id, { status: worstStatus(list), note: s.manual_status ? s.manual_note : '', incidents: mine.map((x) => x.id), maintenances: maint.map((x) => x.id) });
  }
  return out;
}

// ------------------------------------------------------------------------------------------ Störungen

export function getIncident(app: App, id: string): IncidentRow | undefined {
  return app.db.get<IncidentRow>('SELECT * FROM incidents WHERE id = ?', id);
}

function incidentServices(app: App, id: string): string[] {
  return app.db.all<{ service_id: string }>('SELECT service_id FROM incident_services WHERE incident_id = ?', id).map((r) => r.service_id);
}

/** Führendes Zammad-Ticket prüfen und mit dem Tag der Störung markieren (Fehler beim Taggen nur loggen). */
async function linkZammadTicket(app: App, sys: SystemRow, raw: unknown, tag: string): Promise<{ id: number; number: string } | null> {
  if (raw === undefined || raw === null || raw === '') return null;
  const number = String(raw).trim().replace(/^#/, '');
  if (!/^\d{1,20}$/.test(number)) throw new HttpError(422, 'Ticketnummer ungültig', 'validation', { zammadTicket: 'Nur Ziffern' });
  const t = await connectorFor(app, sys).findTicketByNumber(number);
  if (!t) throw new HttpError(422, `Ticket ${number} gibt es in ${sys.name} nicht`, 'validation', { zammadTicket: 'Nicht gefunden' });
  try { await connectorFor(app, sys).addTag(t.id, tag); } catch (err) { log.warn('Tag in Zammad nicht gesetzt', { system: sys.slug, ticket: t.number, tag, error: (err as Error).message }); }
  return { id: t.id, number: t.number };
}

export async function createIncident(app: App, sys: SystemRow, actor: AuthUser, b: Body): Promise<IncidentRow> {
  const title = text(b, 'title', LIMIT.title, true);
  const body = text(b, 'body', LIMIT.text, true);
  const impact = oneOf(b, 'impact', INCIDENT_IMPACTS);
  const state = oneOf(b, 'state', INCIDENT_STATES.filter((s) => s !== 'resolved'), 'investigating');
  const major = b.major === true ? 1 : 0;
  const services = serviceIds(app, sys.id, b);
  const locs = locations(app, b);
  const started = time(b, 'startedAt') ?? Date.now();
  const number = nextNumber(app, 'incidents');
  const ticket = await linkZammadTicket(app, sys, b.zammadTicket, incidentTag(number));
  const id = uuid();
  const t = Date.now();
  app.db.tx(() => {
    app.db.run(
      `INSERT INTO incidents (id, number, system_id, title, impact, major, state, locations, started_at, zammad_ticket_id, zammad_ticket_number, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, number, sys.id, title, impact, major, state, JSON.stringify(locs), started, ticket?.id ?? null, ticket?.number ?? null, actor.id, t, t,
    );
    for (const s of services) app.db.run('INSERT INTO incident_services (incident_id, service_id) VALUES (?, ?)', id, s);
    app.db.run('INSERT INTO incident_updates (id, incident_id, state, body, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)', uuid(), id, state, body, actor.id, t);
  });
  const row = getIncident(app, id)!;
  if (major && getFeatures(app).notifyAllOnMajor) notifyAllUsers(app, sys, `Störung: ${title}`, body, `/stoerungen/${id}`);
  return row;
}

export async function updateIncident(app: App, sys: SystemRow, inc: IncidentRow, b: Body): Promise<IncidentRow> {
  const title = b.title === undefined ? inc.title : text(b, 'title', LIMIT.title, true);
  const impact = b.impact === undefined ? inc.impact : oneOf(b, 'impact', INCIDENT_IMPACTS);
  const major = b.major === undefined ? inc.major : b.major === true ? 1 : 0;
  const locs = b.locations === undefined ? parseJson<string[]>(inc.locations, []) : locations(app, b);
  const started = b.startedAt === undefined ? inc.started_at : time(b, 'startedAt', true)!;
  const services = b.serviceIds === undefined ? null : serviceIds(app, sys.id, b);
  let problemId = inc.problem_id;
  if (b.problemId !== undefined) {
    problemId = b.problemId === null || b.problemId === '' ? null : String(b.problemId);
    if (problemId && !app.db.get('SELECT 1 FROM problems WHERE id = ? AND system_id = ?', problemId, sys.id)) throw new HttpError(422, 'Problem nicht gefunden', 'validation');
  }
  let ticket: { id: number; number: string } | null | undefined;
  if (b.zammadTicket !== undefined && String(b.zammadTicket ?? '') !== (inc.zammad_ticket_number ?? '')) ticket = await linkZammadTicket(app, sys, b.zammadTicket, incidentTag(inc.number));
  app.db.tx(() => {
    app.db.run('UPDATE incidents SET title = ?, impact = ?, major = ?, locations = ?, started_at = ?, problem_id = ?, updated_at = ? WHERE id = ?',
      title, impact, major, JSON.stringify(locs), started, problemId, Date.now(), inc.id);
    if (ticket !== undefined) app.db.run('UPDATE incidents SET zammad_ticket_id = ?, zammad_ticket_number = ? WHERE id = ?', ticket?.id ?? null, ticket?.number ?? null, inc.id);
    if (services) {
      app.db.run('DELETE FROM incident_services WHERE incident_id = ?', inc.id);
      for (const s of services) app.db.run('INSERT INTO incident_services (incident_id, service_id) VALUES (?, ?)', inc.id, s);
    }
  });
  return getIncident(app, inc.id)!;
}

/** Neues Update; benachrichtigt alle, die sich als betroffen gemeldet haben. */
export function addIncidentUpdate(app: App, inc: IncidentRow, actor: AuthUser, b: Body): IncidentRow {
  const state = oneOf(b, 'state', INCIDENT_STATES);
  const body = text(b, 'body', LIMIT.text, true);
  const t = Date.now();
  const resolvedAt = state === 'resolved' ? time(b, 'resolvedAt') ?? t : null;
  app.db.tx(() => {
    app.db.run('INSERT INTO incident_updates (id, incident_id, state, body, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)', uuid(), inc.id, state, body, actor.id, t);
    app.db.run('UPDATE incidents SET state = ?, resolved_at = ?, updated_at = ? WHERE id = ?', state, resolvedAt, t, inc.id);
  });
  const label = state === 'resolved' ? 'Behoben' : INCIDENT_STATE_LABEL[state];
  for (const r of app.db.all<{ user_id: string }>('SELECT user_id FROM incident_affected WHERE incident_id = ?', inc.id)) {
    notify(app, { to: { userId: r.user_id }, kind: 'incident.update', title: `${label}: ${inc.title}`, body, link: `/stoerungen/${inc.id}` });
  }
  return getIncident(app, inc.id)!;
}

/** „Ich bin auch betroffen“ – nur bei offenen Störungen in Ticketsystemen, die die Person sieht. */
export function setAffected(app: App, inc: IncidentRow, user: AuthUser, affected: boolean): number {
  if (inc.state === 'resolved') throw new HttpError(409, 'Die Störung ist schon behoben', 'conflict');
  if (affected) app.db.run('INSERT OR IGNORE INTO incident_affected (incident_id, user_id, created_at) VALUES (?, ?, ?)', inc.id, user.id, Date.now());
  else app.db.run('DELETE FROM incident_affected WHERE incident_id = ? AND user_id = ?', inc.id, user.id);
  return affectedCount(app, inc.id);
}

export function affectedCount(app: App, incidentId: string): number {
  return app.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM incident_affected WHERE incident_id = ?', incidentId)!.n;
}

/** Bei großen Störungen (wenn eingestellt): alle angemeldeten Benutzer, die das Ticketsystem sehen. */
function notifyAllUsers(app: App, sys: SystemRow, title: string, body: string, link: string): void {
  let n = 0;
  for (const row of app.db.all<UserRow>('SELECT * FROM users WHERE disabled = 0 AND last_login_at > ?', Date.now() - 90 * 86400_000)) {
    if (!systemVisibleTo(sys, toAuthUser(app.db, row))) continue;
    notify(app, { to: { userId: row.id }, kind: 'incident.major', title, body, link });
    if (++n >= 5000) break;
  }
  log.info('Große Störung gemeldet', { system: sys.slug, notified: n });
}

// ------------------------------------------------------------------------------------------ Wartungen

export function getMaintenance(app: App, id: string): MaintenanceRow | undefined {
  return app.db.get<MaintenanceRow>('SELECT * FROM maintenances WHERE id = ?', id);
}

export function saveMaintenance(app: App, sys: SystemRow, actor: AuthUser, b: Body, existing?: MaintenanceRow): MaintenanceRow {
  const title = text(b, 'title', LIMIT.title, true);
  const body = text(b, 'body', LIMIT.text);
  const starts = time(b, 'startsAt', true)!;
  const ends = time(b, 'endsAt', true)!;
  if (ends <= starts) throw new HttpError(422, 'Das Ende muss nach dem Beginn liegen', 'validation', { endsAt: 'Nach dem Beginn' });
  if (ends - starts > 30 * 86400_000) throw new HttpError(422, 'Eine Wartung dauert höchstens 30 Tage', 'validation', { endsAt: 'Höchstens 30 Tage' });
  const services = serviceIds(app, sys.id, b);
  const locs = locations(app, b);
  const t = Date.now();
  const id = existing?.id ?? uuid();
  app.db.tx(() => {
    if (existing) {
      app.db.run('UPDATE maintenances SET title = ?, body = ?, starts_at = ?, ends_at = ?, locations = ?, updated_at = ? WHERE id = ?', title, body, starts, ends, JSON.stringify(locs), t, id);
      app.db.run('DELETE FROM maintenance_services WHERE maintenance_id = ?', id);
    } else {
      app.db.run('INSERT INTO maintenances (id, system_id, title, body, starts_at, ends_at, locations, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        id, sys.id, title, body, starts, ends, JSON.stringify(locs), actor.id, t, t);
    }
    for (const s of services) app.db.run('INSERT INTO maintenance_services (maintenance_id, service_id) VALUES (?, ?)', id, s);
  });
  return getMaintenance(app, id)!;
}

// ------------------------------------------------------------------------------------------ Probleme

export function getProblem(app: App, id: string): ProblemRow | undefined {
  return app.db.get<ProblemRow>('SELECT * FROM problems WHERE id = ?', id);
}

export function saveProblem(app: App, sys: SystemRow, actor: AuthUser, b: Body, existing?: ProblemRow): ProblemRow {
  const title = text(b, 'title', LIMIT.title, true);
  const state = oneOf(b, 'state', PROBLEM_STATES, existing?.state ?? 'open');
  const serviceId = b.serviceId === undefined ? existing?.service_id ?? null : b.serviceId === null || b.serviceId === '' ? null : serviceIds(app, sys.id, { s: [b.serviceId] }, 's')[0];
  const description = text(b, 'description', LIMIT.text);
  const rootCause = text(b, 'rootCause', LIMIT.text);
  const workaround = text(b, 'workaround', LIMIT.text);
  const owner = text(b, 'owner', LIMIT.name);
  const pub = b.public === true ? 1 : 0;
  if (pub && !workaround && !description) throw new HttpError(422, 'Für die Anzeige im Portal braucht es eine Beschreibung oder einen Workaround', 'validation', { workaround: 'Für das Portal nötig' });
  const t = Date.now();
  if (existing) {
    app.db.run('UPDATE problems SET title = ?, state = ?, service_id = ?, description = ?, root_cause = ?, workaround = ?, owner = ?, public = ?, updated_at = ? WHERE id = ?',
      title, state, serviceId, description, rootCause, workaround, owner, pub, t, existing.id);
    return getProblem(app, existing.id)!;
  }
  const id = uuid();
  app.db.run(`INSERT INTO problems (id, number, system_id, title, state, service_id, description, root_cause, workaround, owner, public, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, nextNumber(app, 'problems'), sys.id, title, state, serviceId, description, rootCause, workaround, owner, pub, actor.id, t, t);
  return getProblem(app, id)!;
}

/** Zammad-Ticket mit dem Problem verknüpfen: Tag in Zammad setzen und Verknüpfung merken. */
export async function linkProblemTicket(app: App, sys: SystemRow, p: ProblemRow, actor: AuthUser, rawNumber: unknown): Promise<{ id: number; number: string; title: string }> {
  const number = String(rawNumber ?? '').trim().replace(/^#/, '');
  if (!/^\d{1,20}$/.test(number)) throw new HttpError(422, 'Ticketnummer ungültig', 'validation', { number: 'Nur Ziffern' });
  const c = connectorFor(app, sys);
  const t = await c.findTicketByNumber(number);
  if (!t) throw new HttpError(422, `Ticket ${number} gibt es in ${sys.name} nicht`, 'validation', { number: 'Nicht gefunden' });
  await c.addTag(t.id, problemTag(p.number));
  app.db.run('INSERT OR IGNORE INTO problem_tickets (problem_id, ticket_id, ticket_number, added_by, added_at) VALUES (?, ?, ?, ?, ?)', p.id, t.id, t.number, actor.id, Date.now());
  return { id: t.id, number: t.number, title: t.title };
}

export async function unlinkProblemTicket(app: App, sys: SystemRow, p: ProblemRow, ticketId: number): Promise<void> {
  if (!app.db.get('SELECT 1 FROM problem_tickets WHERE problem_id = ? AND ticket_id = ?', p.id, ticketId)) throw new HttpError(404, 'Ticket ist nicht verknüpft', 'not_found');
  try { await connectorFor(app, sys).removeTag(ticketId, problemTag(p.number)); } catch (err) { log.warn('Tag in Zammad nicht entfernt', { ticket: ticketId, error: (err as Error).message }); }
  app.db.run('DELETE FROM problem_tickets WHERE problem_id = ? AND ticket_id = ?', p.id, ticketId);
}

/** Verknüpfte Tickets mit aktuellem Stand aus Zammad (nicht erreichbar: gespeicherte Nummer ohne Stand). */
export async function problemTickets(app: App, sys: SystemRow, p: ProblemRow) {
  const rows = app.db.all<{ ticket_id: number; ticket_number: string; added_at: number }>('SELECT ticket_id, ticket_number, added_at FROM problem_tickets WHERE problem_id = ? ORDER BY added_at', p.id);
  const c = connectorFor(app, sys);
  return Promise.all(rows.map(async (r) => {
    try {
      const t = await c.ticketInfo(r.ticket_id);
      return { id: r.ticket_id, number: r.ticket_number, title: t?.title ?? '(nicht mehr vorhanden)', state: t?.state ?? null, closed: t?.closed ?? null, addedAt: r.added_at };
    } catch {
      return { id: r.ticket_id, number: r.ticket_number, title: '', state: null, closed: null, addedAt: r.added_at, unavailable: true };
    }
  }));
}

// ------------------------------------------------------------------------------------------ Für das Portal

export const incidentPublic = (app: App, i: IncidentRow, sysName: string, userId?: string) => ({
  id: i.id, number: incidentNumber(i.number), systemId: i.system_id, systemName: sysName, title: i.title, impact: i.impact, major: i.major === 1,
  state: i.state, locations: parseJson<string[]>(i.locations, []), startedAt: i.started_at, resolvedAt: i.resolved_at, updatedAt: i.updated_at,
  services: incidentServices(app, i.id),
  affected: getFeatures(app).showAffectedCount ? affectedCount(app, i.id) : null,
  mine: userId ? Boolean(app.db.get('SELECT 1 FROM incident_affected WHERE incident_id = ? AND user_id = ?', i.id, userId)) : false,
  lastUpdate: app.db.get<{ body: string; created_at: number }>('SELECT body, created_at FROM incident_updates WHERE incident_id = ? ORDER BY created_at DESC LIMIT 1', i.id) ?? null,
});

export const maintenancePublic = (app: App, m: MaintenanceRow, sysName: string) => ({
  id: m.id, systemId: m.system_id, systemName: sysName, title: m.title, body: m.body, startsAt: m.starts_at, endsAt: m.ends_at,
  locations: parseJson<string[]>(m.locations, []), cancelled: m.cancelled === 1,
  services: app.db.all<{ service_id: string }>('SELECT service_id FROM maintenance_services WHERE maintenance_id = ?', m.id).map((r) => r.service_id),
});

/** Ticketsysteme, deren Status die Person sehen darf */
export function visibleSystems(app: App, user: AuthUser): SystemRow[] {
  return listSystems(app).filter((s) => systemVisibleTo(s, user));
}

/** Alles für die Status-Seite – eine Seite für alle Ticketsysteme, die die Person sieht. */
export function statusOverview(app: App, user: AuthUser, now = Date.now()) {
  const f = getFeatures(app);
  const systems = visibleSystems(app, user);
  const ids = systems.map((s) => s.id);
  const names = new Map(systems.map((s) => [s.id, s.name]));
  const services = f.status ? servicesOf(app, ids) : [];
  const states = serviceStates(app, services, now);
  const incidents = f.incidents && ids.length
    ? app.db.all<IncidentRow>(`SELECT * FROM incidents WHERE system_id IN (${inList(ids.length)}) AND (state != 'resolved' OR resolved_at > ?) ORDER BY state = 'resolved', major DESC, started_at DESC LIMIT 100`, ...ids, now - 7 * 86400_000)
    : [];
  const maintenances = f.maintenance && ids.length
    ? app.db.all<MaintenanceRow>(`SELECT * FROM maintenances WHERE system_id IN (${inList(ids.length)}) AND cancelled = 0 AND ends_at > ? ORDER BY starts_at LIMIT 100`, ...ids, now)
    : [];
  const problems = f.problems && ids.length
    ? app.db.all<ProblemRow>(`SELECT * FROM problems WHERE system_id IN (${inList(ids.length)}) AND public = 1 AND state NOT IN ('closed') ORDER BY state = 'resolved', updated_at DESC LIMIT 100`, ...ids)
    : [];
  return {
    features: { status: f.status, incidents: f.incidents, maintenance: f.maintenance, problems: f.problems },
    systems: systems.map((s) => ({ id: s.id, name: s.name })),
    services: services.map((s) => ({ id: s.id, systemId: s.system_id, name: s.name, description: s.description, ...states.get(s.id)! })),
    incidents: incidents.map((i) => incidentPublic(app, i, names.get(i.system_id) ?? '', user.id)),
    maintenances: maintenances.map((m) => maintenancePublic(app, m, names.get(m.system_id) ?? '')),
    problems: problems.map((p) => ({
      id: p.id, number: problemNumber(p.number), systemId: p.system_id, systemName: names.get(p.system_id) ?? '', title: p.title, state: p.state,
      serviceId: p.service_id, description: p.description, workaround: p.workaround, updatedAt: p.updated_at,
    })),
    statusLabels: SERVICE_STATUS_LABEL,
  };
}

/** Kurzfassung für den Kopf jeder Portalseite: große Störungen und laufende Wartungen. */
export function statusBanner(app: App, user: AuthUser, now = Date.now()) {
  const f = getFeatures(app);
  const systems = visibleSystems(app, user);
  const ids = systems.map((s) => s.id);
  const names = new Map(systems.map((s) => [s.id, s.name]));
  if (!ids.length) return { major: [], activeIncidents: 0, maintenanceNow: [], maintenanceSoon: [] };
  const open = f.incidents ? app.db.all<IncidentRow>(`SELECT * FROM incidents WHERE system_id IN (${inList(ids.length)}) AND state != 'resolved' ORDER BY started_at DESC`, ...ids) : [];
  const mnt = f.maintenance ? app.db.all<MaintenanceRow>(`SELECT * FROM maintenances WHERE system_id IN (${inList(ids.length)}) AND cancelled = 0 AND ends_at > ? AND starts_at < ? ORDER BY starts_at`, ...ids, now, now + 3 * 86400_000) : [];
  return {
    major: open.filter((i) => i.major === 1).slice(0, 3).map((i) => incidentPublic(app, i, names.get(i.system_id) ?? '', user.id)),
    activeIncidents: open.length,
    maintenanceNow: mnt.filter((m) => m.starts_at <= now).map((m) => maintenancePublic(app, m, names.get(m.system_id) ?? '')),
    maintenanceSoon: mnt.filter((m) => m.starts_at > now).map((m) => maintenancePublic(app, m, names.get(m.system_id) ?? '')),
  };
}

/** Hinweise auf einem Formular: offene Störungen und laufende/nahe Wartungen der Services, die das Formular betrifft. */
export function formNotices(app: App, user: AuthUser, systemId: string, services: string[] | undefined, now = Date.now()) {
  const f = getFeatures(app);
  if (!services?.length || (!f.incidents && !f.maintenance)) return { incidents: [], maintenances: [] };
  const sysName = getSystem(app, systemId)?.name ?? '';
  const incidents = f.incidents ? app.db.all<IncidentRow>(
    `SELECT DISTINCT i.* FROM incidents i JOIN incident_services s ON s.incident_id = i.id WHERE i.system_id = ? AND i.state != 'resolved' AND s.service_id IN (${inList(services.length)}) ORDER BY i.started_at DESC`,
    systemId, ...services) : [];
  const maintenances = f.maintenance ? app.db.all<MaintenanceRow>(
    `SELECT DISTINCT m.* FROM maintenances m JOIN maintenance_services s ON s.maintenance_id = m.id WHERE m.system_id = ? AND m.cancelled = 0 AND m.ends_at > ? AND m.starts_at < ? AND s.service_id IN (${inList(services.length)}) ORDER BY m.starts_at`,
    systemId, now, now + 86400_000, ...services) : [];
  return { incidents: incidents.map((i) => incidentPublic(app, i, sysName, user.id)), maintenances: maintenances.map((m) => maintenancePublic(app, m, sysName)) };
}

/** Tags für ein neues Ticket: jede offene Störung, die einen Service des Formulars betrifft (inc-0003). */
export function incidentTagsFor(app: App, systemId: string, services: string[] | undefined): string[] {
  if (!services?.length || !getFeatures(app).incidents) return [];
  return app.db.all<{ number: number }>(
    `SELECT DISTINCT i.number FROM incidents i JOIN incident_services s ON s.incident_id = i.id WHERE i.system_id = ? AND i.state != 'resolved' AND s.service_id IN (${inList(services.length)})`,
    systemId, ...services,
  ).map((r) => incidentTag(r.number));
}
