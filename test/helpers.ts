// Test-Hilfen: startet Portal, Zammad-Simulator und Entra-Simulator im selben Prozess.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { loadConfig, type Config } from '../src/server/config.ts';
import { createApp, type App } from '../src/server/app.ts';
import { createServer } from '../src/server/server.ts';
import { EntraClient } from '../src/server/auth/oidc.ts';
import { setLogLevel } from '../src/server/log.ts';
import { hashPassword } from '../src/server/crypto.ts';
import { uuid } from '../src/server/db/db.ts';
import { startMockZammad, type MockZammad } from '../tools/mock-zammad.ts';
import { startMockEntra, type MockEntra, type MockEntraUser } from '../tools/mock-entra.ts';
import { saveDraft, publishVersion, emptyDefinition } from '../src/server/services/forms.ts';
import type { FormDefinition } from '../src/shared/form.ts';
import { totpCode, currentStep } from '../src/server/auth/totp.ts';

export const PUBLIC_URL = 'https://portal.test';
export const TENANT_A = 'aaaaaaaa-0000-0000-0000-000000000001';
export const TENANT_B = 'bbbbbbbb-0000-0000-0000-000000000002';

export const ENTRA_USERS: MockEntraUser[] = [
  { oid: '0b6f3c1e-1111-4a6e-9a5e-000000000001', tid: TENANT_A, name: 'Anna Becker', email: 'anna.becker@example.org', groups: ['grp-mitarbeiter'] },
  { oid: '0b6f3c1e-1111-4a6e-9a5e-000000000002', tid: TENANT_B, name: 'Ben Krause', email: 'ben.krause@example.org', groups: ['grp-mitarbeiter', 'it-admins'] },
  { oid: '0b6f3c1e-1111-4a6e-9a5e-000000000003', tid: TENANT_A, name: 'Alex Berger', email: 'alex.berger@example.org', groups: ['grp-mitarbeiter'] },
];

export interface Portal {
  url: string;
  app: App;
  cfg: Config;
  zammad: MockZammad;
  entra: MockEntra;
  entraClient: EntraClient;
  close: () => Promise<void>;
}

export async function startPortal(over: Partial<Config> = {}): Promise<Portal> {
  setLogLevel('error', true);
  const dir = mkdtempSync(join(tmpdir(), 'zsp-test-'));
  const zammad = await startMockZammad({ quiet: true, customers: [{ email: 'anna.becker@example.org', firstname: 'Anna', lastname: 'Becker' }] });
  const entra = await startMockEntra(ENTRA_USERS);
  process.env.NODE_ENV = 'test';
  const cfg = loadConfig({
    env: 'test',
    dataDir: dir,
    publicUrl: PUBLIC_URL,
    secretKey: randomBytes(32),
    localLogin: true,
    localAdminRequireTotp: false,
    trustProxy: [],
    adminAllowedCidrs: [],
    entra: {
      enabled: true, tenantId: TENANT_A, clientId: entra.clientId, clientSecret: entra.clientSecret,
      allowedTenants: [TENANT_A, TENANT_B], authority: entra.url, graphUrl: entra.url,
    },
    clamav: { host: undefined, port: 3310, required: false },
    rateLimits: { api: [100000, 1000], write: [100000, 1000], login: [100000, 1000] },
    ...over,
  });
  const app = createApp(cfg);
  const entraClient = new EntraClient(cfg);
  const { server } = createServer(app, { entra: entraClient });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url, app, cfg, zammad, entra, entraClient,
    close: async () => {
      await new Promise<void>((r) => server.close(() => r()));
      server.closeAllConnections?.();
      await zammad.close();
      await entra.close();
      app.db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export interface Res { status: number; headers: Headers; json: any; text: string }

/** Minimaler Browser-Ersatz: Cookie-Speicher, CSRF-Token, Origin-Header. */
export class Client {
  cookies = new Map<string, string>();
  csrf = '';
  base: string;
  constructor(base: string) { this.base = base; }

  async req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
    const h: Record<string, string> = { ...headers };
    if (this.cookies.size) h.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    if (body !== undefined) h['content-type'] ??= 'application/json';
    if (method !== 'GET' && method !== 'HEAD') {
      h.origin ??= PUBLIC_URL;
      if (this.csrf) h['x-csrf-token'] ??= this.csrf;
    }
    const r = await fetch(this.base + path, {
      method, headers: h, redirect: 'manual',
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    for (const c of r.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      const k = pair.slice(0, i), v = pair.slice(i + 1);
      if (/Max-Age=0/i.test(c) || v === '') this.cookies.delete(k); else this.cookies.set(k, v);
    }
    const text = await r.text();
    let json: any = undefined;
    try { json = JSON.parse(text); } catch { /* kein JSON */ }
    return { status: r.status, headers: r.headers, json, text };
  }

  get(p: string, h?: Record<string, string>) { return this.req('GET', p, undefined, h); }
  post(p: string, b: unknown = {}, h?: Record<string, string>) { return this.req('POST', p, b, h); }
  put(p: string, b: unknown = {}, h?: Record<string, string>) { return this.req('PUT', p, b, h); }
  del(p: string, h?: Record<string, string>) { return this.req('DELETE', p, undefined, h); }

  async refresh(): Promise<Res> {
    const me = await this.get('/api/me');
    if (me.status === 200) this.csrf = me.json.csrf;
    return me;
  }

  async loginLocal(username: string, password: string, totpSecret?: string): Promise<Res> {
    const r = await this.post('/api/auth/local/login', { username, password });
    if (r.status !== 200) return r;
    await this.refresh();
    if (r.json.state === 'mfa_pending' && totpSecret) {
      const t = await this.post('/api/auth/local/totp', { code: totpCode(totpSecret, currentStep()) });
      await this.refresh();
      return t;
    }
    return r;
  }

  /** Anmeldung über den Entra-Simulator (folgt den Weiterleitungen wie ein Browser). */
  async loginEntra(portal: Portal, oid: string, returnTo = '/'): Promise<Res> {
    portal.entra.loginAs(oid);
    const start = await this.get(`/api/auth/entra/login?returnTo=${encodeURIComponent(returnTo)}`);
    if (start.status !== 302) return start;
    const authorize = await fetch(start.headers.get('location')!, { redirect: 'manual' });
    const cb = new URL(authorize.headers.get('location')!);
    const res = await this.get(cb.pathname + cb.search);
    await this.refresh();
    return res;
  }
}

export async function createUser(app: App, opts: { username: string; password?: string; role?: string; email?: string; name?: string; systemId?: string | null; totpSecret?: string }): Promise<string> {
  const id = uuid();
  app.db.run(
    "INSERT INTO users (id, kind, username, email, display_name, password_hash, must_change_password, totp_secret, totp_enabled, created_at) VALUES (?, 'local', ?, ?, ?, ?, 0, ?, ?, ?)",
    id, opts.username, opts.email ?? `${opts.username}@example.org`, opts.name ?? opts.username, await hashPassword(opts.password ?? 'Test-Passwort-123!'),
    opts.totpSecret ? app.box.encrypt('totp', opts.totpSecret) : null, opts.totpSecret ? 1 : 0, Date.now(),
  );
  if (opts.role) {
    const role = app.db.get<{ id: string }>('SELECT id FROM roles WHERE name = ?', opts.role)!;
    app.db.run("INSERT INTO role_assignments (id, role_id, subject_type, subject_value, system_id, created_at) VALUES (?, ?, 'user', ?, ?, ?)", uuid(), role.id, id, opts.systemId ?? null, Date.now());
  }
  return id;
}

export function createSystem(app: App, zammadUrl: string, opts: Partial<{ slug: string; name: string; token: string; released: unknown; requireApproval: boolean }> = {}): string {
  const id = uuid();
  const t = Date.now();
  app.db.run(
    `INSERT INTO ticket_systems (id, slug, name, base_url, api_token, default_group, released_attributes, require_approval, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'IT-Support', ?, ?, ?, ?)`,
    id, opts.slug ?? 'zentrale-it', opts.name ?? 'Zentrale IT', zammadUrl, app.box.encrypt('system-token', opts.token ?? 'test-token'),
    JSON.stringify(opts.released ?? [{ name: 'sec_status', allowedValues: null }, { name: 'standort', allowedValues: null }, { name: 'dringend', allowedValues: null }]),
    opts.requireApproval ? 1 : 0, t, t,
  );
  return id;
}

export function createForm(app: App, systemId: string, def?: FormDefinition, slug = 'stoerung'): string {
  const id = uuid();
  app.db.run('INSERT INTO forms (id, system_id, slug, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', id, systemId, slug, 'Störung melden', 'Etwas funktioniert nicht', Date.now(), Date.now());
  const d = def ?? {
    ...emptyDefinition(),
    fields: [
      { id: 'betreff', type: 'text', label: 'Kurzbeschreibung', required: true, mapping: { target: 'article' } },
      { id: 'beschreibung', type: 'textarea', label: 'Beschreibung', required: true, mapping: { target: 'article' } },
      { id: 'standort', type: 'zammad', label: 'Standort', attribute: 'standort', required: true },
      { id: 'kategorie', type: 'zammad', label: 'Kategorie', attribute: 'sec_status' },
      { id: 'anhang', type: 'file', label: 'Anhang', maxFiles: 2, accept: ['pdf', 'image', 'text'] },
    ],
    settings: { ...emptyDefinition().settings, titleTemplate: 'Störung: {{betreff}}', group: 'IT-Support', tags: ['stoerung'] },
  } as FormDefinition;
  const v = saveDraft(app, id, d, 'test');
  publishVersion(app, v, null);
  return id;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
