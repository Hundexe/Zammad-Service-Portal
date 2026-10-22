// Sicherheitstests: Kann die lokale Anmeldung umgangen werden?
// Jeder Test beschreibt einen Angriffsweg und prüft, dass er geschlossen ist.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startPortal, Client, createSystem, createForm, createUser, ENTRA_USERS, type Portal } from './helpers.ts';
import { totpCode, currentStep } from '../src/server/auth/totp.ts';
import { uuid } from '../src/server/db/db.ts';
import { lockMinutes } from '../src/server/routes/auth.ts';

let p: Portal;
let systemA: string;
const PW = 'Sehr-geheimes-Passwort-42';
const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const wrongCode = () => totpCode(SECRET, currentStep() + 100); // gültiges Format, falscher Zeitpunkt

before(async () => {
  p = await startPortal();
  systemA = createSystem(p.app, p.zammad.url, { slug: 'a', name: 'System A' });
  createForm(p.app, systemA);
  await createUser(p.app, { username: 'superadmin', password: PW, role: 'Super-Admin' });
});
after(async () => { await p.close(); });

const user = (name: string) => p.app.db.get<{ id: string; failed_logins: number; lock_count: number; locked_until: number | null }>('SELECT * FROM users WHERE username = ?', name)!;

function customRole(name: string, permissions: string[]): string {
  const id = uuid();
  p.app.db.run('INSERT INTO roles (id, name, description, permissions, builtin) VALUES (?, ?, ?, ?, 0)', id, name, '', JSON.stringify(permissions));
  return id;
}
function assign(roleId: string, userId: string, systemId: string | null = null): void {
  p.app.db.run("INSERT INTO role_assignments (id, role_id, subject_type, subject_value, system_id, created_at) VALUES (?, ?, 'user', ?, ?, ?)", uuid(), roleId, userId, systemId, Date.now());
}

describe('Zweiter Faktor lässt sich nicht erraten', () => {
  test('falsche 2FA-Codes zählen zur Kontosperre; danach ist die halbe Anmeldung beendet', async () => {
    await createUser(p.app, { username: 'tfa1', password: PW, totpSecret: SECRET });
    const c = new Client(p.url);
    assert.equal((await c.loginLocal('tfa1', PW)).json.state, 'mfa_pending');
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await c.post('/api/auth/local/totp', { code: wrongCode() })).status);
    assert.deepEqual(codes, [401, 401, 401, 401, 401]);
    assert.equal((await c.get('/api/me')).status, 401, 'halbe Sitzung ist weg');
    assert.ok(user('tfa1').locked_until! > Date.now(), 'Konto gesperrt');
    // Auch Passwort + richtiger Code helfen während der Sperre nicht
    const again = await new Client(p.url).post('/api/auth/local/login', { username: 'tfa1', password: PW });
    assert.equal(again.status, 401);
  });

  test('richtiges Passwort setzt den Zähler nicht zurück (kein Raten durch ständiges Neu-Anmelden)', async () => {
    await createUser(p.app, { username: 'tfa2', password: PW, totpSecret: SECRET });
    const c = new Client(p.url);
    await c.loginLocal('tfa2', PW);
    for (let i = 0; i < 4; i++) await c.post('/api/auth/local/totp', { code: wrongCode() });
    const d = new Client(p.url);
    assert.equal((await d.loginLocal('tfa2', PW)).json.state, 'mfa_pending');
    assert.equal(user('tfa2').failed_logins, 4, 'Zähler bleibt stehen');
    await d.post('/api/auth/local/totp', { code: wrongCode() });
    assert.ok(user('tfa2').locked_until! > Date.now(), 'fünfter Fehlversuch sperrt');
  });

  test('erfolgreiche Anmeldung mit Code setzt den Zähler zurück; Sitzungs-ID wechselt nach dem Code', async () => {
    await createUser(p.app, { username: 'tfa3', password: PW, totpSecret: SECRET });
    const c = new Client(p.url);
    await c.post('/api/auth/local/login', { username: 'tfa3', password: PW });
    await c.refresh();
    await c.post('/api/auth/local/totp', { code: wrongCode() });
    const before = c.cookies.get('__Host-zsp');
    const ok = await c.post('/api/auth/local/totp', { code: totpCode(SECRET, currentStep()) });
    assert.equal(ok.json.state, 'active');
    assert.notEqual(c.cookies.get('__Host-zsp'), before, 'neues Sitzungstoken nach 2FA');
    const old = new Client(p.url);
    old.cookies.set('__Host-zsp', before!);
    assert.equal((await old.get('/api/me')).status, 401, 'altes Token ist ungültig');
    assert.equal(user('tfa3').failed_logins, 0);
  });
});

describe('Fortschreitende Sperre', () => {
  test('jede weitere Sperre dauert doppelt so lang, höchstens 24 h', async () => {
    assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7, 20].map((n) => lockMinutes(p.cfg.lockout, n)), [15, 30, 60, 120, 240, 480, 960, 1440, 1440]);
    await createUser(p.app, { username: 'prog', password: PW });
    const fail5 = async () => { for (let i = 0; i < 5; i++) await new Client(p.url).post('/api/auth/local/login', { username: 'prog', password: 'falsch' }); };
    await fail5();
    const first = user('prog');
    assert.ok(Math.abs(first.locked_until! - Date.now() - 15 * 60_000) < 5000);
    p.app.db.run('UPDATE users SET locked_until = ? WHERE id = ?', Date.now() - 1, first.id); // Sperre abgelaufen
    await fail5();
    const second = user('prog');
    assert.equal(second.lock_count, 2);
    assert.ok(Math.abs(second.locked_until! - Date.now() - 30 * 60_000) < 5000, 'zweite Sperre: 30 min');
  });
});

describe('Bestätigung (Step-up) und Passwortwechsel', () => {
  test('falsche Bestätigungen zählen; nach 5 ist die Sitzung beendet und das Konto gesperrt', async () => {
    await createUser(p.app, { username: 'step', password: PW });
    const c = new Client(p.url);
    await c.loginLocal('step', PW);
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await c.post('/api/auth/stepup', { password: `falsch${i}` })).status);
    assert.deepEqual(codes, [401, 401, 401, 401, 401]);
    assert.equal((await c.get('/api/me')).status, 401, 'Sitzung beendet');
    assert.ok(user('step').locked_until! > Date.now());
  });

  test('während einer Sperre wird beim Bestätigen kein Passwort geprüft', async () => {
    await createUser(p.app, { username: 'step2', password: PW });
    const c = new Client(p.url);
    await c.loginLocal('step2', PW);
    p.app.db.run("UPDATE users SET locked_until = ? WHERE username = 'step2'", Date.now() + 60_000);
    const r = await c.post('/api/auth/stepup', { password: PW });
    assert.equal(r.status, 423);
    assert.equal((await c.get('/api/me')).status, 200, 'Sitzung bleibt (Sperre durch Dritte soll niemanden abmelden)');
  });

  test('falsches aktuelles Passwort beim Passwortwechsel zählt ebenfalls', async () => {
    await createUser(p.app, { username: 'pwc', password: PW });
    const c = new Client(p.url);
    await c.loginLocal('pwc', PW);
    await c.post('/api/auth/password', { currentPassword: 'falsch', newPassword: 'Kaffeetasse-Fahrrad-Sonnenhut-8' });
    assert.equal(user('pwc').failed_logins, 1);
  });
});

describe('2FA-Pflicht für lokale Admins gilt bei jeder Anfrage', () => {
  test('wer während der Sitzung Admin-Rechte bekommt, muss sofort 2FA einrichten', async () => {
    const q = await startPortal({ localAdminRequireTotp: true });
    try {
      const id = await createUser(q.app, { username: 'normal', password: PW });
      const c = new Client(q.url);
      assert.equal((await c.loginLocal('normal', PW)).json.state, 'active', 'normale Benutzer brauchen keine 2FA');
      assert.equal((await c.get('/api/portal/systems')).status, 200);
      const role = q.app.db.get<{ id: string }>("SELECT id FROM roles WHERE name = 'Super-Admin'")!;
      q.app.db.run("INSERT INTO role_assignments (id, role_id, subject_type, subject_value, system_id, created_at) VALUES (?, ?, 'user', ?, NULL, ?)", uuid(), role.id, id, Date.now());
      const r = await c.get('/api/admin/overview');
      assert.equal(r.status, 403);
      assert.equal(r.json.code, 'totp_setup');
      assert.equal((await c.get('/api/me')).json.state, 'totp_setup');
    } finally { await q.close(); }
  });

  test('Sitzung ohne zweiten Faktor bei aktivierter 2FA wird verworfen', async () => {
    const id = await createUser(p.app, { username: 'inv', password: PW });
    const c = new Client(p.url);
    await c.loginLocal('inv', PW);
    p.app.db.run('UPDATE users SET totp_enabled = 1, totp_secret = ? WHERE id = ?', p.app.box.encrypt('totp', SECRET), id);
    assert.equal((await c.get('/api/me')).status, 401);
  });
});

describe('Abschalten der lokalen Anmeldung', () => {
  test('beendet auch bestehende lokale Sitzungen', async () => {
    const q = await startPortal();
    try {
      await createUser(q.app, { username: 'lokal', password: PW });
      const c = new Client(q.url);
      await c.loginLocal('lokal', PW);
      assert.equal((await c.get('/api/me')).status, 200);
      q.app.cfg.localLogin = false; // entspricht LOCAL_LOGIN_ENABLED=false + Neustart (Sitzungen liegen in der DB)
      assert.equal((await c.get('/api/me')).status, 401);
      assert.equal(q.app.db.get<{ n: number }>("SELECT COUNT(*) n FROM sessions s JOIN users u ON u.id = s.user_id WHERE u.username = 'lokal'")!.n, 0);
    } finally { await q.close(); }
  });
});

describe('Keine Rechteausweitung über die Verwaltung', () => {
  test('„Benutzer verwalten“ allein: kein Super-Admin-Konto anlegen, keinen Super-Admin übernehmen', async () => {
    const roleId = customRole('Nur Benutzer', ['user.manage']);
    const id = await createUser(p.app, { username: 'umgr', password: PW });
    assign(roleId, id);
    const c = new Client(p.url);
    await c.loginLocal('umgr', PW);
    const sa = user('superadmin');
    const create = await c.post('/api/admin/users', { username: 'boese', role: 'Super-Admin' });
    assert.equal(create.status, 403, 'kein Konto mit Super-Admin-Rolle');
    assert.equal((await c.post(`/api/admin/users/${sa.id}/reset-password`, { resetTotp: true })).status, 403, 'Super-Admin-Passwort nicht zurücksetzbar');
    assert.equal((await c.put(`/api/admin/users/${sa.id}`, { disabled: true })).status, 403, 'Super-Admin nicht deaktivierbar');
    assert.equal((await c.post(`/api/admin/users/${sa.id}/unlock`)).status, 403);
    // Ein normales Konto darf er verwalten
    const plain = await createUser(p.app, { username: 'plain', password: PW });
    assert.equal((await c.post(`/api/admin/users/${plain}/reset-password`, {})).status, 200);
    assert.equal((await c.post('/api/admin/users', { username: 'neu-normal' })).status, 201);
  });

  test('„Rollen verwalten“ allein: sich selbst nichts geben, keine Allmacht-Rolle bauen', async () => {
    const roleId = customRole('Nur Rollen', ['role.manage']);
    const id = await createUser(p.app, { username: 'rmgr', password: PW });
    assign(roleId, id);
    const c = new Client(p.url);
    await c.loginLocal('rmgr', PW);
    const superRole = p.app.db.get<{ id: string }>("SELECT id FROM roles WHERE name = 'Super-Admin'")!;
    assert.equal((await c.post('/api/admin/role-assignments', { roleId: superRole.id, subjectType: 'user', subjectValue: 'rmgr' })).status, 403);
    assert.equal((await c.post('/api/admin/roles', { name: 'Alles', permissions: ['*'] })).status, 403);
    assert.equal((await c.post('/api/admin/roles', { name: 'Mehr', permissions: ['role.manage', 'user.manage'] })).status, 403);
    assert.equal((await c.put(`/api/admin/roles/${roleId}`, { name: 'Nur Rollen', permissions: ['role.manage', 'update.install'] })).status, 403, 'eigene Rolle nicht aufwerten');
    const zielAdmin = p.app.db.get<{ id: string }>("SELECT id FROM roles WHERE name = 'Ziel-Admin'")!;
    assert.equal((await c.post('/api/admin/role-assignments', { roleId: zielAdmin.id, subjectType: 'user', subjectValue: 'rmgr', systemId: systemA })).status, 403);
    const saAssign = p.app.db.get<{ id: string }>("SELECT a.id FROM role_assignments a JOIN roles r ON r.id = a.role_id WHERE r.name = 'Super-Admin' LIMIT 1")!;
    assert.equal((await c.del(`/api/admin/role-assignments/${saAssign.id}`)).status, 403, 'Super-Admins nicht entmachten');
    assert.equal((await c.post('/api/admin/roles', { name: 'Klein', permissions: ['role.manage'] })).status, 201, 'innerhalb der eigenen Rechte erlaubt');
  });

  test('Ziel-Admin für System A kann seine Rechte nicht auf System B ausweiten', async () => {
    const systemB = createSystem(p.app, p.zammad.url, { slug: 'b2', name: 'System B2' });
    const roleId = customRole('Rollen A', ['role.manage']);
    const id = await createUser(p.app, { username: 'za', password: PW, role: 'Ziel-Admin', systemId: systemA });
    assign(roleId, id);
    const c = new Client(p.url);
    await c.loginLocal('za', PW);
    const zielAdmin = p.app.db.get<{ id: string }>("SELECT id FROM roles WHERE name = 'Ziel-Admin'")!;
    assert.equal((await c.post('/api/admin/role-assignments', { roleId: zielAdmin.id, subjectType: 'user', subjectValue: 'za', systemId: systemB })).status, 403);
    assert.equal((await c.post('/api/admin/role-assignments', { roleId: zielAdmin.id, subjectType: 'user', subjectValue: 'za' })).status, 403, 'nicht global');
    const other = await createUser(p.app, { username: 'kollege', password: PW });
    assert.equal((await c.post('/api/admin/role-assignments', { roleId: zielAdmin.id, subjectType: 'user', subjectValue: 'kollege', systemId: systemA })).status, 201, 'für das eigene System erlaubt');
    void other;
  });

  test('mehrdeutige Benutzerangabe bei Rollenzuordnung wird abgelehnt', async () => {
    await createUser(p.app, { username: 'doppelt', password: PW, email: 'gleich@example.org' });
    await createUser(p.app, { username: 'gleich@example.org', password: PW, email: 'anders@example.org' });
    const c = new Client(p.url);
    await c.loginLocal('superadmin', PW);
    const auditor = p.app.db.get<{ id: string }>("SELECT id FROM roles WHERE name = 'Auditor'")!;
    const r = await c.post('/api/admin/role-assignments', { roleId: auditor.id, subjectType: 'user', subjectValue: 'gleich@example.org' });
    assert.equal(r.status, 409);
    assert.equal(r.json.code, 'ambiguous');
  });
});

describe('Lokales Konto kann sich nicht als Microsoft-Benutzer ausgeben', () => {
  test('E-Mail-Adressen sind eindeutig', async () => {
    const c = new Client(p.url);
    await c.loginLocal('superadmin', PW);
    await createUser(p.app, { username: 'hat-mail', password: PW, email: 'belegt@example.org' });
    const r = await c.post('/api/admin/users', { username: 'kopie', email: 'BELEGT@example.org' });
    assert.equal(r.status, 422);
  });

  test('lokales Konto mit der E-Mail eines Microsoft-Kontos sieht dessen Tickets nicht und kann nichts senden', async () => {
    const anna = ENTRA_USERS.find((u) => u.name === 'Anna Becker')!;
    const real = new Client(p.url);
    await real.loginEntra(p, anna.oid);
    const own = await real.get(`/api/portal/systems/${systemA}/tickets`);
    assert.ok(own.json.tickets.length > 0, 'die echte Person sieht ihre Tickets');
    // Konto mit fremder Adresse (z. B. angelegt, bevor sich die Person zum ersten Mal angemeldet hat)
    await createUser(p.app, { username: 'imitator', password: PW, email: anna.email });
    const fake = new Client(p.url);
    await fake.loginLocal('imitator', PW);
    const t = await fake.get(`/api/portal/systems/${systemA}/tickets`);
    assert.equal(t.status, 200);
    assert.equal(t.json.tickets.length, 0, 'keine fremden Tickets');
    const form = p.app.db.get<{ id: string }>('SELECT id FROM forms WHERE system_id = ? LIMIT 1', systemA)!;
    const s = await fake.post(`/api/portal/forms/${form.id}/submit`, { values: { betreff: 'x', beschreibung: 'y', standort: 'nord' } });
    assert.equal(s.status, 409);
    assert.equal(s.json.code, 'email_conflict');
  });
});

describe('Einstellungen aus deploy/.env', () => {
  test('sicherheitsrelevante Werte außerhalb der Grenzen verhindern den Start', async () => {
    const { loadConfig } = await import('../src/server/config.ts');
    const key = Buffer.alloc(32, 1);
    for (const [name, value] of [['LOGIN_MAX_ATTEMPTS', '1'], ['LOGIN_MAX_ATTEMPTS', '1000'], ['PASSWORD_MIN_LENGTH', '6'], ['SESSION_IDLE_MINUTES', '100000'], ['STEPUP_MINUTES', '0'], ['LOGIN_LOCK_MAX_MINUTES', '5'], ['RATE_LIMIT_LOGIN_BURST', '0']]) {
      const before = process.env[name];
      process.env[name] = value;
      try {
        assert.throws(() => loadConfig({ secretKey: key, env: 'test' }), new RegExp(name), `${name}=${value}`);
      } finally {
        if (before === undefined) delete process.env[name]; else process.env[name] = before;
      }
    }
    process.env.LOGIN_MAX_ATTEMPTS = '7';
    process.env.LOCAL_USER_REQUIRE_TOTP = 'true';
    try {
      const cfg = loadConfig({ secretKey: key, env: 'test' });
      assert.equal(cfg.lockout.maxAttempts, 7);
      assert.equal(cfg.localUserRequireTotp, true);
    } finally {
      delete process.env.LOGIN_MAX_ATTEMPTS;
      delete process.env.LOCAL_USER_REQUIRE_TOTP;
    }
  });

  test('LOGIN_MAX_ATTEMPTS und LOGIN_LOCK_MINUTES werden beachtet', async () => {
    const q = await startPortal({ lockout: { maxAttempts: 3, minutes: 60, maxMinutes: 1440, progressive: true } });
    try {
      await createUser(q.app, { username: 'drei', password: PW });
      for (let i = 0; i < 3; i++) await new Client(q.url).post('/api/auth/local/login', { username: 'drei', password: 'falsch' });
      const row = q.app.db.get<{ locked_until: number }>("SELECT locked_until FROM users WHERE username = 'drei'")!;
      assert.ok(Math.abs(row.locked_until - Date.now() - 60 * 60_000) < 5000, 'nach 3 Versuchen 60 min gesperrt');
    } finally { await q.close(); }
  });

  test('LOCAL_USER_REQUIRE_TOTP: dann müssen auch normale Benutzer 2FA einrichten', async () => {
    const q = await startPortal({ localUserRequireTotp: true });
    try {
      await createUser(q.app, { username: 'jeder', password: PW });
      const c = new Client(q.url);
      assert.equal((await c.loginLocal('jeder', PW)).json.state, 'totp_setup');
      assert.equal((await c.get('/api/portal/systems')).status, 403);
    } finally { await q.close(); }
  });

  test('PASSWORD_MIN_LENGTH gilt beim Passwortwechsel', async () => {
    const q = await startPortal({ passwordMinLength: 24 });
    try {
      await createUser(q.app, { username: 'lang', password: PW });
      const c = new Client(q.url);
      await c.loginLocal('lang', PW);
      const r = await c.post('/api/auth/password', { currentPassword: PW, newPassword: 'Kaffeetasse-Fahrrad-8' });
      assert.equal(r.status, 422);
      assert.ok(r.json.details.some((d: string) => d.includes('24')));
      assert.equal((await new Client(q.url).get('/api/public/config')).json.passwordMinLength, 24);
    } finally { await q.close(); }
  });
});
