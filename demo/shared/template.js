// Platzhalter-Vorlagen ohne ausführbaren Code.
// Erlaubt sind nur {{name}} bzw. {{gruppe.name}}. Es gibt keine Schleifen,
// Bedingungen oder Funktionsaufrufe – damit kann eine Vorlage nie Code ausführen.

                                                                                                            

const PLACEHOLDER = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)*)\s*\}\}/g;

export function escapeHtml(s        )         {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function lookup(vars              , path        )          {
  let cur          = vars;
  for (const part of path.split('.')) {
    if (cur === null || typeof cur !== 'object' || !Object.prototype.hasOwnProperty.call(cur, part)) return undefined;
    cur = (cur                           )[part];
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
  template        ,
  vars              ,
  mode                 ,
  raw                         = {},
)         {
  const out = template.replace(PLACEHOLDER, (_m, path        ) => {
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
export function placeholders(template        )           {
  const found = new Set        ();
  for (const m of template.matchAll(PLACEHOLDER)) found.add(m[1]);
  return [...found];
}

/** Wandelt eine Text-Vorlage mit Zeilenumbrüchen in sicheres HTML um (Text wird escaped). */
export function textToHtml(text        )         {
  return escapeHtml(text).replace(/\n/g, '<br>');
}

// ---------------------------------------------------------------- HTML der Text-Vorlage
// Admins schreiben die Text-Vorlage als HTML. Erlaubt ist nur einfache Formatierung – keine Bilder
// (Tracking-Pixel), keine Skripte, keine Formulare, keine Styles; Links nur zu http(s) und mailto.
// Platzhalter dürfen nur im Text stehen, nie in Tags oder Attributen (sonst landete z. B. eine Eingabe
// wie „javascript:…“ in einem Link).
const TEMPLATE_TAGS                           = {
  p: [], br: [], hr: [], strong: [], b: [], em: [], i: [], u: [], small: [], span: [], div: [], code: [], pre: [], blockquote: [],
  h1: [], h2: [], h3: [], h4: [], ul: [], ol: [], li: [],
  table: ['border', 'cellpadding', 'cellspacing', 'width'], thead: [], tbody: [], tr: [],
  th: ['align', 'valign', 'colspan', 'rowspan', 'width'], td: ['align', 'valign', 'colspan', 'rowspan', 'width'],
  a: ['href', 'title'],
};

/** Probleme im HTML einer Text-Vorlage (leer = in Ordnung). */
export function templateHtmlProblems(html        )           {
  const problems = new Set        ();
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt < 0) break;
    if (html.startsWith('<!--', lt)) { const e = html.indexOf('-->', lt + 4); i = e < 0 ? html.length : e + 3; continue; }
    const gt = html.indexOf('>', lt + 1);
    if (gt < 0) { problems.add('unvollständiges Tag'); break; }
    const raw = html.slice(lt + 1, gt);
    i = gt + 1;
    if (raw.includes('{{')) { problems.add('Platzhalter innerhalb eines Tags'); continue; }
    const m = /^\/?\s*([a-zA-Z][a-zA-Z0-9]*)/.exec(raw);
    if (!m) { problems.add(`unbekanntes Konstrukt <${raw.slice(0, 20)}`); continue; }
    const tag = m[1].toLowerCase();
    const allowed = TEMPLATE_TAGS[tag];
    if (!allowed) { problems.add(`<${tag}> ist nicht erlaubt`); continue; }
    if (raw.startsWith('/')) continue;
    const re = /([^\s=/]+)\s*(?:=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
    re.lastIndex = m[0].length;
    let a                        ;
    while ((a = re.exec(raw))) {
      const name = a[1].toLowerCase();
      const value = (a[3] ?? a[4] ?? a[5] ?? '').replace(/&#x?[0-9a-f]+;?/gi, '');
      if (!allowed.includes(name)) { problems.add(`Attribut ${name} an <${tag}> ist nicht erlaubt`); continue; }
      if (name === 'href' && !/^(https?:\/\/|mailto:)/i.test(value.replace(/[\u0000-\u0020]/g, ''))) problems.add('Links nur mit http(s):// oder mailto:');
    }
  }
  return [...problems];
}
