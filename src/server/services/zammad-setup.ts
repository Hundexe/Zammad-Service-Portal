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
  APPROVAL_ATTRS, ATTR_SPECS, DEFAULT_MAPPING, ITSM_KINDS, KIND_ATTRS, KIND_LABEL, KIND_VALUE, normalizeMapping, optionKey,
  type AttrKey, type AttrSpec, type ItsmKind, type ZammadMapping,
} from '../../shared/zammad-model.ts';
import type { SetupInfo, WorkflowDef } from '../connectors/types.ts';

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
export function needed(app: App, sys: SystemRow, m = getMapping(app, sys)): { groups: string[]; states: string[]; existingStates: string[]; specs: AttrSpec[]; kinds: ItsmKind[] } {
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
    existingStates: f.approvals ? [m.approval.approvedState, m.approval.closedState] : [],
    specs,
    kinds,
  };
}

/** Gewünschte Auswahlwerte eines Attributs (fest oder aus dem Portal) */
export function desiredOptions(app: App, systemId: string, spec: AttrSpec): Record<string, string> | undefined {
  if (spec.dynamic === 'services') {
    const rows = app.db.all<{ zkey: string | null; name: string }>('SELECT zkey, name FROM services WHERE system_id = ? ORDER BY sort, name', systemId);
    const out = Object.fromEntries(rows.filter((r) => r.zkey).map((r) => [r.zkey!, r.name]));
    return Object.keys(out).length ? out : { allgemein: 'Allgemein' };
  }
  if (spec.dynamic === 'locations') {
    // Auf ein vorhandenes Attribut umgelenkt: dessen Werte gelten, das Portal ergänzt nur gepflegte Standorte
    const locs = getFeatures(app).locations;
    if (!locs.length && getMapping(app, systemId).attrs.locations !== spec.name) return undefined;
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
  };
  /** Was das Portal nicht selbst anlegt (vorhandene Struktur): fehlende Status bzw. Attribute für Zusatzwerte */
  problems: string[];
  /** Fehlende Abhängigkeiten (Core Workflows „Portal: …“) */
  workflows: string[];
  /** Überschneidungen mit vorhandenen Attributen: Vorschläge zum Übernehmen */
  suggestions: Suggestion[];
  /** Typ und Auswahlwerte der zugeordneten Attribute (für Eingaben in der Verwaltung) */
  attributes: Record<string, { display: string; dataType: string; options: Record<string, string> }>;
  /** Alle übrigen Ticket-Attribute in Zammad (zum Ausblenden je Art) */
  others: { name: string; display: string }[];
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

const WF_PREFIX = 'Portal: ';
/** Core Workflows, die das Portal in Zammad pflegt */
export function workflowDefs(app: App, sys: SystemRow, m = getMapping(app, sys)): WorkflowDef[] {
  if (!m.workflows) return [];
  const need = needed(app, sys, m);
  const names = (keys: AttrKey[]) => keys.filter((k) => need.specs.some((s) => s.key === k)).map((k) => m.attrs[k]);
  const all = need.specs.filter((s) => s.key !== 'kind').map((s) => m.attrs[s.key]);
  const defs: WorkflowDef[] = [];
  if (!all.length) return defs;
  // Grundregel: Portal-Felder sind ausgeblendet; nur „Portal: Art“ bleibt als Schalter sichtbar
  defs.push({ name: `${WF_PREFIX}Felder ausblenden`, priority: 9000, condition: {}, perform: Object.fromEntries(all.map((n) => [n, 'hide'])) });
  if (need.specs.some((s) => s.key === 'form')) defs.push({ name: `${WF_PREFIX}Formular`, priority: 9001, condition: { [m.attrs.form]: { operator: 'is set' } }, perform: { [m.attrs.form]: 'show' } });
  const approval = names(APPROVAL_ATTRS);
  if (approval.length) defs.push({ name: `${WF_PREFIX}Freigabe`, priority: 9002, condition: { [m.attrs.approvalStatus]: { operator: 'is set' } }, perform: Object.fromEntries(approval.map((n) => [n, 'show'])) });
  for (const [key, label] of [['incidentRef', 'Betroffen von Störung'], ['problemRef', 'Bekanntes Problem']] as const) {
    if (names([key]).length) defs.push({ name: `${WF_PREFIX}${label}`, priority: 9003, condition: { [m.attrs[key]]: { operator: 'is set' } }, perform: { [m.attrs[key]]: 'show' } });
  }
  for (const k of need.kinds) {
    const perform: Record<string, 'show' | 'hide'> = Object.fromEntries(names(KIND_ATTRS[k]).map((n) => [n, 'show']));
    for (const n of m.kinds[k].hide) perform[n] = 'hide';
    defs.push({ name: `${WF_PREFIX}${KIND_LABEL[k]}`, priority: 9010 + ITSM_KINDS.indexOf(k), condition: { [m.attrs.kind]: { operator: 'is', value: [KIND_VALUE[k]] } }, perform });
  }
  return defs;
}

function compare(app: App, sys: SystemRow, info: SetupInfo, m: ZammadMapping): { missing: SetupReport['missing']; problems: string[]; addOptions: { id: number; name: string; options: Record<string, string>; spec?: AttrSpec; dataType: string }[] } {
  const need = needed(app, sys, m);
  const groups = need.groups.filter((g) => !info.groups.some((x) => x.name === g && x.active));
  const states = need.states.filter((s) => !info.states.some((x) => x.name === s && x.active));
  const problems: string[] = [];
  for (const s of need.existingStates) if (!info.states.some((x) => x.name === s && x.active)) problems.push(`Status „${s}“ gibt es in Zammad nicht (Zammad-Zuordnung → Freigaben)`);
  const attributes: SetupReport['missing']['attributes'] = [];
  const options: SetupReport['missing']['options'] = [];
  const addOptions: { id: number; name: string; options: Record<string, string>; spec?: AttrSpec; dataType: string }[] = [];
  for (const spec of need.specs) {
    const name = m.attrs[spec.key];
    const have = info.attributes.find((a) => a.name === name);
    if (!have) { attributes.push({ name, display: spec.display }); continue; }
    const want = desiredOptions(app, sys.id, spec);
    if (want && /select/.test(have.dataType)) {
      const lacking = Object.keys(want).filter((k) => !(k in have.options));
      if (lacking.length) {
        options.push({ attribute: name, values: lacking });
        addOptions.push({ id: have.id, name, options: { ...have.options, ...Object.fromEntries(lacking.map((k) => [k, want[k]!])) }, spec, dataType: have.dataType });
      }
    }
  }
  // Zusätzliche Werte für Störungen, Wartungen und Probleme: Attribut muss es geben, fehlende Auswahlwerte ergänzt das Portal
  for (const k of need.kinds) {
    for (const [name, value] of Object.entries(m.kinds[k].fields)) {
      const have = info.attributes.find((a) => a.name === name);
      if (!have) { problems.push(`${KIND_LABEL[k]}: Attribut „${name}“ gibt es in Zammad nicht`); continue; }
      if (/select/.test(have.dataType) && !(value in have.options)) {
        const prev = addOptions.find((x) => x.id === have.id);
        if (prev) prev.options[value] = value;
        else addOptions.push({ id: have.id, name, options: { ...have.options, [value]: value }, dataType: have.dataType });
        const o = options.find((x) => x.attribute === name);
        if (o) o.values.push(value); else options.push({ attribute: name, values: [value] });
      }
    }
  }
  return { missing: { groups, states, attributes, options }, problems, addOptions };
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
    const { missing, problems } = compare(app, sys, info, m);
    const defs = workflowDefs(app, sys, m);
    const have = defs.length ? await c.workflows() : [];
    const workflows = defs.filter((d) => !have.some((w) => w.name === d.name && w.active)).map((d) => d.name);
    const need = needed(app, sys, m);
    const portalNames = new Set(Object.values(m.attrs));
    const ready = !missing.groups.length && !missing.states.length && !missing.attributes.length && !missing.options.length && !problems.length && !workflows.length;
    report = {
      ...base, ready, missing, problems, workflows,
      suggestions: findSuggestions(info, m, need.specs, need.kinds),
      attributes: Object.fromEntries(info.attributes.filter((a) => portalNames.has(a.name)).map((a) => [a.name, { display: a.display, dataType: a.dataType, options: a.options }])),
      others: info.attributes.filter((a) => !portalNames.has(a.name) && !SYSTEM_NAMES.has(a.name)).map((a) => ({ name: a.name, display: a.display })),
      error: null,
    };
  } catch (err) {
    // Ohne Admin-Rechte liefert Zammad die Attributliste nicht – das Portal kann dann nichts prüfen oder anlegen
    const msg = (err as Error).message;
    report = { ...base, ready: false, missing: { groups: [], states: [], attributes: [], options: [] }, problems: [], workflows: [], suggestions: [], attributes: {}, others: [], error: msg.slice(0, 300) };
  }
  reports.set(sys.id, report);
  return report;
}

/** Legt Fehlendes an und prüft danach erneut. */
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
    await c.saveAttribute({ name: a.name, display: spec.display, dataType: spec.type, options: desiredOptions(app, sys.id, spec), position: position++ });
    created.push(`Attribut „${spec.display}“`);
    migrate = true;
  }
  for (const a of addOptions) {
    const have = info.attributes.find((x) => x.id === a.id)!;
    const display = a.spec?.display ?? a.name;
    await c.saveAttribute({ name: a.name, display: have.display ?? display, dataType: a.dataType as never, options: a.options }, a.id);
    created.push(`Auswahlwerte für „${a.name}“`);
    migrate = true;
  }
  if (migrate) await c.executeMigrations();
  // Abhängigkeiten immer neu schreiben – so folgen sie der aktuellen Zuordnung
  const defs = workflowDefs(app, sys, m);
  if (defs.length) {
    const have = await c.workflows();
    for (const d of defs) {
      const w = have.find((x) => x.name === d.name);
      await c.saveWorkflow(d, w?.id);
      if (!w) created.push(`Abhängigkeit „${d.name}“`);
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
      const want = desiredOptions(app, sys.id, spec)!;
      if (Object.entries(want).every(([k, v]) => have.options[k] === v)) continue;
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
      const n = r.missing.groups.length + r.missing.states.length + r.missing.attributes.length + r.missing.options.length + r.workflows.length;
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
