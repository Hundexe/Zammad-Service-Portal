// Service-Status, Störungen, Wartungen, Probleme und Funktionsschalter – gemeinsam für Server und Oberfläche.
// Zammad bleibt das führende System für Tickets: Das Portal zeigt den Zustand der Services an, sammelt
// „Ich bin auch betroffen“ statt doppelter Tickets und verknüpft Tickets in Zammad über Tags.

export const SERVICE_STATUSES = ['operational', 'maintenance', 'degraded', 'partial_outage', 'major_outage'] as const;
export type ServiceStatus = (typeof SERVICE_STATUSES)[number];
export const SERVICE_STATUS_LABEL: Record<ServiceStatus, string> = {
  operational: 'In Betrieb',
  maintenance: 'Wartung',
  degraded: 'Eingeschränkt',
  partial_outage: 'Teilausfall',
  major_outage: 'Ausfall',
};
/** Rangfolge: der schlimmste Zustand gewinnt (Wartung zählt weniger als jede Störung) */
export const statusRank = (s: ServiceStatus) => SERVICE_STATUSES.indexOf(s);
export const worstStatus = (list: ServiceStatus[]): ServiceStatus => list.reduce((a, b) => (statusRank(b) > statusRank(a) ? b : a), 'operational' as ServiceStatus);

export const INCIDENT_IMPACTS = ['degraded', 'partial_outage', 'major_outage'] as const;
export type IncidentImpact = (typeof INCIDENT_IMPACTS)[number];

export const INCIDENT_STATES = ['investigating', 'identified', 'monitoring', 'resolved'] as const;
export type IncidentState = (typeof INCIDENT_STATES)[number];
export const INCIDENT_STATE_LABEL: Record<IncidentState, string> = {
  investigating: 'Wird untersucht',
  identified: 'Ursache gefunden',
  monitoring: 'Behoben, wird beobachtet',
  resolved: 'Behoben',
};

export const PROBLEM_STATES = ['open', 'analysis', 'known_error', 'resolved', 'closed'] as const;
export type ProblemState = (typeof PROBLEM_STATES)[number];
export const PROBLEM_STATE_LABEL: Record<ProblemState, string> = {
  open: 'Neu',
  analysis: 'In Analyse',
  known_error: 'Bekannter Fehler',
  resolved: 'Gelöst',
  closed: 'Geschlossen',
};

export const incidentNumber = (n: number) => `INC-${String(n).padStart(4, '0')}`;
export const problemNumber = (n: number) => `PRB-${String(n).padStart(4, '0')}`;
/** Tags in Zammad: Tickets zu einer Störung bzw. einem Problem finden sich dort über diesen Tag */
export const incidentTag = (n: number) => `inc-${String(n).padStart(4, '0')}`;
export const problemTag = (n: number) => `prb-${String(n).padStart(4, '0')}`;

// ------------------------------------------------------------------------------------------ Funktionen

export const FEATURE_KEYS = ['status', 'incidents', 'maintenance', 'problems', 'approvals', 'routing', 'replyNotifications', 'installApp'] as const;
export type FeatureKey = (typeof FEATURE_KEYS)[number];

export interface Features {
  status: boolean;
  incidents: boolean;
  maintenance: boolean;
  problems: boolean;
  approvals: boolean;
  routing: boolean;
  replyNotifications: boolean;
  /** Portal lässt sich als App installieren (Web-App-Manifest, Service Worker, Verteilung per Intune) */
  installApp: boolean;
  /** Standorte, die bei Störungen und Wartungen auswählbar sind (z. B. „Zentrale“, „Standort Nord“) */
  locations: string[];
  /** Bei einer großen Störung alle Benutzer des Ticketsystems benachrichtigen (sonst nur Banner) */
  notifyAllOnMajor: boolean;
  /** Anzahl der Betroffenen im Portal zeigen */
  showAffectedCount: boolean;
}

/** Neue Funktionen sind zunächst aus, bestehende an – ein Update ändert nichts am Verhalten.
 *  Ausnahme: „Als App installierbar“ ändert keinen Ablauf, sondern bietet nur die Installation an. */
export const DEFAULT_FEATURES: Features = {
  status: false,
  incidents: false,
  maintenance: false,
  problems: false,
  approvals: true,
  routing: true,
  replyNotifications: true,
  installApp: true,
  locations: [],
  notifyAllOnMajor: false,
  showAffectedCount: true,
};

export interface FeatureInfo { key: FeatureKey; label: string; description: string; group: 'itsm' | 'requests' | 'portal' }
export const FEATURE_INFO: FeatureInfo[] = [
  { key: 'status', group: 'itsm', label: 'Service-Status', description: 'Status-Seite mit allen IT-Services und ihrem Zustand. Der Zustand ergibt sich aus Störungen und Wartungen oder wird von Hand gesetzt.' },
  { key: 'incidents', group: 'itsm', label: 'Störungen', description: 'Die IT veröffentlicht Störungen mit laufenden Updates. Große Störungen erscheinen als Banner. Mitarbeitende melden sich mit „Ich bin auch betroffen“ statt mit einem eigenen Ticket und bekommen jedes Update.' },
  { key: 'maintenance', group: 'itsm', label: 'Geplante Wartungen', description: 'Wartungsfenster werden vorab angekündigt und setzen die betroffenen Services während der Wartung automatisch auf „Wartung“.' },
  { key: 'problems', group: 'itsm', label: 'Bekannte Probleme', description: 'Problem-Management: Ursache, Workaround und verknüpfte Störungen und Zammad-Tickets. Freigegebene bekannte Fehler sehen die Mitarbeitenden mit Workaround.' },
  { key: 'approvals', group: 'requests', label: 'Freigabe durch Vorgesetzte', description: 'Formularfeld „Freigabe durch Vorgesetzte(n)“. Ausgeschaltet gehen neue Anfragen ohne Freigabe direkt an die IT; schon wartende Freigaben laufen weiter.' },
  { key: 'routing', group: 'requests', label: 'Weiterleitung aus Formularen', description: 'Auswahlfelder können Anfragen an ein anderes Ticketsystem leiten. Ausgeschaltet bleibt jede Anfrage im Ticketsystem ihres Formulars.' },
  { key: 'replyNotifications', group: 'requests', label: 'Benachrichtigung bei Antworten', description: 'Antwortet die IT in Zammad, erscheint im Portal eine Nachricht unter der Glocke.' },
  { key: 'installApp', group: 'portal', label: 'Als App installierbar', description: 'Das Portal lässt sich in Edge und Chrome als App installieren – eigenes Fenster, Symbol im Startmenü und in der Taskleiste. Per Intune auch für alle Geräte verteilbar. Ausgeschaltet bieten die Browser keine Installation mehr an.' },
];

/** Prüft und vervollständigt gespeicherte oder übermittelte Einstellungen. Wirft bei ungültigen Werten. */
export function normalizeFeatures(input: unknown, base: Features = DEFAULT_FEATURES): Features {
  const out: Features = { ...base, locations: [...base.locations] };
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out;
  const o = input as Record<string, unknown>;
  for (const k of [...FEATURE_KEYS, 'notifyAllOnMajor', 'showAffectedCount'] as const) {
    if (o[k] === undefined) continue;
    if (typeof o[k] !== 'boolean') throw new Error(`Einstellung „${k}“ muss an oder aus sein`);
    out[k] = o[k] as boolean;
  }
  if (o.locations !== undefined) {
    if (!Array.isArray(o.locations) || o.locations.length > 50) throw new Error('Höchstens 50 Standorte');
    const list = o.locations.map((x) => (typeof x === 'string' ? x.trim() : ''));
    if (list.some((x) => !x || x.length > 80)) throw new Error('Standorte: je 1–80 Zeichen');
    out.locations = [...new Set(list)];
  }
  return out;
}

/** Eine der Funktionen rund um Services aktiv? Dann gibt es Services in der Verwaltung und die Status-Seite. */
export const itsmEnabled = (f: Features) => f.status || f.incidents || f.maintenance || f.problems;
