// Kleiner DOM-Baukasten. Texte werden immer als Textknoten eingefügt –
// innerHTML wird im gesamten Frontend nicht verwendet (Schutz vor XSS).

export type Child = Node | string | number | null | undefined | false | Child[];

export interface Props {
  class?: string | (string | false | null | undefined)[];
  id?: string;
  attrs?: Record<string, string | number | boolean | null | undefined>;
  on?: Partial<{ [K in keyof HTMLElementEventMap]: (ev: HTMLElementEventMap[K]) => void }>;
  style?: Record<string, string>;
  text?: string;
  ref?: (el: HTMLElement) => void;
  [attr: string]: unknown;
}

const RESERVED = new Set(['class', 'id', 'attrs', 'on', 'style', 'text', 'ref']);

function append(el: Node, child: Child): void {
  if (child === null || child === undefined || child === false) return;
  if (Array.isArray(child)) { child.forEach((c) => append(el, c)); return; }
  el.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
}

function setAttr(el: Element, k: string, v: unknown): void {
  if (v === null || v === undefined || v === false) return;
  if (/^on/i.test(k)) throw new Error('Event-Handler nur über "on" setzen');
  if ((k === 'href' || k === 'src' || k === 'action') && typeof v === 'string' && /^\s*(javascript|data|vbscript):/i.test(v) && !(k === 'src' && /^data:image\/(png|svg\+xml);/i.test(v))) {
    throw new Error('Unsichere URL');
  }
  el.setAttribute(k, v === true ? '' : String(v));
}

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props?: Props | null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    if (props.class) el.className = Array.isArray(props.class) ? props.class.filter(Boolean).join(' ') : props.class;
    if (props.id) el.id = props.id;
    if (props.text !== undefined) el.textContent = props.text;
    for (const [k, v] of Object.entries(props.attrs ?? {})) setAttr(el, k, v);
    for (const [k, v] of Object.entries(props)) if (!RESERVED.has(k)) setAttr(el, k, v);
    for (const [k, fn] of Object.entries(props.on ?? {})) el.addEventListener(k, fn as EventListener);
    for (const [k, v] of Object.entries(props.style ?? {})) el.style.setProperty(k, v);
    props.ref?.(el);
  }
  append(el, children);
  return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
export function svg(tag: string, attrs: Record<string, string | number> = {}, ...children: Node[]): SVGElement {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  children.forEach((c) => el.appendChild(c));
  return el;
}

export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

export function mount(el: Element, ...children: Child[]): void {
  clear(el);
  append(el, children);
}

export function fmtDate(v: string | number | null | undefined, withTime = true): string {
  if (v === null || v === undefined || v === '') return '';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('de-DE', withTime ? { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' } : { day: '2-digit', month: '2-digit', year: 'numeric' });
}

export function relTime(v: string | number | null | undefined): string {
  if (!v) return '';
  const d = new Date(v).getTime();
  const diff = Date.now() - d;
  const min = Math.round(diff / 60000);
  if (min < 1) return 'gerade eben';
  if (min < 60) return `vor ${min} Min.`;
  const hrs = Math.round(min / 60);
  if (hrs < 24) return `vor ${hrs} Std.`;
  const days = Math.round(hrs / 24);
  if (days < 8) return days === 1 ? 'gestern' : `vor ${days} Tagen`;
  return fmtDate(v, false);
}

/** Kleine Inline-Icons (Pfade selbst gezeichnet, 20×20). */
const ICONS: Record<string, string> = {
  plus: 'M10 4v12M4 10h12',
  check: 'M4 10.5l4 4 8-9',
  x: 'M5 5l10 10M15 5L5 15',
  up: 'M10 15V5M5 10l5-5 5 5',
  down: 'M10 5v10M5 10l5 5 5-5',
  grip: 'M7 5h.01M13 5h.01M7 10h.01M13 10h.01M7 15h.01M13 15h.01',
  file: 'M6 2.5h5l4 4v11H6zM11 2.5v4h4',
  refresh: 'M15.5 8A6 6 0 1 0 16 12M16 3.5V8h-4.5',
  out: 'M8 4H4.5v12H8M12 6l4 4-4 4M16 10H8',
  lock: 'M6 9V6.5a4 4 0 0 1 8 0V9M5 9h10v8H5z',
  back: 'M12 4l-6 6 6 6',
  copy: 'M7 7h9v9H7zM4 13V4h9',
  eye: 'M2 10s3-6 8-6 8 6 8 6-3 6-8 6-8-6-8-6zM10 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z',
  trash: 'M4 6h12M8 6V4h4v2M6 6l1 10h6l1-10',
  clip: 'M14 9l-5 5a2.5 2.5 0 0 1-3.5-3.5l6-6a1.7 1.7 0 0 1 2.4 2.4l-6 6',
  next: 'M8 4.5l5.5 5.5L8 15.5',
  moon: 'M16 12.2A6.5 6.5 0 0 1 7.8 4a6.5 6.5 0 1 0 8.2 8.2z',
  sun: 'M10 13.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM10 1.75v1.5M10 16.75v1.5M1.75 10h1.5M16.75 10h1.5M4.2 4.2l1.05 1.05M14.75 14.75l1.05 1.05M4.2 15.8l1.05-1.05M14.75 5.25l1.05-1.05',
  search: 'M8.75 14.5a5.75 5.75 0 1 0 0-11.5 5.75 5.75 0 0 0 0 11.5zM13 13l4 4',
  printer: 'M6 7.5V3h8v4.5M6 14.5H4a1 1 0 0 1-1-1v-5a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-2M6 11.5h8V17H6z',
  laptop: 'M4.5 5h11a.5.5 0 0 1 .5.5V13H4V5.5a.5.5 0 0 1 .5-.5zM2 15.5h16',
  key: 'M12.5 11.5a4 4 0 1 0-3.9-3.1L3 14v3h3v-2h2v-2h1.6l1.2-1.2c.5.2 1.1.7 1.7.7zM13.5 6.5h.01',
  shield: 'M10 2.5l6 2.3v4.7c0 3.8-2.5 6.6-6 8-3.5-1.4-6-4.2-6-8V4.8zM7.5 10l2 2 3.5-4',
  apps: 'M4 4h4.5v4.5H4zM11.5 4H16v4.5h-4.5zM4 11.5h4.5V16H4zM11.5 11.5H16V16h-4.5z',
  bolt: 'M11 2.5L4.5 11H10l-1 6.5L15.5 9H10z',
  phone: 'M7 2.5h6a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1v-13a1 1 0 0 1 1-1zM9 15h2',
  person: 'M10 10a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM3.5 17.5c.8-3.2 3.4-5 6.5-5s5.7 1.8 6.5 5',
  mail: 'M3 5h14v10H3zM3.5 5.5L10 11l6.5-5.5',
  chat: 'M4 4h12a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H9l-4 3v-3H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z',
};

export function icon(name: keyof typeof ICONS | string, size = 18): SVGElement {
  const path = svg('path', { d: ICONS[name] ?? ICONS.x, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.7, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
  const el = svg('svg', { viewBox: '0 0 20 20', width: size, height: size, 'aria-hidden': 'true', class: 'icon' }, path);
  return el;
}
