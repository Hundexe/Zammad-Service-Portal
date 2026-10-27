// Baut die statische Demo für GitHub Pages nach dist/pages.
//
//   node tools/build-pages.ts
//
// Ablauf: lokale Demo starten (Beispieldaten, simuliertes Zammad und Microsoft-Login), mit einem
// Browser alle Seiten von Portal und Verwaltung durchklicken und jede API-Antwort aufzeichnen.
// Die Oberfläche wird unverändert übernommen; in der Pages-Version beantwortet ein Simulator im
// Browser (src/web/demo/backend.ts) die Aufrufe aus diesen Aufzeichnungen. Es gibt keinen Server.
// Voraussetzung: Playwright mit Chromium (siehe docs/ENTWICKLUNG.md).
import { createRequire } from 'node:module';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { startDemo } from './demo.ts';
import { requestKey } from '../src/web/demo/backend.ts';
import { uuid } from '../src/server/db/db.ts';

const root = new URL('..', import.meta.url).pathname;
const out = join(root, 'dist/pages');
const PORT = 3990;
const BASE = `http://localhost:${PORT}`;
const MAX_PAGES = 400;

const require = createRequire(import.meta.url);
let pw: any;
try { pw = require('playwright'); } catch { pw = require(process.env.PLAYWRIGHT_PATH ?? '/opt/node22/lib/node_modules/playwright'); }

execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', join(root, 'tools/build-web.ts')], { stdio: 'inherit' });

const demo = await startDemo({ port: PORT, publicUrl: BASE, dataDir: join(root, '.data/pages-demo'), quiet: true });
const responses: Record<string, { status: number; data: unknown }> = {};
const browser = await pw.chromium.launch();
try {
  const ctx = await browser.newContext({ locale: 'de-DE', timezoneId: 'Europe/Berlin', viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.on('response', async (res: any) => {
    const req = res.request();
    const url = new URL(res.url());
    if (req.method() !== 'GET' || !url.pathname.startsWith('/api/') || url.pathname.startsWith('/api/assets/') || url.pathname.startsWith('/api/auth/')) return;
    try { responses[requestKey('GET', url.pathname + url.search)] = { status: res.status(), data: await res.json() }; } catch { /* kein JSON */ }
  });

  // Anmelden über den simulierten Microsoft-Login, danach Super-Admin, damit die ganze Verwaltung sichtbar ist
  await page.goto(`${BASE}/login`);
  await page.click('a.btn-ms');
  await page.waitForSelector('.form-list');
  const alex = demo.app.db.get<{ id: string }>("SELECT id FROM users WHERE email = 'alex.berger@example.org'")!;
  const superAdmin = demo.app.db.get<{ id: string }>("SELECT id FROM roles WHERE name = 'Super-Admin'")!;
  demo.app.db.run("INSERT INTO role_assignments (id, role_id, subject_type, subject_value, system_id, created_at) VALUES (?, ?, 'user', ?, NULL, ?)", uuid(), superAdmin.id, alex.id, Date.now());

  // Alle erreichbaren Seiten besuchen (Breitensuche über interne Links und Reiter)
  const queue = ['/', '/anfragen', '/konto', '/admin', '/admin/zustellung?status=failed', '/admin/zustellung?status=queued', '/admin/zustellung?status=delivered'];
  const seen = new Set(queue);
  let visited = 0;
  while (queue.length && visited < MAX_PAGES) {
    const path = queue.shift()!;
    visited++;
    await page.goto(BASE + path);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(150);
    const collect = async () => {
      const hrefs: string[] = await page.$$eval('a[data-link]', (as: Element[]) => as.map((a) => a.getAttribute('href') ?? ''));
      for (const href of hrefs) {
        if (!href.startsWith('/') || href.startsWith('/login') || seen.has(href)) continue;
        seen.add(href);
        queue.push(href);
      }
    };
    await collect();
    // Reiter (z. B. Ticket-Übersichten) nacheinander anklicken – die Seite zeichnet dabei neu
    const tabs = await page.locator('.tab').count();
    for (let i = 0; i < tabs; i++) {
      await page.locator('.tab').nth(i).click().catch(() => undefined);
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(100);
      await collect();
    }
  }
  console.log(`${visited} Seiten besucht, ${Object.keys(responses).length} Antworten aufgezeichnet`);
} finally {
  await browser.close();
}

// Logos und Favicons als data:-URLs mitliefern
const assets: Record<string, string> = {};
const ids = new Set<string>();
JSON.stringify(responses, (k, v) => { if (/^(logoLightId|logoDarkId|faviconId)$/.test(k) && typeof v === 'string') ids.add(v); return v; });
for (const id of ids) {
  const res = await fetch(`${BASE}/api/assets/${id}`);
  if (!res.ok) continue;
  assets[id] = `data:${res.headers.get('content-type')?.split(';')[0] ?? 'image/svg+xml'};base64,${Buffer.from(await res.arrayBuffer()).toString('base64')}`;
}
await demo.close();

// Statische Seite zusammenstellen: relative Pfade (Unterverzeichnis auf github.io), Demo-Kennzeichen
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(join(root, 'dist/web'), out, { recursive: true });
const index = readFileSync(join(out, 'index.html'), 'utf8')
  .replace('<meta name="robots" content="noindex, nofollow">', '<meta name="robots" content="noindex, nofollow">\n  <meta name="zsp-demo" content="1">')
  .replace(/(href|src)="\/(?!\/)/g, '$1="./')
  .replace('<title>Service-Portal</title>', '<title>Service-Portal – Demo</title>');
writeFileSync(join(out, 'index.html'), index);
writeFileSync(join(out, 'styles.css'), readFileSync(join(out, 'styles.css'), 'utf8').replace(/url\("\/fonts\//g, 'url("fonts/'));
writeFileSync(join(out, 'demo-data.json'), JSON.stringify({ recordedAt: Date.now(), responses, assets }));
writeFileSync(join(out, '.nojekyll'), '');
console.log(`Demo gebaut: ${out}`);
process.exit(0);
