// Zammad-Grundausstattung nach ITSM-Praxis (angelehnt an ITIL) – Einstellungen und Standardwerte.
// Das Portal legt damit in einer frischen oder schlanken Zammad-Installation an, was ein IT-Service-Desk
// zum Start braucht: Ticketart, Priorität aus Auswirkung und Dringlichkeit, Status, SLAs mit Kalender,
// automatische Nachrichten, automatisches Schließen, Eskalation und Übersichten.
// Vorhandenes (gleicher Name) wird nie überschrieben; ähnlich benannte Attribute werden gemeldet und übersprungen.

export const BASELINE_PARTS = ['types', 'priority', 'states', 'sla', 'messages', 'autoClose', 'escalation', 'overviews'] as const;
export type BaselinePart = (typeof BASELINE_PARTS)[number];

export const BASELINE_PART_INFO: Record<BaselinePart, { label: string; description: string }> = {
  types: { label: 'Ticketart', description: 'Auswahlfeld „Ticketart“: Störung, Serviceanfrage, Änderung (Change), Problem, Frage.' },
  priority: { label: 'Priorität aus Auswirkung und Dringlichkeit', description: 'Felder „Auswirkung“ (eine Person, eine Gruppe, die ganze Organisation) und „Dringlichkeit“ (gering, mittel, hoch). Trigger setzen daraus die Priorität P1 bis P4.' },
  states: { label: 'Status', description: '„In Bearbeitung“, „Warten auf Rückmeldung“ und „Warten auf Dritte“ (beide halten die SLA an) und „Gelöst“.' },
  sla: { label: 'SLAs mit Arbeitszeiten', description: 'Ein Kalender mit euren Arbeitszeiten und je Priorität eine SLA mit Reaktions- und Lösungszeit.' },
  messages: { label: 'Automatische Nachrichten', description: 'Eingangsbestätigung, E-Mail bei öffentlicher Antwort der IT, Mitteilung bei „Gelöst“; eine Antwort des Kunden öffnet ein wartendes oder gelöstes Ticket wieder.' },
  autoClose: { label: 'Automatisch schließen', description: '„Gelöst“ wird nach einigen Tagen „geschlossen“. Bei „Warten auf Rückmeldung“ erinnert Zammad den Kunden und schließt ohne Antwort später.' },
  escalation: { label: 'Eskalation', description: 'Läuft eine SLA-Zeit ab: Tag „eskaliert“ und Hinweis an Besitzer und Gruppe. Stufe 2 nach weiterer Zeit: Mitteilung an eine Adresse (z. B. Teamleitung). Eine Antwort der IT setzt zurück.' },
  overviews: { label: 'Übersichten', description: 'Für Agenten: Neu, Meine offenen, Warten, Gelöst, Eskaliert, Störungen und – mit Portal-Freigaben – Wartet auf Freigabe.' },
};

export const PRIORITY_NAMES = ['P1 Kritisch', 'P2 Hoch', 'P3 Mittel', 'P4 Niedrig'] as const;
export const IMPACTS = { person: 'Eine Person', gruppe: 'Eine Gruppe / Abteilung', organisation: 'Ganze Organisation' } as const;
export const URGENCIES = { hoch: 'Hoch – Arbeit nicht möglich', mittel: 'Mittel – eingeschränkt', gering: 'Gering – kann warten' } as const;
/** Prioritätsmatrix (Auswirkung × Dringlichkeit → Index in PRIORITY_NAMES) */
export const MATRIX: Record<keyof typeof IMPACTS, Record<keyof typeof URGENCIES, 0 | 1 | 2 | 3>> = {
  organisation: { hoch: 0, mittel: 1, gering: 2 },
  gruppe: { hoch: 1, mittel: 2, gering: 3 },
  person: { hoch: 2, mittel: 3, gering: 3 },
};
export const TICKET_TYPES = { stoerung: 'Störung', serviceanfrage: 'Serviceanfrage', change: 'Änderung (Change)', problem: 'Problem', frage: 'Frage' } as const;

export const STATE_NAMES = { working: 'In Bearbeitung', waitingCustomer: 'Warten auf Rückmeldung', waitingThird: 'Warten auf Dritte', resolved: 'Gelöst' } as const;

export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export interface BaselineOptions {
  parts: Record<BaselinePart, boolean>;
  calendar: { name: string; timezone: string; days: Weekday[]; from: string; to: string };
  /** Minuten Arbeitszeit je Priorität (P1 … P4) */
  sla: { response: [number, number, number, number]; solution: [number, number, number, number] };
  autoClose: { resolvedDays: number; remindDays: number; closeDays: number };
  escalation: { stage2Hours: number; stage2Email: string };
  /** Link für Kunden in den Nachrichten (z. B. das Portal); leer = kein Link */
  customerLink: string;
}

export const DEFAULT_BASELINE: BaselineOptions = {
  parts: { types: true, priority: true, states: true, sla: true, messages: true, autoClose: true, escalation: true, overviews: true },
  calendar: { name: 'IT-Servicezeiten', timezone: 'Europe/Berlin', days: ['mon', 'tue', 'wed', 'thu', 'fri'], from: '08:00', to: '17:00' },
  sla: { response: [30, 60, 240, 480], solution: [240, 480, 1440, 2400] },
  autoClose: { resolvedDays: 5, remindDays: 3, closeDays: 10 },
  escalation: { stage2Hours: 4, stage2Email: '' },
  customerLink: '',
};

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const int = (v: unknown, min: number, max: number, label: string): number => {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${label}: ganze Zahl von ${min} bis ${max}`);
  return n;
};

export function normalizeBaseline(raw: unknown): BaselineOptions {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>;
  const d = DEFAULT_BASELINE;
  const parts = { ...d.parts };
  for (const k of BASELINE_PARTS) if (r.parts?.[k] !== undefined) parts[k] = r.parts[k] === true;
  const c = { ...d.calendar, ...(r.calendar ?? {}) };
  if (typeof c.name !== 'string' || !c.name.trim() || c.name.length > 100) throw new Error('Name des Kalenders fehlt');
  if (typeof c.timezone !== 'string' || !/^[A-Za-z_]+(\/[A-Za-z_+-]+){0,2}$/.test(c.timezone)) throw new Error('Zeitzone ungültig (z. B. Europe/Berlin)');
  if (!Array.isArray(c.days) || !c.days.length || c.days.some((x: unknown) => !(WEEKDAYS as readonly unknown[]).includes(x))) throw new Error('Arbeitstage ungültig');
  if (!TIME.test(c.from) || !TIME.test(c.to) || c.from >= c.to) throw new Error('Arbeitszeit ungültig (z. B. 08:00 bis 17:00)');
  const four = (v: unknown, fb: number[], label: string) => {
    const a = Array.isArray(v) ? v : fb;
    if (a.length !== 4) throw new Error(`${label}: vier Werte (P1 bis P4)`);
    return a.map((x, i) => int(x, 5, 60 * 24 * 30, `${label} P${i + 1}`)) as [number, number, number, number];
  };
  const sla = { response: four(r.sla?.response, d.sla.response, 'Reaktionszeit'), solution: four(r.sla?.solution, d.sla.solution, 'Lösungszeit') };
  sla.solution.forEach((x, i) => { if (x < sla.response[i]!) throw new Error(`Lösungszeit P${i + 1} kürzer als die Reaktionszeit`); });
  const a = { ...d.autoClose, ...(r.autoClose ?? {}) };
  const autoClose = { resolvedDays: int(a.resolvedDays, 1, 60, 'Gelöst → geschlossen'), remindDays: int(a.remindDays, 1, 60, 'Erinnerung'), closeDays: int(a.closeDays, 1, 120, 'Schließen ohne Antwort') };
  if (autoClose.closeDays <= autoClose.remindDays) throw new Error('Schließen ohne Antwort muss nach der Erinnerung liegen');
  const e = { ...d.escalation, ...(r.escalation ?? {}) };
  const stage2Email = typeof e.stage2Email === 'string' ? e.stage2Email.trim() : '';
  if (stage2Email && !/^[^\s@<>()[\]\\,;:"]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,63}$/.test(stage2Email)) throw new Error('Adresse für Eskalationsstufe 2 ungültig');
  const link = typeof r.customerLink === 'string' ? r.customerLink.trim() : d.customerLink;
  if (link && !/^https:\/\/[^\s"'<>]{3,300}$/.test(link)) throw new Error('Link für Kunden muss mit https:// beginnen');
  return {
    parts, calendar: { name: c.name.trim(), timezone: c.timezone, days: [...new Set(c.days as Weekday[])], from: c.from, to: c.to },
    sla, autoClose, escalation: { stage2Hours: int(e.stage2Hours, 1, 168, 'Stufe 2 nach Stunden'), stage2Email }, customerLink: link,
  };
}
