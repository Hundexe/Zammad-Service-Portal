// Nicht erreichbares Zammad: Seiten dürfen nicht lange hängen.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startPortal, Client, createSystem, createUser, type Portal } from './helpers.ts';
import { resetReachability } from '../src/server/connectors/zammad.ts';

// Adresse, an die Pakete verworfen werden (kein „Verbindung abgelehnt“): wie ein ausgeschalteter Server hinter einer Firewall
const BLACKHOLE = 'http://10.255.255.1:81';
let p: Portal;
let admin: Client;

before(async () => {
  p = await startPortal();
  await createUser(p.app, { username: 'super', role: 'Super-Admin' });
  admin = new Client(p.url);
  await admin.loginLocal('super', 'Test-Passwort-123!');
});
after(async () => { resetReachability(); await p.close(); });

async function timed<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const t = Date.now();
  const r = await fn();
  return [r, Date.now() - t];
}

test('Erster Abruf scheitert nach dem Verbindungs-Timeout, weitere sofort', async () => {
  const sys = createSystem(p.app, BLACKHOLE, { slug: 'weg' });
  const [first, t1] = await timed(() => admin.get(`/api/admin/systems/${sys}/metadata`));
  assert.equal(first.status, 502);
  assert.ok(t1 < 8000, `erster Abruf ${t1} ms`);
  const [second, t2] = await timed(() => admin.get(`/api/admin/systems/${sys}/metadata`));
  assert.equal(second.status, 502);
  assert.ok(t2 < 500, `zweiter Abruf ${t2} ms – sollte sofort scheitern`);
  assert.match(second.json.error, /gerade nicht erreichbar/);
});

test('Abgelaufene Stammdaten kommen sofort aus dem Zwischenspeicher, mit Hinweis', async () => {
  resetReachability();
  const sys = createSystem(p.app, BLACKHOLE, { slug: 'weg2' });
  p.app.db.run("INSERT INTO system_metadata (system_id, data, fetched_at) VALUES (?, '{\"groups\":[{\"id\":1,\"name\":\"IT\"}],\"states\":[],\"priorities\":[],\"fields\":[]}', ?)", sys, Date.now() - 3600_000);
  const [r, t] = await timed(() => admin.get(`/api/admin/systems/${sys}/metadata`));
  assert.equal(r.status, 200);
  assert.ok(t < 500, `${t} ms`);
  assert.equal(r.json.metadata.groups[0].name, 'IT');
  // Nach dem fehlgeschlagenen Erneuern im Hintergrund meldet die Seite den alten Stand
  await new Promise((res) => setTimeout(res, 6500));
  const again = await admin.get(`/api/admin/systems/${sys}/metadata`);
  assert.ok(again.json.state.lastError, 'Hinweis auf nicht erreichbares Zammad');
});
