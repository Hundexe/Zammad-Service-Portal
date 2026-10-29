// Verwaltung: Härtungen aus dem Sicherheitstest vom 28.10.2026 (ST-03, ST-08, ST-11, ST-13, ST-17, ST-18, ST-23, ST-26, ST-34).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startPortal, Client, createSystem, createForm, createUser, ENTRA_USERS, type Portal } from './helpers.ts';
import { checkLogo } from '../src/server/services/files.ts';
import { templateHtmlProblems } from '../src/shared/template.ts';
import { buildTicket } from '../src/server/services/requests.ts';

const PW = 'Test-Passwort-123!';
const QUELLE = 'TOKEN-A-geheim';
const EIGENES = 'eigenes-token';
let p: Portal;
let sysA: string;
let sysB: string;
let other: Server;
let otherUrl = '';
const seen: string[] = [];

before(async () => {
  p = await startPortal();
  sysA = createSystem(p.app, p.zammad.url, { slug: 'sys-a', name: 'A', token: QUELLE });
  sysB = createSystem(p.app, p.zammad.url, { slug: 'sys-b', name: 'B', requireApproval: true });
  await createUser(p.app, { username: 'super', role: 'Super-Admin' });
  await createUser(p.app, { username: 'ziel-a', role: 'Ziel-Admin', systemId: sysA });
  await createUser(p.app, { username: 'ziel-b', role: 'Ziel-Admin', systemId: sysB });
  await createUser(p.app, { username: 'editor-b', role: 'Formular-Editor', systemId: sysB });
  other = createServer((req, res) => { seen.push(String(req.headers.authorization ?? '')); res.end('{}'); });
  await new Promise<void>((r) => other.listen(0, '127.0.0.1', () => r()));
  otherUrl = `http://127.0.0.1:${(other.address() as AddressInfo).port}`;
});
after(async () => { other.close(); await p.close(); });

async function local(name: string) {
  const c = new Client(p.url);
  await c.loginLocal(name, PW);
  return c;
}

test('Neue Zammad-Adresse ohne neues Token wird abgelehnt – das Token geht nie an fremde Server', async () => {
  const c = await local('ziel-a');
  const r = await c.put(`/api/admin/systems/${sysA}`, { baseUrl: otherUrl });
  assert.equal(r.status, 422);
  assert.ok(r.json.details.apiToken);
  await c.post(`/api/admin/systems/${sysA}/test`);
  assert.ok(!seen.some((x) => x.includes(QUELLE)), 'kein Token beim fremden Server');
  // Gleicher Ursprung, anderer Pfad: erlaubt
  assert.equal((await c.put(`/api/admin/systems/${sysA}`, { baseUrl: `${p.zammad.url}/` })).status, 200);
  // Mit eigenem Token: erlaubt (dann ist es sein Token)
  assert.equal((await c.put(`/api/admin/systems/${sysA}`, { baseUrl: otherUrl, apiToken: EIGENES })).status, 200);
  assert.ok(p.app.db.get("SELECT 1 FROM audit_log WHERE action = 'system.tested'"), 'Verbindungstest im Audit-Log');
  assert.equal((await c.put(`/api/admin/systems/${sysA}`, { baseUrl: p.zammad.url, apiToken: 'test-token' })).status, 200);
});

test('Import: geänderte Adresse ohne Token → System ohne Token und deaktiviert', async () => {
  const s = await local('super');
  const exp = await s.post('/api/admin/transfer/export', {});
  assert.equal(exp.status, 200, exp.text);
  const file = exp.json.file;
  file.systems.find((x: any) => x.slug === 'sys-a').baseUrl = otherUrl;
  const prev = await s.post('/api/admin/transfer/preview', { file });
  assert.equal(prev.status, 200, prev.text);
  const planA = prev.json.plan.systems.find((x: any) => x.slug === 'sys-a');
  assert.equal(planA.urlChanged, true);
  assert.equal(planA.tokenDropped, true);
  const imp = await s.post('/api/admin/transfer/import', { file, confirm: true });
  assert.equal(imp.status, 200, imp.text);
  const row = p.app.db.get<{ api_token: string | null; status: string }>("SELECT api_token, status FROM ticket_systems WHERE slug = 'sys-a'")!;
  assert.equal(row.api_token, null);
  assert.equal(row.status, 'inactive');
  // für die folgenden Tests zurücksetzen
  sysA = p.app.db.get<{ id: string }>("SELECT id FROM ticket_systems WHERE slug = 'sys-a'")!.id;
  sysB = p.app.db.get<{ id: string }>("SELECT id FROM ticket_systems WHERE slug = 'sys-b'")!.id;
  await s.put(`/api/admin/systems/${sysA}`, { baseUrl: p.zammad.url, apiToken: 'test-token', status: 'active' });
});

test('Vier-Augen-Prinzip: nur ein globaler Admin schaltet es ab', async () => {
  const z = await local('ziel-b');
  assert.equal((await z.put(`/api/admin/systems/${sysB}`, { requireApproval: false })).status, 403);
  const s = await local('super');
  assert.equal((await s.put(`/api/admin/systems/${sysB}`, { requireApproval: false })).status, 200);
  assert.equal((await s.put(`/api/admin/systems/${sysB}`, { requireApproval: true })).status, 200);
});

test('Vier-Augen-Prinzip: Name, Text und Sichtbarkeit gelten erst nach der Freigabe', async () => {
  const formId = createForm(p.app, sysB, undefined, 'geheim');
  p.app.db.run("UPDATE forms SET visible_groups = '[\"grp-geheim\"]' WHERE id = ?", formId);
  const e = await local('editor-b');
  const u = await e.put(`/api/admin/systems/${sysB}/forms/${formId}`, { name: 'Neuer Name', description: 'Neuer Text', visibleGroups: [] });
  assert.equal(u.status, 200, u.text);
  assert.equal(u.json.staged, true);
  let f = p.app.db.get<{ name: string; visible_groups: string }>('SELECT name, visible_groups FROM forms WHERE id = ?', formId)!;
  assert.equal(f.name, 'Störung melden', 'noch nicht live');
  assert.equal(f.visible_groups, '["grp-geheim"]');
  // Zweite Person reicht ein und gibt frei
  const z = await local('ziel-b');
  const sub = await z.post(`/api/admin/systems/${sysB}/forms/${formId}/publish`, {});
  assert.equal(sub.status, 200, sub.text);
  const pending = p.app.db.get<{ id: string }>("SELECT id FROM form_versions WHERE form_id = ? AND status = 'pending'", formId)!;
  const s = await local('super');
  assert.equal((await s.post(`/api/admin/systems/${sysB}/forms/${formId}/versions/${pending.id}/approve`, {})).status, 200);
  f = p.app.db.get<{ name: string; visible_groups: string }>('SELECT name, visible_groups FROM forms WHERE id = ?', formId)!;
  assert.equal(f.name, 'Neuer Name');
  assert.equal(f.visible_groups, '[]');
});

test('Zammad-Adresse mit leerem ? oder # am Ende wird abgelehnt', async () => {
  const s = await local('super');
  for (const suffix of ['?', '#', '/x?']) {
    const r = await s.put(`/api/admin/systems/${sysA}`, { baseUrl: `${p.zammad.url}${suffix}`, apiToken: 'test-token' });
    assert.equal(r.status, 422, suffix);
  }
});

test('SVG-Logos: Allowlist, Umgehungen über Präfix und Entities scheitern, gespeichert wird die bereinigte Fassung', () => {
  const bad = [
    '<svg><h:script xmlns:h="http://www.w3.org/1999/xhtml">alert(1)</h:script></svg>',
    '<svg><a x:href="javascript:alert(1)"><rect/></a></svg>',
    '<svg><use href="&#x6A;avascript:alert(1)"/></svg>',
    '<svg><animate attributeName="href" values="&#106;avascript:x"/></svg>',
    '<svg><set attributeName="href" to="javascript:x"/></svg>',
  ];
  for (const s of bad) assert.throws(() => checkLogo(Buffer.from(s), 'logo'), /nicht erlaubte/, s);
  const ok = checkLogo(Buffer.from('<svg viewBox="0 0 1 1" xmlns:inkscape="x" inkscape:label="a"><metadata><x/></metadata><path d="M0 0"/></svg>'), 'logo');
  assert.equal(ok.mime, 'image/svg+xml');
  assert.equal(ok.data.toString(), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><path d="M0 0"/></svg>');
});

test('Text-Vorlagen: nur einfache Formatierung, keine Platzhalter in Tags', async () => {
  assert.deepEqual(templateHtmlProblems('<p>Hallo <strong>{{benutzer.name}}</strong></p>{{alle_felder}}<a href="https://intranet">Hilfe</a>'), []);
  assert.ok(templateHtmlProblems('<img src="https://tracker/x.gif">').length);
  assert.ok(templateHtmlProblems('<a href="{{link}}">x</a>').length);
  assert.ok(templateHtmlProblems('<a href="javascript:alert(1)">x</a>').length);
  assert.ok(templateHtmlProblems('<p style="x">a</p>').length);
  const s = await local('super');
  const r = await s.post(`/api/admin/systems/${sysA}/templates`, { kind: 'body', name: 'Pixel', content: '<p>x</p><img src="https://t/x.gif">' });
  assert.equal(r.status, 422);
});

test('Tag „freigegeben“ kann nicht aus dem Formular kommen', () => {
  const sys = p.app.db.get<any>('SELECT * FROM ticket_systems WHERE id = ?', sysA)!;
  const t = buildTicket(sys, { id: 'f', name: 'F' } as any, { fields: [], settings: { titleTemplate: 'x', bodyTemplate: '', group: 'IT-Support', tags: ['Freigegeben', 'software'] } } as any, {}, { id: 'u', displayName: 'U', email: 'u@example.org', department: null } as any, 'req-1');
  assert.ok(!t.tags.some((x) => x.toLowerCase() === 'freigegeben'));
  assert.ok(t.tags.includes('software'));
});

test('Personensuche: nur Microsoft-Konten, ab drei Zeichen', async () => {
  const a = new Client(p.url);
  await a.loginEntra(p, ENTRA_USERS[0].oid);
  await new Client(p.url).loginEntra(p, ENTRA_USERS[2].oid);
  assert.equal((await a.get('/api/portal/people?q=al')).json.people.length, 0);
  assert.ok((await a.get('/api/portal/people?q=ale')).json.people.length >= 1);
  const l = await local('super');
  assert.equal((await l.get('/api/portal/people?q=ale')).json.people.length, 0);
});

test('Ticketsystem löschen entfernt auch gespeicherte Anhänge', async () => {
  const s = await local('super');
  const sysC = createSystem(p.app, p.zammad.url, { slug: 'sys-c', name: 'C' });
  const reqId = '11111111-2222-4333-8444-555555555555';
  p.app.db.run("INSERT INTO requests (id, user_id, system_id, form_id, form_version_id, title, status, attempts, next_attempt_at, created_at) VALUES (?, (SELECT id FROM users LIMIT 1), ?, 'f', 'v', 'x', 'failed', 1, 0, ?)", reqId, sysC, Date.now());
  const dir = join(p.app.uploadsDir, reqId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'f1'), 'x');
  assert.equal((await s.del(`/api/admin/systems/${sysC}`)).status, 200);
  assert.equal(existsSync(dir), false);
});
