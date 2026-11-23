// Zammad-Zuordnung und Einrichtung.
//
// Je Ticketsystem legt die Verwaltung fest, wie das Portal Zammad abbildet (siehe shared/zammad-model.ts):
// Attributnamen, Status, Gruppen, Tags und zusätzliche Werte für eine vorhandene Struktur.
// Das Portal prüft regelmäßig, ob Zammad dazu passt, und legt Fehlendes auf Knopfdruck selbst an
// (Gruppen, den Status „wartet auf Freigabe“, eigene Attribute und Auswahlwerte – braucht Admin-Rechte).
// Vorhandene Attribute, auf die umgelenkt wurde, bekommen höchstens fehlende Auswahlwerte; gelöscht wird nie etwas.
import type { App } from '../app.ts';
import { parseJson } from '../db/db.ts';
import { log } from '../log.ts';
import { getFeatures } from './features.ts';
import { connectorFor, getSystem, listSystems, type SystemRow } from './systems.ts';
import {
  APPROVAL_ATTRS, ATTR_SPECS, DEFAULT_MAPPING, ITSM_KINDS, KIND_ATTRS, KIND_LABEL, KIND_VALUE, STATE_ROLES, STATE_ROLE_LABEL, attrLabel, normalizeMapping, optionKey,
  type AttrKey, type AttrSpec, type ItsmKind, type StateRole, type ZammadMapping,
} from '../../shared/zammad-model.ts';
import { ConnectorError, type SetupInfo, type WorkflowDef } from '../connectors/types.ts';
import { WORKFLOW_MARK } from '../connectors/zammad.ts';
import { pickState, resetStateCache } from './zammad-states.ts';

// ------------------------------------------------------------------------------------------ Zuordnung

export function getMapping(app: App, sys: SystemRow | string): ZammadMapping {
  const row = typeof sys === 'string' ? getSystem(app, sys) : sys;
  if (!row) return DEFAULT_MAPPING;
  try { return normalizeMapping(parseJson(row.zammad_mapping ?? '{}', {})); } catch { return DEFAULT_MAPPING; }
}

export function saveMapping(app: App, sys: SystemRow, raw: unknown): ZammadMapping {
  const m = normalizeMapping(raw);
  app.db.run('UPDATE ticket_systems SET zammad_mapping = ?, updated_at = ? WHERE id = ?', JSON.stringify(m), Date.now(), sys.id);
  reports.delete(sys.id);
  resetStateCache(sys.id);
  return m;
}

/** Attributname in Zammad */
export const attr = (m: ZammadMapping, key: AttrKey) => m.attrs[key];

/** Gruppe für Störungen, Wartungen bzw. Probleme */
export function kindGroup(m: ZammadMapping, sys: SystemRow, kind: ItsmKind): string {
  return m.kinds[kind].group || sys.default_group || '';
}

// ------------------------------------------------------------------------------------------ Bedarf

/** Was die eingeschalteten Funktionen in Zammad brauchen */
export function needed(app: App, sys: SystemRow, m = getMapping(app, sys)): { groups: string[]; states: string[]; specs: AttrSpec[]; kinds: ItsmKind[] } {
  const f = getFeatures(app);
  const kinds: ItsmKind[] = [];
  if (f.incidents) kinds.push('incident');
  if (f.maintenance) kinds.push('maintenance');
  if (f.problems) kinds.push('problem');
  const itsm = kinds.length > 0;
  const groups = [...new Set(kinds.map((k) => kindGroup(m, sys, k)).filter(Boolean))];
  const specs = ATTR_SPECS.filter((s) =>
    s.for === 'requests'
    || (s.for === 'approvals' && f.approvals)
    || (s.for === 'itsm' && itsm)
    || (s.for === 'incidents' && f.incidents)
    || (s.for === 'maintenance' && f.maintenance)
    || (s.for === 'problems' && f.problems)
    // Tickets mit einem bekannten Problem verknüpfen geht auch aus Störungen heraus
    || (s.key === 'problemRef' && f.problems));
  return {
    groups,
    states: f.approvals ? [m.approval.state] : [],
    specs,
    kinds,
  };
}

/** Gewünschte Auswahlwerte eines Attributs (fest oder aus dem Portal) */
export function desiredOptions(app: App, systemId: string, spec: AttrSpec, m = getMapping(app, systemId)): Record<string, string> | undefined {
  if (spec.key === 'kind') return Object.fromEntries(ITSM_KINDS.map((k) => [KIND_VALUE[k], m.names.kinds[k]]));
  if (spec.dynamic === 'services') {
    const rows = app.db.all<{ zkey: string | null; name: string }>('SELECT zkey, name FROM services WHERE system_id = ? ORDER BY sort, name', systemId);
    const out = Object.fromEntries(rows.filter((r) => r.zkey).map((r) => [r.zkey!, r.name]));
    return Object.keys(out).length ? out : { allgemein: 'Allgemein' };
  }
  if (spec.dynamic === 'locations') {
    // Auf ein vorhandenes Attribut umgelenkt: dessen Werte gelten, das Portal ergänzt nur gepflegte Standorte
    const locs = getFeatures(app).locations;
    if (!locs.length && m.attrs.locations !== spec.name) return undefined;
    return locs.length ? Object.fromEntries(locs.map((l) => [locationKey(l), l])) : { alle: 'Alle Standorte' };
  }
  return spec.options;
}

/** Schlüssel eines Standorts in Zammad */
export const locationKey = (label: string) => optionKey(label);

// ------------------------------------------------------------------------------------------ Prüfen

export interface SetupReport {
  systemId: string;
  checkedAt: number;
  ready: boolean;
  missing: {
    groups: string[];
    states: string[];
    attributes: { name: string; display: string }[];
    options: { attribute: string; values: string[] }[];
    /** Bezeichnungen, die das Portal nachzieht (Anzeigenamen der Felder bzw. von Auswahlwerten) */
    labels: { attribute: string; from: string; to: string }[];
    overviews: string[];
  };
  /** Was das Portal nicht selbst anlegt (vorhandene Struktur): fehlende Status bzw. Attribute für Zusatzwerte */
  problems: string[];
  /** Hinweise, die nicht blockieren (z. B. Status-Ersatz, gesperrte Abhängigkeiten aus 2.0.0) */
  notes: string[];
  /** Fehlende Abhängigkeiten (Core Workflows „Portal: …“) */
  workflows: string[];
  /** Überschneidungen mit vorhandenen Attributen: Vorschläge zum Übernehmen */
  suggestions: Suggestion[];
  /** Typ und Auswahlwerte der zugeordneten Attribute (für Eingaben in der Verwaltung) */
  attributes: Record<string, { display: string; dataType: string; options: Record<string, string> }>;
  /** Alle übrigen Ticket-Attribute in Zammad (zum Ausblenden je Art, zum Umlenken) */
  others: { name: string; display: string; dataType: string }[];
  /** Aktive Status mit Typ und was das Portal je Rolle setzt */
  states: { name: string; type: string | null }[];
  resolvedStates: Record<StateRole, string | null>;
  groups: string[];
  error: string | null;
}

export type Suggestion =
  | { type: 'attr'; key: AttrKey; attribute: string; display: string; portalDisplay: string }
  | { type: 'kind'; kind: ItsmKind; attribute: string; display: string; value: string; valueLabel: string };

const norm = (s: string) => optionKey(s.replace(/^portal:\s*/i, ''));
/** Ähnliche Namen vorhandener Attribute je Portal-Attribut */
const SYNONYMS: Partial<Record<AttrKey, string[]>> = {
  locations: ['standort', 'standorte', 'location', 'locations', 'ort'],
  services: ['service', 'services', 'dienst', 'dienste', 'it_service'],
  impact: ['auswirkung', 'impact', 'schwere'],
  workaround: ['workaround', 'umgehung', 'loesungsweg'],
  rootCause: ['ursache', 'root_cause', 'grundursache'],
  maintStart: ['wartung_beginn', 'wartungsbeginn', 'wartung_von'],
  maintEnd: ['wartung_ende', 'wartungsende', 'wartung_bis'],
  incidentStart: ['stoerung_beginn', 'stoerungsbeginn', 'stoerung_seit'],
  incidentEnd: ['stoerung_ende', 'behoben_am', 'stoerung_behoben'],
  major: ['major_incident', 'grosse_stoerung', 'grossstoerung'],
  problemStatus: ['problem_status', 'problemstatus'],
};
const SYSTEM_NAMES = new Set(['number', 'title', 'customer_id', 'organization_id', 'group_id', 'owner_id', 'state_id', 'pending_time', 'priority_id', 'tags']);

/** Vorhandene Attribute, die zu Portal-Attributen bzw. Arten passen könnten */
function findSuggestions(info: SetupInfo, m: ZammadMapping, specs: AttrSpec[], kinds: ItsmKind[]): Suggestion[] {
  const out: Suggestion[] = [];
  const portalNames = new Set(Object.values(m.attrs));
  const foreign = info.attributes.filter((a) => !portalNames.has(a.name) && !SYSTEM_NAMES.has(a.name) && !a.name.startsWith('portal_'));
  const compatible = (spec: AttrSpec, a: SetupInfo['attributes'][number]) => {
    if (spec.type === a.dataType) {
      if (!spec.options) return true;
      // Feste Auswahlwerte: nur, wenn das vorhandene Attribut alle schon kennt (Schlüssel oder Anzeige)
      const keys = new Set(Object.keys(a.options).map(norm)), labels = new Set(Object.values(a.options).map(norm));
      return Object.entries(spec.options).every(([k, v]) => keys.has(norm(k)) || labels.has(norm(v)));
    }
    return spec.type === 'multiselect' && spec.dynamic === 'locations' && a.dataType === 'select';
  };
  for (const spec of specs) {
    if (m.attrs[spec.key] !== spec.name || info.attributes.some((a) => a.name === spec.name)) continue; // schon zugeordnet bzw. angelegt
    const words = new Set([norm(spec.display), norm(spec.name.replace(/^portal_/, '')), ...(SYNONYMS[spec.key] ?? [])]);
    const hit = foreign.find((a) => (words.has(norm(a.display)) || words.has(norm(a.name))) && compatible(spec, a));
    if (hit) out.push({ type: 'attr', key: spec.key, attribute: hit.name, display: hit.display, portalDisplay: spec.display });
  }
  for (const k of kinds) {
    if (Object.keys(m.kinds[k].fields).length) continue;
    for (const a of foreign.filter((x) => x.dataType === 'select')) {
      const opt = Object.entries(a.options).find(([key, label]) => norm(label) === norm(KIND_LABEL[k]) || norm(key) === KIND_VALUE[k]);
      if (opt) { out.push({ type: 'kind', kind: k, attribute: a.name, display: a.display, value: opt[0], valueLabel: opt[1] }); break; }
    }
  }
  return out;
}

// ------------------------------------------------------------------------------------------ Abhängigkeiten

/** Core Workflows, die das Portal in Zammad pflegt (Name = Vorsilbe + Bezeichnung, beides anpassbar) */
export function workflowDefs(app: App, sys: SystemRow, m = getMapping(app, sys)): WorkflowDef[] {
  if (!m.workflows) return [];
  const need = needed(app, sys, m);
  const names = (keys: AttrKey[]) => keys.filter((k) => need.specs.some((s) => s.key === k)).map((k) => m.attrs[k]);
  const all = need.specs.filter((s) => s.key !== 'kind').map((s) => m.attrs[s.key]);
  const defs: WorkflowDef[] = [];
  if (!all.length) return defs;
  const P = m.names.workflowPrefix;
  // Grundregel: Portal-Felder sind ausgeblendet; nur „Portal: Art“ bleibt als Schalter sichtbar
  defs.push({ key: 'hide', name: `${P}Felder ausblenden`, priority: 9000, condition: {}, perform: Object.fromEntries(all.map((n) => [n, 'hide'])) });
  if (need.specs.some((s) => s.key === 'form')) defs.push({ key: 'form', name: `${P}${attrLabel(m, 'form').replace(/^Portal: /, '')}`, priority: 9001, condition: { [m.attrs.form]: { operator: 'is set' } }, perform: { [m.attrs.form]: 'show' } });
  const approval = names(APPROVAL_ATTRS);
  if (approval.length) defs.push({ key: 'approval', name: `${P}Freigabe`, priority: 9002, condition: { [m.attrs.approvalStatus]: { operator: 'is set' } }, perform: Object.fromEntries(approval.map((n) => [n, 'show'])) });
  for (const [key, label] of [['incidentRef', 'Betroffen von Störung'], ['problemRef', 'Bekanntes Problem']] as const) {
    if (names([key]).length) defs.push({ key, name: `${P}${label}`, priority: 9003, condition: { [m.attrs[key]]: { operator: 'is set' } }, perform: { [m.attrs[key]]: 'show' } });
  }
  for (const k of need.kinds) {
    const perform: Record<string, 'show' | 'hide'> = Object.fromEntries(names(KIND_ATTRS[k]).map((n) => [n, 'show']));
    for (const n of m.kinds[k].hide) perform[n] = 'hide';
    defs.push({ key: `kind-${k}`, name: `${P}${m.names.kinds[k]}`, priority: 9010 + ITSM_KINDS.indexOf(k), condition: { [m.attrs.kind]: { operator: 'is', value: [KIND_VALUE[k]] } }, perform });
  }
  return defs;
}

/**
 * Zammad zeigt über die API nur Core Workflows mit „changeable“. Workflows aus 2.0.0 wurden ohne angelegt – Zammad
 * meldet dann beim Anlegen „Name has already been taken“, ändern lassen sie sich nicht. Solche Namen merkt sich das
 * Portal je Ticketsystem und meldet sie als Hinweis, statt sie immer wieder anlegen zu wollen.
 */
const lockedKey = (sysId: string) => `zammad.locked_workflows.${sysId}`;
export function lockedWorkflows(app: App, sysId: string): string[] {
  const row = app.db.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', lockedKey(sysId));
  return row ? parseJson<string[]>(row.value, []) : [];
}
function setLockedWorkflows(app: App, sysId: string, names: string[]): void {
  app.db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', lockedKey(sysId), JSON.stringify([...new Set(names)].sort()));
}
/** Befehl, mit dem die Zammad-Verwaltung gesperrte Portal-Workflows einmalig freigibt */
export const UNLOCK_COMMAND = `zammad run rails r "CoreWorkflow.where(changeable: false).where('note LIKE ? OR name LIKE ?', '%Self-Service-Portal%', 'Portal: %').update_all(changeable: true)"`;

type WfList = Awaited<ReturnType<ReturnType<typeof connectorFor>['workflows']>>;
/** Vorhandenen Workflow zu einer Definition finden: über die Kennung in der Notiz, sonst über den Namen */
function findWorkflow(have: WfList, d: WorkflowDef) {
  return have.find((w) => w.note.includes(`${WORKFLOW_MARK}${d.key}]`)) ?? have.find((w) => w.name.toLowerCase() === d.name.toLowerCase());
}

// ------------------------------------------------------------------------------------------ Übersichten

export interface OverviewDef { link: string; name: string; prio: number; condition: Record<string, unknown> }

/** Übersichten, die das Portal in Zammad pflegt; erkannt am festen Verweis (link) „portal_…“ */
export function overviewDefs(app: App, sys: SystemRow, info: SetupInfo, m = getMapping(app, sys)): OverviewDef[] {
  if (!m.overviews.enabled) return [];
  const f = getFeatures(app);
  // „offen“ = jeder Status, der nicht vom Typ geschlossen ist – unabhängig vom Namen
  const openIds = info.states.filter((s) => s.active && s.type && !['closed', 'merged', 'removed'].includes(s.type)).map((s) => String(s.id));
  const notClosed = { 'ticket.state_id': { operator: 'is', value: openIds } };
  const b = m.overviews.builtin;
  const out: OverviewDef[] = [];
  const kind = (key: 'incidents' | 'maintenance' | 'problems', k: ItsmKind, on: boolean, prio: number) => {
    if (on && b[key].active) out.push({ link: `portal_${key}`, name: b[key].name, prio, condition: { [`ticket.${m.attrs.kind}`]: { operator: 'is', value: [KIND_VALUE[k]] }, ...notClosed } });
  };
  if (f.approvals && b.approvals.active) out.push({ link: 'portal_approvals', name: b.approvals.name, prio: 2000, condition: { [`ticket.${m.attrs.approvalStatus}`]: { operator: 'is', value: ['ausstehend'] } } });
  kind('incidents', 'incident', f.incidents, 2010);
  kind('maintenance', 'maintenance', f.maintenance, 2020);
  kind('problems', 'problem', f.problems, 2030);
  m.overviews.forms.forEach((fo, i) => {
    if (!app.db.get('SELECT 1 FROM forms WHERE id = ? AND system_id = ?', fo.formId, sys.id)) return;
    out.push({ link: `portal_form_${fo.formId.replace(/-/g, '').slice(0, 12)}`, name: fo.name, prio: 2100 + i, condition: { [`ticket.${m.attrs.form}`]: { operator: 'contains', value: fo.formId }, ...notClosed } });
  });
  return out;
}

function overviewBody(d: OverviewDef, agentRole: number) {
  return {
    name: d.name, link: d.link, prio: d.prio, active: true, role_ids: [agentRole], condition: d.condition,
    order: { by: 'created_at', direction: 'ASC' }, group_by: '',
    view: { d: ['title', 'customer', 'group', 'state', 'owner', 'created_at'], s: ['number', 'title', 'customer', 'group', 'state', 'owner', 'created_at'], m: ['number', 'title', 'customer', 'group', 'state', 'owner', 'created_at'], view_mode_default: 's' },
  };
}

// ------------------------------------------------------------------------------------------ Vergleich

interface Diff {
  missing: SetupReport['missing'];
  problems: string[];
  notes: string[];
  addOptions: { id: number; name: string; display: string; options: Record<string, string>; dataType: string }[];
}

function compare(app: App, sys: SystemRow, info: SetupInfo, m: ZammadMapping): Diff {
  const need = needed(app, sys, m);
  const groups = need.groups.filter((g) => !info.groups.some((x) => x.name === g && x.active));
  const states = need.states.filter((s) => !info.states.some((x) => x.name === s && x.active));
  const problems: string[] = [];
  const notes: string[] = [];
  // Status, die das Portal setzt: Zuordnung, sonst nach Typ – geprüft wird, ob sich jede Rolle auflösen lässt
  for (const role of STATE_ROLES) {
    const preferred = role === 'new' ? m.approval.approvedState : role === 'closed' ? m.approval.closedState : '';
    for (const name of [preferred, m.states[role]].filter(Boolean)) {
      if (!info.states.some((x) => x.name === name && x.active)) notes.push(`Status „${name}“ (${STATE_ROLE_LABEL[role]}) gibt es in Zammad nicht – das Portal nimmt stattdessen „${pickState(info.states, role, m) ?? '–'}“.`);
    }
    if (!pickState(info.states, role, m, preferred)) problems.push(`Kein aktiver Status vom Typ „${role}“ für „${STATE_ROLE_LABEL[role]}“ – bitte in der Zammad-Zuordnung einen Status eintragen.`);
  }
  const attributes: SetupReport['missing']['attributes'] = [];
  const options: SetupReport['missing']['options'] = [];
  const labels: SetupReport['missing']['labels'] = [];
  const addOptions: Diff['addOptions'] = [];
  const queue = (have: SetupInfo['attributes'][number], opts: Record<string, string>, display: string) => {
    const prev = addOptions.find((x) => x.id === have.id);
    if (prev) { Object.assign(prev.options, opts); prev.display = display; } else addOptions.push({ id: have.id, name: have.name, display, options: { ...have.options, ...opts }, dataType: have.dataType });
  };
  for (const spec of need.specs) {
    const name = m.attrs[spec.key];
    const have = info.attributes.find((a) => a.name === name);
    const own = name === spec.name;
    if (!have) { attributes.push({ name, display: attrLabel(m, spec.key) }); continue; }
    // Anzeigename: eigene Felder immer, umgelenkte nur, wenn ausdrücklich umbenannt
    const wantDisplay = own || m.names.attrs[spec.key] ? attrLabel(m, spec.key) : have.display;
    let display = have.display;
    if (wantDisplay !== have.display) { labels.push({ attribute: name, from: have.display, to: wantDisplay }); display = wantDisplay; }
    const want = desiredOptions(app, sys.id, spec, m);
    const opts: Record<string, string> = {};
    if (want && /select/.test(have.dataType)) {
      const lacking = Object.keys(want).filter((k) => !(k in have.options));
      if (lacking.length) options.push({ attribute: name, values: lacking });
      for (const k of lacking) opts[k] = want[k]!;
      // Bezeichnungen fester Werte (z. B. Arten) bei eigenen Feldern nachziehen
      if (own && !spec.dynamic) for (const [k, v] of Object.entries(want)) if (k in have.options && have.options[k] !== v) { opts[k] = v; labels.push({ attribute: name, from: have.options[k]!, to: v }); }
    }
    if (Object.keys(opts).length || display !== have.display) queue(have, opts, display);
  }
  // Zusätzliche Werte für Störungen, Wartungen und Probleme: Attribut muss es geben, fehlende Auswahlwerte ergänzt das Portal
  for (const k of need.kinds) {
    for (const [name, value] of Object.entries(m.kinds[k].fields)) {
      const have = info.attributes.find((a) => a.name === name);
      if (!have) { problems.push(`${m.names.kinds[k]}: Attribut „${name}“ gibt es in Zammad nicht`); continue; }
      if (/select/.test(have.dataType) && !(value in have.options)) {
        queue(have, { [value]: value }, have.display);
        const o = options.find((x) => x.attribute === name);
        if (o) o.values.push(value); else options.push({ attribute: name, values: [value] });
      }
    }
  }
  return { missing: { groups, states, attributes, options, labels, overviews: [] }, problems, notes, addOptions };
}

const reports = new Map<string, SetupReport>();

/** Letztes Prüfergebnis (ohne Zammad-Aufruf) – für Übersicht und Hinweise */
export function lastReport(systemId: string): SetupReport | undefined {
  return reports.get(systemId);
}

export async function checkSetup(app: App, sys: SystemRow): Promise<SetupReport> {
  const base = { systemId: sys.id, checkedAt: Date.now() };
  let report: SetupReport;
  try {
    const m = getMapping(app, sys);
    const c = connectorFor(app, sys);
    const info = await c.setupInfo();
    resetStateCache(sys.id);
    const { missing, problems, notes } = compare(app, sys, info, m);
    const defs = workflowDefs(app, sys, m);
    const have = defs.length ? await c.workflows() : [];
    const locked = lockedWorkflows(app, sys.id);
    const workflows: string[] = [];
    for (const d of defs) {
      const w = findWorkflow(have, d);
      if (w?.active) continue;
      if (!w && locked.includes(d.name)) notes.push(`Abhängigkeit „${d.name}“ ist in Zammad gesperrt (angelegt von Version 2.0.0) und lässt sich über die API nicht ändern. Einmalig auf dem Zammad-Server freigeben: ${UNLOCK_COMMAND}`);
      else workflows.push(d.name);
    }
    const ovDefs = overviewDefs(app, sys, info, m);
    if (ovDefs.length) {
      const list = await c.adminList('overviews');
      missing.overviews = ovDefs.filter((d) => !list.some((o) => o.link === d.link)).map((d) => d.name);
      if (!(await c.adminList('roles')).some((r) => r.name === 'Agent')) problems.push('Rolle „Agent“ fehlt in Zammad – Übersichten lassen sich nicht zuordnen.');
    }
    const need = needed(app, sys, m);
    const portalNames = new Set(Object.values(m.attrs));
    const ready = !missing.groups.length && !missing.states.length && !missing.attributes.length && !missing.options.length && !missing.labels.length
      && !missing.overviews.length && !problems.length && !workflows.length;
    report = {
      ...base, ready, missing, problems, notes, workflows,
      suggestions: findSuggestions(info, m, need.specs, need.kinds),
      attributes: Object.fromEntries(info.attributes.filter((a) => portalNames.has(a.name)).map((a) => [a.name, { display: a.display, dataType: a.dataType, options: a.options }])),
      others: info.attributes.filter((a) => !portalNames.has(a.name) && !SYSTEM_NAMES.has(a.name)).map((a) => ({ name: a.name, display: a.display, dataType: a.dataType })),
      states: info.states.filter((x) => x.active).map((x) => ({ name: x.name, type: x.type })),
      resolvedStates: Object.fromEntries(STATE_ROLES.map((r) => [r, pickState(info.states, r, m, r === 'new' ? m.approval.approvedState : r === 'closed' ? m.approval.closedState : '')])) as Record<StateRole, string | null>,
      groups: info.groups.filter((g) => g.active).map((g) => g.name),
      error: null,
    };
  } catch (err) {
    // Ohne Admin-Rechte liefert Zammad die Attributliste nicht – das Portal kann dann nichts prüfen oder anlegen
    const msg = (err as Error).message;
    report = {
      ...base, ready: false, missing: { groups: [], states: [], attributes: [], options: [], labels: [], overviews: [] }, problems: [], notes: [], workflows: [],
      suggestions: [], attributes: {}, others: [], states: [], resolvedStates: { new: null, open: null, closed: null }, groups: [], error: msg.slice(0, 300),
    };
  }
  reports.set(sys.id, report);
  return report;
}

/** Legt Fehlendes an, zieht Bezeichnungen, Abhängigkeiten und Übersichten nach und prüft danach erneut. Beliebig oft ausführbar. */
export async function applySetup(app: App, sys: SystemRow): Promise<SetupReport & { created: string[] }> {
  const c = connectorFor(app, sys);
  const m = getMapping(app, sys);
  const info = await c.setupInfo();
  const { missing, addOptions } = compare(app, sys, info, m);
  const created: string[] = [];
  for (const g of missing.groups) { await c.createGroup(g); created.push(`Gruppe „${g}“`); }
  for (const s of missing.states) { await c.createState(s, 'open'); created.push(`Status „${s}“`); }
  let migrate = false;
  let position = 1500;
  for (const a of missing.attributes) {
    const spec = ATTR_SPECS.find((s) => m.attrs[s.key] === a.name)!;
    await c.saveAttribute({ name: a.name, display: attrLabel(m, spec.key), dataType: spec.type, options: desiredOptions(app, sys.id, spec, m), position: position++ });
    created.push(`Attribut „${attrLabel(m, spec.key)}“`);
    migrate = true;
  }
  for (const a of addOptions) {
    await c.saveAttribute({ name: a.name, display: a.display, dataType: a.dataType as never, options: a.options }, a.id);
    created.push(`Attribut „${a.display}“ aktualisiert`);
    migrate = true;
  }
  if (migrate) await c.executeMigrations();
  resetStateCache(sys.id);

  // Abhängigkeiten immer neu schreiben – so folgen sie der aktuellen Zuordnung
  const defs = workflowDefs(app, sys, m);
  if (defs.length) {
    const have = await c.workflows();
    const locked = new Set(lockedWorkflows(app, sys.id));
    for (const d of defs) {
      const w = findWorkflow(have, d);
      try {
        if (w) { await c.saveWorkflow(d, w.id); locked.delete(d.name); continue; }
        if (locked.has(d.name)) continue; // gesperrt – siehe Hinweis in der Prüfung
        await c.saveWorkflow(d);
        created.push(`Abhängigkeit „${d.name}“`);
      } catch (err) {
        if (err instanceof ConnectorError && err.status === 422 && /taken|vergeben|already/i.test(err.message)) { locked.add(d.name); continue; }
        if (err instanceof ConnectorError && err.status === 404 && w) {
          // zwischenzeitlich gesperrt oder gelöscht: neu versuchen
          try { await c.saveWorkflow(d); created.push(`Abhängigkeit „${d.name}“`); } catch { locked.add(d.name); }
          continue;
        }
        throw err;
      }
    }
    setLockedWorkflows(app, sys.id, [...locked].filter((n) => defs.some((d) => d.name === n)));
  }

  // Übersichten: anlegen bzw. Name und Bedingung nachziehen
  const ovDefs = overviewDefs(app, sys, await c.setupInfo(), m);
  if (ovDefs.length) {
    const agent = (await c.adminList('roles')).find((r) => r.name === 'Agent')?.id;
    if (agent) {
      const list = await c.adminList('overviews');
      for (const d of ovDefs) {
        const o = list.find((x) => x.link === d.link);
        if (o) await c.adminUpdate('overviews', o.id, overviewBody(d, agent));
        else { await c.adminCreate('overviews', overviewBody(d, agent)); created.push(`Übersicht „${d.name}“`); }
      }
    }
  }
  log.info('Zammad eingerichtet', { system: sys.slug, created });
  return { ...(await checkSetup(app, sys)), created };
}

/** Nach Änderungen an Services oder Standorten: Auswahlwerte in Zammad ergänzen (Fehler nur protokollieren). */
export async function syncOptions(app: App, systemId: string | null, which: 'services' | 'locations'): Promise<void> {
  const systems = systemId ? [getSystem(app, systemId)].filter(Boolean) as SystemRow[] : listSystems(app).filter((s) => s.status === 'active');
  const spec = ATTR_SPECS.find((s) => s.dynamic === which)!;
  for (const sys of systems) {
    try {
      const c = connectorFor(app, sys);
      const name = getMapping(app, sys).attrs[spec.key];
      const have = (await c.setupInfo()).attributes.find((a) => a.name === name);
      if (!have) continue; // noch nicht eingerichtet – „Zammad einrichten“ legt es an
      const want = desiredOptions(app, sys.id, spec);
      if (!want || Object.entries(want).every(([k, v]) => have.options[k] === v)) continue;
      await c.saveAttribute({ name, display: have.display ?? spec.display, dataType: have.dataType as never, options: { ...have.options, ...want } }, have.id);
      await c.executeMigrations();
    } catch (err) {
      log.warn('Auswahlwerte in Zammad nicht aktualisiert', { system: sys.slug, attribute: which, error: (err as Error).message });
    }
  }
}

export function resetSetupCache(): void { reports.clear(); }

/** Prüfung im Worker: alle aktiven Ticketsysteme */
export async function checkAll(app: App): Promise<void> {
  for (const sys of listSystems(app).filter((s) => s.status === 'active')) await checkSetup(app, sys);
}

/** Hinweise für die Übersicht der Verwaltung */
export function setupWarnings(app: App): string[] {
  const out: string[] = [];
  for (const sys of listSystems(app).filter((s) => s.status === 'active')) {
    const r = reports.get(sys.id);
    if (!r || r.ready) continue;
    if (r.error) out.push(`${sys.name}: Zammad-Einrichtung nicht prüfbar (${r.error}). Der API-Benutzer braucht Admin-Rechte.`);
    else {
      const n = r.missing.groups.length + r.missing.states.length + r.missing.attributes.length + r.missing.options.length + r.missing.labels.length + r.missing.overviews.length + r.workflows.length;
      if (n) out.push(`${sys.name}: In Zammad fehlt etwas für das Portal (${n} Punkte). Ticketsysteme → Zammad-Zuordnung → „In Zammad einrichten“.`);
      for (const p of r.problems) out.push(`${sys.name}: ${p}`);
    }
  }
  return out;
}

/** Liste für ein Attribut passend zu seinem Typ in Zammad (Mehrfachauswahl auf Einfachauswahl umgelenkt: erster Wert) */
export function listValue(app: App, sys: SystemRow, key: AttrKey, values: string[]): string[] | string | null {
  const m = getMapping(app, sys);
  const type = reports.get(sys.id)?.attributes[m.attrs[key]]?.dataType;
  if (type === 'select' || type === 'tree_select') return values[0] ?? null;
  return values;
}

/** Werte eines Listen-Attributs aus Zammad lesen (Einfach- oder Mehrfachauswahl) */
export function listOf(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String).filter(Boolean);
  return v === null || v === undefined || v === '' ? [] : [String(v)];
}

/** Auswählbare Standorte: Werte des Attributs in Zammad, sonst die unter Funktionen gepflegten */
export function locationChoices(app: App, sys: SystemRow): { value: string; label: string }[] {
  const m = getMapping(app, sys);
  const opts = reports.get(sys.id)?.attributes[m.attrs.locations]?.options;
  if (opts && Object.keys(opts).length) return Object.entries(opts).map(([value, label]) => ({ value, label }));
  return getFeatures(app).locations.map((l) => ({ value: locationKey(l), label: l }));
}

export { ITSM_KINDS };
