// Formular-Schema, Validierung und Sichtbarkeitsregeln.
// Dieses Modul läuft unverändert im Browser und auf dem Server: Die Prüfung im
// Browser ist nur Komfort, maßgeblich ist immer die Prüfung auf dem Server.

export const FIELD_TYPES = [
  'text', 'textarea', 'email', 'number', 'date', 'checkbox', 'select', 'multiselect',
  'file', 'zammad', 'info', 'approver',
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

/**
 * Zammad-Ticketfelder, die nie aus einem Formular kommen dürfen: Kunde, Bearbeiter, Gruppe, Status,
 * Organisation usw. setzt das Portal selbst bzw. Zammad. Sonst könnte ein Formular z. B. Tickets
 * einem fremden Kunden zuordnen oder in eine nicht vorgesehene Gruppe legen.
 */
export const PROTECTED_ZAMMAD_FIELDS = [
  'id', 'number', 'title', 'group', 'group_id', 'owner', 'owner_id', 'customer', 'customer_id', 'organization', 'organization_id',
  'state', 'state_id', 'priority', 'priority_id', 'pending_time', 'article', 'tags', 'type', 'created_by', 'created_by_id',
  'updated_by', 'updated_by_id', 'created_at', 'updated_at', 'close_at', 'escalation_at', 'time_unit', 'preferences',
];
export function isProtectedZammadField(name: string): boolean {
  return PROTECTED_ZAMMAD_FIELDS.includes(name) || /_ids?$/.test(name);
}

export const MAPPING_TARGETS = ['article', 'title', 'zammad_field', 'tag', 'group', 'priority', 'none'] as const;
export type MappingTarget = (typeof MAPPING_TARGETS)[number];

export const FILE_KINDS = ['pdf', 'image', 'office', 'text'] as const;
export type FileKind = (typeof FILE_KINDS)[number];

export interface FieldOption { value: string; label: string }

export interface VisibleIf {
  field: string;
  op: 'eq' | 'neq' | 'in' | 'notEmpty';
  value?: string | string[];
}

export interface FieldMapping {
  target: MappingTarget;
  /** Name des Zammad-Feldes (bei zammad_field) */
  name?: string;
  /** Übersetzt Formularwerte in Zammad-Werte, z. B. Gruppenname */
  valueMap?: Record<string, string>;
}

export interface FormField {
  id: string;
  type: FieldType;
  label: string;
  help?: string;
  required?: boolean;
  placeholder?: string;
  default?: string;
  defaultFrom?: 'user.name' | 'user.email' | 'user.department';
  options?: FieldOption[];
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  patternMessage?: string;
  min?: number;
  max?: number;
  maxFiles?: number;
  maxSizeMb?: number;
  accept?: FileKind[];
  /** Name des freigegebenen Zammad-Ticket-Attributs (Feldtyp "zammad") */
  attribute?: string;
  /** Teilmenge der erlaubten Werte des Zammad-Attributs (leer = alle freigegebenen) */
  allowedValues?: string[];
  /** Freigabe-Feld: nur Personen erlauben, die sich schon einmal im Portal angemeldet haben */
  knownOnly?: boolean;
  /** Freigabe-Feld: freigebende Person muss Mitglied einer dieser Entra-Gruppen (bzw. approle:…) sein */
  approverGroups?: string[];
  /** Feld nur für Mitglieder dieser Entra-Gruppen anzeigen (leer = alle) */
  groups?: string[];
  visibleIf?: VisibleIf;
  mapping?: FieldMapping;
}

export interface FormSettings {
  titleTemplate: string;
  bodyTemplate: string;
  group?: string;
  priority?: string;
  tags?: string[];
  successText?: string;
}

export interface FormDefinition {
  fields: FormField[];
  settings: FormSettings;
}

export type FormValues = Record<string, unknown>;

export interface FileMeta { name: string; size: number; type?: string }

export interface ValidationContext {
  /** Reserviert für spätere Erweiterungen */
  strict?: boolean;
}

export interface ValidationResult {
  ok: boolean;
  errors: Record<string, string>;
  values: FormValues;
}

export const LIMITS = {
  maxFields: 60,
  maxOptions: 200,
  maxTextLength: 10000,
  defaultTextLength: 500,
  defaultTextareaLength: 5000,
  maxPatternLength: 200,
  maxFilesPerField: 10,
  maxFileSizeMb: 20,
  maxTotalUploadMb: 25,
  idPattern: /^[a-z][a-z0-9_]{0,39}$/,
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,63}$/;

function isEmpty(v: unknown): boolean {
  if (v === undefined || v === null) return true;
  if (typeof v === 'string') return v.trim() === '';
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'boolean') return v === false;
  return false;
}

/** Wertet die Sichtbarkeitsregel eines Feldes aus. */
export function isVisible(field: FormField, values: FormValues, fields: FormField[]): boolean {
  const rule = field.visibleIf;
  if (!rule) return true;
  const other = fields.find((f) => f.id === rule.field);
  // Ein Feld ist nur sichtbar, wenn das Feld, von dem es abhängt, selbst sichtbar ist.
  if (!other || !isVisible(other, values, fields.filter((f) => f.id !== field.id))) return false;
  const raw = values[rule.field];
  const current = Array.isArray(raw) ? raw.map(String) : raw === undefined || raw === null ? '' : String(raw);
  switch (rule.op) {
    case 'eq':
      return Array.isArray(current) ? current.includes(String(rule.value ?? '')) : current === String(rule.value ?? '');
    case 'neq':
      return Array.isArray(current) ? !current.includes(String(rule.value ?? '')) : current !== String(rule.value ?? '');
    case 'in': {
      const list = Array.isArray(rule.value) ? rule.value.map(String) : String(rule.value ?? '').split(',').map((s) => s.trim());
      return Array.isArray(current) ? current.some((c) => list.includes(c)) : list.includes(current);
    }
    case 'notEmpty':
      return !isEmpty(raw);
    default:
      return false;
  }
}

// Auf dem Server laufen Prüfmuster in der linearen Regex-Engine von V8 (Flag „l“): Laufzeit wächst
// nur linear mit der Eingabe, kein ReDoS. Nicht unterstützt sind Rückverweise, Lookarounds und \p{…}.
// Im Browser (nur Vorschau der eigenen Eingabe) bleibt die normale Engine.
let linearRegex = false;

/** Server: lineare Regex-Engine verwenden (vorher v8.setFlagsFromString('--enable-experimental-regexp-engine')). */
export function useLinearRegex(): boolean {
  try { new RegExp('a', 'l'); linearRegex = true; } catch { linearRegex = false; }
  return linearRegex;
}

/** Muster kompilieren. 'unsupported' = gültiges Muster, das die lineare Engine nicht kann (nur Server). */
function compilePattern(pattern: string): RegExp | 'unsupported' | null {
  if (pattern.length > LIMITS.maxPatternLength) return null;
  const source = `^(?:${pattern})$`;
  try { new RegExp(source, 'u'); } catch { return null; }
  if (!linearRegex) return new RegExp(source, 'u');
  // Die lineare Engine kennt kein Flag „u“: Unicode-Escapes hätten ohne „u“ eine andere Bedeutung
  if (/\\[pP]\{|\\u\{/.test(pattern)) return 'unsupported';
  try { return new RegExp(source, 'l'); } catch { return 'unsupported'; }
}


function textLimit(field: FormField): number {
  const fallback = field.type === 'textarea' ? LIMITS.defaultTextareaLength : LIMITS.defaultTextLength;
  return Math.min(field.maxLength ?? fallback, LIMITS.maxTextLength);
}

/**
 * Prüft die Eingaben eines Benutzers gegen das Formular.
 * Gibt bereinigte Werte zurück: nur bekannte, sichtbare Felder, mit festen Typen.
 */
export function validateSubmission(def: FormDefinition, input: FormValues, _ctx: ValidationContext = {}): ValidationResult {
  const errors: Record<string, string> = {};
  const values: FormValues = {};
  const fields = def.fields;

  for (const field of fields) {
    if (field.type === 'info') continue;
    if (!isVisible(field, input, fields)) continue;
    const raw = Object.prototype.hasOwnProperty.call(input, field.id) ? input[field.id] : undefined;

    if (isEmpty(raw)) {
      // Ein sichtbares Freigabe-Feld ist immer Pflicht – sonst ließe sich die Freigabe einfach überspringen.
      if (field.required || field.type === 'approver') errors[field.id] = field.type === 'approver' ? 'Bitte die freigebende Person angeben' : 'Pflichtfeld';
      continue;
    }

    switch (field.type) {
      case 'text':
      case 'textarea':
      case 'email': {
        if (typeof raw !== 'string') { errors[field.id] = 'Ungültiger Wert'; break; }
        const v = field.type === 'textarea' ? raw.replace(/\r\n/g, '\n') : raw.replace(/[\r\n]+/g, ' ').trim();
        if (v.length > textLimit(field)) { errors[field.id] = `Höchstens ${textLimit(field)} Zeichen`; break; }
        if (field.minLength && v.length < field.minLength) { errors[field.id] = `Mindestens ${field.minLength} Zeichen`; break; }
        if (field.type === 'email' && !EMAIL_RE.test(v)) { errors[field.id] = 'Keine gültige E-Mail-Adresse'; break; }
        if (field.pattern) {
          const re = compilePattern(field.pattern);
          // Ältere Muster, die die lineare Engine nicht kann, werden nicht ausgeführt (nie ReDoS);
          // der Editor verlangt beim nächsten Speichern ein unterstütztes Muster.
          if (re === null || (re instanceof RegExp && !re.test(v))) { errors[field.id] = field.patternMessage || 'Format ungültig'; break; }
        }
        values[field.id] = v;
        break;
      }
      case 'approver': {
        if (typeof raw !== 'string') { errors[field.id] = 'Ungültiger Wert'; break; }
        const v = raw.replace(/\s+/g, '').toLowerCase();
        if (v.length > 254 || !EMAIL_RE.test(v)) { errors[field.id] = 'Bitte die E-Mail-Adresse der freigebenden Person angeben'; break; }
        values[field.id] = v;
        break;
      }
      case 'number': {
        const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
        if (!Number.isFinite(n)) { errors[field.id] = 'Keine Zahl'; break; }
        if (field.min !== undefined && n < field.min) { errors[field.id] = `Mindestens ${field.min}`; break; }
        if (field.max !== undefined && n > field.max) { errors[field.id] = `Höchstens ${field.max}`; break; }
        values[field.id] = n;
        break;
      }
      case 'date': {
        if (typeof raw !== 'string' || !DATE_RE.test(raw) || Number.isNaN(Date.parse(raw + 'T00:00:00Z'))) {
          errors[field.id] = 'Kein gültiges Datum'; break;
        }
        values[field.id] = raw;
        break;
      }
      case 'checkbox': {
        if (raw !== true && raw !== 'true' && raw !== 'on') { errors[field.id] = 'Ungültiger Wert'; break; }
        values[field.id] = true;
        break;
      }
      case 'select': {
        const v = String(raw);
        if (!(field.options ?? []).some((o) => o.value === v)) { errors[field.id] = 'Ungültige Auswahl'; break; }
        values[field.id] = v;
        break;
      }
      case 'multiselect': {
        const arr = Array.isArray(raw) ? raw.map(String) : [String(raw)];
        const allowed = new Set((field.options ?? []).map((o) => o.value));
        if (arr.length > LIMITS.maxOptions || arr.some((v) => !allowed.has(v))) { errors[field.id] = 'Ungültige Auswahl'; break; }
        values[field.id] = [...new Set(arr)];
        break;
      }
      case 'file': {
        if (!Array.isArray(raw)) { errors[field.id] = 'Ungültige Dateien'; break; }
        const max = Math.min(field.maxFiles ?? 3, LIMITS.maxFilesPerField);
        if (raw.length > max) { errors[field.id] = `Höchstens ${max} Dateien`; break; }
        const sizeLimit = Math.min(field.maxSizeMb ?? 10, LIMITS.maxFileSizeMb) * 1024 * 1024;
        const metas: FileMeta[] = [];
        for (const f of raw as FileMeta[]) {
          if (!f || typeof f.name !== 'string' || typeof f.size !== 'number') { errors[field.id] = 'Ungültige Datei'; break; }
          if (f.size > sizeLimit) { errors[field.id] = `Datei „${f.name}“ ist zu groß`; break; }
          metas.push({ name: f.name, size: f.size, type: f.type });
        }
        if (!errors[field.id]) values[field.id] = metas;
        break;
      }
      default:
        // "zammad"-Felder werden vor der Prüfung in konkrete Typen aufgelöst.
        errors[field.id] = 'Feld ist nicht verfügbar';
    }
  }
  return { ok: Object.keys(errors).length === 0, errors, values };
}

/** Prüft ein Formular, das ein Admin speichern will. Gibt eine Liste von Fehlern zurück. */
export function validateDefinition(def: unknown): string[] {
  const problems: string[] = [];
  if (!def || typeof def !== 'object') return ['Formular fehlt'];
  const d = def as FormDefinition;
  if (!Array.isArray(d.fields)) return ['Feldliste fehlt'];
  if (d.fields.length > LIMITS.maxFields) problems.push(`Höchstens ${LIMITS.maxFields} Felder`);
  const ids = new Set<string>();
  const approvers = d.fields.filter((f) => f?.type === 'approver').length;
  if (approvers > 1) problems.push('Ein Formular kann nur ein Feld „Freigabe durch Vorgesetzte(n)“ haben');
  for (const [i, f] of d.fields.entries()) {
    const where = `Feld ${i + 1}`;
    if (!f || typeof f !== 'object') { problems.push(`${where}: ungültig`); continue; }
    if (typeof f.id !== 'string' || !LIMITS.idPattern.test(f.id)) problems.push(`${where}: Feld-ID nur a–z, 0–9, _ (beginnt mit Buchstabe)`);
    else if (ids.has(f.id)) problems.push(`${where}: Feld-ID „${f.id}“ doppelt`);
    else ids.add(f.id);
    if (!(FIELD_TYPES as readonly string[]).includes(f.type)) problems.push(`${where}: unbekannter Typ`);
    if (typeof f.label !== 'string' || f.label.trim() === '' || f.label.length > 200) problems.push(`${where}: Bezeichnung fehlt oder zu lang`);
    if (f.help !== undefined && (typeof f.help !== 'string' || f.help.length > 2000)) problems.push(`${where}: Hilfetext zu lang`);
    if ((f.type === 'select' || f.type === 'multiselect')) {
      if (!Array.isArray(f.options) || f.options.length === 0) problems.push(`${where}: Auswahlfeld braucht Optionen`);
      else if (f.options.length > LIMITS.maxOptions) problems.push(`${where}: zu viele Optionen`);
      else if (f.options.some((o) => typeof o?.value !== 'string' || o.value === '' || typeof o.label !== 'string')) problems.push(`${where}: Optionen brauchen Wert und Bezeichnung`);
    }
    if (f.pattern !== undefined) {
      const re = typeof f.pattern === 'string' ? compilePattern(f.pattern) : null;
      if (re === null) problems.push(`${where}: Prüfmuster ungültig`);
      else if (re === 'unsupported') problems.push(`${where}: Prüfmuster nicht erlaubt – Rückverweise (\\1), Lookarounds ((?=…), (?<=…)) und \\p{…} werden aus Sicherheitsgründen nicht unterstützt`);
    }
    if (f.maxLength !== undefined && (!Number.isInteger(f.maxLength) || f.maxLength < 1 || f.maxLength > LIMITS.maxTextLength)) problems.push(`${where}: Maximallänge 1–${LIMITS.maxTextLength}`);
    if (f.maxFiles !== undefined && (!Number.isInteger(f.maxFiles) || f.maxFiles < 1 || f.maxFiles > LIMITS.maxFilesPerField)) problems.push(`${where}: 1–${LIMITS.maxFilesPerField} Dateien`);
    if (f.maxSizeMb !== undefined && (typeof f.maxSizeMb !== 'number' || f.maxSizeMb <= 0 || f.maxSizeMb > LIMITS.maxFileSizeMb)) problems.push(`${where}: Dateigröße bis ${LIMITS.maxFileSizeMb} MB`);
    if (f.accept !== undefined && (!Array.isArray(f.accept) || f.accept.some((k) => !(FILE_KINDS as readonly string[]).includes(k)))) problems.push(`${where}: unbekannter Dateityp`);
    if (f.type === 'zammad' && !/^[a-z][a-z0-9_]{0,60}$/.test(f.attribute ?? '')) problems.push(`${where}: Zammad-Attribut fehlt`);
    if (f.allowedValues !== undefined && (!Array.isArray(f.allowedValues) || f.allowedValues.some((v) => typeof v !== 'string'))) problems.push(`${where}: erlaubte Werte ungültig`);
    if (f.groups !== undefined && (!Array.isArray(f.groups) || f.groups.some((g) => typeof g !== 'string' || g.length > 200))) problems.push(`${where}: Gruppen ungültig`);
    if (f.mapping) {
      if (!(MAPPING_TARGETS as readonly string[]).includes(f.mapping.target)) problems.push(`${where}: unbekanntes Ziel im Ticket`);
      if (f.mapping.target === 'zammad_field' && !/^[a-z][a-z0-9_]{0,60}$/.test(f.mapping.name ?? '')) problems.push(`${where}: Zammad-Feldname ungültig`);
      else if (f.mapping.target === 'zammad_field' && isProtectedZammadField(f.mapping.name!)) problems.push(`${where}: Das Zammad-Feld „${f.mapping.name}“ setzt das Portal selbst – es darf nicht aus einem Formular kommen`);
    }
    if (f.type === 'approver') {
      if (f.mapping && !['article', 'none'].includes(f.mapping.target)) problems.push(`${where}: Die freigebende Person kann nur in den Tickettext übernommen werden`);
    }
    if (f.knownOnly !== undefined && typeof f.knownOnly !== 'boolean') problems.push(`${where}: Einstellung „nur bekannte Personen“ ungültig`);
    if (f.approverGroups !== undefined && (!Array.isArray(f.approverGroups) || f.approverGroups.length > 20 || f.approverGroups.some((g) => typeof g !== 'string' || !g.trim() || g.length > 200))) problems.push(`${where}: Gruppen der freigebenden Person ungültig (höchstens 20)`);
    if (f.visibleIf) {
      if (!d.fields.some((o) => o?.id === f.visibleIf!.field && o !== f)) problems.push(`${where}: Sichtbarkeitsregel verweist auf unbekanntes Feld`);
      if (!['eq', 'neq', 'in', 'notEmpty'].includes(f.visibleIf.op)) problems.push(`${where}: Sichtbarkeitsregel ungültig`);
    }
  }
  const s = d.settings;
  if (!s || typeof s !== 'object') problems.push('Ticket-Einstellungen fehlen');
  else {
    if (typeof s.titleTemplate !== 'string' || s.titleTemplate.trim() === '' || s.titleTemplate.length > 300) problems.push('Titel-Vorlage fehlt oder zu lang');
    if (typeof s.bodyTemplate !== 'string' || s.bodyTemplate.length > 20000) problems.push('Text-Vorlage fehlt oder zu lang');
    if (s.tags !== undefined && (!Array.isArray(s.tags) || s.tags.some((t) => typeof t !== 'string' || t.length > 60))) problems.push('Tags ungültig');
  }
  return problems;
}

/** Das Freigabe-Feld eines Formulars, wenn es für diese Eingaben sichtbar ist. */
export function activeApproverField(def: FormDefinition, values: FormValues): FormField | undefined {
  return def.fields.find((f) => f.type === 'approver' && isVisible(f, values, def.fields));
}

/** Lesbarer Wert eines Feldes (z. B. Bezeichnung statt Optionswert). */
export function displayValue(field: FormField, value: unknown): string {
  if (value === undefined || value === null) return '';
  switch (field.type) {
    case 'select':
      return field.options?.find((o) => o.value === value)?.label ?? String(value);
    case 'multiselect':
      return (value as string[]).map((v) => field.options?.find((o) => o.value === v)?.label ?? v).join(', ');
    case 'checkbox':
      return value ? 'Ja' : 'Nein';
    case 'file':
      return (value as FileMeta[]).map((f) => f.name).join(', ');
    case 'date': {
      const [y, m, d] = String(value).split('-');
      return `${d}.${m}.${y}`;
    }
    default:
      return String(value);
  }
}
