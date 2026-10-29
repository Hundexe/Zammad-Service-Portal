// Daten und Betrieb: Härtungen aus dem Sicherheitstest vom 28.10.2026 (ST-10, ST-12, ST-14, ST-15).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startPortal, Client, createSystem, createForm, createUser, ENTRA_USERS, type Portal } from './helpers.ts';
import { deliverNext, purgeOld, PURGED_TITLE } from '../src/server/services/requests.ts';
import { notify, listNotifications } from '../src/server/services/notifications.ts';
import { toAuthUser, getUser } from '../src/server/services/users.ts';
import { blockedAddress, hostAllowed } from '../src/server/net/guarded-fetch.ts';

let p: Portal;
let proxy: http.Server;
let proxyUrl = '';
let breakCreate = true;

before(async () => {
  p = await startPortal();
  const target = new URL(p.zammad.url);
  // Proxy vor dem Zammad-Simulator: bricht die Antwort auf „Ticket anlegen“ nach dem Anlegen ab
  proxy = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const up = http.request({ host: target.hostname, port: target.port, path: req.url, method: req.method, headers: req.headers }, (ur) => {
        const body: Buffer[] = [];
        ur.on('data', (c) => body.push(c));
        ur.on('end', () => {
          const all = Buffer.concat(body);
          if (breakCreate && req.method === 'POST' && req.url === '/api/v1/tickets') {
            res.writeHead(ur.statusCode!, { 'content-type': 'application/json', 'content-length': String(all.length) });
            res.write(all.subarray(0, 5));
            setTimeout(() => res.socket?.destroy(), 20);
            return;
          }
          res.writeHead(ur.statusCode!, ur.headers);
          res.end(all);
        });
      });
      up.end(Buffer.concat(chunks));
    });
  });
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', () => r()));
  proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
  await createUser(p.app, { username: 'super', role: 'Super-Admin' });
});
after(async () => { proxy.close(); await p.close(); });

test('Abbruch nach dem Anlegen: neuer Versuch statt Fehler, kein Doppel-Ticket auch nach „Erneut senden“', async () => {
  const sys = createSystem(p.app, proxyUrl, { slug: 'proxy' });
  const formId = createForm(p.app, sys);
  const c = new Client(p.url);
  await c.loginEntra(p, ENTRA_USERS[0].oid);
  const r = await c.post(`/api/portal/forms/${formId}/submit`, { values: { betreff: 'Drucker', beschreibung: 'kaputt', standort: 'nord' } });
  assert.equal(r.status, 201, r.text);
  const start = p.zammad.state.tickets.length;
  await deliverNext(p.app);
  const row = p.app.db.get<{ status: string }>('SELECT status FROM requests WHERE id = ?', r.json.id)!;
  assert.equal(row.status, 'queued', 'vorübergehender Fehler → neuer Versuch');
  assert.equal(p.zammad.state.tickets.length - start, 1);
  // Admin stößt die Zustellung sofort an (Status auf failed setzen und erneut senden – wie „Erneut senden“)
  breakCreate = false;
  p.app.db.run("UPDATE requests SET status = 'failed' WHERE id = ?", r.json.id);
  const a = new Client(p.url);
  await a.loginLocal('super', 'Test-Passwort-123!');
  assert.equal((await a.post(`/api/admin/requests/${r.json.id}/retry`, {})).status, 200);
  await deliverNext(p.app);
  const done = p.app.db.get<{ status: string; ticket_number: string }>('SELECT status, ticket_number FROM requests WHERE id = ?', r.json.id)!;
  assert.equal(done.status, 'delivered');
  assert.equal(p.zammad.state.tickets.length - start, 1, 'kein zweites Ticket');
});

test('Benachrichtigungen liegen verschlüsselt in der Datenbank', async () => {
  const c = new Client(p.url);
  await c.loginEntra(p, ENTRA_USERS[0].oid);
  const uid = p.app.db.get<{ id: string }>('SELECT id FROM users WHERE entra_oid = ?', ENTRA_USERS[0].oid)!.id;
  notify(p.app, { to: { userId: uid }, kind: 'request.cancelled', title: 'Geheimer-Titel-XYZ', body: 'Vertraulicher-Grund-QRS' });
  const raw = p.app.db.get<{ title: string; body: string }>("SELECT title, body FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 1", uid)!;
  assert.ok(!raw.title.includes('Geheimer') && !raw.body.includes('Vertraulicher'));
  const list = listNotifications(p.app, toAuthUser(p.app.db, getUser(p.app.db, uid)!));
  assert.equal(list[0].title, 'Geheimer-Titel-XYZ');
  assert.equal(list[0].body, 'Vertraulicher-Grund-QRS');
  p.app.db.raw.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const file = readFileSync(join(p.cfg.dataDir, 'portal.sqlite'));
  assert.equal(file.includes(Buffer.from('Vertraulicher-Grund-QRS')), false);
});

test('Nach der Aufbewahrungsfrist verschwinden Titel und Fehlertext', () => {
  const r = p.app.db.get<{ id: string }>('SELECT id FROM requests LIMIT 1')!;
  p.app.db.run("UPDATE requests SET title = 'Burnout-Krankmeldung', last_error = 'Grund', purge_after = ? WHERE id = ?", Date.now() - 1000, r.id);
  purgeOld(p.app);
  const row = p.app.db.get<{ title: string; last_error: string | null }>('SELECT title, last_error FROM requests WHERE id = ?', r.id)!;
  assert.equal(row.title, PURGED_TITLE);
  assert.equal(row.last_error, null);
});

test('SSRF: zusätzliche gesperrte Netze und Allowlist für Hostnamen', () => {
  const o = { allowPrivate: true, allowLoopback: false, blockedCidrs: ['172.30.10.0/24', 'fd00:1::/64'] };
  assert.match(blockedAddress('172.30.10.5', o) ?? '', /gesperrtes Netz/);
  assert.match(blockedAddress('::ffff:172.30.10.5', o) ?? '', /gesperrtes Netz/);
  assert.match(blockedAddress('fd00:1::5', o) ?? '', /gesperrtes Netz/);
  assert.equal(blockedAddress('10.1.2.3', o), null);
  assert.equal(hostAllowed('zammad.firma.intern', ['.firma.intern']), true);
  assert.equal(hostAllowed('firma.intern', ['.firma.intern']), true);
  assert.equal(hostAllowed('evil.example', ['.firma.intern', 'zammad2.example']), false);
  assert.equal(hostAllowed('beliebig', []), true);
});

test('Docker-Stack: ALLOW_PRIVATE_TICKET_URLS ist nicht mehr fest vorgegeben', () => {
  const compose = readFileSync(new URL('../deploy/docker-compose.yml', import.meta.url), 'utf8');
  assert.ok(!/ALLOW_PRIVATE_TICKET_URLS:\s*"true"/.test(compose));
});

test('Abbruchgrund steht nicht im Audit-Log', async () => {
  const sys = createSystem(p.app, p.zammad.url, { slug: 'audit-test' });
  const formId = createForm(p.app, sys);
  const c = new Client(p.url);
  await c.loginEntra(p, ENTRA_USERS[0].oid);
  const r = await c.post(`/api/portal/forms/${formId}/submit`, { values: { betreff: 'X', beschreibung: 'Y', standort: 'nord' } });
  const a = new Client(p.url);
  await a.loginLocal('super', 'Test-Passwort-123!');
  assert.equal((await a.post(`/api/admin/requests/${r.json.id}/cancel`, { reason: 'Diagnose-ABC' })).status, 200);
  assert.equal(p.app.db.get("SELECT 1 FROM audit_log WHERE details LIKE '%Diagnose-ABC%'"), undefined);
});


test('Anfragetitel liegt verschlüsselt in der Datenbank, Listen zeigen ihn lesbar', async () => {
  const { sealLegacyTitles, openTitle } = await import('../src/server/services/request-title.ts');
  const sys = createSystem(p.app, p.zammad.url, { slug: 'titel' });
  const formId = createForm(p.app, sys);
  const c = new Client(p.url);
  await c.loginEntra(p, ENTRA_USERS[0].oid);
  const r = await c.post(`/api/portal/forms/${formId}/submit`, { values: { betreff: 'Vertraulicher-Betreff-77', beschreibung: 'x', standort: 'nord' } });
  assert.equal(r.status, 201, r.text);
  const raw = p.app.db.get<{ title: string }>('SELECT title FROM requests WHERE id = ?', r.json.id)!;
  assert.ok(raw.title.startsWith('v1.') && !raw.title.includes('Vertraulicher'));
  const list = await c.get('/api/portal/requests');
  assert.ok(list.json.requests.some((x: { title: string }) => x.title.includes('Vertraulicher-Betreff-77')));
  // Altbestand aus früheren Versionen wird beim Start nachträglich verschlüsselt
  p.app.db.run('UPDATE requests SET title = ? WHERE id = ?', 'Alter-Klartext-Titel', r.json.id);
  assert.ok(sealLegacyTitles(p.app.db, p.app.box) >= 1);
  const again = p.app.db.get<{ title: string }>('SELECT title FROM requests WHERE id = ?', r.json.id)!;
  assert.ok(again.title.startsWith('v1.'));
  assert.equal(openTitle(p.app.box, again.title), 'Alter-Klartext-Titel');
  p.app.db.raw.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  assert.equal(readFileSync(join(p.cfg.dataDir, 'portal.sqlite')).includes(Buffer.from('Vertraulicher-Betreff-77')), false);
});
