// Ladezeiten: Startseite und Ticketliste dürfen nicht bei jedem Aufruf auf Zammad warten.
import { test, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { startPortal, Client, createSystem, ENTRA_USERS, type Portal } from './helpers.ts';
import { resetReachability } from '../src/server/connectors/zammad.ts';

let p: Portal;
let proxy: http.Server;
let proxyUrl = '';
let delayMs = 0;
let connections = 0;
let requests = 0;

before(async () => {
  p = await startPortal();
  const target = new URL(p.zammad.url);
  // Proxy vor dem Zammad-Simulator: zählt Verbindungen und kann Antworten verzögern
  proxy = http.createServer((req, res) => {
    requests++;
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => setTimeout(() => {
      const up = http.request({ host: target.hostname, port: target.port, path: req.url, method: req.method, headers: { ...req.headers, connection: 'close' } }, (ur) => {
        const headers = { ...ur.headers };
        delete headers.connection;
        res.writeHead(ur.statusCode!, headers);
        ur.pipe(res);
      });
      up.end(Buffer.concat(chunks));
    }, req.url?.includes('/tickets') ? delayMs : 0));
  });
  proxy.on('connection', () => { connections++; });
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', () => r()));
  proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
});
after(async () => { mock.timers.reset(); resetReachability(); proxy.closeAllConnections(); proxy.close(); await p.close(); });

test('Ticketliste: abgelaufener Stand kommt sofort, erneuert wird im Hintergrund', async () => {
  const sys = createSystem(p.app, proxyUrl, { slug: 'tempo' });
  const c = new Client(p.url);
  await c.loginEntra(p, ENTRA_USERS[0].oid);
  const first = await c.get(`/api/portal/systems/${sys}/tickets`);
  assert.equal(first.status, 200, first.text);
  assert.equal(first.json.unavailable, false);
  // Zammad wird langsam, der gespeicherte Stand ist eine Minute alt
  delayMs = 1500;
  mock.timers.enable({ apis: ['Date'], now: Date.now() + 60_000 });
  const t = performance.now();
  const second = await c.get(`/api/portal/systems/${sys}/tickets`);
  const took = performance.now() - t;
  assert.equal(second.status, 200);
  assert.ok(took < 800, `${Math.round(took)} ms – sollte nicht auf Zammad warten`);
  assert.deepEqual(second.json.tickets, first.json.tickets);
  // Ausdrücklich „Aktualisieren“ wartet auf den frischen Stand
  const t2 = performance.now();
  const fresh = await c.get(`/api/portal/systems/${sys}/tickets?refresh=1`);
  assert.equal(fresh.status, 200);
  assert.ok(performance.now() - t2 >= 1400, 'refresh=1 holt neu');
  mock.timers.reset();
  delayMs = 0;
});

test('Verbindungen zu Zammad werden wiederverwendet (Keep-Alive)', async () => {
  const sys = createSystem(p.app, proxyUrl, { slug: 'tempo2' });
  const c = new Client(p.url);
  await c.loginEntra(p, ENTRA_USERS[1].oid);
  connections = 0;
  requests = 0;
  for (let i = 0; i < 4; i++) await c.get(`/api/portal/systems/${sys}/tickets?refresh=1`);
  assert.ok(requests >= 4, `${requests} Aufrufe`);
  assert.ok(connections < requests, `${connections} Verbindungen für ${requests} Aufrufe`);
});
