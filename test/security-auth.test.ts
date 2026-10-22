// Sicherheitstests: Anmeldung, Sitzungen, CSRF, Zugriffskontrolle.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { startPortal, Client, createSystem, createForm, createUser, ENTRA_USERS, PUBLIC_URL, type Portal } from './helpers.ts';
import { totpCode, currentStep } from '../src/server/auth/totp.ts';
import { buildRouter } from '../src/server/server.ts';
import { EntraClient } from '../src/server/auth/oidc.ts';

let p: Portal;
let systemA: string, systemB: string, formA: string;
const PW = 'Sehr-geheimes-Passwort-42';

before(async () => {
  p = await startPortal();
  systemA = createSystem(p.app, p.zammad.url, { slug: 'a', name: 'System A' });
  systemB = createSystem(p.app, p.zammad.url, { slug: 'b', name: 'System B' });
  formA = createForm(p.app, systemA);
  await createUser(p.app, { username: 'user1', password: PW, email: 'anna.becker@example.org' });
  await createUser(p.app, { username: 'superadmin', password: PW, role: 'Super-Admin' });
  await createUser(p.app, { username: 'zieladmin', password: PW, role: 'Ziel-Admin', systemId: systemA });
});
after(async () => { await p.close(); });

describe('Sicherheits-Header', () => {
  test('alle Antworten tragen strenge Header', async () => {
    const c = new Client(p.url);
    for (const path of ['/', '/api/public/config', '/api/me', '/gibt-es-nicht.js']) {
      const r = await c.get(path);
      const csp = r.headers.get('content-security-policy') ?? '';
      assert.match(csp, /default-src 'none'/, path);
      assert.match(csp, /script-src 'self'/, path);
      assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/, path);
      assert.match(csp, /frame-ancestors 'none'/, path);
      assert.equal(r.headers.get('x-content-type-options'), 'nosniff', path);
      assert.equal(r.headers.get('x-frame-options'), 'DENY', path);
      assert.equal(r.headers.get('referrer-policy'), 'no-referrer', path);
      assert.match(r.headers.get('strict-transport-security') ?? '', /max-age=\d{8}/, path);
      assert.equal(r.headers.get('cross-origin-opener-policy'), 'same-origin', path);
      assert.equal(r.headers.get('server'), null, path);
      assert.equal(r.headers.get('x-powered-by'), null, path);
    }
  });

  test('API-Antworten werden nicht zwischengespeichert', async () => {
    const r = await new Client(p.url).get('/api/public/config');
    assert.equal(r.headers.get('cache-control'), 'no-store');
  });

  test('Fehler verraten keine internen Details', async () => {
    const r = await new Client(p.url).req('POST', '/api/auth/local/login', '{kaputt', { 'content-type': 'application/json' });
    assert.equal(r.status, 400);
    assert.doesNotMatch(r.text, /at \w+ \(|node:|\.ts:/);
  });
});

describe('Zugriff ohne Anmeldung', () => {
  test('jede geschützte API-Route antwortet mit 401', async () => {
    const router = buildRouter(p.app, { entra: new EntraClient(p.cfg) });
    const c = new Client(p.url);
    let checked = 0;
    for (const r of router.routes) {
      if (r.opts.auth === 'public') continue;
      const path = r.pattern.replace(/:([a-zA-Z]+)/g, '00000000-0000-0000-0000-000000000000');
      const res = await c.req(r.method, path, r.method === 'GET' ? undefined : {});
      assert.equal(res.status, 401, `${r.method} ${r.pattern} → ${res.status}`);
      checked++;
    }
    assert.ok(checked > 60, `nur ${checked} Routen geprüft`);
  });
});

describe('Rechte', () => {
  test('normaler Benutzer bekommt auf keiner Admin-Route Daten', async () => {
    const c = new Client(p.url);
    await c.loginLocal('user1', PW);
    const router = buildRouter(p.app, { entra: new EntraClient(p.cfg) });
    for (const r of router.routes.filter((x) => x.pattern.startsWith('/api/admin'))) {
      const path = r.pattern.replace(':systemId', systemA).replace(/:([a-zA-Z]+)/g, '00000000-0000-0000-0000-000000000000');
      const res = await c.req(r.method, path, r.method === 'GET' ? undefined : {});
      assert.ok([403, 404].includes(res.status), `${r.method} ${r.pattern} → ${res.status}`);
    }
  });

  test('Ziel-Admin für System A kann System B nicht ändern und keine Rollen vergeben', async () => {
    const c = new Client(p.url);
    await c.loginLocal('zieladmin', PW);
    assert.equal((await c.get(`/api/admin/systems/${systemA}/forms`)).status, 200);
    assert.equal((await c.get(`/api/admin/systems/${systemB}/forms`)).status, 403);
    assert.equal((await c.post(`/api/admin/systems/${systemB}/forms`, { slug: 'x', name: 'X' })).status, 403);
    assert.equal((await c.put(`/api/admin/systems/${systemB}/branding/draft`, { branding: {} })).status, 403);
    assert.equal((await c.get('/api/admin/roles')).status, 403);
    const role = p.app.db.get<{ id: string }>("SELECT id FROM roles WHERE name = 'Super-Admin'")!;
    assert.equal((await c.post('/api/admin/role-assignments', { roleId: role.id, subjectType: 'user', subjectValue: 'zieladmin' })).status, 403);
    assert.equal((await c.get('/api/admin/users')).status, 403);
    assert.equal((await c.post('/api/admin/updates/install', { version: '9.9.9' })).status, 403);
    const list = await c.get('/api/admin/systems');
    assert.deepEqual(list.json.systems.map((s: any) => s.id), [systemA]);
    assert.equal(list.json.systems[0].apiToken, undefined, 'Token wird nie ausgeliefert');
  });

  test('Formular eines fremden Systems ist über die Formular-ID nicht erreichbar', async () => {
    const c = new Client(p.url);
    await c.loginLocal('zieladmin', PW);
    assert.equal((await c.get(`/api/admin/systems/${systemA}/forms/${formA}`)).status, 200);
    // Formular-ID von A, aber System-ID B in der URL → kein Zugriff
    assert.ok([403, 404].includes((await c.get(`/api/admin/systems/${systemB}/forms/${formA}`)).status));
  });

  test('Vier-Augen-Prinzip: Einreicher kann eigene Version nicht freigeben', async () => {
    p.app.db.run('UPDATE ticket_systems SET require_approval = 1 WHERE id = ?', systemA);
    const c = new Client(p.url);
    await c.loginLocal('zieladmin', PW);
    const def = (await c.get(`/api/admin/systems/${systemA}/forms/${formA}`)).json.definition;
    def.fields[0].label = 'Neu';
    assert.equal((await c.put(`/api/admin/systems/${systemA}/forms/${formA}/draft`, { definition: def })).status, 200);
    const pub = await c.post(`/api/admin/systems/${systemA}/forms/${formA}/publish`);
    assert.equal(pub.json.status, 'pending');
    const v = p.app.db.get<{ id: string }>("SELECT id FROM form_versions WHERE form_id = ? AND status = 'pending'", formA)!;
    const self = await c.post(`/api/admin/systems/${systemA}/forms/${formA}/versions/${v.id}/approve`);
    assert.equal(self.status, 403);
    assert.equal(self.json.code, 'four_eyes');
    const other = new Client(p.url);
    await other.loginLocal('superadmin', PW);
    assert.equal((await other.post(`/api/admin/systems/${systemA}/forms/${formA}/versions/${v.id}/approve`)).status, 200);
    p.app.db.run('UPDATE ticket_systems SET require_approval = 0 WHERE id = ?', systemA);
  });

  test('letzte Super-Admin-Zuordnung kann nicht entfernt werden', async () => {
    const c = new Client(p.url);
    await c.loginLocal('superadmin', PW);
    const roles = await c.get('/api/admin/roles');
    const sa = roles.json.roles.find((r: any) => r.name === 'Super-Admin');
    const a = roles.json.assignments.find((x: any) => x.roleId === sa.id);
    const r = await c.del(`/api/admin/role-assignments/${a.id}`);
    assert.equal(r.status, 409);
    assert.equal(r.json.code, 'last_admin');
  });

  test('Admin-Rollen können nicht „allen“ gegeben werden', async () => {
    const c = new Client(p.url);
    await c.loginLocal('superadmin', PW);
    const role = p.app.db.get<{ id: string }>("SELECT id FROM roles WHERE name = 'Ziel-Admin'")!;
    const r = await c.post('/api/admin/role-assignments', { roleId: role.id, subjectType: 'all' });
    assert.equal(r.status, 422);
  });

  test('Step-up: ältere Anmeldung muss für kritische Aktionen bestätigt werden', async () => {
    const c = new Client(p.url);
    await c.loginLocal('superadmin', PW);
    p.app.db.run('UPDATE sessions SET auth_time = ?', Date.now() - 60 * 60_000);
    const role = p.app.db.get<{ id: string }>("SELECT id FROM roles WHERE name = 'Auditor'")!;
    const r = await c.post('/api/admin/role-assignments', { roleId: role.id, subjectType: 'user', subjectValue: 'user1' });
    assert.equal(r.status, 403);
    assert.equal(r.json.code, 'stepup_required');
    assert.equal((await c.post('/api/auth/stepup', { password: 'falsch' })).status, 401);
    assert.equal((await c.post('/api/auth/stepup', { password: PW })).status, 200);
    assert.equal((await c.post('/api/admin/role-assignments', { roleId: role.id, subjectType: 'user', subjectValue: 'user1' })).status, 201);
  });

  test('Admin-Bereich lässt sich auf Admin-Netze beschränken', async () => {
    const q = await startPortal({ adminAllowedCidrs: ['10.99.0.0/16'] });
    try {
      await createUser(q.app, { username: 'sa', password: PW, role: 'Super-Admin' });
      const c = new Client(q.url);
      await c.loginLocal('sa', PW);
      const r = await c.get('/api/admin/overview');
      assert.equal(r.status, 403);
      assert.equal(r.json.code, 'admin_network');
      assert.equal((await c.get('/api/portal/systems')).status, 200, 'Portal bleibt erreichbar');
    } finally { await q.close(); }
  });
});

describe('Lokale Anmeldung', () => {
  test('Sitzungscookie: __Host-, HttpOnly, Secure, SameSite=Strict; neue ID nach Login', async () => {
    const c = new Client(p.url);
    c.cookies.set('__Host-zsp', 'a'.repeat(43)); // untergeschobene Sitzungs-ID (Fixation)
    const r = await c.post('/api/auth/local/login', { username: 'user1', password: PW });
    const cookie = r.headers.getSetCookie().find((x) => x.startsWith('__Host-zsp='))!;
    assert.ok(cookie, 'Cookie gesetzt');
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /Secure/);
    assert.match(cookie, /SameSite=Strict/);
    assert.match(cookie, /Path=\//);
    assert.doesNotMatch(cookie, /Domain=/);
    assert.notEqual(c.cookies.get('__Host-zsp'), 'a'.repeat(43));
  });

  test('gleiche Fehlermeldung für unbekannten Benutzer und falsches Passwort', async () => {
    const a = await new Client(p.url).post('/api/auth/local/login', { username: 'gibtsnicht', password: 'x' });
    const b = await new Client(p.url).post('/api/auth/local/login', { username: 'superadmin', password: 'x' });
    assert.equal(a.status, 401);
    assert.equal(b.status, 401);
    assert.equal(a.json.error, b.json.error);
  });

  test('Konto wird nach 5 Fehlversuchen gesperrt – auch das richtige Passwort hilft dann nicht', async () => {
    await createUser(p.app, { username: 'opfer', password: PW });
    const c = new Client(p.url);
    for (let i = 0; i < 5; i++) await c.post('/api/auth/local/login', { username: 'opfer', password: `falsch${i}` }, { 'x-forwarded-for': `10.0.0.${i}` });
    const r = await c.post('/api/auth/local/login', { username: 'opfer', password: PW });
    assert.equal(r.status, 401);
    const row = p.app.db.get<{ locked_until: number }>("SELECT locked_until FROM users WHERE username = 'opfer'")!;
    assert.ok(row.locked_until > Date.now());
    const audit = p.app.db.get<{ n: number }>("SELECT COUNT(*) n FROM audit_log WHERE action = 'login.locked'")!;
    assert.ok(audit.n >= 1);
  });

  test('Ratenbegrenzung: Anmeldung und ändernde Anfragen je IP', async () => {
    const q = await startPortal({ rateLimits: { api: [240, 4], write: [60, 1], login: [10, 10 / 60] } });
    try {
      const c = new Client(q.url);
      const codes: number[] = [];
      for (let i = 0; i < 12; i++) codes.push((await c.post('/api/auth/local/login', { username: `x${i}`, password: 'y' })).status);
      assert.deepEqual(codes.slice(0, 10), Array(10).fill(401));
      assert.equal(codes[11], 429, 'ab dem 11. Versuch 429');
      let api = 0;
      for (let i = 0; i < 260; i++) if ((await c.get('/api/public/config')).status === 429) api++;
      assert.ok(api > 0, 'API-Begrenzung greift');
    } finally { await q.close(); }
  });

  test('Abmelden macht die Sitzung serverseitig ungültig', async () => {
    const c = new Client(p.url);
    await c.loginLocal('user1', PW);
    const stolen = c.cookies.get('__Host-zsp')!;
    assert.equal((await c.post('/api/auth/logout')).status, 200);
    const thief = new Client(p.url);
    thief.cookies.set('__Host-zsp', stolen);
    assert.equal((await thief.get('/api/me')).status, 401);
  });

  test('deaktivierter Benutzer verliert sofort den Zugriff', async () => {
    const id = await createUser(p.app, { username: 'baldweg', password: PW });
    const c = new Client(p.url);
    await c.loginLocal('baldweg', PW);
    assert.equal((await c.get('/api/me')).status, 200);
    p.app.db.run('UPDATE users SET disabled = 1 WHERE id = ?', id);
    assert.equal((await c.get('/api/me')).status, 401);
  });

  test('Erstanmeldung: generiertes Passwort muss geändert werden, vorher kein Zugriff', async () => {
    const { createLocalUser } = await import('../src/server/services/users.ts');
    const u = await createLocalUser(p.app.db, { username: 'neu', email: 'neu@example.org' });
    assert.equal(u.password.length, 20);
    const c = new Client(p.url);
    const r = await c.loginLocal('neu', u.password);
    assert.equal(r.json.state, 'password_change');
    assert.equal((await c.get('/api/portal/systems')).status, 403);
    const weak = await c.post('/api/auth/password', { currentPassword: u.password, newPassword: 'kurz' });
    assert.equal(weak.status, 422);
    const ok = await c.post('/api/auth/password', { currentPassword: u.password, newPassword: 'Kaffeetasse-Fahrrad-Sonnenhut-8' });
    assert.equal(ok.json.state, 'active', ok.text);
    assert.equal((await c.get('/api/portal/systems')).status, 200);
  });

  test('Admin-Konto ohne 2FA muss erst den Authenticator einrichten; Codes sind nicht wiederverwendbar', async () => {
    const q = await startPortal({ localAdminRequireTotp: true });
    try {
      await createUser(q.app, { username: 'adm', password: PW, role: 'Super-Admin' });
      const c = new Client(q.url);
      const r = await c.loginLocal('adm', PW);
      assert.equal(r.json.state, 'totp_setup');
      assert.equal((await c.get('/api/admin/overview')).status, 403);
      const setup = await c.get('/api/auth/totp/setup');
      const secret = setup.json.secret.replace(/\s/g, '');
      assert.ok(Array.isArray(setup.json.qr) && setup.json.qr.length >= 21);
      assert.equal((await c.post('/api/auth/totp/enable', { code: '000000' })).status, 401);
      assert.equal((await c.post('/api/auth/totp/enable', { code: totpCode(secret, currentStep()) })).json.state, 'active');
      assert.equal((await c.get('/api/admin/overview')).status, 200);
      // Neue Anmeldung: derselbe Code darf nicht noch einmal funktionieren
      const c2 = new Client(q.url);
      await c2.post('/api/auth/local/login', { username: 'adm', password: PW });
      await c2.refresh();
      const replay = await c2.post('/api/auth/local/totp', { code: totpCode(secret, currentStep()) });
      assert.equal(replay.status, 401, 'Wiederverwendung abgelehnt');
      const next = await c2.post('/api/auth/local/totp', { code: totpCode(secret, currentStep() + 1) });
      assert.equal(next.status, 200);
      // Das TOTP-Geheimnis liegt verschlüsselt in der Datenbank
      const row = q.app.db.get<{ totp_secret: string }>("SELECT totp_secret FROM users WHERE username = 'adm'")!;
      assert.ok(!row.totp_secret.includes(secret));
    } finally { await q.close(); }
  });

  test('lokale Anmeldung lässt sich abschalten', async () => {
    const q = await startPortal({ localLogin: false });
    try {
      await createUser(q.app, { username: 'x', password: PW });
      const r = await new Client(q.url).post('/api/auth/local/login', { username: 'x', password: PW });
      assert.equal(r.status, 404);
    } finally { await q.close(); }
  });
});

describe('CSRF und Herkunft', () => {
  test('ändernde Anfragen ohne oder mit falschem Token werden abgelehnt', async () => {
    const c = new Client(p.url);
    await c.loginLocal('user1', PW);
    const body = { values: { betreff: 'x', beschreibung: 'y', standort: 'nord' } };
    assert.equal((await c.post(`/api/portal/forms/${formA}/submit`, body, { 'x-csrf-token': '' })).json.code, 'csrf');
    assert.equal((await c.post(`/api/portal/forms/${formA}/submit`, body, { 'x-csrf-token': 'falsch' })).json.code, 'csrf');
    assert.equal((await c.post(`/api/portal/forms/${formA}/submit`, body, { origin: 'https://evil.example' })).json.code, 'bad_origin');
    assert.equal((await c.post(`/api/portal/forms/${formA}/submit`, body, { 'sec-fetch-site': 'cross-site' })).json.code, 'bad_origin');
    assert.equal((await c.post(`/api/portal/forms/${formA}/submit`, body)).status, 201);
  });

  test('nur JSON wird angenommen (keine einfachen Formular-POSTs)', async () => {
    const c = new Client(p.url);
    await c.loginLocal('user1', PW);
    const r = await c.req('POST', '/api/auth/logout', 'a=b', { 'content-type': 'application/x-www-form-urlencoded' });
    assert.equal(r.status, 415);
  });

  test('Login-CSRF: fremde Herkunft kann niemanden anmelden', async () => {
    const r = await new Client(p.url).post('/api/auth/local/login', { username: 'user1', password: PW }, { origin: 'https://evil.example' });
    assert.equal(r.status, 403);
  });
});

describe('Microsoft-Anmeldung (OIDC)', () => {
  const cases: [string, Record<string, unknown>][] = [
    ['falsche Zielgruppe (aud)', { wrongAud: true }],
    ['falscher Aussteller (iss)', { wrongIss: true }],
    ['abgelaufenes Token', { expired: true }],
    ['falsche Nonce (Replay)', { wrongNonce: true }],
    ['falsche Signatur', { badSignature: true }],
    ['alg: none', { algNone: true }],
    ['fremder Tenant', { otherTenant: 'cccccccc-0000-0000-0000-000000000009' }],
  ];
  for (const [name, tamper] of cases) {
    test(`abgelehnt: ${name}`, async () => {
      Object.assign(p.entra.tamper, tamper);
      try {
        const c = new Client(p.url);
        const r = await c.loginEntra(p, ENTRA_USERS[0].oid);
        assert.equal(r.status, 302);
        assert.equal(r.headers.get('location'), '/login?fehler=sso');
        assert.equal((await c.get('/api/me')).status, 401);
      } finally {
        for (const k of Object.keys(tamper)) delete (p.entra.tamper as any)[k];
      }
    });
  }

  test('state-Parameter muss passen, Transaktions-Cookie ist Pflicht', async () => {
    const c = new Client(p.url);
    const start = await c.get('/api/auth/entra/login');
    const auth = await fetch(start.headers.get('location')!, { redirect: 'manual' });
    const cb = new URL(auth.headers.get('location')!);
    cb.searchParams.set('state', 'manipuliert');
    const r = await c.get(cb.pathname + cb.search);
    assert.equal(r.headers.get('location'), '/login?fehler=sso');
    const noCookie = new Client(p.url);
    const r2 = await noCookie.get(`/api/auth/entra/callback?code=x&state=y`);
    assert.equal(r2.headers.get('location'), '/login?fehler=sso');
  });

  test('keine offene Weiterleitung über returnTo', async () => {
    for (const evil of ['//evil.example', 'https://evil.example', '/\\evil.example', '/api/auth/logout', 'javascript:alert(1)']) {
      const c = new Client(p.url);
      const r = await c.loginEntra(p, ENTRA_USERS[0].oid, evil);
      assert.equal(r.headers.get('location'), '/', evil);
    }
  });
});

describe('Host-Header', () => {
  test('in Produktion werden fremde Hostnamen abgewiesen (DNS-Rebinding)', async () => {
    const q = await startPortal({ env: 'production' });
    try {
      const port = Number(new URL(q.url).port);
      const raw = (host: string) => new Promise<number>((resolve, reject) => {
        const req = httpRequest({ host: '127.0.0.1', port, path: '/api/public/config', headers: { host } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
        req.on('error', reject);
        req.end();
      });
      assert.equal(await raw('evil.example'), 421);
      assert.equal(await raw(new URL(PUBLIC_URL).host), 200);
      assert.equal((await fetch(q.url + '/healthz')).status, 200, 'Healthcheck bleibt intern erreichbar');
    } finally { await q.close(); }
  });
});
