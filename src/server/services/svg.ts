// SVG-Logos: Allowlist statt Blockliste.
//
// Das SVG wird zerlegt und neu geschrieben. Übernommen werden nur bekannte Zeichenelemente und
// Darstellungsattribute; Unbekanntes (Metadaten von Grafikprogrammen, eigene Namensräume) fällt weg.
// Abgelehnt wird alles, was Code ausführen oder Inhalte nachladen kann – geprüft auf den
// dekodierten Werten, damit Entities (&#106;avascript:) und Namensraum-Präfixe (<h:script>) nichts
// verstecken. Ausgeliefert werden Logos zusätzlich mit Sandbox-CSP.
import { HttpError } from '../http/core.ts';

const ELEMENTS = new Set([
  'svg', 'g', 'defs', 'symbol', 'use', 'title', 'desc', 'style',
  'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
  'text', 'tspan', 'textPath',
  'linearGradient', 'radialGradient', 'stop', 'pattern', 'clipPath', 'mask', 'filter',
  'feGaussianBlur', 'feOffset', 'feBlend', 'feColorMatrix', 'feComposite', 'feFlood', 'feMerge', 'feMergeNode', 'feDropShadow', 'feMorphology',
]);
/** Elemente, die Code ausführen, nachladen oder Attribute zur Laufzeit ändern können */
const DANGEROUS = /^(script|foreignobject|iframe|embed|object|image|feimage|a|animate|animatemotion|animatetransform|set|handler|listener|link|meta|base|audio|video|discard)$/i;

const ATTRS = new Set([
  'id', 'class', 'style', 'width', 'height', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'fx', 'fy', 'd', 'points',
  'viewBox', 'preserveAspectRatio', 'version', 'transform', 'opacity', 'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width',
  'stroke-opacity', 'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit', 'stroke-dasharray', 'stroke-dashoffset', 'clip-path',
  'clip-rule', 'mask', 'filter', 'color', 'display', 'visibility', 'offset', 'stop-color', 'stop-opacity', 'gradientUnits',
  'gradientTransform', 'spreadMethod', 'patternUnits', 'patternContentUnits', 'patternTransform', 'clipPathUnits', 'maskUnits',
  'maskContentUnits', 'filterUnits', 'primitiveUnits', 'font-family', 'font-size', 'font-weight', 'font-style', 'text-anchor',
  'dominant-baseline', 'letter-spacing', 'word-spacing', 'dx', 'dy', 'rotate', 'textLength', 'lengthAdjust', 'startOffset',
  'stdDeviation', 'in', 'in2', 'result', 'mode', 'type', 'values', 'operator', 'k1', 'k2', 'k3', 'k4', 'flood-color', 'flood-opacity',
  'radius', 'paint-order', 'vector-effect', 'shape-rendering', 'mix-blend-mode', 'isolation', 'href', 'xlink:href', 'xml:space',
  'xmlns', 'xmlns:xlink', 'role', 'aria-label', 'aria-hidden', 'focusable',
]);
const NS = { xmlns: 'http://www.w3.org/2000/svg', 'xmlns:xlink': 'http://www.w3.org/1999/xlink' } as Record<string, string>;
const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

const fail = (why: string): never => { throw new HttpError(422, `SVG enthält nicht erlaubte Inhalte (${why})`, 'bad_file'); };

function decode(v: string): string {
  return v.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{1,8});?/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : '';
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}
const esc = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// Steuerzeichen und Leerraum entfernen wie ein Browser vor dem Schema
const squash = (v: string) => v.replace(/[\u0000- \u007f-\u009f]/g, '').toLowerCase();

/** CSS (style-Attribut oder <style>): keine externen Verweise, kein Code. */
function checkCss(css: string, where: string): void {
  const c = squash(decode(css)).replace(/\\/g, '');
  if (/@import|expression\(|javascript:|behavior:|-moz-binding|<\/?/.test(c)) fail(`CSS in ${where}`);
  for (const m of c.matchAll(/url\(([^)]*)\)/g)) if (!/^["']?#/.test(m[1])) fail(`externer Verweis in ${where}`);
}

function checkValue(name: string, value: string): string | null {
  const v = decode(value);
  const s = squash(v);
  if (/(javascript|vbscript|data):/.test(s)) fail(`Attribut ${name}`);
  if (name === 'href' || name === 'xlink:href') { if (!v.trim().startsWith('#')) fail('externer Verweis'); return v.trim(); }
  if (name === 'style') checkCss(v, 'style-Attribut');
  if (/url\(/i.test(v) && !/^url\(\s*["']?#[^)]*\)\s*$/i.test(v.trim())) fail(`externer Verweis in ${name}`);
  if (name.startsWith('xmlns')) return NS[name] && v === NS[name] ? v : null;
  return v;
}

export function sanitizeSvg(text: string): string {
  let i = 0;
  const n = text.length;
  let out = '';
  const stack: string[] = [];
  let skip = 0; // > 0: innerhalb eines verworfenen Elements
  let sawRoot = false;
  let inStyle = false;
  while (i < n) {
    const lt = text.indexOf('<', i);
    const chunk = text.slice(i, lt < 0 ? n : lt);
    if (chunk) {
      if (!skip && stack.length) {
        if (inStyle) checkCss(chunk, '<style>');
        out += esc(decode(chunk));
      } else if (!sawRoot && chunk.trim()) fail('Text außerhalb von <svg>');
    }
    if (lt < 0) break;
    if (text.startsWith('<!--', lt)) { const e = text.indexOf('-->', lt + 4); if (e < 0) fail('Kommentar'); i = e + 3; continue; }
    if (text.startsWith('<![CDATA[', lt)) {
      const e = text.indexOf(']]>', lt + 9);
      if (e < 0) fail('CDATA');
      const body = text.slice(lt + 9, e);
      if (!skip && stack.length) { if (inStyle) checkCss(body, '<style>'); out += esc(body); }
      i = e + 3; continue;
    }
    if (text.startsWith('<?', lt)) { const e = text.indexOf('?>', lt + 2); if (e < 0) fail('Verarbeitungsanweisung'); i = e + 2; continue; }
    if (text.startsWith('<!', lt)) fail('DOCTYPE oder ENTITY');
    // Tag lesen (Anführungszeichen beachten)
    let j = lt + 1;
    let quote = '';
    while (j < n) {
      const c = text[j];
      if (quote) { if (c === quote) quote = ''; } else if (c === '"' || c === "'") quote = c; else if (c === '>') break;
      j++;
    }
    if (j >= n) fail('unvollständiges Tag');
    const raw = text.slice(lt + 1, j);
    i = j + 1;
    if (raw.startsWith('/')) {
      const name = raw.slice(1).trim();
      if (skip) { if (--skip === 0) { /* verworfenes Element zu Ende */ } continue; }
      const open = stack.pop();
      if (open !== name) fail('Verschachtelung');
      if (name === 'style') inStyle = false;
      out += `</${name}>`;
      continue;
    }
    const selfClose = raw.endsWith('/');
    const m = /^([A-Za-z_][\w.:-]*)/.exec(raw);
    if (!m) return fail('Tag');
    const tag = m[1];
    const local = tag.includes(':') ? tag.slice(tag.indexOf(':') + 1) : tag;
    if (DANGEROUS.test(local)) fail(`Element <${tag}>`);
    if (skip) { if (!selfClose) skip++; continue; }
    if (!sawRoot && tag !== 'svg') fail('Wurzelelement muss <svg> sein');
    if (!ELEMENTS.has(tag)) { if (!selfClose) skip = 1; continue; } // unbekannt/Namensraum: still verwerfen
    sawRoot = true;
    // Attribute
    const attrs: string[] = [];
    const re = /([^\s=/]+)\s*(?:=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
    re.lastIndex = m[0].length;
    const rest = raw.slice(0, selfClose ? -1 : undefined);
    let a: RegExpExecArray | null;
    while ((a = re.exec(rest))) {
      const name = a[1];
      const value = a[3] ?? a[4] ?? a[5] ?? '';
      if (/^on/i.test(name.includes(':') ? name.slice(name.indexOf(':') + 1) : name)) fail(`Ereignis-Attribut ${name}`);
      if (!ATTRS.has(name)) {
        // Namensraum-Attribute von Grafikprogrammen (inkscape:, sodipodi:, …) verwerfen – aber kein verstecktes href
        if (/(^|:)href$/i.test(name)) fail('externer Verweis');
        continue;
      }
      const v = checkValue(name, value);
      if (v !== null) attrs.push(`${name}="${esc(v)}"`);
    }
    if (tag === 'svg' && stack.length === 0 && !attrs.some((x) => x.startsWith('xmlns='))) attrs.unshift(`xmlns="${NS.xmlns}"`);
    out += `<${tag}${attrs.length ? ' ' + attrs.join(' ') : ''}${selfClose ? '/>' : '>'}`;
    if (!selfClose) { stack.push(tag); if (tag === 'style') inStyle = true; }
  }
  if (!sawRoot) fail('kein <svg>');
  if (stack.length || skip) fail('unvollständig');
  return out;
}
