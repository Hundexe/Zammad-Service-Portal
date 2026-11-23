// Service-Status, Störungen, Wartungen und Probleme (ab 2.0 als Tickets in Zammad).
//
// Jede Störung, Wartung und jedes Problem ist ein Ticket mit dem Attribut „Portal: Art“. Was im Portal steht
// (Auswirkung, Phase, Services, Standorte, Zeiten, Workaround …), sind Attribute des Tickets; öffentliche Updates
// sind öffentliche Notizen (Betreff = Phase). Wer „Ich bin auch betroffen“ meldet, bekommt ein eigenes Ticket,
// verknüpft als Kind der Störung und mit „Portal: betroffen von Störung“. Probleme verknüpfen Tickets über
// Zammad-Verknüpfungen und „Portal: bekanntes Problem“.
//
// Das Portal hält nur noch die Services (Name, Beschreibung, Schlüssel in Zammad) und liest alles andere live –
// mit kurzem Zwischenspeicher, damit die Status-Seite Zammad nicht bei jedem Aufruf befragt.
import type { App } from '../app.ts';
import { uuid } from '../db/db.ts';
import { HttpError } from '../http/core.ts';
import { log } from '../log.ts';
import { getFeatures } from './features.ts';
import { notify } from './notifications.ts';
import { connectorFor, getSystem, listSystems, systemVisibleTo, type SystemRow } from './systems.ts';
import type { AuthUser } from './rbac.ts';
import { toAuthUser, type UserRow } from './users.ts';
import { customerFor } from './requests.ts';
import { userOfCustomer } from './approvals.ts';
import { getMapping, kindGroup, listOf, listValue, locationChoices, syncOptions } from './zammad-setup.ts';
import { blocksToText, formatHtmlArticle, formatTextArticle } from './article-format.ts';
import { escapeHtml, textToHtml } from '../../shared/template.ts';
import {
  INCIDENT_IMPACTS, INCIDENT_STATES, INCIDENT_STATE_LABEL, PROBLEM_STATES, SERVICE_STATUS_LABEL, worstStatus,
  type IncidentImpact, type IncidentState, type ProblemState, type ServiceStatus,
} from '../../shared/itsm.ts';
import { KIND_VALUE, optionKey, parseTicketRef, ticketRef, type ItsmKind, type ZammadMapping } from '../../shared/zammad-model.ts';
import type { AgentArticle, ZTicket } from '../connectors/types.ts';

export interface ServiceRow { id: string; system_id: string; name: string; description: string; zkey: string | null; sort: number; created_at: number; updated_at: number }

const LIMIT = { title: 200, text: 10_000, name: 120 };
const inList = (n: number) => Array.from({ length: n }, () => '?').join(',');
type Body = Record<string, unknown>;

// ------------------------------------------------------------------------------------------ Eingaben prüfen

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
/** Standorte: Werte aus Zammad bzw. unter Funktionen gepflegt; Eingabe als Wert oder Anzeigename */
function locations(app: App, sys: SystemRow, b: Body): string[] {
  const v = b.locations;
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > 50) throw new HttpError(422, 'Standorte ungültig', 'validation');
  const choices = locationChoices(app, sys);
  const out = new Set<string>();
  for (const x of v) {
    const hit = choices.find((c) => c.value === x || c.label === x);
    if (!hit) throw new HttpError(422, `Unbekannter Standort: ${String(x).slice(0, 60)}`, 'validation');
    out.add(hit.value);
  }
  return [...out];
}
const locationLabels = (app: App, sys: SystemRow, keys: string[]) => {
  const choices = locationChoices(app, sys);
  return keys.map((k) => choices.find((c) => c.value === k)?.label ?? k);
};

// ------------------------------------------------------------------------------------------ Services

export function servicesOf(app: App, systemIds: string[]): ServiceRow[] {
  if (!systemIds.length) return [];
  return app.db.all<ServiceRow>(`SELECT * FROM services WHERE system_id IN (${inList(systemIds.length)}) ORDER BY sort, name`, ...systemIds);
}

/** Eindeutiger Schlüssel eines Service in Zammad (Auswahlwert von „Portal: Services“) */
function freeKey(app: App, systemId: string, name: string, own?: string): string {
  const base = optionKey(name).slice(0, 50);
  for (let i = 1; ; i++) {
    const k = i === 1 ? base : `${base}_${i}`;
    if (!app.db.get('SELECT 1 FROM services WHERE system_id = ? AND zkey = ? AND id <> ?', systemId, k, own ?? '')) return k;
  }
}

/** Services ohne Schlüssel (aus 1.x oder Import) bekommen einen – beim Start */
export function ensureServiceKeys(app: App): void {
  for (const s of app.db.all<ServiceRow>('SELECT * FROM services WHERE zkey IS NULL')) {
    app.db.run('UPDATE services SET zkey = ? WHERE id = ?', freeKey(app, s.system_id, s.name, s.id), s.id);
  }
}

export function saveService(app: App, systemId: string, b: Body, existing?: ServiceRow): ServiceRow {
  const name = text(b, 'name', LIMIT.name, true);
  const description = text(b, 'description', 1000);
  const sort = Number.isInteger(b.sort) ? Number(b.sort) : existing?.sort ?? 0;
  const t = Date.now();
  if (existing) {
    // Der Schlüssel bleibt – Tickets in Zammad verweisen darauf; der Anzeigename folgt
    app.db.run('UPDATE services SET name = ?, description = ?, sort = ?, updated_at = ? WHERE id = ?', name, description, sort, t, existing.id);
  } else {
    if (app.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM services WHERE system_id = ?', systemId)!.n >= 200) throw new HttpError(422, 'Höchstens 200 Services je Ticketsystem', 'validation');
    const id = uuid();
    app.db.run('INSERT INTO services (id, system_id, name, description, zkey, sort, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', id, systemId, name, description, freeKey(app, systemId, name), sort, t, t);
    existing = { id } as ServiceRow;
  }
  void syncOptions(app, systemId, 'services');
  return app.db.get<ServiceRow>('SELECT * FROM services WHERE id = ?', existing.id)!;
}

/** Service-IDs (oder Namen aus Exportdateien) eines Formulars auflösen – Unbekanntes fällt weg */
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

/** Schlüssel in Zammad zu Service-IDs */
export function serviceKeys(app: App, systemId: string, ids: string[]): string[] {
  if (!ids.length) return [];
  return app.db.all<{ zkey: string | null }>(`SELECT zkey FROM services WHERE system_id = ? AND id IN (${inList(ids.length)})`, systemId, ...ids).map((r) => r.zkey!).filter(Boolean);
}
function serviceIdsOfKeys(app: App, systemId: string, keys: string[]): string[] {
  if (!keys.length) return [];
  return app.db.all<{ id: string }>(`SELECT id FROM services WHERE system_id = ? AND zkey IN (${inList(keys.length)})`, systemId, ...keys).map((r) => r.id);
}
/** Service-IDs aus der Eingabe prüfen (müssen zum Ticketsystem gehören) und in Schlüssel umsetzen */
function serviceInput(app: App, systemId: string, b: Body, key = 'serviceIds'): string[] {
  const v = b[key];
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > 100 || v.some((x) => typeof x !== 'string')) throw new HttpError(422, 'Services ungültig', 'validation');
  const ids = [...new Set(v as string[])];
  const keys = serviceKeys(app, systemId, ids);
  if (keys.length !== ids.length) throw new HttpError(422, 'Ein Service gehört nicht zu diesem Ticketsystem', 'validation');
  return keys;
}

// ------------------------------------------------------------------------------------------ Lesen aus Zammad

const TTL = 30_000;
const listCache = new Map<string, { at: number; list: ZTicket[] }>();
const articleCache = new Map<string, { updatedAt: string; list: AgentArticle[] }>();
const affectedCache = new Map<string, { at: number; list: ZTicket[] }>();

/** Nach Änderungen durch das Portal: Zwischenspeicher eines Ticketsystems verwerfen */
export function invalidate(systemId?: string): void {
  for (const k of [...listCache.keys()]) if (!systemId || k.startsWith(systemId)) listCache.delete(k);
  for (const k of [...affectedCache.keys()]) if (!systemId || k.startsWith(systemId)) affectedCache.delete(k);
}

/** Alle Tickets einer Art (neueste zuerst, höchstens 200) */
async function tickets(app: App, sys: SystemRow, kind: ItsmKind, fresh = false): Promise<ZTicket[]> {
  const key = `${sys.id}:${kind}`;
  const hit = listCache.get(key);
  if (!fresh && hit && Date.now() - hit.at < TTL) return hit.list;
  const m = getMapping(app, sys);
  try {
    const list = await connectorFor(app, sys).searchTickets({ [m.attrs.kind]: KIND_VALUE[kind] }, 200);
    listCache.set(key, { at: Date.now(), list });
    return list;
  } catch (err) {
    log.warn('Zammad nicht erreichbar – Status aus dem Zwischenspeicher', { system: sys.slug, kind, error: (err as Error).message });
    return hit?.list ?? [];
  }
}

async function articles(app: App, sys: SystemRow, t: ZTicket): Promise<AgentArticle[]> {
  const key = ticketRef(sys.id, t.id);
  const hit = articleCache.get(key);
  if (hit && hit.updatedAt === t.updatedAt) return hit.list;
  try {
    const list = await connectorFor(app, sys).agentArticles(t.id);
    articleCache.set(key, { updatedAt: t.updatedAt, list });
    if (articleCache.size > 2000) articleCache.delete(articleCache.keys().next().value!);
    return list;
  } catch { return hit?.list ?? []; }
}

/** Öffentliche Notizen der IT als Text (im Portal spricht „die IT“, ohne Namen) */
async function publicNotes(app: App, sys: SystemRow, t: ZTicket) {
  return (await articles(app, sys, t)).filter((a) => !a.internal && a.sender !== 'Customer' && a.type !== 'email').map((a) => ({
    subject: a.subject,
    body: blocksToText((a.contentType === 'text/html' ? formatHtmlArticle(a.body) : formatTextArticle(a.body)).blocks),
    at: Date.parse(a.createdAt) || 0,
  }));
}

/** Tickets der Betroffenen einer Störung (offene und geschlossene) */
async function affectedTickets(app: App, sys: SystemRow, incidentId: number, fresh = false): Promise<ZTicket[]> {
  const key = `${sys.id}:${incidentId}`;
  const hit = affectedCache.get(key);
  if (!fresh && hit && Date.now() - hit.at < TTL) return hit.list;
  const m = getMapping(app, sys);
  try {
    const list = await connectorFor(app, sys).searchTickets({ [m.attrs.incidentRef]: incidentId }, 200);
    affectedCache.set(key, { at: Date.now(), list });
    return list;
  } catch { return hit?.list ?? []; }
}

const bool = (v: unknown) => v === true || v === 'true';
const ts = (v: unknown) => { const n = typeof v === 'string' || typeof v === 'number' ? Date.parse(String(v)) : NaN; return Number.isFinite(n) ? n : null; };
const phaseOf = (subject: string): IncidentState => (Object.entries(INCIDENT_STATE_LABEL).find(([, l]) => l === subject)?.[0] as IncidentState | undefined) ?? 'investigating';

// ------------------------------------------------------------------------------------------ Umwandeln

export interface Incident {
  ref: string; sys: SystemRow; t: ZTicket; title: string; impact: IncidentImpact; major: boolean; state: IncidentState; public: boolean;
  locations: string[]; services: string[]; startedAt: number; resolvedAt: number | null; updatedAt: number; problemRef: number | null;
}
export interface Maintenance { ref: string; sys: SystemRow; t: ZTicket; title: string; startsAt: number; endsAt: number; locations: string[]; services: string[]; cancelled: boolean; public: boolean }
export interface Problem {
  ref: string; sys: SystemRow; t: ZTicket; title: string; state: ProblemState; public: boolean; services: string[]; workaround: string; rootCause: string; updatedAt: number; createdAt: number;
}

function toIncident(app: App, sys: SystemRow, m: ZammadMapping, t: ZTicket): Incident {
  const f = t.fields;
  const impact = (INCIDENT_IMPACTS as readonly string[]).includes(String(f[m.attrs.impact])) ? f[m.attrs.impact] as IncidentImpact : 'degraded';
  const phase = (INCIDENT_STATES as readonly string[]).includes(String(f[m.attrs.phase])) ? f[m.attrs.phase] as IncidentState : 'investigating';
  return {
    ref: ticketRef(sys.id, t.id), sys, t, title: t.title, impact, major: bool(f[m.attrs.major]), state: t.closed ? 'resolved' : phase,
    public: bool(f[m.attrs.public]), locations: listOf(f[m.attrs.locations]), services: serviceIdsOfKeys(app, sys.id, listOf(f[m.attrs.services])),
    startedAt: ts(f[m.attrs.incidentStart]) ?? (Date.parse(t.createdAt) || 0),
    resolvedAt: t.closed ? ts(f[m.attrs.incidentEnd]) ?? ts(t.closeAt) ?? (Date.parse(t.updatedAt) || null) : null,
    updatedAt: Date.parse(t.updatedAt) || 0,
    problemRef: Number(f[m.attrs.problemRef]) > 0 ? Number(f[m.attrs.problemRef]) : null,
  };
}
function toMaintenance(app: App, sys: SystemRow, m: ZammadMapping, t: ZTicket): Maintenance | null {
  const startsAt = ts(t.fields[m.attrs.maintStart]), endsAt = ts(t.fields[m.attrs.maintEnd]);
  if (startsAt === null || endsAt === null) return null;
  return {
    ref: ticketRef(sys.id, t.id), sys, t, title: t.title, startsAt, endsAt, public: bool(t.fields[m.attrs.public]),
    locations: listOf(t.fields[m.attrs.locations]), services: serviceIdsOfKeys(app, sys.id, listOf(t.fields[m.attrs.services])),
    // Vor dem Ende geschlossen = abgesagt
    cancelled: t.closed && (ts(t.closeAt) ?? Date.now()) < endsAt,
  };
}
function toProblem(app: App, sys: SystemRow, m: ZammadMapping, t: ZTicket): Problem {
  const st = String(t.fields[m.attrs.problemStatus] ?? '');
  return {
    ref: ticketRef(sys.id, t.id), sys, t, title: t.title,
    state: t.closed ? 'closed' : (PROBLEM_STATES as readonly string[]).includes(st) ? st as ProblemState : 'open',
    public: bool(t.fields[m.attrs.public]), services: serviceIdsOfKeys(app, sys.id, listOf(t.fields[m.attrs.services])),
    workaround: String(t.fields[m.attrs.workaround] ?? ''), rootCause: String(t.fields[m.attrs.rootCause] ?? ''),
    updatedAt: Date.parse(t.updatedAt) || 0, createdAt: Date.parse(t.createdAt) || 0,
  };
}

export async function incidentsOf(app: App, sys: SystemRow, fresh = false): Promise<Incident[]> {
  const m = getMapping(app, sys);
  return (await tickets(app, sys, 'incident', fresh)).map((t) => toIncident(app, sys, m, t));
}
export async function maintenancesOf(app: App, sys: SystemRow, fresh = false): Promise<Maintenance[]> {
  const m = getMapping(app, sys);
  return (await tickets(app, sys, 'maintenance', fresh)).map((t) => toMaintenance(app, sys, m, t)).filter((x): x is Maintenance => x !== null);
}
export async function problemsOf(app: App, sys: SystemRow, fresh = false): Promise<Problem[]> {
  const m = getMapping(app, sys);
  return (await tickets(app, sys, 'problem', fresh)).map((t) => toProblem(app, sys, m, t));
}

/** Ein Ticket über die Kennung aus dem Portal laden und als Art prüfen */
async function load(app: App, ref: string, kind: ItsmKind): Promise<{ sys: SystemRow; t: ZTicket; m: ZammadMapping } | null> {
  const p = parseTicketRef(ref);
  const sys = p ? getSystem(app, p.systemId) : undefined;
  if (!p || !sys) return null;
  const t = await connectorFor(app, sys).getTicketFull(p.ticketId).catch(() => null);
  const m = getMapping(app, sys);
  if (!t || String(t.fields[m.attrs.kind] ?? '') !== KIND_VALUE[kind]) return null;
  return { sys, t, m };
}
export async function getIncident(app: App, ref: string): Promise<Incident | null> {
  const x = await load(app, ref, 'incident');
  return x ? toIncident(app, x.sys, x.m, x.t) : null;
}
export async function getMaintenance(app: App, ref: string): Promise<Maintenance | null> {
  const x = await load(app, ref, 'maintenance');
  return x ? toMaintenance(app, x.sys, x.m, x.t) : null;
}
export async function getProblem(app: App, ref: string): Promise<Problem | null> {
  const x = await load(app, ref, 'problem');
  return x ? toProblem(app, x.sys, x.m, x.t) : null;
}

// ------------------------------------------------------------------------------------------ Zustand der Services

export interface ServiceState { status: ServiceStatus; note: string; incidents: string[]; maintenances: string[] }

/** Zustand je Service: schlimmster aus offenen Störungen und laufenden Wartungen. */
export function serviceStates(services: ServiceRow[], incidents: Incident[], maintenances: Maintenance[], now = Date.now()): Map<string, ServiceState> {
  const out = new Map<string, ServiceState>();
  for (const s of services) {
    const inc = incidents.filter((i) => i.state !== 'resolved' && i.startedAt <= now && i.services.includes(s.id));
    const mnt = maintenances.filter((m) => !m.cancelled && !m.t.closed && m.startsAt <= now && m.endsAt > now && m.services.includes(s.id));
    out.set(s.id, { status: worstStatus([...inc.map((i) => i.impact), ...(mnt.length ? ['maintenance' as const] : [])]), note: '', incidents: inc.map((i) => i.ref), maintenances: mnt.map((m) => m.ref) });
  }
  return out;
}

// ------------------------------------------------------------------------------------------ Anlegen und ändern

/** Gemeinsame Attribute aus der Eingabe (nur gesetzte Schlüssel) */
function commonFields(app: App, sys: SystemRow, m: ZammadMapping, b: Body): Record<string, unknown> {
  const f: Record<string, unknown> = {};
  if (b.serviceIds !== undefined) f[m.attrs.services] = listValue(app, sys, 'services', serviceInput(app, sys.id, b));
  if (b.locations !== undefined) f[m.attrs.locations] = listValue(app, sys, 'locations', locations(app, sys, b));
  if (b.public !== undefined) f[m.attrs.public] = b.public !== false;
  return f;
}

export async function createKindTicket(app: App, sys: SystemRow, kind: ItsmKind, title: string, subject: string, bodyText: string, fields: Record<string, unknown>): Promise<ZTicket> {
  const m = getMapping(app, sys);
  const c = connectorFor(app, sys);
  const group = kindGroup(m, sys, kind);
  if (!group) throw new HttpError(422, 'Für dieses Ticketsystem ist keine Gruppe festgelegt (Zammad-Zuordnung bzw. Standardgruppe)', 'config_error');
  const t = await c.createAgentTicket({
    customerId: await c.selfId(), title, group,
    fields: { ...m.kinds[kind].fields, [m.attrs.kind]: KIND_VALUE[kind], ...fields },
    tags: m.kinds[kind].tags,
    article: { type: 'note', internal: false, subject, body: textToHtml(bodyText || title) },
  });
  invalidate(sys.id);
  return t;
}

export async function createIncident(app: App, sys: SystemRow, actor: AuthUser, b: Body): Promise<Incident> {
  const m = getMapping(app, sys);
  const title = text(b, 'title', LIMIT.title, true);
  const body = text(b, 'body', LIMIT.text, true);
  const impact = oneOf(b, 'impact', INCIDENT_IMPACTS);
  const state = oneOf(b, 'state', INCIDENT_STATES.filter((s) => s !== 'resolved'), 'investigating');
  const started = time(b, 'startedAt') ?? Date.now();
  const t = await createKindTicket(app, sys, 'incident', title, INCIDENT_STATE_LABEL[state], body, {
    ...commonFields(app, sys, m, { public: true, ...b }),
    [m.attrs.impact]: impact, [m.attrs.major]: b.major === true, [m.attrs.phase]: state, [m.attrs.incidentStart]: new Date(started).toISOString(),
  });
  const inc = toIncident(app, sys, m, t);
  if (inc.major && getFeatures(app).notifyAllOnMajor) notifyAllUsers(app, sys, `Störung: ${title}`, body, `/stoerungen/${inc.ref}`);
  log.info('Störung angelegt', { system: sys.slug, ticket: t.number, by: actor.id });
  return inc;
}

export async function updateIncident(app: App, inc: Incident, b: Body): Promise<Incident> {
  const { sys } = inc;
  const m = getMapping(app, sys);
  const fields = commonFields(app, sys, m, b);
  if (b.impact !== undefined) fields[m.attrs.impact] = oneOf(b, 'impact', INCIDENT_IMPACTS);
  if (b.major !== undefined) fields[m.attrs.major] = b.major === true;
  if (b.startedAt !== undefined) fields[m.attrs.incidentStart] = new Date(time(b, 'startedAt', true)!).toISOString();
  if (b.problemId !== undefined) {
    const prev = inc.problemRef;
    const ref = b.problemId === null || b.problemId === '' ? null : String(b.problemId);
    const p = ref ? await getProblem(app, ref) : null;
    if (ref && (!p || p.sys.id !== sys.id)) throw new HttpError(422, 'Problem nicht gefunden', 'validation');
    fields[m.attrs.problemRef] = p ? p.t.id : null;
    const c = connectorFor(app, sys);
    if (prev && prev !== p?.t.id) await c.removeLink(prev, inc.t.id, 'normal').catch(() => undefined);
    if (p && prev !== p.t.id) await c.addLink(p.t.number, inc.t.id, 'normal').catch((err) => log.warn('Verknüpfung nicht gesetzt', { error: (err as Error).message }));
  }
  const t = await connectorFor(app, sys).updateTicket(inc.t.id, { title: b.title === undefined ? undefined : text(b, 'title', LIMIT.title, true), fields });
  invalidate(sys.id);
  return toIncident(app, sys, m, t);
}

/** Neues Update (öffentliche Notiz); „Behoben“ schließt die Störung und – wenn eingestellt – die Tickets der Betroffenen. */
export async function addIncidentUpdate(app: App, inc: Incident, actor: AuthUser, b: Body): Promise<Incident> {
  const { sys } = inc;
  const m = getMapping(app, sys);
  const state = oneOf(b, 'state', INCIDENT_STATES);
  const body = text(b, 'body', LIMIT.text, true);
  const c = connectorFor(app, sys);
  await c.addArticle(inc.t.id, { type: 'note', internal: false, subject: INCIDENT_STATE_LABEL[state], body: textToHtml(body) });
  const fields: Record<string, unknown> = {};
  if (state === 'resolved') fields[m.attrs.incidentEnd] = new Date(time(b, 'resolvedAt') ?? Date.now()).toISOString();
  else fields[m.attrs.phase] = state;
  const t = await c.updateTicket(inc.t.id, { state: state === 'resolved' ? 'closed' : inc.t.closed ? 'open' : undefined, fields });
  invalidate(sys.id);
  const label = INCIDENT_STATE_LABEL[state];
  for (const a of await affectedTickets(app, sys, inc.t.id, true)) {
    const u = userOfCustomer(app, sys.id, a.customerId);
    if (u) notify(app, { to: { userId: u.id }, kind: 'incident.update', title: `${label}: ${inc.title}`, body, link: `/stoerungen/${inc.ref}` });
  }
  if (state === 'resolved') await closeAffected(app, sys, t, body);
  log.info('Störung: Update', { system: sys.slug, ticket: inc.t.number, state, by: actor.id });
  return toIncident(app, sys, m, t);
}

/** Tickets der Betroffenen schließen (einmal je Störung) */
async function closeAffected(app: App, sys: SystemRow, incident: ZTicket, note: string): Promise<number> {
  const m = getMapping(app, sys);
  if (!m.closeAffected || app.db.get("SELECT 1 FROM zammad_done WHERE system_id = ? AND ticket_id = ? AND kind = 'affected_closed'", sys.id, incident.id)) return 0;
  const c = connectorFor(app, sys);
  let n = 0;
  for (const a of (await affectedTickets(app, sys, incident.id, true)).filter((x) => !x.closed)) {
    try {
      await c.addArticle(a.id, { type: 'note', internal: false, subject: 'Störung behoben', body: `<p>Die Störung „${escapeHtml(incident.title)}“ ist behoben.</p>${note ? textToHtml(note) : ''}` });
      await c.updateTicket(a.id, { state: 'closed' });
      n++;
    } catch (err) {
      log.warn('Ticket einer betroffenen Person nicht geschlossen', { system: sys.slug, ticket: a.number, error: (err as Error).message });
      return n; // beim nächsten Lauf erneut
    }
  }
  app.db.run("INSERT OR IGNORE INTO zammad_done (system_id, ticket_id, kind, done_at) VALUES (?, ?, 'affected_closed', ?)", sys.id, incident.id, Date.now());
  affectedCache.delete(`${sys.id}:${incident.id}`);
  return n;
}

/** „Ich bin auch betroffen“: eigenes Ticket als Kind der Störung bzw. dieses wieder schließen */
export async function setAffected(app: App, inc: Incident, user: AuthUser, affected: boolean): Promise<number> {
  if (inc.state === 'resolved') throw new HttpError(409, 'Die Störung ist schon behoben', 'conflict');
  if (!user.email) throw new HttpError(422, 'Ihrem Konto ist keine E-Mail-Adresse zugeordnet', 'no_email');
  const { sys } = inc;
  const m = getMapping(app, sys);
  const c = connectorFor(app, sys);
  const customer = (await customerFor(app, sys, user.id, user.email, user.displayName, true))!;
  const mine = (await affectedTickets(app, sys, inc.t.id, true)).filter((t) => t.customerId === customer.customerId && !t.closed);
  if (affected && !mine.length) {
    // Als API-Benutzer anlegen (Kunden dürfen das Attribut nicht setzen), Absender bleibt die Person
    const t = await c.createTicket({
      customer, title: `Betroffen: ${inc.title}`, group: inc.t.group ?? kindGroup(m, sys, 'incident'), state: 'new',
      bodyHtml: `<p>${escapeHtml(user.displayName)} ist von der Störung „${escapeHtml(inc.title)}“ (Ticket ${escapeHtml(inc.t.number)}) betroffen.</p><p><small>Gemeldet über das Self-Service-Portal</small></p>`,
      attachments: [], fields: { [m.attrs.incidentRef]: inc.t.id }, tags: m.affectedTags,
    });
    await c.addLink(inc.t.number, t.id, 'parent').catch((err) => log.warn('Verknüpfung zur Störung nicht gesetzt', { ticket: t.number, error: (err as Error).message }));
  }
  if (!affected) {
    for (const t of mine) {
      await c.addArticle(t.id, { type: 'note', internal: false, subject: 'Nicht mehr betroffen', body: `<p>${escapeHtml(user.displayName)} ist nicht mehr betroffen.</p>` }).catch(() => undefined);
      await c.updateTicket(t.id, { state: 'closed' });
    }
  }
  affectedCache.delete(`${sys.id}:${inc.t.id}`);
  return (await affectedTickets(app, sys, inc.t.id, true)).filter((t) => !t.closed).length;
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

/** Neues Ticket aus dem Portal: mit offenen Störungen der betroffenen Services verknüpfen */
export async function linkRequestToIncidents(app: App, sys: SystemRow, ticket: { id: number; number: string }, keys: string[]): Promise<void> {
  if (!getFeatures(app).incidents || !keys.length) return;
  try {
    const ids = serviceIdsOfKeys(app, sys.id, keys);
    const open = (await incidentsOf(app, sys)).filter((i) => i.state !== 'resolved' && i.services.some((s) => ids.includes(s)));
    for (const i of open) await connectorFor(app, sys).addLink(i.t.number, ticket.id, 'normal');
  } catch (err) {
    log.warn('Ticket nicht mit Störung verknüpft', { system: sys.slug, ticket: ticket.number, error: (err as Error).message });
  }
}

// ------------------------------------------------------------------------------------------ Wartungen

export async function saveMaintenance(app: App, sys: SystemRow, actor: AuthUser, b: Body, existing?: Maintenance): Promise<Maintenance> {
  const m = getMapping(app, sys);
  const title = text(b, 'title', LIMIT.title, true);
  const body = text(b, 'body', LIMIT.text);
  const starts = time(b, 'startsAt', true)!;
  const ends = time(b, 'endsAt', true)!;
  if (ends <= starts) throw new HttpError(422, 'Das Ende muss nach dem Beginn liegen', 'validation', { endsAt: 'Nach dem Beginn' });
  if (ends - starts > 30 * 86400_000) throw new HttpError(422, 'Eine Wartung dauert höchstens 30 Tage', 'validation', { endsAt: 'Höchstens 30 Tage' });
  const fields = { ...commonFields(app, sys, m, { public: true, ...b }), [m.attrs.maintStart]: new Date(starts).toISOString(), [m.attrs.maintEnd]: new Date(ends).toISOString() };
  let t: ZTicket;
  if (existing) {
    const c = connectorFor(app, sys);
    t = await c.updateTicket(existing.t.id, { title, fields });
    const notes = await publicNotes(app, sys, existing.t);
    if (body && notes.at(-1)?.body.trim() !== body) await c.addArticle(existing.t.id, { type: 'note', internal: false, subject: 'Wartung geändert', body: textToHtml(body) });
    t = (await c.getTicketFull(existing.t.id)) ?? t;
    invalidate(sys.id);
  } else {
    t = await createKindTicket(app, sys, 'maintenance', title, 'Wartung angekündigt', body, fields);
  }
  log.info(existing ? 'Wartung geändert' : 'Wartung angelegt', { system: sys.slug, ticket: t.number, by: actor.id });
  return toMaintenance(app, sys, m, t)!;
}

export async function cancelMaintenance(app: App, mnt: Maintenance): Promise<void> {
  const c = connectorFor(app, mnt.sys);
  await c.addArticle(mnt.t.id, { type: 'note', internal: false, subject: 'Wartung abgesagt', body: '<p>Die Wartung findet nicht statt.</p>' });
  await c.updateTicket(mnt.t.id, { state: 'closed' });
  invalidate(mnt.sys.id);
}

/** Aus dem Portal nehmen: nicht mehr anzeigen und schließen (das Ticket bleibt in Zammad) */
export async function removeFromPortal(app: App, sys: SystemRow, t: ZTicket): Promise<void> {
  const m = getMapping(app, sys);
  await connectorFor(app, sys).updateTicket(t.id, { state: t.closed ? undefined : 'closed', fields: { [m.attrs.public]: false } });
  invalidate(sys.id);
}

// ------------------------------------------------------------------------------------------ Probleme

export async function saveProblem(app: App, sys: SystemRow, actor: AuthUser, b: Body, existing?: Problem): Promise<Problem> {
  const m = getMapping(app, sys);
  const title = text(b, 'title', LIMIT.title, true);
  const state = oneOf(b, 'state', PROBLEM_STATES, existing?.state ?? 'open');
  const description = text(b, 'description', LIMIT.text);
  const rootCause = text(b, 'rootCause', LIMIT.text);
  const workaround = text(b, 'workaround', LIMIT.text);
  const pub = b.public === true;
  if (pub && !workaround && !description) throw new HttpError(422, 'Für die Anzeige im Portal braucht es eine Beschreibung oder einen Workaround', 'validation', { workaround: 'Für das Portal nötig' });
  const serviceIds = b.serviceId === undefined ? undefined : b.serviceId === null || b.serviceId === '' ? [] : [String(b.serviceId)];
  const fields: Record<string, unknown> = {
    ...(serviceIds ? commonFields(app, sys, m, { serviceIds }) : {}),
    [m.attrs.public]: pub, [m.attrs.workaround]: workaround, [m.attrs.rootCause]: rootCause,
    [m.attrs.problemStatus]: state === 'closed' ? 'resolved' : state,
  };
  let t: ZTicket;
  const c = connectorFor(app, sys);
  if (existing) {
    t = await c.updateTicket(existing.t.id, { title, fields, state: state === 'closed' ? 'closed' : existing.t.closed ? 'open' : undefined });
    const first = (await publicNotes(app, sys, existing.t))[0];
    if (description && first?.body.trim() !== description) await c.addArticle(existing.t.id, { type: 'note', internal: false, subject: 'Beschreibung', body: textToHtml(description) });
    invalidate(sys.id);
  } else {
    t = await createKindTicket(app, sys, 'problem', title, 'Beschreibung', description, fields);
    if (state === 'closed') t = await c.updateTicket(t.id, { state: 'closed' });
  }
  log.info(existing ? 'Problem geändert' : 'Problem angelegt', { system: sys.slug, ticket: t.number, by: actor.id });
  return toProblem(app, sys, m, t);
}

/** Zammad-Ticket mit dem Problem verknüpfen (Verknüpfung und „Portal: bekanntes Problem“) */
export async function linkProblemTicket(app: App, p: Problem, rawNumber: unknown): Promise<{ id: number; number: string; title: string }> {
  const number = String(rawNumber ?? '').trim().replace(/^#/, '');
  if (!/^\d{1,20}$/.test(number)) throw new HttpError(422, 'Ticketnummer ungültig', 'validation', { number: 'Nur Ziffern' });
  const c = connectorFor(app, p.sys);
  const t = await c.findTicketByNumber(number);
  if (!t) throw new HttpError(422, `Ticket ${number} gibt es in ${p.sys.name} nicht`, 'validation', { number: 'Nicht gefunden' });
  if (t.id === p.t.id) throw new HttpError(422, 'Das Problem kann nicht mit sich selbst verknüpft werden', 'validation', { number: 'Eigenes Ticket' });
  await c.addLink(p.t.number, t.id, 'normal');
  const m = getMapping(app, p.sys);
  await c.updateTicket(t.id, { fields: { [m.attrs.problemRef]: p.t.id } }).catch((err) => log.warn('„Bekanntes Problem“ nicht gesetzt', { ticket: t.number, error: (err as Error).message }));
  return { id: t.id, number: t.number, title: t.title };
}

export async function unlinkProblemTicket(app: App, p: Problem, ticketId: number): Promise<void> {
  const c = connectorFor(app, p.sys);
  if (!(await c.links(p.t.id)).some((l) => l.ticketId === ticketId)) throw new HttpError(404, 'Ticket ist nicht verknüpft', 'not_found');
  await c.removeLink(p.t.id, ticketId, 'normal');
  const m = getMapping(app, p.sys);
  await c.updateTicket(ticketId, { fields: { [m.attrs.problemRef]: null } }).catch(() => undefined);
}

/** Verknüpfte Tickets mit aktuellem Stand aus Zammad */
export async function problemTickets(app: App, p: Problem) {
  const c = connectorFor(app, p.sys);
  const links = (await c.links(p.t.id)).filter((l) => l.type === 'normal');
  return Promise.all(links.map(async (l) => {
    const t = await c.ticketInfo(l.ticketId).catch(() => null);
    return { id: l.ticketId, number: t?.number ?? String(l.ticketId), title: t?.title ?? '(nicht mehr vorhanden)', state: t?.state ?? null, closed: t?.closed ?? null, addedAt: null };
  }));
}

// ------------------------------------------------------------------------------------------ Für das Portal

export async function incidentPublic(app: App, i: Incident, user?: AuthUser) {
  const affected = await affectedTickets(app, i.sys, i.t.id);
  const notes = await publicNotes(app, i.sys, i.t);
  const last = notes.at(-1);
  let mine = false;
  if (user) {
    const cid = app.db.get<{ customer_id: number }>('SELECT customer_id FROM zammad_customers WHERE system_id = ? AND user_id = ?', i.sys.id, user.id)?.customer_id;
    mine = cid !== undefined && affected.some((t) => t.customerId === cid && !t.closed);
  }
  return {
    id: i.ref, number: i.t.number, systemId: i.sys.id, systemName: i.sys.name, title: i.title, impact: i.impact, major: i.major,
    state: i.state, locations: locationLabels(app, i.sys, i.locations), startedAt: i.startedAt, resolvedAt: i.resolvedAt, updatedAt: i.updatedAt,
    services: i.services,
    affected: getFeatures(app).showAffectedCount ? affected.filter((t) => !t.closed || i.state === 'resolved').length : null,
    mine,
    lastUpdate: last ? { body: last.body, created_at: last.at } : null,
  };
}

export async function incidentUpdates(app: App, i: Incident) {
  return (await publicNotes(app, i.sys, i.t)).map((n) => ({ state: n.subject === INCIDENT_STATE_LABEL.resolved ? 'resolved' : phaseOf(n.subject), body: n.body, at: n.at })).reverse();
}

export async function maintenancePublic(app: App, mnt: Maintenance) {
  const notes = await publicNotes(app, mnt.sys, mnt.t);
  return {
    id: mnt.ref, number: mnt.t.number, systemId: mnt.sys.id, systemName: mnt.sys.name, title: mnt.title, body: notes.filter((n) => n.subject !== 'Wartung abgesagt').at(-1)?.body ?? '',
    startsAt: mnt.startsAt, endsAt: mnt.endsAt, locations: locationLabels(app, mnt.sys, mnt.locations), cancelled: mnt.cancelled, services: mnt.services, public: mnt.public,
  };
}

export async function problemPublic(app: App, p: Problem) {
  const notes = await publicNotes(app, p.sys, p.t);
  return {
    id: p.ref, number: p.t.number, systemId: p.sys.id, systemName: p.sys.name, title: p.title, state: p.state, serviceId: p.services[0] ?? null,
    description: notes.filter((n) => n.subject === 'Beschreibung').at(-1)?.body ?? notes[0]?.body ?? '', workaround: p.workaround, updatedAt: p.updatedAt,
  };
}

/** Ticketsysteme, deren Status die Person sehen darf */
export function visibleSystems(app: App, user: AuthUser): SystemRow[] {
  return listSystems(app).filter((s) => s.status !== 'inactive' && systemVisibleTo(s, user));
}

const recent = (i: Incident, now: number) => i.state !== 'resolved' || (i.resolvedAt ?? 0) > now - 7 * 86400_000;

/** Alles für die Status-Seite – eine Seite für alle Ticketsysteme, die die Person sieht. */
export async function statusOverview(app: App, user: AuthUser, now = Date.now()) {
  const f = getFeatures(app);
  const systems = visibleSystems(app, user);
  const incidents: Incident[] = [], maintenances: Maintenance[] = [], problems: Problem[] = [];
  for (const s of systems) {
    if (f.incidents || f.status) incidents.push(...(await incidentsOf(app, s)).filter((i) => i.public && recent(i, now)));
    if (f.maintenance || f.status) maintenances.push(...(await maintenancesOf(app, s)).filter((m) => m.public && !m.cancelled && m.endsAt > now));
    if (f.problems) problems.push(...(await problemsOf(app, s)).filter((p) => p.public && p.state !== 'closed'));
  }
  const services = f.status ? servicesOf(app, systems.map((s) => s.id)) : [];
  const states = serviceStates(services, incidents, maintenances, now);
  incidents.sort((a, b) => Number(a.state === 'resolved') - Number(b.state === 'resolved') || Number(b.major) - Number(a.major) || b.startedAt - a.startedAt);
  maintenances.sort((a, b) => a.startsAt - b.startsAt);
  problems.sort((a, b) => Number(a.state === 'resolved') - Number(b.state === 'resolved') || b.updatedAt - a.updatedAt);
  return {
    features: { status: f.status, incidents: f.incidents, maintenance: f.maintenance, problems: f.problems },
    systems: systems.map((s) => ({ id: s.id, name: s.name })),
    services: services.map((s) => ({ id: s.id, systemId: s.system_id, name: s.name, description: s.description, ...states.get(s.id)! })),
    incidents: f.incidents ? await Promise.all(incidents.slice(0, 100).map((i) => incidentPublic(app, i, user))) : [],
    maintenances: f.maintenance ? await Promise.all(maintenances.slice(0, 100).map((m) => maintenancePublic(app, m))) : [],
    problems: await Promise.all(problems.slice(0, 100).map((p) => problemPublic(app, p))),
    statusLabels: SERVICE_STATUS_LABEL,
  };
}

/** Kurzfassung für den Kopf jeder Portalseite: große Störungen und laufende Wartungen. */
export async function statusBanner(app: App, user: AuthUser, now = Date.now()) {
  const f = getFeatures(app);
  const open: Incident[] = [], mnt: Maintenance[] = [];
  for (const s of visibleSystems(app, user)) {
    if (f.incidents) open.push(...(await incidentsOf(app, s)).filter((i) => i.public && i.state !== 'resolved'));
    if (f.maintenance) mnt.push(...(await maintenancesOf(app, s)).filter((m) => m.public && !m.cancelled && !m.t.closed && m.endsAt > now && m.startsAt < now + 3 * 86400_000));
  }
  mnt.sort((a, b) => a.startsAt - b.startsAt);
  return {
    major: await Promise.all(open.filter((i) => i.major).slice(0, 3).map((i) => incidentPublic(app, i, user))),
    activeIncidents: open.length,
    maintenanceNow: await Promise.all(mnt.filter((m) => m.startsAt <= now).map((m) => maintenancePublic(app, m))),
    maintenanceSoon: await Promise.all(mnt.filter((m) => m.startsAt > now).map((m) => maintenancePublic(app, m))),
  };
}

/** Hinweise auf einem Formular: offene Störungen und laufende/nahe Wartungen der Services, die das Formular betrifft. */
export async function formNotices(app: App, user: AuthUser, systemId: string, services: string[] | undefined, now = Date.now()) {
  const f = getFeatures(app);
  const sys = getSystem(app, systemId);
  if (!sys || !services?.length || (!f.incidents && !f.maintenance)) return { incidents: [], maintenances: [] };
  const hits = (list: string[]) => list.some((s) => services.includes(s));
  const incidents = f.incidents ? (await incidentsOf(app, sys)).filter((i) => i.public && i.state !== 'resolved' && hits(i.services)) : [];
  const maintenances = f.maintenance ? (await maintenancesOf(app, sys)).filter((m) => m.public && !m.cancelled && !m.t.closed && m.endsAt > now && m.startsAt < now + 86400_000 && hits(m.services)) : [];
  return {
    incidents: await Promise.all(incidents.map((i) => incidentPublic(app, i, user))),
    maintenances: await Promise.all(maintenances.map((m) => maintenancePublic(app, m))),
  };
}

/** Für die Verwaltung: Betroffene einer Störung mit Portal-Konto, falls bekannt */
export async function affectedPeople(app: App, i: Incident) {
  return (await affectedTickets(app, i.sys, i.t.id, true)).filter((t) => !t.closed || i.state === 'resolved').map((t) => {
    const u = userOfCustomer(app, i.sys.id, t.customerId);
    return { name: u?.name ?? String(t.fields.customer ?? ''), email: u?.email ?? null, department: u?.department ?? null, at: Date.parse(t.createdAt) || 0, ticket: t.number };
  });
}

/** Störungen, die mit einem Problem verknüpft sind */
export async function incidentsOfProblem(app: App, p: Problem) {
  return (await incidentsOf(app, p.sys)).filter((i) => i.problemRef === p.t.id).map((i) => ({ id: i.ref, number: i.t.number, title: i.title, state: i.state }));
}

// ------------------------------------------------------------------------------------------ Worker

/**
 * Aufräumen in Zammad: In Zammad geschlossene Störungen schließen die Tickets der Betroffenen; Wartungen werden
 * nach ihrem Ende geschlossen. Jedes Ticket nur einmal (zammad_done).
 */
export async function itsmHousekeeping(app: App, now = Date.now()): Promise<{ affectedClosed: number; maintenancesClosed: number }> {
  const f = getFeatures(app);
  let affectedClosed = 0, maintenancesClosed = 0;
  for (const sys of listSystems(app).filter((s) => s.status === 'active')) {
    try {
      if (f.incidents) {
        for (const i of (await incidentsOf(app, sys, true)).filter((x) => x.state === 'resolved')) {
          if (app.db.get("SELECT 1 FROM zammad_done WHERE system_id = ? AND ticket_id = ? AND kind = 'affected_closed'", sys.id, i.t.id)) continue;
          affectedClosed += await closeAffected(app, sys, i.t, '');
        }
      }
      if (f.maintenance) {
        for (const mnt of (await maintenancesOf(app, sys, true)).filter((x) => !x.t.closed && x.endsAt <= now)) {
          const c = connectorFor(app, sys);
          await c.addArticle(mnt.t.id, { type: 'note', internal: false, subject: 'Wartung beendet', body: '<p>Das Wartungsfenster ist vorbei.</p>' });
          await c.updateTicket(mnt.t.id, { state: 'closed' });
          maintenancesClosed++;
        }
        if (maintenancesClosed) invalidate(sys.id);
      }
    } catch (err) {
      log.warn('Störungen/Wartungen: Aufräumen in Zammad fehlgeschlagen', { system: sys.slug, error: (err as Error).message });
    }
  }
  if (affectedClosed || maintenancesClosed) log.info('Zammad aufgeräumt', { betroffeneGeschlossen: affectedClosed, wartungenGeschlossen: maintenancesClosed });
  return { affectedClosed, maintenancesClosed };
}
