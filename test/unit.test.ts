// Unit-Tests für Bausteine ohne Server.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { SecretBox, generatePassword, hashPassword, verifyPassword, passwordProblems } from '../src/server/crypto.ts';
import { base32Encode, totpCode, verifyTotp } from '../src/server/auth/totp.ts';
import { renderTemplate, placeholders } from '../src/shared/template.ts';
import { validateSubmission, validateDefinition, isVisible, type FormDefinition } from '../src/shared/form.ts';
import { contrastRatio, contrastWarnings, validateBranding, DEFAULT_BRANDING } from '../src/shared/branding.ts';
import { sniff, safeFilename, checkLogo } from '../src/server/services/files.ts';
import { flattenOptions, toAttribute } from '../src/server/connectors/zammad.ts';
import { htmlToText } from '../src/server/routes/portal.ts';
import { safeReturnTo } from '../src/server/routes/auth.ts';
import { ProxyTrust } from '../src/server/http/core.ts';

describe('Kryptografie', () => {
  test('SecretBox: Verschlüsselung, Zweckbindung, Manipulationsschutz', () => {
    const box = new SecretBox(randomBytes(32));
    const c = box.encrypt('a', 'geheim');
    assert.equal(box.decrypt('a', c), 'geheim');
    assert.notEqual(box.encrypt('a', 'geheim'), c, 'zufälliger IV');
    assert.throws(() => box.decrypt('b', c), 'anderer Zweck → Fehler');
    const parts = c.split('.');
    parts[2] = parts[2].slice(0, -2) + (parts[2].endsWith('A') ? 'BB' : 'AA');
    assert.throws(() => box.decrypt('a', parts.join('.')), 'Manipulation fällt auf');
    assert.throws(() => new SecretBox(randomBytes(16)));
    const blob = box.encryptBlob('upload', Buffer.from('daten'));
    assert.equal(box.decryptBlob('upload', blob).toString(), 'daten');
  });

  test('Passwort-Hash: scrypt, Salz, Prüfung', async () => {
    const h1 = await hashPassword('Kaffeetasse-Fahrrad-1');
    const h2 = await hashPassword('Kaffeetasse-Fahrrad-1');
    assert.notEqual(h1, h2);
    assert.equal(await verifyPassword('Kaffeetasse-Fahrrad-1', h1), true);
    assert.equal(await verifyPassword('kaffeetasse-fahrrad-1', h1), false);
    assert.equal(await verifyPassword('egal', null), false);
    assert.equal(await verifyPassword('egal', 'kaputt'), false);
  });

  test('generierte Passwörter: Länge, Zeichenarten, keine Wiederholung', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const pw = generatePassword();
      assert.equal(pw.length, 20);
      assert.match(pw, /[A-Z]/); assert.match(pw, /[a-z]/); assert.match(pw, /[2-9]/); assert.match(pw, /[!#%+\-=?@_]/);
      assert.doesNotMatch(pw, /[0O1lI]/);
      assert.deepEqual(passwordProblems(pw), []);
      seen.add(pw);
    }
    assert.equal(seen.size, 200);
  });

  test('Passwortregeln', () => {
    assert.ok(passwordProblems('kurz').length);
    assert.ok(passwordProblems('nurkleinbuchstaben').length === 0, '18 Zeichen genügen');
    assert.ok(passwordProblems('abcdefghijkl').length, '12 Zeichen brauchen Vielfalt');
    assert.ok(passwordProblems('Alex-Berger-2026!', ['alex']).length, 'Name enthalten');
  });
});

describe('TOTP (RFC 6238)', () => {
  // Testvektoren aus RFC 6238, Anhang B (SHA-1, Schlüssel "12345678901234567890")
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  const vectors: [number, string][] = [[59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'], [1234567890, '89005924'], [2000000000, '69279037']];
  test('Testvektoren (letzte 6 Ziffern)', () => {
    for (const [t, code] of vectors) assert.equal(totpCode(secret, Math.floor(t / 30)), code.slice(2));
  });
  test('Toleranz ±1 Schritt, Schutz gegen Wiederverwendung', () => {
    const now = 1_800_000_000_000;
    const step = Math.floor(now / 30000);
    assert.equal(verifyTotp(secret, totpCode(secret, step - 1), null, now), step - 1);
    assert.equal(verifyTotp(secret, totpCode(secret, step - 2), null, now), null);
    assert.equal(verifyTotp(secret, totpCode(secret, step), step, now), null, 'schon benutzt');
    assert.equal(verifyTotp(secret, 'abcdef', null, now), null);
  });
});

describe('Vorlagen', () => {
  test('Platzhalter, Escaping, Rohwerte', () => {
    const vars = { a: '<b>', benutzer: { name: 'Alex' } };
    assert.equal(renderTemplate('{{a}} {{ benutzer.name }} {{x}}', vars, 'html'), '&lt;b&gt; Alex ');
    assert.equal(renderTemplate('{{alle_felder}}', vars, 'html', { alle_felder: '<table></table>' }), '<table></table>');
    assert.equal(renderTemplate('{{alle_felder}}', vars, 'text', { alle_felder: '<table></table>' }), '');
    assert.equal(renderTemplate('Titel\nmit {{a}}', vars, 'text'), 'Titel mit <b>');
    assert.equal(renderTemplate('x'.repeat(400), {}, 'text').length, 250);
    assert.deepEqual(placeholders('{{a}} {{b.c}} {{a}}'), ['a', 'b.c']);
  });
});

describe('Formulare', () => {
  const def: FormDefinition = {
    fields: [
      { id: 'art', type: 'select', label: 'Art', required: true, options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] },
      { id: 'nur_b', type: 'text', label: 'Nur B', required: true, visibleIf: { field: 'art', op: 'eq', value: 'b' } },
      { id: 'zahl', type: 'number', label: 'Zahl', min: 1, max: 5 },
      { id: 'datum', type: 'date', label: 'Datum' },
      { id: 'mail', type: 'email', label: 'Mail' },
      { id: 'mehr', type: 'multiselect', label: 'Mehr', options: [{ value: 'x', label: 'X' }, { value: 'y', label: 'Y' }] },
      { id: 'ok', type: 'checkbox', label: 'OK' },
    ],
    settings: { titleTemplate: 't', bodyTemplate: 'b' },
  };
  test('Sichtbarkeitsregeln und Pflichtfelder', () => {
    assert.equal(validateSubmission(def, { art: 'a' }).ok, true);
    const r = validateSubmission(def, { art: 'b' });
    assert.equal(r.errors.nur_b, 'Pflichtfeld');
    assert.equal(validateSubmission(def, { art: 'a', nur_b: 'versteckt' }).values.nur_b, undefined, 'versteckte Felder werden verworfen');
    assert.equal(isVisible(def.fields[1], { art: 'b' }, def.fields), true);
  });
  test('Typprüfung', () => {
    const r = validateSubmission(def, { art: 'c', zahl: '9', datum: '2026-13-45', mail: 'kein@mail', mehr: ['x', 'z'], ok: 'vielleicht' });
    assert.deepEqual(Object.keys(r.errors).sort(), ['art', 'datum', 'mail', 'mehr', 'ok', 'zahl']);
    const good = validateSubmission(def, { art: 'a', zahl: '3', datum: '2026-10-21', mail: 'a.b@example.org', mehr: ['x', 'x'], ok: true });
    assert.equal(good.ok, true);
    assert.deepEqual(good.values.mehr, ['x']);
    assert.equal(good.values.zahl, 3);
  });
  test('Definition prüfen', () => {
    assert.deepEqual(validateDefinition(def), []);
    const bad = validateDefinition({ fields: [{ id: '1x', type: 'nix', label: '' }, { id: 'a', type: 'select', label: 'A' }, { id: 'a', type: 'text', label: 'B', visibleIf: { field: 'gibtsnicht', op: 'eq' } }], settings: {} });
    assert.ok(bad.length >= 5, bad.join(' | '));
  });
});

describe('Branding', () => {
  test('Kontrast nach WCAG', () => {
    assert.equal(Math.round(contrastRatio('#000000', '#ffffff')), 21);
    assert.equal(contrastWarnings(DEFAULT_BRANDING).length, 0);
    assert.ok(contrastWarnings({ ...DEFAULT_BRANDING, headerColor: '#ffff00', headerTextColor: '#ffffff' }).length > 0);
  });
  test('Validierung', () => {
    assert.ok(validateBranding({ ...DEFAULT_BRANDING, primaryColor: 'red' }).errors.length);
    assert.ok(validateBranding({ ...DEFAULT_BRANDING, imprintUrl: 'javascript:alert(1)' }).errors.length);
    assert.equal(validateBranding(DEFAULT_BRANDING).errors.length, 0);
  });
});

describe('Dateien', () => {
  test('Typ anhand des Inhalts', () => {
    assert.equal(sniff(Buffer.from('%PDF-1.7 x'), 'a.pdf')?.mime, 'application/pdf');
    assert.equal(sniff(Buffer.from('%PDF-1.7 x'), 'a.exe'), null);
    assert.equal(sniff(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]), 'a.png')?.kind, 'image');
    assert.equal(sniff(Buffer.from('a;b\n1;2'), 'liste.csv')?.kind, 'text');
    assert.equal(sniff(Buffer.from([0xff, 0xfe, 0x00, 0x41]), 'a.txt'), null);
    assert.equal(sniff(Buffer.from('MZ...'), 'a.pdf'), null);
  });
  test('Dateinamen', () => {
    assert.equal(safeFilename('C:\\Users\\x\\bericht.pdf'), 'bericht.pdf');
    assert.equal(safeFilename('../../.htaccess'), 'htaccess');
    assert.equal(safeFilename(''), 'datei');
  });
  test('Logos', () => {
    assert.equal(checkLogo(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>'), 'logo').mime, 'image/svg+xml');
    assert.throws(() => checkLogo(Buffer.from('<svg><style>@import url(x)</style></svg>'), 'logo'));
    assert.throws(() => checkLogo(Buffer.from('GIF89a'), 'logo'));
  });
});

describe('Zammad-Objekte', () => {
  test('Baumoptionen werden zu Eltern::Kind', () => {
    const opts = flattenOptions([{ name: 'A', value: 'A', children: [{ name: 'B', value: 'A::B', children: [{ name: 'C', value: 'A::B::C' }] }] }, { name: 'D', value: 'D' }]);
    assert.deepEqual(opts.map((o) => o.value), ['A', 'A::B', 'A::B::C', 'D']);
    assert.equal(opts[2].label, 'A › B › C');
    assert.deepEqual(flattenOptions({ x: 'X' }), [{ value: 'x', label: 'X' }]);
  });
  test('Typen werden auf Portal-Felder abgebildet', () => {
    assert.equal(toAttribute({ name: 'a', data_type: 'tree_select', data_option: { options: [] } }).portalType, 'select');
    assert.equal(toAttribute({ name: 'b', data_type: 'boolean', data_option: { options: { true: 'Ja', false: 'Nein' } } }).options?.length, 2);
    assert.equal(toAttribute({ name: 'c', data_type: 'user_autocompletion' }).portalType, null);
  });
});

describe('Sonstiges', () => {
  test('HTML → Text', () => {
    assert.equal(htmlToText('<p>Hallo &amp; <b>Welt</b></p><script>x</script><ul><li>A</li></ul>&#x3C;'), 'Hallo & Welt\n• A\n<');
  });
  test('Rücksprung-Ziele nach dem Login', () => {
    assert.equal(safeReturnTo('/s/1/tickets?ansicht=2'), '/s/1/tickets?ansicht=2');
    for (const bad of ['//evil', 'https://evil', '/\\evil', '/a/../b', 'javascript:x', '/api/x', 42]) assert.equal(safeReturnTo(bad), '/', String(bad));
  });
  test('Vertrauenswürdige Proxys und X-Forwarded-For', () => {
    const t = new ProxyTrust(['172.20.0.0/16']);
    const req = (remote: string, xff?: string) => ({ socket: { remoteAddress: remote }, headers: xff ? { 'x-forwarded-for': xff } : {} }) as any;
    assert.equal(t.clientIp(req('172.20.0.5', '1.2.3.4')), '1.2.3.4');
    assert.equal(t.clientIp(req('10.0.0.9', '1.2.3.4')), '10.0.0.9', 'nicht vertrauenswürdig → ignoriert');
    assert.equal(t.clientIp(req('172.20.0.5', '6.6.6.6, 1.2.3.4')), '1.2.3.4', 'gefälschter linker Eintrag zählt nicht');
    assert.equal(t.clientIp(req('::ffff:172.20.0.5', '1.2.3.4')), '1.2.3.4');
  });
});

describe('Statische Demo', () => {
  test('Antworten werden über Methode, Pfad und sortierte Parameter gefunden', async () => {
    const { requestKey } = await import('../src/web/demo/backend.ts');
    assert.equal(requestKey('get', '/api/portal/systems/a/tickets?'), 'GET /api/portal/systems/a/tickets');
    assert.equal(requestKey('GET', '/api/x?b=2&a=1&refresh=1'), 'GET /api/x?a=1&b=2');
  });
});
