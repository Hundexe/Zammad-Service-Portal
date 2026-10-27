// Review 2026-10, Punkt OIDC (#2): Prüfung der ID-Tokens im Detail.
// Unabhängig vom Entra-Simulator: Metadaten und Schlüssel (JWKS) kommen aus einem eigenen fetch,
// die Tokens werden hier selbst signiert – auch absichtlich falsch.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, createSign, generateKeyPairSync, randomBytes, randomUUID, type KeyObject } from 'node:crypto';
import { loadConfig } from '../src/server/config.ts';
import { EntraClient } from '../src/server/auth/oidc.ts';

const AUTH = 'https://login.test';
const TENANT = 'aaaaaaaa-0000-0000-0000-000000000001';
const OTHER_TENANT = 'cccccccc-0000-0000-0000-000000000003';
const CLIENT = 'client-123';

const k1 = generateKeyPairSync('rsa', { modulusLength: 2048 });
const k2 = generateKeyPairSync('rsa', { modulusLength: 2048 });
const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const jwk = (key: KeyObject, kid: string, extra: Record<string, unknown> = {}) => ({ ...(key.export({ format: 'jwk' }) as object), kid, use: 'sig', ...extra });

let keys: unknown[] = [jwk(k1.publicKey, 'k1')];
let jwksFetches = 0;
let jwksFail = false;
let jwksDelay = 0;
const fetchImpl = (async (input: string | URL) => {
  const url = String(input);
  if (url.endsWith('/.well-known/openid-configuration')) {
    return Response.json({ issuer: `${AUTH}/${TENANT}/v2.0`, authorization_endpoint: `${AUTH}/authorize`, token_endpoint: `${AUTH}/token`, jwks_uri: `${AUTH}/keys` });
  }
  if (url === `${AUTH}/keys`) {
    jwksFetches++;
    if (jwksDelay) await new Promise((r) => setTimeout(r, jwksDelay));
    return jwksFail ? new Response('kaputt', { status: 500 }) : Response.json({ keys });
  }
  return new Response('not found', { status: 404 });
}) as typeof fetch;

function client(tenants = [TENANT]) {
  const cfg = loadConfig({
    env: 'test', secretKey: randomBytes(32), publicUrl: 'https://portal.test',
    entra: { enabled: true, tenantId: TENANT, clientId: CLIENT, clientSecret: 'x', allowedTenants: tenants, authority: AUTH, graphUrl: AUTH },
  });
  return new EntraClient(cfg, fetchImpl);
}

const b64 = (v: object | Buffer) => (Buffer.isBuffer(v) ? v : Buffer.from(JSON.stringify(v))).toString('base64url');
function sign(claims: Record<string, unknown>, opts: { key?: KeyObject; kid?: string | null; alg?: string } = {}): string {
  const header: Record<string, unknown> = { alg: opts.alg ?? 'RS256', typ: 'JWT' };
  if (opts.kid !== null) header.kid = opts.kid ?? 'k1';
  const input = `${b64(header)}.${b64(claims)}`;
  return `${input}.${b64(createSign('RSA-SHA256').update(input).sign(opts.key ?? k1.privateKey))}`;
}
function claims(over: Record<string, unknown> = {}): Record<string, unknown> {
  const t = Math.floor(Date.now() / 1000);
  return { iss: `${AUTH}/${TENANT}/v2.0`, aud: CLIENT, tid: TENANT, oid: randomUUID(), sub: 'abc', iat: t, nbf: t, exp: t + 3600, nonce: 'n1', name: 'Test', ...over };
}
const tx = { nonce: 'n1', stepup: false };

describe('OIDC: ID-Token-Prüfung (#2)', () => {
  test('gültiges Token wird angenommen', async () => {
    const c = client();
    const r = await c.verifyIdToken(sign(claims()), tx);
    assert.equal(r.tid, TENANT);
  });

  const t = () => Math.floor(Date.now() / 1000);
  const rejected: [string, () => string, RegExp][] = [
    ['nbf in der Zukunft', () => sign(claims({ nbf: t() + 600 })), /noch nicht gültig/],
    ['abgelaufen', () => sign(claims({ exp: t() - 600 })), /abgelaufen/],
    ['iat in der Zukunft', () => sign(claims({ iat: t() + 600 })), /Ausstellungszeit/],
    ['falsche Zielgruppe (aud)', () => sign(claims({ aud: 'andere-app' })), /Zielgruppe/],
    ['aud als Liste', () => sign(claims({ aud: [CLIENT, 'andere-app'] })), /Zielgruppe/],
    ['fremder Tenant', () => sign(claims({ tid: OTHER_TENANT, iss: `${AUTH}/${OTHER_TENANT}/v2.0` })), /Tenant/],
    ['Aussteller passt nicht zum Tenant', () => sign(claims({ iss: `${AUTH}/${OTHER_TENANT}/v2.0` })), /Aussteller/],
    ['Nonce fehlt', () => sign(claims({ nonce: undefined })), /Nonce/],
    ['Nonce falsch', () => sign(claims({ nonce: 'n2' })), /Nonce/],
    ['Objekt-ID fehlt', () => sign(claims({ oid: undefined })), /Objekt-ID/],
    ['mit fremdem Schlüssel signiert', () => sign(claims(), { key: k2.privateKey }), /Signatur/],
    ['alg=none', () => `${b64({ alg: 'none', kid: 'k1' })}.${b64(claims())}.`, /Algorithmus/],
    ['ohne kid', () => sign(claims(), { kid: null }), /Algorithmus/],
    ['HS256 mit öffentlichem Schlüssel als Geheimnis (Algorithm Confusion)', () => {
      const header = b64({ alg: 'HS256', typ: 'JWT', kid: 'k1' });
      const body = b64(claims());
      const secret = k1.publicKey.export({ format: 'pem', type: 'spki' });
      return `${header}.${body}.${createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url')}`;
    }, /Algorithmus/],
    ['manipulierte Nutzdaten', () => { const [h, , s] = sign(claims()).split('.'); return `${h}.${b64(claims({ name: 'Admin' }))}.${s}`; }, /Signatur/],
    ['kein JWT', () => 'abc.def', /ungültig/],
  ];
  for (const [name, make, msg] of rejected) {
    test(`abgelehnt: ${name}`, async () => {
      await assert.rejects(client().verifyIdToken(make(), tx), msg);
    });
  }

  test('Step-up: alte Anmeldung (auth_time) wird nicht akzeptiert', async () => {
    await assert.rejects(client().verifyIdToken(sign(claims({ auth_time: t() - 3600 })), { nonce: 'n1', stepup: true }), /Erneute Anmeldung/);
    await client().verifyIdToken(sign(claims({ auth_time: t() - 30 })), { nonce: 'n1', stepup: true });
  });

  test('Schlüsselwechsel: neuer kid → JWKS wird neu geladen, aber höchstens alle 5 Minuten', async () => {
    keys = [jwk(k1.publicKey, 'k1')];
    const c = client();
    jwksFetches = 0;
    await c.verifyIdToken(sign(claims()), tx);
    assert.equal(jwksFetches, 1);
    // Microsoft rotiert: nur noch k2 veröffentlicht
    keys = [jwk(k2.publicKey, 'k2')];
    await assert.rejects(c.verifyIdToken(sign(claims(), { key: k2.privateKey, kid: 'k2' }), tx), /Unbekannter Signaturschlüssel/);
    assert.equal(jwksFetches, 1, 'innerhalb von 5 Minuten kein erneuter Abruf (kein Verstärker für Angreifer)');
    (c as any).keysAt = Date.now() - 6 * 60_000;
    await c.verifyIdToken(sign(claims(), { key: k2.privateKey, kid: 'k2' }), tx);
    assert.equal(jwksFetches, 2);
    // Der alte Schlüssel ist danach nicht mehr gültig
    await assert.rejects(c.verifyIdToken(sign(claims()), tx), /Unbekannter Signaturschlüssel/);
  });

  test('Schlüssel mit use=enc, EC-, zu kurze (1024 Bit) und kaputte Schlüssel werden ignoriert', async () => {
    keys = [
      jwk(k1.publicKey, 'enc1', { use: 'enc' }),
      jwk(ec.publicKey, 'ec1'),
      { kty: 'RSA', kid: 'kaputt', n: 'xx', e: 'AQAB' },
      { kty: 'RSA', n: 'ohne-kid' },
    ];
    const weak = generateKeyPairSync('rsa', { modulusLength: 1024 });
    keys.push(jwk(weak.publicKey, 'schwach'));
    try {
      const c = client();
      for (const [kid, key] of [['enc1', k1.privateKey], ['ec1', k1.privateKey], ['kaputt', k1.privateKey], ['schwach', weak.privateKey]] as const) {
        (c as any).keysAt = 0;
        await assert.rejects(c.verifyIdToken(sign(claims(), { kid, key }), tx), /Unbekannter Signaturschlüssel/, kid);
      }
    } finally {
      keys = [jwk(k1.publicKey, 'k1')];
    }
  });

  test('Gruppen-Überlauf (_claim_names): Gruppen werden verworfen, nicht geraten', async () => {
    const r = await client().verifyIdToken(sign(claims({ groups: ['it-admins'], _claim_names: { groups: 'src1' } })), tx);
    assert.deepEqual(r.groups, []);
    const bad = await client().verifyIdToken(sign(claims({ groups: 'it-admins', roles: { a: 1 } })), tx);
    assert.deepEqual(bad.groups, []);
    assert.deepEqual(bad.roles, []);
  });

  test('mehrere Tenants: jeder erlaubte Tenant mit eigenem Aussteller', async () => {
    const c = client([TENANT, OTHER_TENANT]);
    await c.verifyIdToken(sign(claims({ tid: OTHER_TENANT, iss: `${AUTH}/${OTHER_TENANT}/v2.0` })), tx);
    await assert.rejects(c.verifyIdToken(sign(claims({ tid: OTHER_TENANT, iss: `${AUTH}/${TENANT}/v2.0` })), tx), /Aussteller/);
  });
});

describe('OIDC: unbekannte Schlüssel-IDs und JWKS-Erneuerung (zweites Review)', () => {
  const fresh = async () => {
    keys = [jwk(k1.publicKey, 'k1')];
    jwksFail = false; jwksDelay = 0;
    const c = client();
    await c.verifyIdToken(sign(claims()), tx);
    jwksFetches = 0;
    return c;
  };

  test('viele erfundene kid-Werte lösen keinen einzigen zusätzlichen Abruf aus', async () => {
    const c = await fresh();
    for (let i = 0; i < 25; i++) {
      await assert.rejects(c.verifyIdToken(sign(claims(), { kid: `erfunden-${i}` }), tx), /Unbekannter Signaturschlüssel/);
    }
    assert.equal(jwksFetches, 0);
  });

  test('ungültige kid-Werte (zu lang, Steuerzeichen) werden ohne Abruf abgelehnt', async () => {
    const c = await fresh();
    (c as any).keysAt = 0;
    for (const kid of ['x'.repeat(129), 'a\nb', 'a b', 'schlüssel', '']) {
      await assert.rejects(c.verifyIdToken(sign(claims(), { kid }), tx), /Schlüssel-ID ungültig|Algorithmus/, JSON.stringify(kid));
    }
    assert.equal(jwksFetches, 0);
  });

  test('gleichzeitige Anmeldungen mit neuem kid teilen sich einen Abruf', async () => {
    const c = await fresh();
    keys = [jwk(k1.publicKey, 'k1'), jwk(k2.publicKey, 'k2')];
    (c as any).keysAt = Date.now() - 6 * 60_000;
    jwksDelay = 50;
    await Promise.all(Array.from({ length: 10 }, () => c.verifyIdToken(sign(claims(), { key: k2.privateKey, kid: 'k2' }), tx)));
    assert.equal(jwksFetches, 1);
    jwksDelay = 0;
  });

  test('nach 24 Stunden wird die Liste erneuert: zurückgezogene Schlüssel gelten nicht mehr', async () => {
    const c = await fresh();
    keys = [jwk(k2.publicKey, 'k2')]; // k1 zurückgezogen
    (c as any).keysOkAt = Date.now() - 25 * 3600_000;
    (c as any).keysAt = Date.now() - 25 * 3600_000;
    await assert.rejects(c.verifyIdToken(sign(claims()), tx), /Unbekannter Signaturschlüssel/);
    assert.equal(jwksFetches, 1);
    await c.verifyIdToken(sign(claims(), { key: k2.privateKey, kid: 'k2' }), tx);
  });

  test('ist das JWKS beim Erneuern nicht erreichbar, bleibt die bisherige Liste in Gebrauch', async () => {
    const c = await fresh();
    jwksFail = true;
    (c as any).keysOkAt = Date.now() - 25 * 3600_000;
    (c as any).keysAt = Date.now() - 25 * 3600_000;
    await c.verifyIdToken(sign(claims()), tx);
    assert.equal(jwksFetches, 1);
    jwksFail = false;
  });

  test('leere oder kaputte Schlüsselliste ersetzt die gültige nicht', async () => {
    const c = await fresh();
    keys = [];
    (c as any).keysAt = 0;
    await assert.rejects(c.verifyIdToken(sign(claims(), { kid: 'neu' }), tx), /Unbekannter Signaturschlüssel/);
    assert.equal(jwksFetches, 1);
    await c.verifyIdToken(sign(claims()), tx); // k1 gilt weiter
  });

  test('erster Abruf scheitert: nächster Versuch frühestens nach 30 Sekunden', async () => {
    keys = [jwk(k1.publicKey, 'k1')];
    jwksFail = true; jwksFetches = 0;
    const c = client();
    await assert.rejects(c.verifyIdToken(sign(claims()), tx), /JWKS nicht abrufbar/);
    await assert.rejects(c.verifyIdToken(sign(claims()), tx), /Unbekannter Signaturschlüssel/);
    assert.equal(jwksFetches, 1);
    jwksFail = false;
    (c as any).keysAt = Date.now() - 31_000;
    await c.verifyIdToken(sign(claims()), tx);
    assert.equal(jwksFetches, 2);
  });
});
