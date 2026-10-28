// Zustand, Router und Rahmen der Anwendung.
import { h, icon, mount, type Child } from './dom.ts';
import { ApiError, get, onStepupRequired, onUnauthorized, post, setCsrf } from './api.ts';
import { button, dialog, errorText, fieldWrap, input, loading, notice, toast } from './ui.ts';
import { effectiveColors, luminance, themeOf, type Branding } from '../../shared/branding.ts';
import { DEMO, demoBackend } from './env.ts';

// ---------------------------------------------------------------- Adresse
// Normal: echte Pfade (/s/…). In der statischen Demo: alles hinter dem # (#/s/…).
function hashParts(): [string, string] {
  const raw = location.hash.slice(1) || '/';
  const i = raw.indexOf('?');
  return i >= 0 ? [raw.slice(0, i), raw.slice(i)] : [raw, ''];
}
export function curPath(): string { return DEMO ? hashParts()[0] : location.pathname; }
export function curSearch(): string { return DEMO ? hashParts()[1] : location.search; }
/** Ändert die Adresse ohne neu zu zeichnen. */
export function setUrl(path: string, replace = false): void {
  const url = DEMO ? `#${path}` : path;
  if (replace) history.replaceState(null, '', url); else history.pushState(null, '', url);
}
/** Adresse eines hochgeladenen Bildes (Logo, Favicon). */
export function assetUrl(id: string): string {
  return DEMO ? demoBackend()?.asset(id) ?? '' : `/api/assets/${id}`;
}

export interface Me {
  user: { id: string; kind: 'entra' | 'local'; username: string | null; displayName: string; email: string | null; department: string | null; totpEnabled: boolean };
  state: 'active' | 'mfa_pending' | 'password_change' | 'totp_setup';
  csrf: string;
  isAdmin: boolean;
  permissions: { global: string[]; bySystem: Record<string, string[]> };
  stepupValidUntil: number;
}

export interface PortalSystem { id: string; slug: string; name: string; status: string; allowReplies: boolean; branding: Branding }

export const state = {
  me: null as Me | null,
  config: null as { localLogin: boolean; entra: boolean; passwordMinLength?: number; branding: Branding } | null,
  systems: [] as PortalSystem[],
  systemId: null as string | null,
};

export function can(perm: string, systemId?: string | null): boolean {
  const p = state.me?.permissions;
  if (!p) return false;
  if (p.global.includes(perm)) return true;
  return systemId ? (p.bySystem[systemId] ?? []).includes(perm) : false;
}
export function canAnywhere(perm: string): boolean {
  const p = state.me?.permissions;
  if (!p) return false;
  return p.global.includes(perm) || Object.values(p.bySystem).some((l) => l.includes(perm));
}

// ---------------------------------------------------------------- Branding
export function applyBranding(b: Branding | undefined | null): void {
  const root = document.documentElement;
  const br = b ?? state.config?.branding;
  if (!br) return;
  const c = effectiveColors(br);
  root.style.setProperty('--brand', c.primaryColor);
  root.style.setProperty('--brand-accent', c.accentColor);
  root.style.setProperty('--band', c.headerColor);
  root.style.setProperty('--band-text', c.headerTextColor);
  // Gestaltungsstil des Ticketsystems; für den nächsten Seitenaufruf merken (kein Aufblitzen)
  const style = themeOf(br);
  if (root.getAttribute('data-style') !== style) {
    root.setAttribute('data-style', style);
    try { localStorage.setItem('zsp.style', style); } catch { /* privater Modus */ }
  }
  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) { link = h('link', { attrs: { rel: 'icon' } }); document.head.appendChild(link); }
  link.href = br.faviconId ? assetUrl(br.faviconId) : DEMO ? 'favicon.svg' : '/favicon.svg';
}

/** Logo für die Farbfläche: auf dunkler Fläche das helle Logo („Logo auf der Farbfläche“),
 *  auf heller Fläche (z. B. Material-Farben) das Logo für helle Flächen. */
export function bandLogoId(b: Branding): string | null {
  const light = luminance(effectiveColors(b).headerColor) > 0.4;
  return (light ? b.logoLightId : b.logoDarkId) ?? null;
}

export function logo(b: Branding, dark = false): HTMLElement {
  const id = (dark && b.logoDarkId) || b.logoLightId;
  return id
    ? h('img', { class: 'brand-logo', attrs: { src: assetUrl(id), alt: b.displayName } })
    : h('span', { class: 'brand-mark', attrs: { 'aria-hidden': 'true' } }, b.displayName.slice(0, 1));
}

/** Marke in der Navigationsleiste. Hell: Logo für helle Flächen, dunkel: Logo für die Farbfläche
 *  (meist hell/weiß). Fehlt das passende Logo, erscheinen Farbkachel und Name. */
export function navBrand(b: Branding): Child[] {
  const fallback = (): Child[] => [h('span', { class: 'brand-mark', attrs: { 'aria-hidden': 'true' } }, b.displayName.slice(0, 1)), h('span', { class: 'brand-name' }, b.displayName)];
  const img = (id: string) => h('img', { class: 'brand-logo', attrs: { src: assetUrl(id), alt: b.displayName } });
  if (!b.logoLightId && !b.logoDarkId) return fallback();
  return [
    h('span', { class: 'theme-light-only' }, ...(b.logoLightId ? [img(b.logoLightId)] : fallback())),
    h('span', { class: 'theme-dark-only' }, ...(b.logoDarkId ? [img(b.logoDarkId)] : fallback())),
  ];
}

// ---------------------------------------------------------------- Helles / dunkles Design
export function currentTheme(): 'light' | 'dark' {
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}

/** Schalter für das dunkle Design. Die Wahl wird nur im Browser gespeichert (localStorage). */
export function themeToggle(): HTMLButtonElement {
  const btn = h('button', { class: 'icon-btn theme-toggle', attrs: { type: 'button' } });
  const draw = () => {
    const dark = currentTheme() === 'dark';
    btn.setAttribute('aria-label', dark ? 'Helles Design einschalten' : 'Dunkles Design einschalten');
    btn.setAttribute('title', dark ? 'Helles Design' : 'Dunkles Design');
    btn.setAttribute('aria-pressed', dark ? 'true' : 'false');
    btn.replaceChildren(icon(dark ? 'sun' : 'moon', 18));
  };
  btn.addEventListener('click', () => {
    const next = currentTheme() === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem('zsp.theme', next); } catch { /* privater Modus */ }
    draw();
  });
  draw();
  return btn;
}

// Folgt dem Betriebssystem, solange niemand selbst gewählt hat
window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', (e) => {
  let saved: string | null = null;
  try { saved = localStorage.getItem('zsp.theme'); } catch { /* egal */ }
  if (saved !== 'light' && saved !== 'dark') {
    document.documentElement.setAttribute('data-theme', e.matches ? 'dark' : 'light');
    document.querySelectorAll('.theme-toggle').forEach((b) => b.replaceWith(themeToggle()));
  }
});

/** Segmentierte Auswahl des Ticketsystems (nur bei mehr als einem System). */
export function systemSwitch(hrefFor: (id: string) => string, light = false): HTMLElement | null {
  if (state.systems.length < 2) return null;
  const cur = currentSystem();
  return h('nav', { class: ['switch', light && 'switch-light'], attrs: { 'aria-label': 'Ticketsystem wählen' } },
    ...state.systems.map((s) => h('a', {
      class: ['switch-item', s.id === cur?.id && 'active'],
      attrs: { href: hrefFor(s.id), 'data-link': '', 'aria-current': s.id === cur?.id ? 'true' : undefined },
      on: { click: () => selectSystem(s.id) },
    }, h('span', { class: 'switch-dot', style: { background: effectiveColors(s.branding).headerColor } }), s.name)));
}

export function currentSystem(): PortalSystem | undefined {
  return state.systems.find((s) => s.id === state.systemId) ?? state.systems[0];
}

export function selectSystem(id: string): void {
  state.systemId = id;
  try { localStorage.setItem('zsp.system', id); } catch { /* privater Modus */ }
  applyBranding(currentSystem()?.branding);
}

// ---------------------------------------------------------------- Router
type Render = (params: Record<string, string>, query: URLSearchParams) => Promise<Child> | Child;
interface Route { re: RegExp; keys: string[]; render: Render; layout: 'portal' | 'admin' | 'bare'; auth: boolean }
const routes: Route[] = [];
let layouts: Record<string, (content: Child, path: string) => Child> = {};
let prepare: Partial<Record<string, (params: Record<string, string>) => Promise<void>>> = {};
export function setPrepare(p: typeof prepare): void { prepare = p; }

export function route(path: string, layout: Route['layout'], render: Render, auth = true): void {
  const keys: string[] = [];
  const re = new RegExp('^' + path.replace(/:([a-zA-Z]+)/g, (_m, k: string) => { keys.push(k); return '([^/]+)'; }) + '/?$');
  routes.push({ re, keys, render, layout, auth });
}

export function setLayouts(l: typeof layouts): void { layouts = l; }

let renderToken = 0;
export async function render(): Promise<void> {
  const token = ++renderToken;
  const appEl = document.getElementById('app')!;
  const path = curPath();
  const r = routes.find((x) => x.re.test(path));
  if (!r) { mount(appEl, layouts.bare(h('div', { class: 'center-page' }, h('h1', null, 'Seite nicht gefunden'), h('p', null, h('a', { href: '/', attrs: { 'data-link': '' } }, 'Zur Startseite'))), path)); return; }
  if (r.auth && (!state.me || state.me.state !== 'active')) { navigate(`/login?ziel=${encodeURIComponent(path + curSearch())}`, true); return; }
  const m = r.re.exec(path)!;
  const params: Record<string, string> = {};
  r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
  const holder = h('div', { class: 'page-holder' }, loading());
  // Vor dem Rahmen: Ticketsystem/Branding passend zur URL setzen
  try { await prepare[r.layout]?.(params); } catch { /* Seite zeigt den Fehler */ }
  if (token !== renderToken) return;
  mount(appEl, layouts[r.layout](holder, path));
  try {
    const content = await r.render(params, new URLSearchParams(curSearch()));
    if (token !== renderToken) return;
    mount(holder, content);
    // Fokus für Screenreader auf die Überschrift
    const h1 = holder.querySelector('h1');
    if (h1) { h1.tabIndex = -1; h1.focus({ preventScroll: true }); }
  } catch (err) {
    if (token !== renderToken) return;
    if (err instanceof ApiError && err.status === 401) return;
    mount(holder, notice('error', errorText(err)));
  }
}

export function navigate(path: string, replace = false): void {
  setUrl(path, replace);
  void render();
  window.scrollTo({ top: 0 });
}

export function link(href: string, ...children: Child[]): HTMLAnchorElement {
  return h('a', { attrs: { href, 'data-link': '' } }, ...children);
}

document.addEventListener('click', (e) => {
  const a = (e.target as HTMLElement).closest?.('a[data-link]') as HTMLAnchorElement | null;
  if (!a || e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
  e.preventDefault();
  navigate(a.getAttribute('href')!.replace(/^#/, ''));
});
window.addEventListener('popstate', () => void render());
if (DEMO) {
  window.addEventListener('hashchange', () => void render());
  // Downloads und Exporte gibt es in der statischen Demo nicht
  document.addEventListener('click', (e) => {
    const a = (e.target as HTMLElement).closest?.('a[href^="/api/"]');
    if (a) { e.preventDefault(); toast('In der Demo nicht verfügbar', 'info'); }
  });
}

// ---------------------------------------------------------------- Sitzung
export async function loadMe(): Promise<Me | null> {
  try {
    const me = await get<Me>('/api/me');
    state.me = me;
    setCsrf(me.csrf);
    return me;
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) { state.me = null; return null; }
    throw err;
  }
}

export async function loadSystems(): Promise<void> {
  const r = await get<{ systems: PortalSystem[] }>('/api/portal/systems');
  state.systems = r.systems;
  let saved: string | null = null;
  try { saved = localStorage.getItem('zsp.system'); } catch { /* egal */ }
  if (!state.systemId || !state.systems.some((s) => s.id === state.systemId)) {
    state.systemId = state.systems.find((s) => s.id === saved)?.id ?? state.systems[0]?.id ?? null;
  }
  applyBranding(currentSystem()?.branding ?? state.config?.branding);
}

export async function logout(): Promise<void> {
  try {
    const r = await post<{ redirect: string | null }>('/api/auth/logout');
    state.me = null;
    if (r.redirect && !DEMO) { location.href = r.redirect; return; }
  } catch { /* trotzdem abmelden */ }
  if (DEMO) { state.me = null; navigate('/login', true); return; }
  location.href = '/login';
}

onUnauthorized(() => {
  if (curPath() !== '/login') {
    state.me = null;
    navigate(`/login?ziel=${encodeURIComponent(curPath())}`, true);
  }
});

// Erneute Anmeldung für besonders schützenswerte Aktionen
onStepupRequired(async () => {
  const me = state.me;
  if (!me) return false;
  if (me.user.kind === 'entra') {
    const ok = await dialog('Bitte erneut anmelden',
      h('p', null, 'Für diese Aktion ist eine frische Anmeldung bei Microsoft nötig. Danach kommen Sie hierher zurück und können die Aktion wiederholen.'),
      (close) => [button('Abbrechen', () => close(false), { kind: 'ghost' }), button('Bei Microsoft anmelden', () => close(true), { kind: 'primary' })]);
    if (ok) location.href = `/api/auth/entra/login?stepup=1&returnTo=${encodeURIComponent(curPath())}`;
    return false;
  }
  let pw = '', code = '';
  const msg = h('div');
  const result = await dialog('Aktion bestätigen', h('form', { class: 'stack', on: { submit: (e) => e.preventDefault() } },
    h('p', null, 'Bitte bestätigen Sie diese Aktion mit Ihrem Passwort' + (me.user.totpEnabled ? ' und einem Code aus der Authenticator-App.' : '.')),
    fieldWrap(input('', (v) => { pw = v; }, { type: 'password', autocomplete: 'current-password' }), { label: 'Passwort' }),
    me.user.totpEnabled ? fieldWrap(input('', (v) => { code = v; }, { inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 6 }), { label: 'Code' }) : null,
    msg,
  ), (close) => [
    button('Abbrechen', () => close(false), { kind: 'ghost' }),
    button('Bestätigen', async () => {
      try {
        await post('/api/auth/stepup', { password: pw, code });
        close(true);
      } catch (err) {
        mount(msg, notice('error', errorText(err)));
      }
    }, { kind: 'primary', type: 'submit' }),
  ]);
  if (result === true) await loadMe();
  return result === true;
});

export function userMenu(): HTMLElement {
  const me = state.me!;
  const details = h('details', { class: 'user-menu' },
    h('summary', null, h('span', { class: 'avatar', attrs: { 'aria-hidden': 'true' } }, initials(me.user.displayName)), h('span', { class: 'user-name' }, me.user.displayName)),
    h('div', { class: 'menu' },
      h('p', { class: 'menu-who' }, me.user.displayName, h('br'), h('span', { class: 'muted small' }, me.user.email ?? me.user.username ?? '')),
      link('/anfragen', 'Meine Anfragen'),
      link('/freigaben', 'Freigaben'),
      link('/konto', 'Konto und Sicherheit'),
      me.isAdmin ? link('/admin', 'Verwaltung') : null,
      h('button', { class: 'menu-item', attrs: { type: 'button' }, on: { click: () => void logout() } }, icon('out', 16), 'Abmelden'),
    ));
  details.addEventListener('click', (e) => { if ((e.target as HTMLElement).closest('a')) details.open = false; });
  return details;
}

export function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join('') || '?';
}
