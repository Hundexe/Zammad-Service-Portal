// Portal als App (Progressive Web App): Web-App-Manifest und App-Symbole.
// Die Symbole entstehen hier in den Farben der Gestaltung (Farbfläche + Schriftfarbe) – ohne Bildbibliothek:
// Kantenglättung über vorzeichenbehaftete Abstände, PNG über zlib.
import { deflateSync, crc32 } from 'node:zlib';
import { createHash } from 'node:crypto';
import type { App } from '../app.ts';
import { effectiveColors, type Branding } from '../../shared/branding.ts';
import { globalBranding } from './systems.ts';
import { getFeatures } from './features.ts';

export type IconVariant = 'any' | 'maskable' | 'apple';
/** Erlaubte Symbol-Dateien: Name → Größe und Art */
export const ICONS: Record<string, { size: number; variant: IconVariant }> = {
  '192.png': { size: 192, variant: 'any' },
  '512.png': { size: 512, variant: 'any' },
  'maskable-192.png': { size: 192, variant: 'maskable' },
  'maskable-512.png': { size: 512, variant: 'maskable' },
  'apple-touch-icon.png': { size: 180, variant: 'apple' },
};

function hexRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Abstand zu einem abgerundeten Rechteck (negativ = innen), Mittelpunkt c, halbe Kantenlänge e, Radius r */
function sdRoundRect(x: number, y: number, c: number, e: number, r: number): number {
  const qx = Math.abs(x - c) - e + r;
  const qy = Math.abs(y - c) - e + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

/** Abstand zu einer waagerechten Linie mit runden Enden */
function sdLine(x: number, y: number, x1: number, x2: number, ly: number, r: number): number {
  const cx = Math.min(Math.max(x, x1), x2);
  return Math.hypot(x - cx, y - ly) - r;
}

/**
 * Zeichnet das Portal-Symbol (drei Zeilen wie im Favicon) als RGBA-Pixel.
 * any: abgerundetes Quadrat mit transparenten Ecken. maskable/apple: randlos (das System schneidet selbst zu).
 */
export function renderIcon(size: number, variant: IconVariant, bg: string, fg: string): Buffer {
  const [br, bgG, bb] = hexRgb(bg);
  const [fr, fgG, fb] = hexRgb(fg);
  const s = size / 32; // Entwurf im 32er-Raster wie favicon.svg
  // Bei randlosen Symbolen liegt das Motiv kleiner in der Mitte (sichere Zone für runde Masken)
  const k = variant === 'any' ? 1 : 0.82;
  const lines: [number, number, number][] = [[9, 23, 11], [9, 23, 16], [9, 18, 21]];
  const px = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1);
    px[row] = 0; // Filter: keiner
    for (let x = 0; x < size; x++) {
      // Pixelmitte im 32er-Raster
      const ux = (x + 0.5) / s;
      const uy = (y + 0.5) / s;
      const bgCov = variant === 'any' ? Math.min(Math.max(0.5 - sdRoundRect(ux, uy, 16, 16, 7) * s, 0), 1) : 1;
      // Motiv um die Mitte skaliert
      const gx = 16 + (ux - 16) / k;
      const gy = 16 + (uy - 16) / k;
      let d = Infinity;
      for (const [x1, x2, ly] of lines) d = Math.min(d, sdLine(gx, gy, x1, x2, ly, 1.3));
      const fgCov = Math.min(Math.max(0.5 - d * k * s, 0), 1);
      const o = row + 1 + x * 4;
      px[o] = Math.round(br + (fr - br) * fgCov);
      px[o + 1] = Math.round(bgG + (fgG - bgG) * fgCov);
      px[o + 2] = Math.round(bb + (fb - bb) * fgCov);
      px[o + 3] = Math.round(bgCov * 255);
    }
  }
  return encodePng(size, size, px);
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
}

/** PNG aus bereits gefilterten Zeilen (je Zeile ein Filter-Byte + RGBA) */
function encodePng(w: number, h: number, raw: Buffer): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // Bit je Kanal
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const iconCache = new Map<string, Buffer>();

export function appIcon(app: App, name: string): Buffer | null {
  const spec = ICONS[name];
  if (!spec) return null;
  const c = effectiveColors(globalBranding(app));
  const key = `${name}|${c.headerColor}|${c.headerTextColor}`;
  let png = iconCache.get(key);
  if (!png) {
    if (iconCache.size > 40) iconCache.clear();
    png = renderIcon(spec.size, spec.variant, c.headerColor, c.headerTextColor);
    iconCache.set(key, png);
  }
  return png;
}

/** Kurzname für Startbildschirm und Taskleiste: höchstens 15 Zeichen, an Wortgrenzen gekürzt */
export function shortName(name: string): string {
  const n = name.trim();
  if (n.length <= 15) return n;
  let out = '';
  for (const w of n.split(/\s+/)) {
    if ((out ? out.length + 1 : 0) + w.length > 15) break;
    out = out ? `${out} ${w}` : w;
  }
  return out || n.slice(0, 14) + '…';
}

/** Eigenes Favicon als App-Symbol, wenn es groß genug ist: SVG oder quadratisches PNG ab 192 Pixel */
function customIcon(app: App, b: Branding): { src: string; sizes: string; type: string; purpose: string } | null {
  if (!b.faviconId) return null;
  const a = app.db.get<{ mime: string; data: Uint8Array }>('SELECT mime, data FROM assets WHERE id = ?', b.faviconId);
  if (!a) return null;
  const src = `/api/assets/${b.faviconId}`;
  if (a.mime === 'image/svg+xml') return { src, sizes: 'any', type: a.mime, purpose: 'any' };
  if (a.mime === 'image/png' && a.data.length > 24) {
    const d = Buffer.from(a.data);
    const w = d.readUInt32BE(16);
    const h = d.readUInt32BE(20);
    if (w === h && w >= 192) return { src, sizes: `${w}x${h}`, type: a.mime, purpose: 'any' };
  }
  return null;
}

export function manifest(app: App): Record<string, unknown> {
  const b = globalBranding(app);
  const c = effectiveColors(b);
  const f = getFeatures(app);
  // Versionskennung aus den Farben: Ändert sich die Gestaltung, holen die Browser die Symbole neu
  const v = createHash('sha256').update(`${c.headerColor}${c.headerTextColor}`).digest('hex').slice(0, 10);
  const icon = (file: string, size: number, purpose: string) => ({ src: `/api/app/icon/${file}?v=${v}`, sizes: `${size}x${size}`, type: 'image/png', purpose });
  const custom = customIcon(app, b);
  return {
    id: '/',
    name: b.displayName,
    short_name: shortName(b.displayName),
    description: 'Anfragen an die IT stellen und Tickets im Blick behalten.',
    lang: 'de',
    dir: 'ltr',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: c.headerColor,
    theme_color: c.headerColor,
    categories: ['business', 'productivity'],
    // Ein Klick auf einen Portal-Link öffnet das vorhandene App-Fenster statt eines zweiten
    launch_handler: { client_mode: ['navigate-existing', 'auto'] },
    icons: [
      ...(custom ? [custom] : []),
      icon('192.png', 192, 'any'),
      icon('512.png', 512, 'any'),
      icon('maskable-192.png', 192, 'maskable'),
      icon('maskable-512.png', 512, 'maskable'),
    ],
    shortcuts: [
      { name: 'Anfrage stellen', url: '/' },
      { name: 'Meine Anfragen', url: '/anfragen' },
      ...(f.status ? [{ name: 'Status', url: '/status' }] : []),
    ],
  };
}

/**
 * Eintrag für die Richtlinie „WebAppInstallForceList“ (Edge und Chrome, z. B. per Intune):
 * installiert das Portal ohne Zutun als App im eigenen Fenster.
 */
export function forceInstallPolicy(publicUrl: string, opts: { name: string; desktopShortcut: boolean }): string {
  const url = new URL('/', publicUrl).href;
  // fallback_app_name: Name, bis Edge das Manifest geladen hat
  const entry = { url, default_launch_container: 'window', create_desktop_shortcut: opts.desktopShortcut, fallback_app_name: opts.name };
  return JSON.stringify([entry], null, 2);
}
