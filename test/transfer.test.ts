// Export und Import der Ticketsysteme zwischen zwei Portalen.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startPortal, Client, createSystem, createForm, createUser, ENTRA_USERS, type Portal } from './helpers.ts';
import { uuid } from '../src/server/db/db.ts';

let a: Portal; // Quelle
let b: Portal; // Ziel
let adminA: Client;
let adminB: Client;
let sysA: string;
const PASSWORT = 'Export-Passwort-2026';
const QUELL_TOKEN = ['quelle', 'token', '123'].join('-');
const FALSCH = `${PASSWORT}-falsch`;
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>');

async function adminOf(p: Portal): Promise<Client> {
  await createUser(p.app, { username: 'it-admin', role: 'Super-Admin' });
  const c = new Client(p.url);
  await c.loginLocal('it-admin', 'Test-Passwort-123!');
  return c;
}

async function exportFile(c: Client, password?: string) {
  const r = await c.post('/api/admin/transfer/export', password ? { includeTokens: true, password } : { includeTokens: false });
  assert.equal(r.status, 200, r.text);
  return r.json.file;
}

before(async () => {
  a = await startPortal();
  b = await startPortal();
  adminA = await adminOf(a);
  adminB = await adminOf(b);
  // Quelle: ein System über die API (mit Stil, Vorlagen, Übersichten), Logo, Formular mit zwei Versionen
  const r = await adminA.post('/api/admin/systems', { slug: 'zentrale-it', name: 'Zentrale IT', baseUrl: a.zammad.url, apiToken: QUELL_TOKEN, defaultGroup: 'IT-Support', allowedGroups: ['IT-Support'] });
  assert.equal(r.status, 201, r.text);
  sysA = r.json.system.id;
  const logo = uuid();
  a.app.db.run("INSERT INTO assets (id, kind, mime, size, sha256, data, created_at) VALUES (?, 'logo', 'image/svg+xml', ?, 'x', ?, ?)", logo, SVG.length, SVG, Date.now());
  const bv = a.app.db.get<{ id: string; data: string }>("SELECT id, data FROM branding_versions WHERE system_id = ? AND status = 'published'", sysA)!;
  a.app.db.run('UPDATE branding_versions SET data = ? WHERE id = ?', JSON.stringify({ ...JSON.parse(bv.data), theme: 'glas', logoLightId: logo, logoDarkId: logo }), bv.id);
  a.app.db.run("UPDATE ticket_systems SET released_attributes = '[{\"name\":\"standort\",\"allowedValues\":null}]' WHERE id = ?", sysA);
  createForm(a.app, sysA, undefined, 'stoerung');
  // Ziel: ein System mit gleichem Kürzel (bleibt mit seiner ID), eins, das wegfällt
  const sysB = createSystem(b.app, b.zammad.url, { slug: 'zentrale-it', name: 'Alt', token: 'altes-token' });
  createForm(b.app, sysB, undefined, 'veraltet');
  createSystem(b.app, b.zammad.url, { slug: 'wird-geloescht', name: 'Weg damit' });
});
after(async () => { await a.close(); await b.close(); });

test('Export ohne Passwort enthält keine Geheimnisse', async () => {
  const f = await exportFile(adminA);
  const text = JSON.stringify(f);
  assert.equal(f.format, 'zammad-service-portal-export');
  assert.equal(f.tokens, null);
  assert.ok(!text.includes(QUELL_TOKEN));
  const s = f.systems.find((x: any) => x.slug === 'zentrale-it');
  assert.equal(s.apiToken, null);
  assert.equal(s.forms[0].slug, 'stoerung');
  assert.ok(s.forms[0].versions.length >= 1);
  assert.ok(s.templates.length >= 3 && s.overviews.length >= 2);
  assert.equal(s.branding.find((v: any) => v.status === 'published').data.logoLightId, 'asset-1', 'Logo als Verweis');
  assert.equal(f.assets.length, 1, 'gleiches Logo nur einmal');
});

test('Export mit Passwort: Token verschlüsselt; falsches Passwort wird abgelehnt', async () => {
  const short = await adminA.post('/api/admin/transfer/export', { includeTokens: true, password: 'kurz' });
  assert.equal(short.status, 422);
  const f = await exportFile(adminA, PASSWORT);
  assert.ok(!JSON.stringify(f).includes(QUELL_TOKEN));
  assert.ok(f.systems[0].apiToken.data);
  const none = await adminB.post('/api/admin/transfer/preview', { file: f });
  assert.equal(none.status, 422);
  assert.match(none.json.error, /Export-Passwort/);
  const wrong = await adminB.post('/api/admin/transfer/preview', { file: f, password: FALSCH });
  assert.equal(wrong.status, 422);
  assert.match(wrong.json.error, /falsch/);
});

test('Vorschau zeigt, was ersetzt, angelegt und gelöscht wird – ohne etwas zu ändern', async () => {
  const f = await exportFile(adminA, PASSWORT);
  const before = b.app.db.get<{ n: number }>('SELECT COUNT(*) n FROM ticket_systems')!.n;
  const r = await adminB.post('/api/admin/transfer/preview', { file: f, password: PASSWORT });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.plan.systems.map((s: any) => [s.slug, s.action, s.token]), [['zentrale-it', 'replace', true]]);
  assert.deepEqual(r.json.plan.remove.map((s: any) => s.slug), ['wird-geloescht']);
  assert.ok(!JSON.stringify(r.json).includes(QUELL_TOKEN), 'Vorschau ohne Geheimnisse');
  assert.equal(b.app.db.get<{ n: number }>('SELECT COUNT(*) n FROM ticket_systems')!.n, before);
});

test('Offene Anfragen in einem System, das wegfallen würde, verhindern den Import', async () => {
  const f = await exportFile(adminA, PASSWORT);
  const weg = b.app.db.get<{ id: string }>("SELECT id FROM ticket_systems WHERE slug = 'wird-geloescht'")!;
  const user = b.app.db.get<{ id: string }>("SELECT id FROM users WHERE username = 'it-admin'")!;
  b.app.db.run("INSERT INTO requests (id, user_id, system_id, form_id, form_version_id, title, status, next_attempt_at, created_at) VALUES (?, ?, ?, 'f', 'v', 'Offen', 'queued', ?, ?)", uuid(), user.id, weg.id, Date.now(), Date.now());
  const r = await adminB.post('/api/admin/transfer/import', { file: f, password: PASSWORT, confirm: true });
  assert.equal(r.status, 422);
  assert.ok(r.json.details.some((d: string) => /offene Anfrage/.test(d)));
  assert.ok(b.app.db.get("SELECT 1 FROM ticket_systems WHERE slug = 'wird-geloescht'"), 'nichts geändert');
  b.app.db.run("UPDATE requests SET status = 'delivered' WHERE system_id = ?", weg.id);
});

test('Import ersetzt alles: gleiche ID bei gleichem Kürzel, Rollen bleiben, Token und Logos übernommen', async () => {
  const f = await exportFile(adminA, PASSWORT);
  const sysB = b.app.db.get<{ id: string }>("SELECT id FROM ticket_systems WHERE slug = 'zentrale-it'")!.id;
  const role = b.app.db.get<{ id: string }>("SELECT id FROM roles WHERE name = 'Ziel-Admin'")!;
  b.app.db.run("INSERT INTO role_assignments (id, role_id, subject_type, subject_value, system_id, created_at) VALUES (?, ?, 'group', 'it-admins', ?, ?)", uuid(), role.id, sysB, Date.now());
  assert.equal((await adminB.post('/api/admin/transfer/import', { file: f, password: PASSWORT })).status, 422, 'ohne Bestätigung nicht');
  const r = await adminB.post('/api/admin/transfer/import', { file: f, password: PASSWORT, confirm: true });
  assert.equal(r.status, 200, r.text);
  const sys = b.app.db.get<{ id: string; name: string; api_token: string; released_attributes: string; allowed_groups: string }>("SELECT * FROM ticket_systems WHERE slug = 'zentrale-it'")!;
  assert.equal(sys.id, sysB);
  assert.equal(sys.name, 'Zentrale IT');
  assert.equal(b.app.box.decrypt('system-token', sys.api_token), QUELL_TOKEN);
  assert.deepEqual(JSON.parse(sys.allowed_groups), ['IT-Support']);
  assert.match(sys.released_attributes, /standort/);
  assert.ok(b.app.db.get('SELECT 1 FROM role_assignments WHERE system_id = ?', sysB), 'Rollen-Zuordnung bleibt');
  assert.equal(b.app.db.get("SELECT 1 FROM ticket_systems WHERE slug = 'wird-geloescht'"), undefined);
  const forms = b.app.db.all<{ slug: string }>('SELECT slug FROM forms WHERE system_id = ?', sysB).map((x) => x.slug);
  assert.deepEqual(forms, ['stoerung'], 'veraltetes Formular gelöscht');
  const brand = JSON.parse(b.app.db.get<{ data: string }>("SELECT data FROM branding_versions WHERE system_id = ? AND status = 'published'", sysB)!.data);
  assert.equal(brand.theme, 'glas');
  const asset = b.app.db.get<{ data: Uint8Array }>('SELECT data FROM assets WHERE id = ?', brand.logoLightId)!;
  assert.equal(Buffer.from(asset.data).toString(), SVG.toString());
  assert.ok(b.app.db.get("SELECT 1 FROM audit_log WHERE action = 'transfer.imported'"));
  // Das importierte Formular ist im Portal nutzbar
  const user = new Client(b.url);
  await user.loginEntra(b, ENTRA_USERS[0].oid);
  const list = await user.get(`/api/portal/systems/${sysB}/forms`);
  assert.deepEqual(list.json.forms.map((x: any) => x.slug), ['stoerung']);
});

test('Rundreise: Export des Ziels entspricht dem Export der Quelle', async () => {
  const strip = (f: any) => JSON.parse(JSON.stringify(f, (k, v) => (['createdAt', 'publishedAt', 'tokens', 'apiToken', 'portalVersion'].includes(k) ? undefined : v)));
  assert.deepEqual(strip(await exportFile(adminB)), strip(await exportFile(adminA)));
});

test('Unsichere Inhalte werden abgelehnt', async () => {
  const base = await exportFile(adminA);
  const bad = (mut: (f: any) => void) => { const f = structuredClone(base); mut(f); return f; };
  const cases: [string, any][] = [
    ['geschütztes Zammad-Feld', bad((f) => { f.systems[0].forms[0].versions[0].definition.fields[0].mapping = { target: 'zammad_field', name: 'owner_id' }; })],
    ['SVG mit Skript', bad((f) => { f.assets[0].data = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString('base64'); })],
    ['Metadaten-Adresse', bad((f) => { f.systems[0].baseUrl = 'http://169.254.169.254'; })],
    ['geschütztes Zammad-Objekt', bad((f) => { f.systems[0].releasedAttributes = [{ name: 'customer_id', allowedValues: null }]; })],
    ['fremdes Format', bad((f) => { f.format = 'irgendwas'; })],
    ['Übersicht mit unbekannter Spalte', bad((f) => { f.systems[0].overviews[0].columns = ['password']; })],
  ];
  assert.equal((await adminB.post('/api/admin/transfer/preview', { file: base })).status, 200, 'unverändert gültig');
  const expect: Record<string, RegExp> = { 'geschütztes Zammad-Feld': /owner_id/, 'SVG mit Skript': /SVG/, 'Metadaten-Adresse': /Zammad-Adresse/, 'geschütztes Zammad-Objekt': /customer_id/, 'fremdes Format': /keine Export-Datei/, 'Übersicht mit unbekannter Spalte': /Übersicht/ };
  for (const [name, f] of cases) {
    const r = await adminB.post('/api/admin/transfer/preview', { file: f });
    assert.equal(r.status, 422, name);
    assert.match(`${r.json.error} ${(r.json.details ?? []).join(' ')}`, expect[name], name);
  }
});

test('Nur globale Admins; Import verlangt frische Anmeldung', async () => {
  const user = new Client(b.url);
  await user.loginEntra(b, ENTRA_USERS[0].oid);
  assert.ok([403, 404].includes((await user.post('/api/admin/transfer/export', {})).status));
  const sysB = b.app.db.get<{ id: string }>("SELECT id FROM ticket_systems WHERE slug = 'zentrale-it'")!.id;
  await createUser(b.app, { username: 'system-admin', role: 'Ziel-Admin', systemId: sysB });
  const sa = new Client(b.url);
  await sa.loginLocal('system-admin', 'Test-Passwort-123!');
  assert.equal((await sa.post('/api/admin/transfer/export', {})).status, 403, 'System-Admin');
  // Step-up abgelaufen
  const file = await exportFile(adminA);
  b.app.db.run('UPDATE sessions SET auth_time = auth_time - 3600000');
  const r = await adminB.post('/api/admin/transfer/import', { file, confirm: true });
  assert.equal(r.status, 403);
  assert.equal(r.json.code, 'stepup_required');
});
