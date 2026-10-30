// Nachrichten aus Zammad für den Verlauf im Portal aufbereiten.
//
// Das Portal zeigt nie fremdes HTML an. Aus dem HTML entstehen einfache Blöcke (Text, Tabelle als
// Feld/Wert-Liste, Signatur, Fußzeile), die der Browser als Text einsetzt. In Zammad bleibt die Nachricht
// unverändert. Zitate früherer Nachrichten (<blockquote>, „Am … schrieb …:“, Outlook-Kopf „Von: … Gesendet:“)
// werden abgetrennt – im Portal stehen die Nachrichten ohnehin untereinander.
//
// Linear: ein Durchlauf mit indexOf; Regexe nur auf einzelnen, begrenzt langen Stücken.

export type Block =
  | { t: 'text'; text: string }
  | { t: 'fields'; rows: [string, string][] }
  | { t: 'signature'; text: string }
  | { t: 'meta'; text: string };

export interface FormattedArticle { blocks: Block[]; quoted: string | null }

const MAX_INPUT = 200_000;
const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', auml: 'ä', ouml: 'ö', uuml: 'ü', Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü',
  szlig: 'ß', euro: '€', ndash: '–', mdash: '—', middot: '·', bull: '•', hellip: '…', laquo: '«', raquo: '»', bdquo: '„', ldquo: '“', rdquo: '”', copy: '©', reg: '®',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{1,10});/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : '';
    }
    return ENTITIES[e] ?? m;
  });
}

/** Zeilen säubern: Leerraum an den Rändern, höchstens eine Leerzeile am Stück */
function tidy(s: string): string {
  const lines = decodeEntities(s).replace(/ /g, ' ').split('\n').map((l) => l.trim());
  const out: string[] = [];
  for (const l of lines) {
    if (!l && (!out.length || !out[out.length - 1])) continue;
    out.push(l);
  }
  while (out.length && !out[out.length - 1]) out.pop();
  return out.join('\n');
}

const BREAK_AFTER = new Set(['p', 'div', 'li', 'tr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'table', 'ul', 'ol', 'pre', 'section', 'article', 'header', 'footer']);
const VOID = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'col', 'area', 'base', 'wbr', 'source']);

interface Cell { text: string }

export function formatHtmlArticle(html: string): FormattedArticle {
  const s = html.slice(0, MAX_INPUT);
  const lower = s.toLowerCase();
  const blocks: Block[] = [];
  let main = '';
  let sig = '';
  let quoted = '';
  let quoteDepth = 0;
  let restQuoted = false; // Outlook/Gmail: ab hier nur noch zitierter Verlauf
  let sigTag = '';
  let sigDepth = 0;
  let preDepth = 0;
  let tableDepth = 0;
  let rows: string[][] = [];
  let row: Cell[] | null = null;
  let cell: Cell | null = null;

  const inQuote = () => quoteDepth > 0 || restQuoted;
  const write = (txt: string) => {
    if (!txt) return;
    if (inQuote()) quoted += txt;
    else if (cell) cell.text += txt;
    else if (sigDepth > 0) sig += txt;
    else main += txt;
  };
  const flushMain = () => {
    const t = tidy(main);
    main = '';
    if (t) pushText(blocks, t);
  };
  const flushTable = () => {
    let fieldRows: [string, string][] = [];
    const closeFields = () => { if (fieldRows.length) blocks.push({ t: 'fields', rows: fieldRows }); fieldRows = []; };
    for (const r of rows) {
      const cells = r.map((c) => tidy(c)).filter((c) => c !== '');
      if (cells.length === 2 && cells[0].length <= 80 && !cells[0].includes('\n')) fieldRows.push([cells[0], cells[1]]);
      else if (cells.length) { closeFields(); pushText(blocks, cells.join('\n')); }
    }
    closeFields();
    rows = [];
  };

  let i = 0;
  while (i < s.length) {
    const lt = s.indexOf('<', i);
    const textEnd = lt < 0 ? s.length : lt;
    if (textEnd > i) {
      const raw = s.slice(i, textEnd);
      // HTML fasst Leerraum zusammen – Zeilenumbrüche im Quelltext sind keine Umbrüche (außer in <pre>)
      write(preDepth > 0 ? raw : raw.replace(/[ \t\r\n\f]+/g, ' '));
    }
    if (lt < 0) break;
    const gt = s.indexOf('>', lt + 1);
    if (gt < 0) { write(s.slice(lt).replace(/[ \t\r\n\f]+/g, ' ')); break; }
    const tag = s.slice(lt + 1, gt);
    i = gt + 1;
    const m = /^\/?([a-zA-Z][a-zA-Z0-9]{0,15})/.exec(tag.slice(0, 18));
    if (!m) continue; // Kommentar, Doctype
    const closing = tag[0] === '/';
    const name = m[1].toLowerCase();

    if (!closing && (name === 'script' || name === 'style' || name === 'head' || name === 'title')) {
      const end = lower.indexOf(`</${name}`, i);
      if (end < 0) break;
      const close = s.indexOf('>', end);
      i = close < 0 ? s.length : close + 1;
      continue;
    }

    if (!closing) {
      // Merkmale nur am Tag selbst prüfen (Länge begrenzt)
      const attrs = tag.length > 2000 ? '' : tag;
      if (!inQuote() && /\bid\s*=\s*["']?(divRplyFwdMsg|appendonsend)\b/i.test(attrs)) restQuoted = true;
      if (!inQuote() && /\bclass\s*=\s*["'][^"']*\b(gmail_quote|moz-cite-prefix)\b/i.test(attrs)) restQuoted = true;
      if (name === 'blockquote') {
        quoteDepth++;
        write('\n');
        continue;
      }
      if (sigDepth > 0 && name === sigTag) sigDepth++;
      else if (sigDepth === 0 && !inQuote() && !VOID.has(name) && /\bdata-signature\s*=\s*["']?true/i.test(attrs)) { sigTag = name; sigDepth = 1; }
      if (name === 'pre') preDepth++;
      if (name === 'br') write('\n');
      else if (name === 'hr') write('\n');
      else if (name === 'li') write('\n• ');
      if (name === 'table' && !inQuote()) {
        tableDepth++;
        if (tableDepth === 1 && sigDepth === 0) { flushMain(); rows = []; }
      } else if (tableDepth === 1 && sigDepth === 0 && !inQuote()) {
        if (name === 'tr') { row = []; cell = null; }
        else if ((name === 'td' || name === 'th') && row) { cell = { text: '' }; row.push(cell); }
      }
      continue;
    }

    // schließende Tags
    if (name === 'blockquote') { if (quoteDepth > 0) quoteDepth--; write('\n'); continue; }
    if (name === 'pre' && preDepth > 0) preDepth--;
    if (name === 'table' && tableDepth > 0 && !inQuote()) {
      tableDepth--;
      if (tableDepth === 0 && sigDepth === 0) { if (row) rows.push(row.map((c) => c.text)); row = null; cell = null; flushTable(); continue; }
    }
    if (tableDepth === 1 && sigDepth === 0 && !inQuote()) {
      if (name === 'td' || name === 'th') { cell = null; continue; }
      if (name === 'tr') { if (row) rows.push(row.map((c) => c.text)); row = null; cell = null; continue; }
    }
    if (BREAK_AFTER.has(name)) write('\n');
    else if (name === 'td' || name === 'th') write(' ');
    if (sigDepth > 0 && name === sigTag) sigDepth--;
  }
  if (row) rows.push(row.map((c) => c.text));
  if (rows.length) flushTable();
  flushMain();
  return finish(blocks, tidy(sig), tidy(quoted));
}

export function formatTextArticle(text: string): FormattedArticle {
  const lines = text.slice(0, MAX_INPUT).replace(/\r\n?/g, '\n').split('\n');
  const main: string[] = [];
  const quoted: string[] = [];
  let sig: string[] | null = null;
  for (const l of lines) {
    if (/^\s*>/.test(l)) quoted.push(l.replace(/^\s*>\s?/, ''));
    else if (sig) sig.push(l);
    else if (l === '-- ' || l === '--') sig = [];
    else main.push(l);
  }
  const blocks: Block[] = [];
  const t = tidy(main.join('\n').replace(/&/g, '&amp;'));
  if (t) pushText(blocks, t);
  return finish(blocks, sig ? tidy(sig.join('\n').replace(/&/g, '&amp;')) : '', tidy(quoted.join('\n').replace(/&/g, '&amp;')));
}

// Auch die alte Fußzeile („… das Service-Portal“) aus Tickets vor 1.11.1
const FOOTER = /^—?\s*Erstellt über das (?:Self-)?Service-Portal\b/;

/** Text in Blöcke; die Fußzeile des Portals („Erstellt über das Self-Service-Portal · Anfrage …“) wird klein gesetzt */
function pushText(blocks: Block[], text: string): void {
  const lines = text.split('\n');
  const idx = lines.findIndex((l) => l.length < 300 && FOOTER.test(l));
  if (idx < 0) { blocks.push({ t: 'text', text }); return; }
  const before = lines.slice(0, idx).join('\n').trim();
  if (before) blocks.push({ t: 'text', text: before });
  blocks.push({ t: 'meta', text: lines[idx].replace(/^—\s*/, '') });
  const after = lines.slice(idx + 1).join('\n').trim();
  if (after) blocks.push({ t: 'text', text: after });
}

// Kopfzeilen zitierter Antworten im Fließtext
const CUT_LINE = [
  /^-{2,}\s*(Original Message|Ursprüngliche Nachricht|Weitergeleitete Nachricht|Forwarded message)\s*-{2,}/i,
  /^(Am|On)\s.{4,200}\s(schrieb|wrote)\b.{0,120}:$/i,
];
const OUTLOOK_FROM = /^(Von|From):\s*\S/i;
const OUTLOOK_NEXT = /^(Gesendet|Sent|Datum|Date|An|To|Betreff|Subject):/i;

/** Zitierten Verlauf im Fließtext abtrennen (Outlook ohne <blockquote> u. Ä.) */
function finish(blocks: Block[], sig: string, quoted: string): FormattedArticle {
  const out: Block[] = [];
  const rest: string[] = quoted ? [quoted] : [];
  let cut = false;
  for (const b of blocks) {
    if (cut) { rest.push(b.t === 'fields' ? b.rows.map(([k, v]) => `${k}: ${v}`).join('\n') : b.text); continue; }
    if (b.t !== 'text') { out.push(b); continue; }
    const lines = b.text.split('\n');
    let at = -1;
    for (let n = 0; n < lines.length && at < 0; n++) {
      const l = lines[n];
      if (l.length > 400) continue;
      if (CUT_LINE.some((re) => re.test(l))) at = n;
      else if (OUTLOOK_FROM.test(l) && lines.slice(n + 1, n + 4).some((x) => x.length < 400 && OUTLOOK_NEXT.test(x))) at = n;
    }
    if (at < 0) { out.push(b); continue; }
    const keep = lines.slice(0, at).join('\n').trim();
    if (!keep && !out.some((x) => x.t === 'text' || x.t === 'fields')) { out.push(b); continue; } // nur Zitat: lieber zeigen als leer
    if (keep) out.push({ t: 'text', text: keep });
    rest.unshift(lines.slice(at).join('\n'));
    cut = true;
  }
  if (sig) {
    // Signatur gehört vor einen abgetrennten Verlauf, nicht dahinter
    out.push({ t: 'signature', text: sig });
  }
  const q = rest.map((x) => x.trim()).filter(Boolean).join('\n\n');
  if (!out.length && q) return { blocks: [{ t: 'text', text: q }], quoted: null };
  return { blocks: out, quoted: q || null };
}

/** Reiner Text aus den Blöcken (für Benachrichtigungen, Tests, ältere Oberflächen) */
export function blocksToText(blocks: Block[]): string {
  return blocks.map((b) => (b.t === 'fields' ? b.rows.map(([k, v]) => `${k}: ${v}`).join('\n') : b.text)).join('\n\n');
}
