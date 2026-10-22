// Platzhalter-Vorlagen ohne ausführbaren Code.
// Erlaubt sind nur {{name}} bzw. {{gruppe.name}}. Es gibt keine Schleifen,
// Bedingungen oder Funktionsaufrufe – damit kann eine Vorlage nie Code ausführen.

export interface TemplateVars { [key: string]: string | number | boolean | undefined | null | TemplateVars }

const PLACEHOLDER = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)*)\s*\}\}/g;

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function lookup(vars: TemplateVars, path: string): unknown {
  let cur: unknown = vars;
  for (const part of path.split('.')) {
    if (cur === null || typeof cur !== 'object' || !Object.prototype.hasOwnProperty.call(cur, part)) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/**
 * Ersetzt Platzhalter.
 * mode 'text': Ergebnis ist reiner Text (Zeilenumbrüche werden zu Leerzeichen, max. Länge).
 * mode 'html': Werte werden HTML-escaped; `raw` enthält Platzhalter, deren Wert bereits
 * sicheres HTML ist (z. B. die vom Server erzeugte Feldtabelle).
 */
export function renderTemplate(
  template: string,
  vars: TemplateVars,
  mode: 'text' | 'html',
  raw: Record<string, string> = {},
): string {
  const out = template.replace(PLACEHOLDER, (_m, path: string) => {
    if (mode === 'html' && Object.prototype.hasOwnProperty.call(raw, path)) return raw[path];
    const v = lookup(vars, path);
    if (v === undefined || v === null || typeof v === 'object') return '';
    const s = String(v);
    return mode === 'html' ? escapeHtml(s).replace(/\n/g, '<br>') : s;
  });
  if (mode === 'text') return out.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, 250);
  return out;
}

/** Liefert alle Platzhalter einer Vorlage (für die Vorschau im Editor). */
export function placeholders(template: string): string[] {
  const found = new Set<string>();
  for (const m of template.matchAll(PLACEHOLDER)) found.add(m[1]);
  return [...found];
}

/** Wandelt eine Text-Vorlage mit Zeilenumbrüchen in sicheres HTML um (Text wird escaped). */
export function textToHtml(text: string): string {
  return escapeHtml(text).replace(/\n/g, '<br>');
}
