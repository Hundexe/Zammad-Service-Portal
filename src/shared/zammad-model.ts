// Abbildung in Zammad (ab 2.0): Zammad ist die einzige Datenquelle für Anfragen, Freigaben, Störungen, Wartungen
// und bekannte Probleme. Das Portal liest und schreibt nur über die API.
//
// Alles ist je Ticketsystem einstellbar (Verwaltung → Ticketsysteme → Zammad-Zuordnung): Namen der Attribute,
// Status, Gruppen, Tags und zusätzliche Werte, mit denen die Tickets in eine bestehende Zammad-Struktur passen
// (z. B. „Ticketart = Störung“ für vorhandene SLAs oder ein Tag, der Eskalationen ausnimmt).
// Die Standardwerte funktionieren ohne Anpassung – das Portal legt dann alles Nötige selbst an.
import { INCIDENT_IMPACTS, INCIDENT_STATE_LABEL, PROBLEM_STATES, PROBLEM_STATE_LABEL, SERVICE_STATUS_LABEL } from './itsm.ts';

/** Schlüssel der Attribute, die das Portal braucht */
export const ATTR_KEYS = [
  'form', 'approvalStatus', 'approver', 'approvalDue', 'approvedAt',
  'kind', 'public', 'services', 'locations', 'impact',
  'major', 'phase', 'incidentStart', 'incidentEnd', 'incidentRef',
  'maintStart', 'maintEnd',
  'problemStatus', 'problemRef', 'workaround', 'rootCause',
] as const;
export type AttrKey = (typeof ATTR_KEYS)[number];

export const ITSM_KINDS = ['incident', 'maintenance', 'problem'] as const;
export type ItsmKind = (typeof ITSM_KINDS)[number];
/** Werte des Attributs „Portal: Art“ */
export const KIND_VALUE: Record<ItsmKind, string> = { incident: 'stoerung', maintenance: 'wartung', problem: 'problem' };
export const KIND_LABEL: Record<ItsmKind, string> = { incident: 'Störung', maintenance: 'Wartung', problem: 'Problem' };

export const APPROVAL_STATUSES = ['ausstehend', 'genehmigt', 'abgelehnt', 'zurueckgezogen', 'abgelaufen', 'abgebrochen'] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];
export const APPROVAL_STATUS_LABEL: Record<ApprovalStatus, string> = {
  ausstehend: 'ausstehend', genehmigt: 'genehmigt', abgelehnt: 'abgelehnt', zurueckgezogen: 'zurückgezogen', abgelaufen: 'abgelaufen', abgebrochen: 'abgebrochen',
};
/** Status im Portal (Oberfläche und API wie bis 1.x) */
export const APPROVAL_STATUS_PORTAL: Record<ApprovalStatus, string> = {
  ausstehend: 'pending', genehmigt: 'approved', abgelehnt: 'rejected', zurueckgezogen: 'withdrawn', abgelaufen: 'expired', abgebrochen: 'cancelled',
};

export type AttrType = 'input' | 'textarea' | 'select' | 'multiselect' | 'boolean' | 'datetime' | 'date' | 'integer';
export interface AttrSpec {
  key: AttrKey;
  /** Standardname in Zammad */
  name: string;
  display: string;
  type: AttrType;
  /** feste Auswahlwerte (Schlüssel → Anzeige) */
  options?: Record<string, string>;
  /** Auswahlwerte kommen aus dem Portal (Services, Standorte) */
  dynamic?: 'services' | 'locations';
  /** gebraucht für … (Funktion) */
  for: 'requests' | 'approvals' | 'itsm' | 'incidents' | 'maintenance' | 'problems';
}

const phases = Object.fromEntries(Object.entries(INCIDENT_STATE_LABEL).filter(([k]) => k !== 'resolved'));
const impacts = Object.fromEntries(INCIDENT_IMPACTS.map((k) => [k, SERVICE_STATUS_LABEL[k]]));
const problemStates = Object.fromEntries(PROBLEM_STATES.map((k) => [k, PROBLEM_STATE_LABEL[k]]));
const kinds = Object.fromEntries(ITSM_KINDS.map((k) => [KIND_VALUE[k], KIND_LABEL[k]]));

/** Alle Attribute mit Standardnamen. Präfix „portal_“, damit nichts mit vorhandenen Attributen kollidiert. */
export const ATTR_SPECS: AttrSpec[] = [
  { key: 'form', name: 'portal_formular', display: 'Portal: Formular', type: 'input', for: 'requests' },
  { key: 'approvalStatus', name: 'portal_freigabe', display: 'Portal: Freigabe', type: 'select', options: { ...APPROVAL_STATUS_LABEL }, for: 'approvals' },
  { key: 'approver', name: 'portal_freigabe_durch', display: 'Portal: Freigabe durch', type: 'input', for: 'approvals' },
  { key: 'approvalDue', name: 'portal_freigabe_bis', display: 'Portal: Freigabe bis', type: 'date', for: 'approvals' },
  { key: 'approvedAt', name: 'portal_freigabe_am', display: 'Portal: entschieden am', type: 'datetime', for: 'approvals' },
  { key: 'kind', name: 'portal_art', display: 'Portal: Art', type: 'select', options: kinds, for: 'itsm' },
  { key: 'public', name: 'portal_anzeigen', display: 'Portal: im Portal anzeigen', type: 'boolean', for: 'itsm' },
  { key: 'services', name: 'portal_services', display: 'Portal: Services', type: 'multiselect', dynamic: 'services', for: 'itsm' },
  { key: 'locations', name: 'portal_standorte', display: 'Portal: Standorte', type: 'multiselect', dynamic: 'locations', for: 'itsm' },
  { key: 'impact', name: 'portal_auswirkung', display: 'Portal: Auswirkung', type: 'select', options: impacts, for: 'itsm' },
  { key: 'major', name: 'portal_grosse_stoerung', display: 'Portal: große Störung', type: 'boolean', for: 'incidents' },
  { key: 'phase', name: 'portal_phase', display: 'Portal: Phase der Störung', type: 'select', options: phases, for: 'incidents' },
  { key: 'incidentStart', name: 'portal_stoerung_beginn', display: 'Portal: Störung seit', type: 'datetime', for: 'incidents' },
  { key: 'incidentEnd', name: 'portal_stoerung_ende', display: 'Portal: Störung behoben am', type: 'datetime', for: 'incidents' },
  { key: 'incidentRef', name: 'portal_stoerung', display: 'Portal: betroffen von Störung', type: 'integer', for: 'incidents' },
  { key: 'maintStart', name: 'portal_wartung_beginn', display: 'Portal: Wartung Beginn', type: 'datetime', for: 'maintenance' },
  { key: 'maintEnd', name: 'portal_wartung_ende', display: 'Portal: Wartung Ende', type: 'datetime', for: 'maintenance' },
  { key: 'problemStatus', name: 'portal_problem_status', display: 'Portal: Problem-Status', type: 'select', options: problemStates, for: 'problems' },
  { key: 'problemRef', name: 'portal_problem', display: 'Portal: bekanntes Problem', type: 'integer', for: 'problems' },
  { key: 'workaround', name: 'portal_workaround', display: 'Portal: Workaround', type: 'textarea', for: 'problems' },
  { key: 'rootCause', name: 'portal_ursache', display: 'Portal: Ursache (intern)', type: 'textarea', for: 'problems' },
];
export const specOf = (key: AttrKey) => ATTR_SPECS.find((s) => s.key === key)!;

export interface KindMapping {
  /** Zammad-Gruppe; leer = Standardgruppe des Ticketsystems */
  group: string;
  /** Zusätzliche Attributwerte beim Anlegen (z. B. eure Ticketart), Name → Wert */
  fields: Record<string, string>;
  tags: string[];
  /** Vorhandene Attribute, die bei dieser Art ausgeblendet werden (Core Workflow in Zammad) */
  hide: string[];
}

export interface ZammadMapping {
  /** Attributnamen in Zammad (Standard: portal_…; umlenkbar auf vorhandene Attribute) */
  attrs: Record<AttrKey, string>;
  approval: {
    /** Status, solange die Freigabe aussteht (wird vom Typ „offen“ angelegt, falls er fehlt) */
    state: string;
    /** Status nach der Freigabe – ab hier bearbeitet die Fachgruppe */
    approvedState: string;
    /** Status nach Ablehnung, Rückzug oder Ablauf */
    closedState: string;
    /** Tags, solange die Freigabe aussteht (z. B. um Eskalationen auszunehmen); danach entfernt */
    pendingTags: string[];
    /** Tag nach der Freigabe */
    approvedTag: string;
    /** E-Mails über Zammad: an die freigebende Person und an die anfragende Person nach der Entscheidung */
    emailApprover: boolean;
    emailRequester: boolean;
  };
  kinds: Record<ItsmKind, KindMapping>;
  /** Tags an den Tickets der Betroffenen einer Störung */
  affectedTags: string[];
  /** Ticket einer betroffenen Person schließen, wenn die Störung behoben ist */
  closeAffected: boolean;
  /** Abhängigkeiten in Zammad pflegen (Core Workflows „Portal: …“): Felder nur zeigen, wo sie gebraucht werden */
  workflows: boolean;
}

export const DEFAULT_MAPPING: ZammadMapping = {
  attrs: Object.fromEntries(ATTR_SPECS.map((s) => [s.key, s.name])) as Record<AttrKey, string>,
  approval: {
    state: 'wartet auf Freigabe', approvedState: 'new', closedState: 'closed',
    pendingTags: [], approvedTag: 'freigegeben', emailApprover: true, emailRequester: true,
  },
  kinds: {
    incident: { group: 'Störungen', fields: {}, tags: [], hide: [] },
    maintenance: { group: 'Wartungen', fields: {}, tags: [], hide: [] },
    problem: { group: 'Probleme', fields: {}, tags: [], hide: [] },
  },
  affectedTags: [],
  closeAffected: true,
  workflows: true,
};

/** Welche Portal-Attribute bei welcher Art sichtbar sind (alle anderen blendet der Core Workflow aus) */
export const KIND_ATTRS: Record<ItsmKind, AttrKey[]> = {
  incident: ['kind', 'public', 'services', 'locations', 'impact', 'major', 'phase', 'incidentStart', 'incidentEnd', 'problemRef'],
  maintenance: ['kind', 'public', 'services', 'locations', 'maintStart', 'maintEnd'],
  problem: ['kind', 'public', 'services', 'problemStatus', 'workaround', 'rootCause'],
};
/** Attribute einer Freigabe */
export const APPROVAL_ATTRS: AttrKey[] = ['approvalStatus', 'approver', 'approvalDue', 'approvedAt'];

const NAME_RE = /^[a-z][a-z0-9_]{1,60}$/;
const RESERVED = ['title', 'customer_id', 'group_id', 'owner_id', 'state_id', 'priority_id', 'organization_id', 'pending_time', 'tags', 'number', 'id', 'group', 'state', 'priority', 'customer', 'owner', 'article'];
const textOk = (v: unknown, max: number) => typeof v === 'string' && v.trim().length > 0 && v.trim().length <= max && !/[\u0000-\u001f]/.test(v);

function tagList(v: unknown, label: string): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > 10) throw new Error(`${label}: höchstens 10 Tags`);
  return [...new Set(v.map((t) => {
    if (!textOk(t, 60) || /,/.test(String(t))) throw new Error(`${label}: ungültiger Tag „${String(t).slice(0, 60)}“`);
    return String(t).trim();
  }))];
}

/**
 * Prüft eine Zuordnung aus der Verwaltung (oder gespeichertes JSON) und ergänzt fehlende Werte mit dem Standard.
 * Wirft bei ungültigen Angaben einen Error mit verständlicher Meldung.
 */
export function normalizeMapping(raw: unknown): ZammadMapping {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>;
  const d = DEFAULT_MAPPING;
  const attrs = { ...d.attrs };
  for (const k of ATTR_KEYS) {
    const v = r.attrs?.[k];
    if (v === undefined || v === '') continue;
    if (typeof v !== 'string' || !NAME_RE.test(v) || RESERVED.includes(v) || /_ids?$/.test(v)) throw new Error(`Attributname „${String(v).slice(0, 60)}“ ist ungültig (Kleinbuchstaben, Ziffern, Unterstrich; nicht auf _id endend)`);
    attrs[k] = v;
  }
  const names = Object.values(attrs);
  const dup = names.find((n, i) => names.indexOf(n) !== i);
  if (dup) throw new Error(`Attribut „${dup}“ ist mehrfach zugeordnet`);
  const a = r.approval ?? {};
  const state = (key: 'state' | 'approvedState' | 'closedState') => {
    const v = a[key];
    if (v === undefined || v === '') return d.approval[key];
    if (!textOk(v, 60)) throw new Error('Status ungültig');
    return String(v).trim();
  };
  const approval = {
    state: state('state'), approvedState: state('approvedState'), closedState: state('closedState'),
    pendingTags: tagList(a.pendingTags, 'Tags während der Freigabe'),
    approvedTag: a.approvedTag === '' ? '' : a.approvedTag === undefined ? d.approval.approvedTag : tagList([a.approvedTag], 'Tag nach Freigabe')[0]!,
    emailApprover: a.emailApprover === undefined ? d.approval.emailApprover : a.emailApprover === true,
    emailRequester: a.emailRequester === undefined ? d.approval.emailRequester : a.emailRequester === true,
  };
  if (approval.state === approval.approvedState) throw new Error('„Wartet auf Freigabe“ und „nach der Freigabe“ müssen verschiedene Status sein');
  const kindsOut = {} as Record<ItsmKind, KindMapping>;
  for (const k of ITSM_KINDS) {
    const m = r.kinds?.[k] ?? {};
    const group = m.group === undefined ? d.kinds[k].group : m.group === '' ? '' : textOk(m.group, 160) ? String(m.group).trim() : (() => { throw new Error(`Gruppe für ${KIND_LABEL[k]} ungültig`); })();
    const fields: Record<string, string> = {};
    for (const [n, v] of Object.entries(m.fields ?? {})) {
      if (!NAME_RE.test(n) || RESERVED.includes(n) || names.includes(n)) throw new Error(`${KIND_LABEL[k]}: Attribut „${n.slice(0, 60)}“ ist hier nicht erlaubt`);
      if (!textOk(v, 200)) throw new Error(`${KIND_LABEL[k]}: Wert für „${n}“ fehlt oder ist zu lang`);
      fields[n] = String(v).trim();
    }
    if (Object.keys(fields).length > 5) throw new Error(`${KIND_LABEL[k]}: höchstens 5 zusätzliche Attribute`);
    const hide: string[] = [];
    if (m.hide !== undefined) {
      if (!Array.isArray(m.hide) || m.hide.length > 40) throw new Error(`${KIND_LABEL[k]}: höchstens 40 auszublendende Felder`);
      for (const n of m.hide) {
        if (typeof n !== 'string' || !NAME_RE.test(n) || names.includes(n) || ['title', 'state_id', 'group_id', 'owner_id', 'priority_id', 'customer_id'].includes(n)) throw new Error(`${KIND_LABEL[k]}: Feld „${String(n).slice(0, 60)}“ lässt sich nicht ausblenden`);
        if (!hide.includes(n)) hide.push(n);
      }
    }
    kindsOut[k] = { group, fields, tags: tagList(m.tags, `Tags für ${KIND_LABEL[k]}`), hide };
  }
  return {
    attrs, approval, kinds: kindsOut,
    affectedTags: tagList(r.affectedTags, 'Tags für Betroffene'),
    closeAffected: r.closeAffected === undefined ? d.closeAffected : r.closeAffected === true,
    workflows: r.workflows === undefined ? d.workflows : r.workflows === true,
  };
}

/** Schlüssel für einen Auswahlwert aus einem Anzeigenamen (Zammad: Kleinbuchstaben, Ziffern, Unterstrich) */
export function optionKey(label: string): string {
  const k = label.toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);
  return k || 'wert';
}

/** Eindeutige Kennung eines Tickets im Portal (Ticketsystem + Ticket-ID), z. B. für /stoerungen/<ref> */
export const ticketRef = (systemId: string, ticketId: number) => `${systemId}.${ticketId}`;
export function parseTicketRef(ref: string): { systemId: string; ticketId: number } | null {
  const m = /^([0-9a-f-]{36})\.(\d{1,12})$/.exec(ref);
  return m ? { systemId: m[1]!, ticketId: Number(m[2]) } : null;
}
