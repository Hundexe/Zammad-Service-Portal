// Härtungen 1.14: Hinweise in der Verwaltung, „nur benachrichtigen“, Authentifizierungskontext bei Bestätigungen,
// Kontoprüfung in Entra, ältere Office-Formate je Feld.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startPortal, Client, createSystem, createForm, createUser, ENTRA_USERS, type Portal } from './helpers.ts';
import { checkFiles } from '../src/server/services/files.ts';
import { checkForUpdates, newerVersions } from '../src/server/services/update-notify.ts';
import { checkEntraAccounts } from '../src/server/services/account-check.ts';
import { validateDefinition } from '../src/shared/form.ts';
import { emptyDefinition } from '../src/server/services/forms.ts';
import type { FormDefinition } from '../src/shared/form.ts';

const PW = 'Test-Passwort-123!';
let p: Portal;
let su: Client;
let sys: string;
const BEN = ENTRA_USERS[1]!;

before(async () => {
  p = await startPortal();
  p.cfg.entra.stepupAuthContext = 'c1';
  sys = createSystem(p.app, p.zammad.url, { slug: 'h114', name: 'H114' });
  await createUser(p.app, { username: 'chef', role: 'Super-Admin' });
  su = new Client(p.url);
  await su.loginLocal('chef', PW);
});
after(async () => { await p.close(); });

test('Übersicht: Hinweis bei fehlender Beschränkung der Zammad-Server und bei Freigabe-Feld ohne Gruppen', async () => {
  const def = {
    ...emptyDefinition(),
    fields: [
      { id: 'betreff', type: 'text', label: 'Betreff', required: true, mapping: { target: 'article' } },
      { id: 'chefin', type: 'approver', label: 'Vorgesetzte' },
    ],
  } as FormDefinition;
  const formId = createForm(p.app, sys, def, 'mit-freigabe');
  const r = await su.get('/api/admin/overview');
  assert.equal(r.status, 200);
  const w: string[] = r.json.warnings;
  assert.ok(w.some((x) => x.includes('TICKET_URL_ALLOWED_HOSTS')), 'Hinweis Zammad-Server');
  assert.ok(w.some((x) => x.includes('ADMIN_ALLOWED_CIDRS')), 'Hinweis Admin-Netz');
  assert.ok(w.some((x) => x.includes('Freigabe-Feld ohne Gruppen')), 'Hinweis Freigabe-Feld');
  // mit Gruppen verschwindet der Hinweis
  p.app.db.run("UPDATE form_versions SET definition = ? WHERE form_id = ? AND status = 'published'",
    JSON.stringify({ ...def, fields: def.fields.map((f) => f.type === 'approver' ? { ...f, approverGroups: ['grp-fuehrung'] } : f) }), formId);
  const w2: string[] = (await su.get('/api/admin/overview')).json.warnings;
  assert.ok(!w2.some((x) => x.includes('Freigabe-Feld ohne Gruppen')));
});

test('Nur benachrichtigen: neuere Versionen erkennen, nichts installierbar machen', async () => {
  assert.deepEqual(newerVersions([{ name: 'v1.2.0' }, { name: 'v99.0.1' }, { name: 'v99.1.0' }, { name: 'kaputt' }, { name: 'v1.0' }, 'v99.0.0'], '1.13.0'), ['99.1.0', '99.0.1', '99.0.0']);
  assert.deepEqual(newerVersions({ message: 'rate limit' }, '1.0.0'), []);
  // aus: keine Abfrage
  let calls = 0;
  const fake = (async () => { calls++; return new Response(JSON.stringify([{ name: 'v99.0.0' }, { name: 'v1.0.0' }]), { status: 200 }); }) as typeof fetch;
  p.cfg.updateNotify = { enabled: false, url: 'https://example.org/tags' };
  assert.equal(await checkForUpdates(p.app, fake), null);
  assert.equal(calls, 0);
  // an: Versionen anzeigen, „available“ (installierbar) bleibt leer
  p.cfg.updateNotify = { enabled: true, url: 'https://example.org/tags' };
  assert.deepEqual(await checkForUpdates(p.app, fake), ['99.0.0']);
  const u = await su.get('/api/admin/updates');
  assert.equal(u.json.notifyOnly, true);
  assert.deepEqual(u.json.notifyVersions, ['99.0.0']);
  assert.equal(u.json.latestVersion, '99.0.0');
  assert.deepEqual(u.json.available, []);
  assert.equal((await su.post('/api/admin/updates/install', { version: '99.0.0' })).status, 422, 'nicht installierbar');
  // Fehler werden angezeigt, nicht geworfen
  const broken = (async () => new Response('nope', { status: 500 })) as typeof fetch;
  assert.equal(await checkForUpdates(p.app, broken), null);
  assert.match((await su.get('/api/admin/updates')).json.lastError, /HTTP 500/);
  // läuft der Update-Dienst, hält sich die Benachrichtigung heraus
  p.app.db.run('UPDATE update_state SET updater_seen_at = ? WHERE id = 1', Date.now());
  assert.equal(await checkForUpdates(p.app, fake), null);
  assert.equal((await su.get('/api/admin/updates')).json.notifyOnly, false);
  p.app.db.run('UPDATE update_state SET updater_seen_at = NULL WHERE id = 1');
  p.cfg.updateNotify = { enabled: false, url: 'https://example.org/tags' };
});

async function stepup(c: Client): Promise<{ authorizeUrl: string; final: string }> {
  const start = await c.get('/api/auth/entra/login?stepup=1&returnTo=%2Fadmin');
  assert.equal(start.status, 302, start.text);
  const authorizeUrl = start.headers.get('location')!;
  const authorize = await fetch(authorizeUrl, { redirect: 'manual' });
  const cb = new URL(authorize.headers.get('location')!);
  const res = await c.get(cb.pathname + cb.search);
  return { authorizeUrl, final: res.headers.get('location') ?? '' };
}

test('Bestätigung mit Authentifizierungskontext: angefordert, im Token geprüft, erst dann „MFA“', async () => {
  const ben = new Client(p.url);
  await ben.loginEntra(p, BEN.oid);
  const uid = p.app.db.get<{ id: string }>('SELECT id FROM users WHERE entra_oid = ?', BEN.oid)!.id;
  const mfa = () => p.app.db.get<{ mfa: number }>('SELECT mfa FROM sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT 1', uid)!.mfa;
  assert.equal(mfa(), 0, 'Anmeldung allein gilt nicht als MFA');
  // Kontext nicht erfüllt → Bestätigung scheitert
  p.entra.acrs.grant = false;
  const bad = await stepup(ben);
  assert.match(decodeURIComponent(new URL(bad.authorizeUrl).searchParams.get('claims') ?? ''), /"acrs":\{"essential":true,"value":"c1"\}/);
  assert.match(bad.final, /fehler=sso/);
  assert.equal(mfa(), 0);
  // erfüllt → bestätigt und als MFA gekennzeichnet
  p.entra.acrs.grant = true;
  const ok = await stepup(ben);
  assert.equal(ok.final, '/admin');
  assert.equal(mfa(), 1);
  // ohne Konfiguration: kein claims-Parameter, Bestätigung klappt, aber keine MFA-Kennzeichnung
  p.cfg.entra.stepupAuthContext = undefined;
  const plain = await stepup(ben);
  assert.equal(new URL(plain.authorizeUrl).searchParams.get('claims'), null);
  assert.equal(plain.final, '/admin');
  assert.equal(mfa(), 0);
  p.cfg.entra.stepupAuthContext = 'c1';
});

test('Kontoprüfung: in Entra deaktivierte oder gelöschte Konten verlieren ihre Sitzungen', async () => {
  const ben = new Client(p.url);
  await ben.loginEntra(p, BEN.oid);
  assert.equal((await ben.get('/api/me')).status, 200);
  // aktiv: nichts passiert
  let r = await checkEntraAccounts(p.app, p.entraClient);
  assert.ok(r.checked >= 1);
  assert.equal(r.ended, 0);
  p.entra.disabledOids.add(BEN.oid);
  r = await checkEntraAccounts(p.app, p.entraClient);
  assert.equal(r.ended, 1);
  assert.equal((await ben.get('/api/me')).status, 401);
  assert.ok(p.app.db.get("SELECT 1 FROM audit_log WHERE action = 'user.sessions_ended'"));
  p.entra.disabledOids.delete(BEN.oid);
  // unbekannt (Graph-Fehler) → nichts tun
  const ben2 = new Client(p.url);
  await ben2.loginEntra(p, BEN.oid);
  r = await checkEntraAccounts(p.app, { accountEnabled: async () => null });
  assert.equal(r.ended, 0);
  assert.equal((await ben2.get('/api/me')).status, 200);
  // gelöscht (404) zählt wie deaktiviert
  p.entra.deletedOids.add(BEN.oid);
  r = await checkEntraAccounts(p.app, p.entraClient);
  assert.equal(r.ended, 1);
  p.entra.deletedOids.delete(BEN.oid);
});

test('Ältere Office-Formate je Feld abschaltbar – Standard: erlaubt', async () => {
  const ole = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(504)]);
  const file = [{ name: 'alt.doc', data: ole.toString('base64') }];
  assert.equal((await checkFiles(p.app, file, undefined, 1e6)).length, 1, 'Standard: erlaubt');
  await assert.rejects(checkFiles(p.app, file, undefined, 1e6, { noLegacyOffice: true }), /ältere Office-Formate/);
  const pdf = [{ name: 'a.pdf', data: Buffer.from('%PDF-1.7\n').toString('base64') }];
  assert.equal((await checkFiles(p.app, pdf, undefined, 1e6, { noLegacyOffice: true })).length, 1);
  // Definition: nur true/false erlaubt
  const bad = validateDefinition({ fields: [{ id: 'f', type: 'file', label: 'Datei', noLegacyOffice: 'ja' }], settings: {} } as never);
  assert.ok(bad.some((x) => x.includes('ältere Office-Formate')));
});
