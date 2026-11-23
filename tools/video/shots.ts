// Bilder für Webseite und Video aus der lokalen Demo (2160 × 1350, JPEG).
//
//   node tools/video/shots.ts [ziel] [name …]
//
// Startet die Demo (Beispieldaten, simuliertes Zammad und Microsoft-Login) im selben Prozess, meldet sich als
// Alex Berger an (Super-Admin für die Aufnahmen) und nimmt die Seiten auf. Ohne Namen: alle Bilder.
// Ziel: Standard docs/website/img. Voraussetzung: Playwright mit Chromium (docs/ENTWICKLUNG.md).
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { startDemo } from '../demo.ts';
import { uuid } from '../../src/server/db/db.ts';

const root = new URL('../..', import.meta.url).pathname;
const out = process.argv.slice(2).find((a) => a.includes('/')) ?? join(root, 'docs/website/img');
const only = process.argv.slice(2).filter((a) => !a.includes('/'));
mkdirSync(out, { recursive: true });
const PORT = 3992;
const BASE = `http://localhost:${PORT}`;

const require = createRequire(import.meta.url);
let pw: any;
try { pw = require('playwright'); } catch { pw = require(process.env.PLAYWRIGHT_PATH ?? '/opt/node22/lib/node_modules/playwright'); }

execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', join(root, 'tools/build-web.ts')], { stdio: 'inherit' });
const demo = await startDemo({ port: PORT, publicUrl: BASE, dataDir: join(root, '.data/shots-demo'), quiet: true });
const { systems, forms } = demo.seeded as { systems: Record<string, string>; forms: Record<string, string> };
const z = systems.zentral!;
const browser = await pw.chromium.launch();
const ctxOpts = { locale: 'de-DE', timezoneId: 'Europe/Berlin', viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1.5 };

async function shot(page: any, name: string): Promise<void> {
  if (only.length && !only.includes(name)) return;
  await page.waitForTimeout(350);
  await page.screenshot({ path: join(out, `${name}.jpg`), type: 'jpeg', quality: 88 });
  console.log('📸', name);
}

async function login(ctx: any) {
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`);
  await page.click('a.btn-ms');
  await page.waitForSelector('.form-list');
  return page;
}

try {
  // Alex bekommt für die Aufnahmen die ganze Verwaltung
  const alexId = demo.app.db.get<{ id: string }>("SELECT id FROM users WHERE email = 'alex.berger@example.org' AND kind = 'entra'")!.id;
  const superAdmin = demo.app.db.get<{ id: string }>("SELECT id FROM roles WHERE name = 'Super-Admin'")!.id;
  demo.app.db.run("INSERT INTO role_assignments (id, role_id, subject_type, subject_value, system_id, created_at) VALUES (?, ?, 'user', ?, NULL, ?)", uuid(), superAdmin, alexId, Date.now());
  const status = (await (await fetch(`${BASE}/api/health`).catch(() => null))?.text()) ?? '';
  void status;

  // ------------------------------------------------------------ Portal (hell)
  {
    const ctx = await browser.newContext(ctxOpts);
    const page0 = await ctx.newPage();
    await page0.goto(`${BASE}/login`);
    await page0.waitForSelector('.login-card');
    await shot(page0, 'login');
    await page0.close();
    const page = await login(ctx);
    await shot(page, 'start-stoerung');
    await page.click('.notif-menu summary');
    await page.waitForSelector('.notif-list, .notif-empty');
    await shot(page, 'glocke');
    await page.keyboard.press('Escape');
    await page.goto(`${BASE}/s/${z}/formular/${forms.vpn}`);
    await page.waitForSelector('.portal-form');
    await shot(page, 'formular-hinweis');
    await page.goto(`${BASE}/s/${z}/formular/${forms.software}`);
    await page.waitForSelector('.portal-form');
    await page.fill('#ff-programm', 'Bildbearbeitung');
    await page.fill('#ff-grund', 'Fotos für Website und Prospekte bearbeiten.');
    await page.selectOption('#ff-lizenz', 'kostenpflichtig');
    await page.fill('#ff-vorgesetzt', 'anna.becker@example.org');
    await page.waitForTimeout(500);
    await shot(page, 'formular-freigabe');
    await page.click('button[type=submit]');
    await page.waitForSelector('.success');
    await shot(page, 'freigabe-gesendet');
    await page.goto(`${BASE}/anfragen`);
    await page.waitForSelector('.table');
    await shot(page, 'anfragen');
    await page.goto(`${BASE}/freigaben`);
    await page.waitForSelector('.approval-list');
    await page.click('.approval-list a');
    await page.waitForSelector('.decide');
    await page.fill('.decide textarea', 'Passt, Lizenz ist im Budget.');
    await page.evaluate(() => window.scrollTo(0, 0));
    await shot(page, 'freigabe');
    await page.goto(`${BASE}/s/${z}/tickets`);
    await page.waitForSelector('.table');
    await shot(page, 'tickets');
    await page.goto(`${BASE}/status`);
    await page.waitForSelector('.st-section');
    await shot(page, 'status');
    await page.locator('#services, .st-section:has(h2:has-text("Services"))').first().scrollIntoViewIfNeeded();
    await page.evaluate(() => document.querySelector('.st-section:nth-of-type(3)')?.scrollIntoView({ block: 'start' }));
    await shot(page, 'status-services');
    await page.goto(`${BASE}/status`);
    await page.waitForSelector('.st-section');
    await page.click('.inc-card a, a[href^="/stoerungen/"]');
    await page.waitForSelector('.inc-timeline, .timeline, h1');
    await shot(page, 'stoerung');
    // Verwaltung
    await page.goto(`${BASE}/admin/status`);
    await page.waitForSelector('.table');
    await shot(page, 'admin-stoerungen');
    await page.click('.table tbody tr:first-child');
    await page.waitForSelector('.inc-timeline');
    await shot(page, 'admin-stoerung');
    await page.goto(`${BASE}/admin/status?reiter=probleme`);
    await page.waitForSelector('.table tbody tr');
    await page.click('.table tbody tr:first-child');
    await page.waitForSelector('textarea');
    await shot(page, 'admin-problem');
    await page.goto(`${BASE}/admin/systeme/${z}/zammad`);
    await page.waitForSelector('.panel h2');
    await page.waitForTimeout(600);
    await shot(page, 'zammad');
    await page.evaluate(() => document.querySelectorAll('.panel')[2]?.scrollIntoView({ block: 'start' }));
    await shot(page, 'zammad-arten');
    await page.goto(`${BASE}/admin/systeme/${z}/grundausstattung`);
    await page.waitForSelector('.panel');
    await page.waitForTimeout(1200);
    await shot(page, 'grundausstattung');
    await page.evaluate(() => document.querySelectorAll('.panel')[3]?.scrollIntoView({ block: 'start' }));
    await page.waitForTimeout(300);
    await shot(page, 'grundausstattung-vorschau');
    await ctx.close();
  }
} finally {
  await browser.close();
  await demo.close();
}
console.log(`Bilder in ${out}`);
process.exit(0);
