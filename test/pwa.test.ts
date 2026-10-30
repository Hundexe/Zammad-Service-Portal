// Portal als App: Manifest, App-Symbole, Service Worker, Schalter und Vorlage für Intune.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { startPortal, Client, createUser, PUBLIC_URL, type Portal } from './helpers.ts';
import { renderIcon, shortName, forceInstallPolicy } from '../src/server/services/pwa.ts';
import { CSP } from '../src/server/http/security.ts';

const PW = 'Test-Passwort-123!';
let p: Portal;
let su: Client;

before(async () => {
  p = await startPortal();
  await createUser(p.app, { username: 'chef', password: PW, role: 'Super-Admin' });
  su = new Client(p.url);
  await su.loginLocal('chef', PW);
});
after(async () => { await p.close(); });

/** Liest Breite, Höhe und die Pixel (RGBA) eines PNG aus renderIcon */
function decodePng(png: Buffer): { w: number; h: number; px: (x: number, y: number) => number[] } {
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const w = png.readUInt32BE(16), h = png.readUInt32BE(20);
  assert.equal(png[24], 8);
  assert.equal(png[25], 6);
  const idat: Buffer[] = [];
  for (let o = 8; o < png.length;) {
    const len = png.readUInt32BE(o);
    if (png.toString('latin1', o + 4, o + 8) === 'IDAT') idat.push(png.subarray(o + 8, o + 8 + len));
    o += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  assert.equal(raw.length, (w * 4 + 1) * h);
  return { w, h, px: (x, y) => [...raw.subarray(y * (w * 4 + 1) + 1 + x * 4, y * (w * 4 + 1) + 5 + x * 4)] };
}

test('Manifest: öffentlich, Name und Farben aus der Gestaltung, Symbole in allen Größen', async () => {
  const anon = new Client(p.url);
  const r = await anon.get('/api/app/manifest');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type') ?? '', /^application\/manifest\+json/);
  const m = r.json;
  assert.equal(m.name, 'IT-Self-Service-Portal');
  assert.ok(m.short_name.length <= 15);
  assert.equal(m.id, '/');
  assert.equal(m.start_url, '/');
  assert.equal(m.scope, '/');
  assert.equal(m.display, 'standalone');
  assert.equal(m.theme_color, '#13294b');
  const sizes = m.icons.map((i: { sizes: string; purpose: string }) => `${i.sizes}/${i.purpose}`);
  for (const s of ['192x192/any', '512x512/any', '192x192/maskable', '512x512/maskable']) assert.ok(sizes.includes(s), s);
  // Status-Seite ist aus → kein Kurzbefehl dorthin
  assert.ok(!m.shortcuts.some((s: { url: string }) => s.url === '/status'));
});

test('App-Symbole: echte PNG in der Farbe der Farbfläche, Ecken bei „any“ transparent, maskable randlos', async () => {
  const m = (await new Client(p.url).get('/api/app/manifest')).json;
  for (const icon of m.icons) {
    const res = await fetch(p.url + icon.src);
    assert.equal(res.status, 200, icon.src);
    assert.equal(res.headers.get('content-type'), 'image/png');
    assert.match(res.headers.get('cache-control') ?? '', /max-age=604800/);
    const png = decodePng(Buffer.from(await res.arrayBuffer()));
    assert.equal(`${png.w}x${png.h}`, icon.sizes);
    const corner = png.px(0, 0);
    if (icon.purpose === 'any') assert.equal(corner[3], 0, 'Ecke transparent');
    else assert.deepEqual(corner, [0x13, 0x29, 0x4b, 255], 'randlos in der Farbe der Farbfläche');
    // Mitte der oberen Zeile: Schriftfarbe (weiß)
    const line = png.px(Math.round(png.w / 2), Math.round(png.h * 11 / 32));
    assert.ok(line[0]! > 230 && line[1]! > 230 && line[2]! > 230, `Zeile hell: ${line}`);
  }
  const apple = await fetch(`${p.url}/api/app/icon/apple-touch-icon.png`);
  assert.equal(decodePng(Buffer.from(await apple.arrayBuffer())).w, 180);
  assert.equal((await fetch(`${p.url}/api/app/icon/1024.png`)).status, 404);
  assert.equal((await fetch(`${p.url}/api/app/icon/..%2F..%2Fetc%2Fpasswd`)).status, 404);
});

test('Symbole folgen der Gestaltung; eigenes SVG-Favicon wird zusätzlich angeboten', async () => {
  const before = (await new Client(p.url).get('/api/app/manifest')).json.icons[0].src as string;
  p.app.db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('branding.global', ?)", JSON.stringify({ displayName: 'Hilfe', colorMode: 'custom', primaryColor: '#1f5fae', accentColor: '#0f8a6a', headerColor: '#ffffff', headerTextColor: '#000000' }));
  const m = (await new Client(p.url).get('/api/app/manifest')).json;
  assert.equal(m.name, 'Hilfe');
  assert.equal(m.theme_color, '#ffffff');
  assert.notEqual(m.icons[0].src, before, 'neue Versionskennung');
  const png = decodePng(Buffer.from(await (await fetch(p.url + m.icons[2].src)).arrayBuffer()));
  assert.deepEqual(png.px(0, 0), [255, 255, 255, 255]);
  p.app.db.run("DELETE FROM settings WHERE key = 'branding.global'");
});

test('Kurzname: an Wortgrenzen gekürzt', () => {
  assert.equal(shortName('IT-Hilfe'), 'IT-Hilfe');
  assert.equal(shortName('Service Portal der IT Nord'), 'Service Portal');
  assert.equal(shortName('IT-Self-Service-Portal').length, 15);
});

test('renderIcon: Größe stimmt, Kanten geglättet', () => {
  const png = decodePng(renderIcon(64, 'any', '#000000', '#ffffff'));
  assert.equal(png.w, 64);
  // irgendwo am Rand der Linie liegt ein Zwischenton
  let mid = false;
  for (let x = 0; x < 64 && !mid; x++) for (let y = 0; y < 64 && !mid; y++) { const v = png.px(x, y)[0]!; if (v > 20 && v < 235) mid = true; }
  assert.ok(mid);
});

test('Sicherheit: CSP erlaubt Service Worker nur vom eigenen Server, Seiten verweisen auf das Manifest', () => {
  assert.match(CSP, /worker-src 'self'/);
  assert.match(CSP, /manifest-src 'self'/);
  const html = readFileSync(new URL('../src/web/index.html', import.meta.url), 'utf8');
  assert.match(html, /<link rel="manifest" href="\/api\/app\/manifest">/);
  const sw = readFileSync(new URL('../src/web/sw.js', import.meta.url), 'utf8');
  // Der Service Worker speichert nichts zwischen und lässt API-Aufrufe (Anmeldung, Daten) unberührt
  assert.doesNotMatch(sw, /cache\.put|caches\.open|\.addAll\(/);
  assert.match(sw, /startsWith\('\/api\/'\)\) return/);
});

test('Öffentliche Einstellungen melden den Schalter', async () => {
  const r = await new Client(p.url).get('/api/public/config');
  assert.equal(r.json.installApp, true);
});

test('Intune-Vorlage: nur für Admins, fertiger Wert für WebAppInstallForceList', async () => {
  assert.equal((await new Client(p.url).get('/api/admin/settings/app')).status, 401);
  const r = await su.get('/api/admin/settings/app');
  assert.equal(r.status, 200);
  assert.equal(r.json.url, `${PUBLIC_URL}/`);
  const list = JSON.parse(r.json.policy);
  assert.deepEqual(list, [{ url: `${PUBLIC_URL}/`, default_launch_container: 'window', create_desktop_shortcut: false, fallback_app_name: 'IT-Self-Service-Portal' }]);
  assert.equal(JSON.parse(r.json.policyDesktop)[0].create_desktop_shortcut, true);
  assert.equal(JSON.parse(forceInstallPolicy('https://hilfe.example.org/pfad', { name: 'X', desktopShortcut: false }))[0].url, 'https://hilfe.example.org/');
});

test('Ausgeschaltet: kein Manifest, keine Symbole – Browser bieten keine Installation an', async () => {
  const f = (await su.get('/api/admin/settings/features')).json.features;
  assert.equal(f.installApp, true, 'Standard: an');
  assert.equal((await su.put('/api/admin/settings/features', { features: { ...f, installApp: false } })).status, 200);
  assert.equal((await new Client(p.url).get('/api/app/manifest')).status, 404);
  assert.equal((await fetch(`${p.url}/api/app/icon/192.png`)).status, 404);
  assert.equal((await new Client(p.url).get('/api/public/config')).json.installApp, false);
  assert.equal((await su.get('/api/admin/settings/app')).json.enabled, false);
  assert.equal((await su.put('/api/admin/settings/features', { features: { ...f, installApp: true } })).status, 200);
  assert.equal((await new Client(p.url).get('/api/app/manifest')).status, 200);
});
