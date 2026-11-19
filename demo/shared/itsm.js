// Service-Status, Störungen, Wartungen, Probleme und Funktionsschalter – gemeinsam für Server und Oberfläche.
// Zammad bleibt das führende System für Tickets: Das Portal zeigt den Zustand der Services an, sammelt
// „Ich bin auch betroffen“ statt doppelter Tickets und verknüpft Tickets in Zammad über Tags.

export const SERVICE_STATUSES = ['operational', 'maintenance', 'degraded', 'partial_outage', 'major_outage']         ;
                                                              
export const SERVICE_STATUS_LABEL                                = {
  operational: 'In Betrieb',
  maintenance: 'Wartung',
  degraded: 'Eingeschränkt',
  partial_outage: 'Teilausfall',
  major_outage: 'Ausfall',
};
/** Rangfolge: der schlimmste Zustand gewinnt (Wartung zählt weniger als jede Störung) */
export const statusRank = (s               ) => SERVICE_STATUSES.indexOf(s);
export const worstStatus = (list                 )                => list.reduce((a, b) => (statusRank(b) > statusRank(a) ? b : a), 'operational'                 );

export const INCIDENT_IMPACTS = ['degraded', 'partial_outage', 'major_outage']         ;
                                                               

export const INCIDENT_STATES = ['investigating', 'identified', 'monitoring', 'resolved']         ;
                                                             
export const INCIDENT_STATE_LABEL                                = {
  investigating: 'Wird untersucht',
  identified: 'Ursache gefunden',
  monitoring: 'Behoben, wird beobachtet',
  resolved: 'Behoben',
};

export const PROBLEM_STATES = ['open', 'analysis', 'known_error', 'resolved', 'closed']         ;
                                                           
export const PROBLEM_STATE_LABEL                               = {
  open: 'Neu',
  analysis: 'In Analyse',
  known_error: 'Bekannter Fehler',
  resolved: 'Gelöst',
  closed: 'Geschlossen',
};

export const incidentNumber = (n        ) => `INC-${String(n).padStart(4, '0')}`;
export const problemNumber = (n        ) => `PRB-${String(n).padStart(4, '0')}`;
/** Tags in Zammad: Tickets zu einer Störung bzw. einem Problem finden sich dort über diesen Tag */
export const incidentTag = (n        ) => `inc-${String(n).padStart(4, '0')}`;
export const problemTag = (n        ) => `prb-${String(n).padStart(4, '0')}`;

// ------------------------------------------------------------------------------------------ Funktionen

export const FEATURE_KEYS = ['status', 'incidents', 'maintenance', 'problems', 'approvals', 'routing', 'replyNotifications', 'installApp']         ;
                                                       

                           
                  
                     
                       
                    
                     
                   
                              
                                                                                                         
                      
                                                                                                       
                      
                                                                                                    
                            
                                                
                             
 

/** Neue Funktionen sind zunächst aus, bestehende an – ein Update ändert nichts am Verhalten.
 *  Ausnahme: „Als App installierbar“ ändert keinen Ablauf, sondern bietet nur die Installation an. */
export const DEFAULT_FEATURES           = {
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

                                                                                                                           
export const FEATURE_INFO                = [
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
export function normalizeFeatures(input         , base           = DEFAULT_FEATURES)           {
  const out           = { ...base, locations: [...base.locations] };
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out;
  const o = input                           ;
  for (const k of [...FEATURE_KEYS, 'notifyAllOnMajor', 'showAffectedCount']         ) {
    if (o[k] === undefined) continue;
    if (typeof o[k] !== 'boolean') throw new Error(`Einstellung „${k}“ muss an oder aus sein`);
    out[k] = o[k]           ;
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
export const itsmEnabled = (f          ) => f.status || f.incidents || f.maintenance || f.problems;
