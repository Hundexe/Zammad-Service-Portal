// Erstellt die Screenshots für die Dokumentation gegen die laufende Demo
// (node tools/demo.ts + Caddy). Aufruf: node tools/screenshots.ts [filter]
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { totpCode, currentStep } from '../src/server/auth/totp.ts';
import { DEMO_ADMIN_PASSWORD, DEMO_TOTP_SECRET } from './demo.ts';

const require = createRequire(import.meta.url);
let pw: any;
try { pw = require('playwright'); } catch { pw = require(process.env.PLAYWRIGHT_PATH ?? '/opt/node22/lib/node_modules/playwright'); }

const root = new URL('..', import.meta.url).pathname;
const out = join(root, 'docs/screenshots');
mkdirSync(out, { recursive: true });
const BASE = process.env.PUBLIC_URL ?? 'https://portal.localhost:8443';
const demo = JSON.parse(readFileSync(join(root, '.data/demo/demo.json'), 'utf8'));
const filter = process.argv[2] ?? '';

const browser = await pw.chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const ctxOpts = { ignoreHTTPSErrors: true, locale: 'de-DE', timezoneId: 'Europe/Berlin', viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 };

async function shot(page: any, name: string, opts: { full?: boolean } = {}) {
  if (filter && !name.includes(filter)) return;
  await page.waitForTimeout(250);
  // Bei ganzseitigen Aufnahmen die mitlaufende Navigationsleiste oben festhalten (sonst erscheint sie mitten im Bild)
  if (opts.full) await page.evaluate(() => {
    const set = (sel: string, props: Record<string, string>) => document.querySelectorAll<HTMLElement>(sel).forEach((el) => { for (const [k, v] of Object.entries(props)) el.style.setProperty(k, v); });
    set('.band', { position: 'static' });
    set('.sidebar', { position: 'static', height: 'auto', 'align-self': 'stretch' });
    set('.col-preview, .sticky-top', { position: 'static', 'max-height': 'none' });
  });
  await page.screenshot({ path: join(out, `${name}.png`), fullPage: opts.full ?? false });
  console.log('📸', name);
}

async function entraLogin(page: any, as?: string) {
  await page.goto(`${BASE}/login`);
  const href = await page.getAttribute('a.btn-ms', 'href');
  await page.goto(`${BASE}${href}${as ? '' : ''}`);
  if (as) {
    // Simulator: anderer Benutzer über ?as=
    const url = new URL(page.url());
    void url;
  }
  await page.waitForSelector('.band');
}

const sys = demo.systems as { zentral: string; nord: string };
let firstPassword = '';
const forms = demo.forms as Record<string, string>;

// ---------------------------------------------------------------- Portal
{
  const ctx = await browser.newContext(ctxOpts);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`);
  await page.waitForSelector('.login-card');
  await shot(page, '01-anmeldung');
  await page.click('a.btn-ms');
  await page.waitForSelector('.form-list');
  await shot(page, '02-portal-start');
  await page.click('.switch-item:nth-child(2)');
  await page.waitForTimeout(400);
  await page.waitForSelector('.form-list');
  await shot(page, '03-portal-start-zweites-system');
  await page.goto(`${BASE}/s/${sys.zentral}/formular/${forms.hardware}`);
  await page.waitForSelector('.portal-form');
  await page.click('button[type=submit]');
  await page.waitForSelector('.has-error');
  await shot(page, '05-formular-pruefung', { full: true });
  await page.selectOption('#ff-art', 'Hardware::Laptop');
  await page.fill('#ff-kostenstelle', '4711');
  await page.fill('#ff-bis_wann', '2026-11-15');
  await page.selectOption('#ff-standort', 'nord');
  await page.fill('#ff-begruendung', 'Der alte Laptop (NB-0042) ist sieben Jahre alt und startet nur noch mit Netzteil.');
  await page.fill('#ff-vorgesetzt', 'anna.becker@example.org');
  await shot(page, '04-formular-ausgefuellt', { full: true });
  await page.click('button[type=submit]');
  await page.waitForSelector('.success');
  await shot(page, '41-freigabe-wartet');
  // Anfrage ohne Freigabe
  await page.goto(`${BASE}/s/${sys.zentral}/formular/${forms.stoerung}`);
  await page.waitForSelector('.portal-form');
  await page.selectOption('#ff-was', 'drucker');
  await page.fill('#ff-betreff', 'Drucker zieht kein Papier ein');
  await page.fill('#ff-beschreibung', 'Seit heute früh, Papier ist eingelegt.');
  await page.selectOption('#ff-standort', 'nord');
  await page.click('button[type=submit]');
  await page.waitForSelector('.success');
  await shot(page, '06-anfrage-gesendet');
  await page.waitForTimeout(2500);
  await page.goto(`${BASE}/s/${sys.zentral}/tickets`);
  await page.waitForSelector('.table');
  await shot(page, '07-meine-tickets');
  await page.click('.table tbody tr:nth-child(2) a');
  await page.waitForSelector('.thread');
  await page.fill('textarea', 'Danke, dann warte ich auf den Toner.');
  await shot(page, '08-ticket-verlauf', { full: true });
  await page.goto(`${BASE}/konto`);
  await page.waitForSelector('.facts');
  await shot(page, '22-konto');
  await ctx.close();
}

// ---------------------------------------------------------------- Mobil
{
  const ctx = await browser.newContext({ ...ctxOpts, viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`);
  await page.click('a.btn-ms');
  await page.waitForSelector('.form-list');
  await shot(page, '09-mobil-start', { full: true });
  await page.goto(`${BASE}/s/${sys.zentral}/formular/${forms.stoerung}`);
  await page.waitForSelector('.portal-form');
  await page.selectOption('#ff-was', 'programm');
  await shot(page, '09b-mobil-formular', { full: true });
  await ctx.close();
}

// ---------------------------------------------------------------- Verwaltung (lokaler Admin mit 2FA)
{
  const ctx = await browser.newContext(ctxOpts);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`);
  await page.click('.local-login summary');
  await page.fill('input[autocomplete=username]', 'admin');
  await page.fill('input[autocomplete=current-password]', DEMO_ADMIN_PASSWORD);
  await page.click('.local-login button[type=submit]');
  await page.waitForSelector('.code-input');
  await shot(page, '20b-anmeldung-code');
  await page.fill('.code-input', totpCode(DEMO_TOTP_SECRET, currentStep()));
  await page.click('button[type=submit]');
  await page.waitForSelector('.band');
  await page.goto(`${BASE}/admin`);
  await page.waitForSelector('.stats');
  await shot(page, '10-admin-uebersicht');
  await page.goto(`${BASE}/admin/systeme/${sys.zentral}`);
  await page.waitForSelector('.panel');
  await page.click('text=Verbindung testen');
  await page.waitForSelector('.notice-ok');
  await shot(page, '11-admin-verbindung', { full: true });
  await page.goto(`${BASE}/admin/systeme/${sys.zentral}/objekte`);
  await page.waitForSelector('.attr-list');
  await shot(page, '12-admin-zammad-objekte', { full: true });
  await page.goto(`${BASE}/admin/systeme/${sys.zentral}/formulare`);
  await page.waitForSelector('.table');
  await shot(page, '13-admin-formulare');
  await page.goto(`${BASE}/admin/systeme/${sys.zentral}/formulare/${forms.stoerung}`);
  await page.waitForSelector('.editor-grid');
  await page.click('.field-row:nth-child(2)');
  await page.waitForTimeout(200);
  await shot(page, '14-admin-formular-editor', { full: true });
  await page.click('.tab:nth-child(2)');
  await shot(page, '15-admin-formular-ticket', { full: true });
  await page.goto(`${BASE}/admin/systeme/${sys.zentral}/branding`);
  await page.waitForSelector('.branding-grid');
  await page.setViewportSize({ width: 1440, height: 1250 });
  await shot(page, '16-admin-branding');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${BASE}/admin/rollen`);
  await page.waitForSelector('.table');
  await shot(page, '17-admin-rollen', { full: true });
  await page.goto(`${BASE}/admin/benutzer`);
  await page.waitForSelector('.table');
  // Anmeldung künstlich altern lassen, damit die Bestätigung (Step-up) erscheint
  const { DatabaseSync } = await import('node:sqlite');
  const sdb = new DatabaseSync(join(root, '.data/demo/portal.sqlite'));
  sdb.exec('UPDATE sessions SET auth_time = auth_time - 3600000');
  sdb.close();
  await page.click('text=Lokalen Benutzer anlegen');
  // Step-up: frische Anmeldung für das Anlegen von Benutzern
  const dlg = page.locator('dialog');
  await dlg.locator('input').nth(0).fill('m.mustermann');
  await dlg.locator('input').nth(1).fill('Max Mustermann');
  await dlg.locator('input').nth(2).fill('max.mustermann@example.org');
  await dlg.locator('input').nth(3).fill('Vertrieb');
  await dlg.getByRole('button', { name: 'Anlegen', exact: true }).click();
  // Liegt die Anmeldung länger als 10 Minuten zurück, fragt das Portal erst nach Passwort + Code (Step-up).
  await Promise.race([page.waitForSelector('.secret-pw'), page.waitForSelector('text=Aktion bestätigen')]);
  if (await page.locator('dialog >> text=Aktion bestätigen').count()) {
    await shot(page, '18a-admin-bestaetigung');
    await page.locator('dialog input[type=password]').fill(DEMO_ADMIN_PASSWORD);
    await page.locator('dialog input[autocomplete=one-time-code]').fill(totpCode(DEMO_TOTP_SECRET, currentStep() + 1));
    await page.locator('dialog').getByRole('button', { name: 'Bestätigen', exact: true }).click();
  }
  await page.waitForSelector('.secret-pw');
  firstPassword = (await page.textContent('.secret-pw'))!.trim();
  await shot(page, '18-admin-benutzer-angelegt');
  await page.locator('dialog').getByRole('button', { name: 'Fertig' }).click();
  await page.waitForTimeout(500);
  await page.goto(`${BASE}/admin/audit`);
  await page.waitForSelector('.table');
  await shot(page, '19-admin-audit');
  await page.goto(`${BASE}/admin/updates`);
  await page.waitForSelector('.panel');
  await shot(page, '20-admin-updates');
  await page.goto(`${BASE}/admin/zustellung`);
  await page.waitForSelector('.table, .empty');
  await shot(page, '21-admin-zustellung');
  await ctx.close();
}

// ---------------------------------------------------------------- Erstanmeldung eines neuen lokalen Admins
if (firstPassword) {
  // Max bekommt Admin-Rechte, damit nach dem Passwortwechsel die 2FA-Einrichtung folgt
  const { DatabaseSync } = await import('node:sqlite');
  const sdb = new DatabaseSync(join(root, '.data/demo/portal.sqlite'));
  sdb.prepare(`INSERT INTO role_assignments (id, role_id, subject_type, subject_value, system_id, created_at)
    SELECT lower(hex(randomblob(16))), r.id, 'user', u.id, NULL, ? FROM roles r, users u WHERE r.name = 'Super-Admin' AND u.username = 'm.mustermann'`).run(Date.now());
  sdb.close();
  const ctx = await browser.newContext(ctxOpts);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`);
  await page.click('.local-login summary');
  await page.fill('input[autocomplete=username]', 'm.mustermann');
  await page.fill('input[autocomplete=current-password]', firstPassword);
  await page.click('.local-login button[type=submit]');
  await page.waitForSelector('input[autocomplete=new-password]');
  await shot(page, '23-erstanmeldung-passwort');
  const pwInputs = page.locator('input[type=password]');
  await pwInputs.nth(0).fill(firstPassword);
  await pwInputs.nth(1).fill('Kaffeetasse-Fahrrad-Sonnenhut-8');
  await pwInputs.nth(2).fill('Kaffeetasse-Fahrrad-Sonnenhut-8');
  await page.click('button[type=submit]');
  await page.waitForSelector('.qr');
  await shot(page, '24-erstanmeldung-2fa', { full: true });
  await ctx.close();
}

// ---------------------------------------------------------------- Dunkles Design
{
  const ctx = await browser.newContext({ ...ctxOpts, colorScheme: 'dark' });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`);
  await page.waitForSelector('.login-card');
  await shot(page, '27-dunkel-anmeldung');
  await page.click('a.btn-ms');
  await page.waitForSelector('.form-list');
  await shot(page, '25-dunkel-start');
  await page.goto(`${BASE}/admin`);
  await page.waitForSelector('.stats');
  await shot(page, '26-dunkel-verwaltung');
  await ctx.close();
}

// ---------------------------------------------------------------- Freigabe durch Vorgesetzte
{
  const ctx = await browser.newContext(ctxOpts);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`);
  await page.click('a.btn-ms');
  await page.waitForSelector('.form-list');
  // Formular mit bedingtem Freigabe-Feld und Personenvorschlägen
  await page.goto(`${BASE}/s/${sys.zentral}/formular/${forms.software}`);
  await page.waitForSelector('.portal-form');
  await page.fill('#ff-programm', 'Bildbearbeitung');
  await page.fill('#ff-grund', 'Fotos für Website und Prospekte bearbeiten.');
  await page.selectOption('#ff-lizenz', 'kostenpflichtig');
  await page.fill('#ff-vorgesetzt', 'anna.becker@example.org');
  await page.waitForTimeout(600);
  await shot(page, '40-freigabe-formular', { full: true });
  // Glocke
  await page.goto(`${BASE}/s/${sys.zentral}`);
  await page.waitForSelector('.form-list');
  await page.click('.notif-menu summary');
  await page.waitForSelector('.notif-list, .notif-empty');
  await shot(page, '45-freigabe-benachrichtigungen');
  // Liste und Entscheidung
  await page.goto(`${BASE}/freigaben`);
  await page.waitForSelector('.approval-list, .empty');
  await shot(page, '42-freigabe-liste');
  await page.click('.approval-list a');
  await page.waitForSelector('.decide');
  await page.fill('.decide textarea', 'Kostenstelle 4711');
  await shot(page, '43-freigabe-entscheiden', { full: true });
  // Sicht der anfragenden Person
  await page.goto(`${BASE}/anfragen`);
  await page.waitForSelector('.table');
  await shot(page, '44-freigabe-meine-anfragen');
  // Editor: Feldtyp und Eigenschaften
  await page.goto(`${BASE}/admin/systeme/${sys.zentral}/formulare/${forms.software}`);
  await page.waitForSelector('.field-list');
  await page.click('.field-row:has-text("Wer gibt die Lizenz frei")');
  await page.waitForTimeout(300);
  await shot(page, '46-freigabe-editor', { full: true });
  await ctx.close();
}

await browser.close();
console.log('fertig');
void entraLogin;
