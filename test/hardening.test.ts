// Härtungen aus dem Sicherheitstest vom 28.10.2026 (ST-04, ST-16, ST-19, ST-29 …).
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startPortal, Client, createSystem, createForm, createUser, ENTRA_USERS, type Portal } from './helpers.ts';
import { ByteBudget, RateLimiter, checkJsonShape, limiterKey } from '../src/server/http/core.ts';
import { htmlToText } from '../src/server/routes/portal.ts';

let p: Portal;
let formId: string;

before(async () => {
  p = await startPortal();
  const systemId = createSystem(p.app, p.zammad.url);
  formId = createForm(p.app, systemId);
  await createUser(p.app, { username: 'sa', role: 'Super-Admin' });
});
after(async () => { await p.close(); });

async function raw(c: Client, path: string, body: string) {
  return c.req('POST', path, body, { 'content-type': 'application/json' });
}

describe('JSON-Bodys (ST-04, ST-29)', () => {
  test('null, Arrays und Primitive ergeben 400 statt 500 – auch vor der Anmeldung', async () => {
    const anon = new Client(p.url);
    for (const b of ['null', '[]', '"x"', '42', 'true']) {
      const r = await raw(anon, '/api/auth/local/login', b);
      assert.equal(r.status, 400, `${b}: ${r.text}`);
      assert.equal(r.json.code, 'bad_json');
    }
  });

  test('tief verschachtelt oder mit sehr vielen Elementen: sofort 400, kein Blockieren', async () => {
    const c = new Client(p.url);
    await c.loginEntra(p, ENTRA_USERS[0].oid);
    const deep = '{"a":' + '['.repeat(200_000) + ']'.repeat(200_000) + '}';
    const many = '{"a":[' + '0,'.repeat(3_000_000) + '0]}';
    for (const [name, body] of [['tief', deep], ['viele', many]] as const) {
      const started = Date.now();
      const r = await raw(c, `/api/portal/forms/${formId}/submit`, body);
      assert.equal(r.status, 400, `${name}: ${r.text.slice(0, 200)}`);
      assert.ok(Date.now() - started < 2000, `${name} dauerte ${Date.now() - started} ms`);
    }
    // Lange Zeichenketten (Base64-Dateien) bleiben erlaubt
    assert.equal(checkJsonShape(Buffer.from(JSON.stringify({ data: 'A'.repeat(5_000_000) }))), null);
    assert.equal((await c.get('/healthz')).status, 200);
  });

  test('Body-Grenze für Uploads folgt der Konfiguration (25 MB × 4/3 + 1 MB)', async () => {
    const c = new Client(p.url);
    await c.loginEntra(p, ENTRA_USERS[0].oid);
    const r = await raw(c, `/api/portal/forms/${formId}/submit`, JSON.stringify({ values: {}, pad: 'A'.repeat(36 * 1024 * 1024) }));
    assert.equal(r.status, 413);
  });

  test('Speicherbudget: weitere große Bodys warten, statt den Speicher zu sprengen', async () => {
    const b = new ByteBudget(100);
    await b.acquire(60, 1000);
    let second = false;
    const wait = b.acquire(60, 1000).then(() => { second = true; });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(second, false, 'wartet, solange kein Platz ist');
    b.release(60);
    await wait;
    assert.equal(second, true);
    await assert.rejects(() => b.acquire(60, 30), /viele Uploads/);
    b.release(60);
    assert.equal(b.inUse, 0);
  });
});

describe('Ratenbegrenzung (ST-19)', () => {
  test('konstante Kosten auch mit sehr vielen Adressen, Obergrenze greift', () => {
    const rl = new RateLimiter(10, 1, 50_000);
    for (let i = 0; i < 120_000; i++) rl.take(`10.${i >> 16}.${(i >> 8) & 255}.${i & 255}`);
    assert.ok(rl.size <= 50_000);
    const started = Date.now();
    for (let i = 0; i < 20_000; i++) rl.take(`x${i}`);
    assert.ok(Date.now() - started < 500, `20 000 Aufrufe dauerten ${Date.now() - started} ms`);
  });

  test('IPv6 wird je /64 gezählt, IPv4 je Adresse', () => {
    assert.equal(limiterKey('2001:db8:1:2:aaaa::1'), limiterKey('2001:db8:1:2:ffff:1:2:3'));
    assert.notEqual(limiterKey('2001:db8:1:2::1'), limiterKey('2001:db8:1:3::1'));
    assert.equal(limiterKey('2001:db8::1'), '2001:db8:0:0::/64');
    assert.equal(limiterKey('fe80::1%eth0'), 'fe80:0:0:0::/64');
    assert.equal(limiterKey('10.1.2.3'), '10.1.2.3');
  });
});

describe('Ticketverlauf (ST-16)', () => {
  test('HTML in Text: linear auch bei präpariertem HTML', () => {
    for (const s of ['<a '.repeat(66_000), '<script>'.repeat(20_000), ' '.repeat(190_000) + 'x', '&a'.repeat(90_000), '<p'.repeat(90_000) + '>']) {
      const started = Date.now();
      htmlToText(s);
      assert.ok(Date.now() - started < 300, `${s.slice(0, 10)}… dauerte ${Date.now() - started} ms`);
    }
    assert.equal(htmlToText('a<br>b<table><tr><td>1</td><td>2</td></tr></table><style>x</style>c'), 'a\nb1\t2\nc');
  });
});

describe('Anmeldung (ST-20, ST-21, ST-32)', () => {
  const PW = 'Test-Passwort-123!';
  const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
  const FALSCH = 'falsch-falsch-1';

  test('Step-up: derselbe TOTP-Code wird auch parallel nur einmal angenommen', async () => {
    const { totpCode, currentStep } = await import('../src/server/auth/totp.ts');
    await createUser(p.app, { username: 'race', role: 'Super-Admin', totpSecret: SECRET });
    const c = new Client(p.url);
    await c.loginLocal('race', PW, SECRET);
    // vorigen Code verbraucht der Login; für den Step-up den nächsten Schritt nehmen
    const code = totpCode(SECRET, currentStep() + 1);
    const [a, b] = await Promise.all([c.post('/api/auth/stepup', { password: PW, code }), c.post('/api/auth/stepup', { password: PW, code })]);
    assert.deepEqual([a.status, b.status].sort(), [200, 401], `${a.status} ${b.status}`);
  });

  test('2FA einrichten im laufenden Betrieb verlangt das aktuelle Passwort', async () => {
    const { totpCode, currentStep } = await import('../src/server/auth/totp.ts');
    await createUser(p.app, { username: 'ohne2fa' });
    const c = new Client(p.url);
    await c.loginLocal('ohne2fa', PW);
    const setup = await c.get('/api/auth/totp/setup');
    assert.equal(setup.status, 200);
    const secret = setup.json.secret.replace(/\s/g, '');
    const code = totpCode(secret, currentStep());
    assert.equal((await c.post('/api/auth/totp/enable', { code })).status, 401, 'ohne Passwort');
    assert.equal((await c.post('/api/auth/totp/enable', { code, password: FALSCH })).status, 401, 'falsches Passwort');
    assert.equal((await c.post('/api/auth/totp/enable', { code, password: PW })).status, 200);
  });

  test('/api/me verrät im Zwischenzustand keine Rechte', async () => {
    await createUser(p.app, { username: 'halb', role: 'Super-Admin', totpSecret: SECRET });
    const c = new Client(p.url);
    const r = await c.loginLocal('halb', PW); // ohne Code → mfa_pending
    assert.equal(r.json.state, 'mfa_pending');
    const me = await c.get('/api/me');
    assert.equal(me.json.isAdmin, false);
    assert.deepEqual(me.json.permissions, { global: [], bySystem: {} });
    assert.equal(me.json.user.email, null);
  });

  test('/readyz nennt die Version nur bei direktem Aufruf, nicht über den Proxy', async () => {
    const c = new Client(p.url);
    assert.ok((await c.get('/readyz')).json.version);
    assert.equal((await c.get('/readyz', { 'x-forwarded-for': '10.0.0.1' })).json.version, undefined);
  });

  test('GCM: verkürzte Tags werden abgelehnt', () => {
    const token = p.app.box.encrypt('test', 'geheim');
    const [v, iv, data, tag] = token.split('.');
    const short = [v, iv, data, Buffer.from(tag, 'base64url').subarray(0, 8).toString('base64url')].join('.');
    assert.throws(() => p.app.box.decrypt('test', short));
    assert.equal(p.app.box.decrypt('test', token), 'geheim');
  });
});
