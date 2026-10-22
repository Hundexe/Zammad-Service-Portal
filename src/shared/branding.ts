// Branding pro Ticketsystem und Kontrastprüfung nach WCAG 2.1.

export interface Branding {
  displayName: string;
  primaryColor: string;
  accentColor: string;
  headerColor: string;
  headerTextColor: string;
  logoLightId?: string | null;
  logoDarkId?: string | null;
  faviconId?: string | null;
  welcomeText: string;
  footerText: string;
  imprintUrl?: string;
  privacyUrl?: string;
}

export const DEFAULT_BRANDING: Branding = {
  displayName: 'IT-Service-Portal',
  primaryColor: '#1f5fae',
  accentColor: '#0f8a6a',
  headerColor: '#13294b',
  headerTextColor: '#ffffff',
  logoLightId: null,
  logoDarkId: null,
  faviconId: null,
  welcomeText: 'Wie können wir helfen?',
  footerText: '',
  imprintUrl: '',
  privacyUrl: '',
};

const HEX = /^#[0-9a-fA-F]{6}$/;

export function isHexColor(s: unknown): s is string {
  return typeof s === 'string' && HEX.test(s);
}

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

export function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrastRatio(a: string, b: string): number {
  const la = luminance(a), lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Prüft die Kontraste, die im Portal wirklich vorkommen. Liefert Warnungen (kein harter Fehler). */
export function contrastWarnings(b: Branding): string[] {
  const out: string[] = [];
  const check = (fg: string, bg: string, what: string) => {
    if (!isHexColor(fg) || !isHexColor(bg)) return;
    const r = contrastRatio(fg, bg);
    if (r < 4.5) out.push(`${what}: Kontrast ${r.toFixed(2)}:1 – WCAG AA verlangt mindestens 4,5:1`);
  };
  check(b.headerTextColor, b.headerColor, 'Farbfläche (Text auf Hintergrund)');
  check('#ffffff', b.primaryColor, 'Schaltflächen (weißer Text auf Primärfarbe)');
  check(b.primaryColor, '#ffffff', 'Links (Primärfarbe auf Weiß)');
  return out;
}

export function validateBranding(input: unknown): { branding?: Branding; errors: string[] } {
  const errors: string[] = [];
  if (!input || typeof input !== 'object') return { errors: ['Branding fehlt'] };
  const i = input as Record<string, unknown>;
  const str = (k: string, max: number, required = false): string => {
    const v = i[k];
    if (v === undefined || v === null || v === '') { if (required) errors.push(`${k} fehlt`); return ''; }
    if (typeof v !== 'string' || v.length > max) { errors.push(`${k} ungültig`); return ''; }
    return v;
  };
  const color = (k: string): string => {
    const v = i[k];
    if (!isHexColor(v)) { errors.push(`${k}: Farbe im Format #rrggbb`); return '#000000'; }
    return v.toLowerCase();
  };
  const url = (k: string): string => {
    const v = str(k, 500);
    if (v && !/^https:\/\/[^\s"'<>]+$/.test(v)) errors.push(`${k}: nur https-Links`);
    return v;
  };
  const id = (k: string): string | null => {
    const v = i[k];
    if (v === undefined || v === null || v === '') return null;
    if (typeof v !== 'string' || !/^[0-9a-f-]{36}$/.test(v)) { errors.push(`${k} ungültig`); return null; }
    return v;
  };
  const branding: Branding = {
    displayName: str('displayName', 80, true),
    primaryColor: color('primaryColor'),
    accentColor: color('accentColor'),
    headerColor: color('headerColor'),
    headerTextColor: color('headerTextColor'),
    logoLightId: id('logoLightId'),
    logoDarkId: id('logoDarkId'),
    faviconId: id('faviconId'),
    welcomeText: str('welcomeText', 500),
    footerText: str('footerText', 500),
    imprintUrl: url('imprintUrl'),
    privacyUrl: url('privacyUrl'),
  };
  return { branding: errors.length ? undefined : branding, errors };
}
