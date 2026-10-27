// Lasttest: startet Portal, Zammad-Simulator und Entra-Simulator in einem Prozess und misst
// typische Spitzen – viele Anmeldungen, viele Ticketansichten, gleichzeitige Anfragen mit Anhängen.
//
//   node tools/loadtest.ts [--users 50] [--submits 20] [--upload-kb 1024] [--json docs/lasttest-ergebnis.json]
//
// Gemessen wird die Antwortzeit des Portals einschließlich der Aufrufe an den (simulierten) Zammad.
// Echte Zammad-Instanzen antworten langsamer; die Werte zeigen, was das Portal selbst kostet.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, cpus, totalmem } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { loadConfig } from '../src/server/config.ts';
import { createApp } from '../src/server/app.ts';
import { createServer } from '../src/server/server.ts';
import { EntraClient } from '../src/server/auth/oidc.ts';
import { setLogLevel } from '../src/server/log.ts';
import { deliverNext } from '../src/server/services/requests.ts';
import { startMockZammad } from './mock-zammad.ts';
import { startMockEntra, type MockEntraUser } from './mock-entra.ts';
import { Client, createSystem, createForm } from '../test/helpers.ts';

const argv = process.argv.slice(2);
const opt = (name: string, def: number) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? Number(argv[i + 1]) : def; };
const USERS = opt('users', 50);
const SUBMITS = opt('submits', 20);
const UPLOAD_KB = opt('upload-kb', 1024);
const jsonOut = (() => { const i = argv.indexOf('--json'); return i >= 0 ? argv[i + 1] : null; })();

const TENANT = 'aaaaaaaa-0000-0000-0000-000000000001';
const PUBLIC_URL = 'https://portal.test';

interface Sample { ms: number; status: number }
function stats(samples: Sample[]) {
  const ms = samples.map((s) => s.ms).sort((a, b) => a - b);
  const q = (p: number) => ms.length ? ms[Math.min(ms.length - 1, Math.ceil(p * ms.length) - 1)] : 0;
  const ok = samples.filter((s) => s.status >= 200 && s.status < 400).length;
  return {
    count: samples.length, ok, errors: samples.length - ok,
    p50: Math.round(q(0.5)), p95: Math.round(q(0.95)), max: Math.round(ms.at(-1) ?? 0),
    avg: Math.round(ms.reduce((a, b) => a + b, 0) / (ms.length || 1)),
    statusCodes: [...new Set(samples.map((s) => s.status))].sort(),
  };
}
async function timed<T>(fn: () => Promise<{ status: number } & T>): Promise<Sample> {
  const t = performance.now();
  try { const r = await fn(); return { ms: performance.now() - t, status: r.status }; } catch { return { ms: performance.now() - t, status: 0 }; }
}

setLogLevel('error', true);
const dir = mkdtempSync(join(tmpdir(), 'zsp-load-'));
const users: MockEntraUser[] = Array.from({ length: USERS }, (_, i) => ({
  oid: `0b6f3c1e-2222-4a6e-9a5e-${String(i).padStart(12, '0')}`, tid: TENANT, name: `Last Test ${i}`, email: `last.test${i}@example.org`, groups: ['grp-mitarbeiter'],
}));
const zammad = await startMockZammad({ quiet: true, customers: users.slice(0, Math.ceil(USERS / 2)).map((u, i) => ({ email: u.email, firstname: 'Last', lastname: `Test${i}` })) });
const entra = await startMockEntra(users);
process.env.NODE_ENV = 'test';
const cfg = loadConfig({
  env: 'test', dataDir: dir, publicUrl: PUBLIC_URL, secretKey: randomBytes(32), localLogin: true, trustProxy: [], adminAllowedCidrs: [],
  entra: { enabled: true, tenantId: TENANT, clientId: entra.clientId, clientSecret: entra.clientSecret, allowedTenants: [TENANT], authority: entra.url, graphUrl: entra.url },
  clamav: { host: undefined, port: 3310, required: false },
  rateLimits: { api: [100000, 1000], write: [100000, 1000], login: [100000, 1000] },
});
const app = createApp(cfg);
const { server } = createServer(app, { entra: new EntraClient(cfg) });
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const systemId = createSystem(app, zammad.url);
const formId = createForm(app, systemId);

async function login(u: MockEntraUser): Promise<Client> {
  const c = new Client(base);
  const start = await c.get('/api/auth/entra/login?returnTo=%2F');
  const authorize = await fetch(`${start.headers.get('location')!}&as=${u.oid}`, { redirect: 'manual' });
  const cb = new URL(authorize.headers.get('location')!);
  const r = await c.get(cb.pathname + cb.search);
  await c.refresh();
  return Object.assign(c, { lastStatus: r.status });
}

const result: Record<string, unknown> = {
  date: new Date().toISOString(), node: process.version, cpus: cpus().length, memGb: Math.round(totalmem() / 1024 ** 3),
  params: { users: USERS, submits: SUBMITS, uploadKb: UPLOAD_KB },
};
const memStart = process.memoryUsage().rss;

// 1) Anmeldespitze
let clients: Client[] = [];
const loginSamples: Sample[] = [];
let t0 = performance.now();
await Promise.all(users.map(async (u, i) => {
  const t = performance.now();
  try {
    const c = await login(u);
    loginSamples.push({ ms: performance.now() - t, status: (c as any).lastStatus });
    clients[i] = c;
  } catch { loginSamples.push({ ms: performance.now() - t, status: 0 }); }
}));
result.login = { ...stats(loginSamples), wallMs: Math.round(performance.now() - t0) };
clients = clients.filter(Boolean);

// 2) Ticketansichten gleichzeitig (Liste mit refresh, danach aus dem Zwischenspeicher)
t0 = performance.now();
const listSamples = await Promise.all(clients.map((c) => timed(() => c.get(`/api/portal/systems/${systemId}/tickets?refresh=1`))));
result.ticketList = { ...stats(listSamples), wallMs: Math.round(performance.now() - t0) };
t0 = performance.now();
const cachedSamples = await Promise.all(clients.map((c) => timed(() => c.get(`/api/portal/systems/${systemId}/tickets`))));
result.ticketListCached = { ...stats(cachedSamples), wallMs: Math.round(performance.now() - t0) };
const withTicket = clients.slice(0, Math.ceil(USERS / 2));
const firstIds = await Promise.all(withTicket.map(async (c) => (await c.get(`/api/portal/systems/${systemId}/tickets`)).json?.tickets?.[0]?.id));
t0 = performance.now();
const detailSamples = await Promise.all(withTicket.map((c, i) => timed(() => c.get(`/api/portal/systems/${systemId}/tickets/${firstIds[i]}`))));
result.ticketDetail = { ...stats(detailSamples), wallMs: Math.round(performance.now() - t0) };

// 3) Gleichzeitige Anfragen mit Anhang
const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), randomBytes(UPLOAD_KB * 1024)]).toString('base64');
t0 = performance.now();
const submitSamples = await Promise.all(clients.slice(0, SUBMITS).map((c, i) => timed(() => c.post(`/api/portal/forms/${formId}/submit`, {
  values: { betreff: `Lasttest ${i}`, beschreibung: 'Gleichzeitige Anfrage mit Anhang', standort: 'nord' },
  files: { anhang: [{ name: `anhang-${i}.pdf`, type: 'application/pdf', data: pdf }] },
}))));
result.submit = { ...stats(submitSamples), wallMs: Math.round(performance.now() - t0) };

// 4) Zustellung der Warteschlange durch den Worker
t0 = performance.now();
let delivered = 0;
while (await deliverNext(app)) delivered++;
const queue = app.db.all<{ status: string; n: number }>('SELECT status, COUNT(*) n FROM requests GROUP BY status');
result.delivery = { delivered, wallMs: Math.round(performance.now() - t0), perRequestMs: Math.round((performance.now() - t0) / (delivered || 1)), statuses: Object.fromEntries(queue.map((r) => [r.status, r.n])) };
result.memory = { rssStartMb: Math.round(memStart / 1024 ** 2), rssEndMb: Math.round(process.memoryUsage().rss / 1024 ** 2) };

await new Promise<void>((r) => server.close(() => r()));
server.closeAllConnections?.();
await zammad.close();
await entra.close();
app.db.close();
rmSync(dir, { recursive: true, force: true });

console.log(JSON.stringify(result, null, 2));
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(result, null, 2) + '\n');
const failed = ['login', 'ticketList', 'ticketDetail', 'submit'].some((k) => (result[k] as any).errors > 0) || (result.delivery as any).statuses.failed;
process.exit(failed ? 1 : 0);
