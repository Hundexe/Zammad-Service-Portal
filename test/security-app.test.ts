// Sicherheitstests: Datenzugriff, Eingaben, Uploads, Speicherung.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createTcpServer, type Server as TcpServer, type AddressInfo } from 'node:net';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { startPortal, Client, createSystem, createForm, createUser, ENTRA_USERS, type Portal } from './helpers.ts';
import { deliverNext } from '../src/server/services/requests.ts';
import { verifyAuditChain } from '../src/server/services/audit.ts';
import { renderTemplate } from '../src/shared/template.ts';
import { validateSubmission, validateDefinition } from '../src/shared/form.ts';
import { ClamAv } from '../src/server/services/clamav.ts';

let p: Portal;
let systemId: string, formId: string;
const PW = 'Sehr-geheimes-Passwort-42';
let clamd: TcpServer;

// Simulierter Virenscanner (clamd-Protokoll): meldet EICAR als Fund.
async function startFakeClamd(): Promise<{ server: TcpServer; port: number }> {
  const server = createTcpServer((sock) => {
    let buf = Buffer.alloc(0);
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length >= 4 && buf.subarray(-4).equals(Buffer.alloc(4))) {
        const found = buf.includes(Buffer.from('EICAR-STANDARD-ANTIVIRUS-TEST-FILE'));
        sock.end(found ? 'stream: Eicar-Test-Signature FOUND\0' : 'stream: OK\0');
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return { server, port: (server.address() as AddressInfo).port };
}

const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

before(async () => {
  const fake = await startFakeClamd();
  clamd = fake.server;
  p = await startPortal({ clamav: { host: '127.0.0.1', port: fake.port, required: true } });
  p.app.clamav = new ClamAv('127.0.0.1', fake.port);
  systemId = createSystem(p.app, p.zammad.url);
  formId = createForm(p.app, systemId);
  await createUser(p.app, { username: 'anna', password: PW, email: 'anna.becker@example.org' });
  await createUser(p.app, { username: 'mallory', password: PW, email: 'mallory@example.org' });
  await createUser(p.app, { username: 'sa', password: PW, role: 'Super-Admin' });
});
after(async () => { await p.close(); clamd.close(); });

const values = { betreff: 'Test', beschreibung: 'Text', standort: 'nord' };

describe('Fremde Tickets (IDOR)', () => {
  test('fremdes Ticket: nicht lesbar, keine Antwort, kein Anhang', async () => {
    const victim = p.zammad.state.tickets.find((t) => t.title.includes('Drucker'))!; // gehört Anna
    const secret = p.zammad.state.tickets.find((t) => t.title.includes('Geheim'))!; // gehört Fritz Fremd
    const m = new Client(p.url);
    await m.loginLocal('mallory', PW);
    for (const id of [victim.id, secret.id]) {
      assert.equal((await m.get(`/api/portal/systems/${systemId}/tickets/${id}`)).status, 404);
      assert.equal((await m.post(`/api/portal/systems/${systemId}/tickets/${id}/reply`, { text: 'hallo' })).status, 404);
    }
    const list = await m.get(`/api/portal/systems/${systemId}/tickets?refresh=1`);
    assert.equal(list.json.tickets.length, 0);
    // Anna sieht ihr eigenes Ticket, aber nicht das von Fritz (selbe Organisation wäre etwas anderes)
    const a = new Client(p.url);
    await a.loginLocal('anna', PW);
    assert.equal((await a.get(`/api/portal/systems/${systemId}/tickets/${victim.id}`)).status, 200);
    assert.equal((await a.get(`/api/portal/systems/${systemId}/tickets/${secret.id}`)).status, 404);
  });

  test('Ticket-IDs werden streng geprüft', async () => {
    const a = new Client(p.url);
    await a.loginLocal('anna', PW);
    for (const bad of ['0', '-1', '1e3', '12abc', '99999999999999999999']) {
      const r = await a.get(`/api/portal/systems/${systemId}/tickets/${bad}`);
      assert.ok([400, 404].includes(r.status), bad);
    }
  });

  test('Anfragen anderer Benutzer sind nicht sichtbar', async () => {
    const a = new Client(p.url);
    await a.loginLocal('anna', PW);
    await a.post(`/api/portal/forms/${formId}/submit`, { values });
    const m = new Client(p.url);
    await m.loginLocal('mallory', PW);
    const mine = await m.get('/api/portal/requests');
    assert.equal(mine.json.requests.length, 0);
  });

  test('unsichtbares Ticketsystem (Gruppenfreigabe) ist auch per ID gesperrt', async () => {
    const hidden = createSystem(p.app, p.zammad.url, { slug: 'geheim', name: 'Geheim' });
    p.app.db.run("UPDATE ticket_systems SET visible_groups = '[\"grp-geheim\"]' WHERE id = ?", hidden);
    const f = createForm(p.app, hidden, undefined, 'x');
    const a = new Client(p.url);
    await a.loginLocal('anna', PW);
    assert.ok(!(await a.get('/api/portal/systems')).json.systems.some((s: any) => s.id === hidden));
    assert.equal((await a.get(`/api/portal/forms/${f}`)).status, 404);
    assert.equal((await a.post(`/api/portal/forms/${f}/submit`, { values })).status, 404);
    assert.equal((await a.get(`/api/portal/systems/${hidden}/tickets`)).status, 404);
  });
});

describe('Eingaben', () => {
  test('nur bekannte Felder und erlaubte Werte werden übernommen', async () => {
    const a = new Client(p.url);
    await a.loginLocal('anna', PW);
    const bad = await a.post(`/api/portal/forms/${formId}/submit`, { values: { ...values, standort: 'mond' } });
    assert.equal(bad.status, 422);
    assert.equal(bad.json.details.standort, 'Ungültige Auswahl');
    const r = await a.post(`/api/portal/forms/${formId}/submit`, { values: { ...values, kategorie: 'Warten auf::Kunde', hacker: 'x', __proto__: { admin: true } } });
    assert.equal(r.status, 201);
    await deliverNext(p.app); await deliverNext(p.app); await deliverNext(p.app);
    const ticket = p.zammad.state.tickets.at(-1)!;
    assert.equal(ticket.hacker, undefined);
    assert.equal((ticket as any).admin, undefined);
  });

  test('XSS in Eingaben landet escaped im Ticket', async () => {
    const a = new Client(p.url);
    await a.loginLocal('anna', PW);
    const payload = '<img src=x onerror=alert(1)><script>alert(1)</script>"\'&';
    const r = await a.post(`/api/portal/forms/${formId}/submit`, { values: { ...values, betreff: payload, beschreibung: payload } });
    assert.equal(r.status, 201);
    while (await deliverNext(p.app)) { /* alle zustellen */ }
    const ticket = p.zammad.state.tickets.at(-1)!;
    const art = p.zammad.state.articles.find((x) => x.ticket_id === ticket.id)!;
    assert.doesNotMatch(art.body, /<script|<img/i);
    assert.match(art.body, /&lt;script&gt;/);
    assert.ok(ticket.title.includes('<img'), 'Titel ist reiner Text (Zammad zeigt ihn escaped)');
  });

  test('Vorlagen führen keinen Code aus und lesen keine Objekt-Interna', () => {
    const out = renderTemplate('{{constructor.name}}{{__proto__}}{{benutzer.toString}}{{ a }}{{#if x}}', { benutzer: { name: 'A' }, a: '<b>' }, 'html');
    assert.equal(out, '&lt;b&gt;{{#if x}}');
  });

  test('HTML aus Zammad wird im Portal nur als Text ausgegeben', async () => {
    const victim = p.zammad.state.tickets.find((t) => t.title.includes('Drucker'))!;
    p.zammad.state.articles.push({ id: 99901, ticket_id: victim.id, from: 'Agent', sender: 'Agent', body: '<p>Hallo<script>alert(1)</script><img src=x onerror=alert(2)></p>', content_type: 'text/html', internal: false, created_at: new Date().toISOString(), attachments: [] });
    const a = new Client(p.url);
    await a.loginLocal('anna', PW);
    const d = await a.get(`/api/portal/systems/${systemId}/tickets/${victim.id}`);
    const last = d.json.articles.at(-1);
    assert.equal(last.text, 'Hallo');
    assert.equal(last.body, undefined);
  });

  test('SQL-Injection in Suchfeldern bleibt wirkungslos', async () => {
    const c = new Client(p.url);
    await c.loginLocal('sa', PW);
    for (const q of ["' OR 1=1 --", '%', '_', "x'); DROP TABLE users; --", '\\']) {
      const r = await c.get(`/api/admin/users?q=${encodeURIComponent(q)}`);
      assert.equal(r.status, 200, q);
      assert.ok(r.json.users.length <= 1, `${q} → ${r.json.users.length}`);
    }
    assert.ok(p.app.db.get('SELECT COUNT(*) n FROM users'));
    const audit = await c.get(`/api/admin/audit?action=${encodeURIComponent("login' OR '1'='1")}`);
    assert.equal(audit.status, 200);
  });

  test('Prototype Pollution über JSON wird verhindert', async () => {
    const a = new Client(p.url);
    await a.loginLocal('anna', PW);
    await a.req('POST', `/api/portal/forms/${formId}/submit`, '{"values":{"betreff":"a","beschreibung":"b","standort":"nord"},"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}');
    assert.equal(({} as any).polluted, undefined);
  });

  test('zu große Anfragen werden abgewiesen', async () => {
    const a = new Client(p.url);
    await a.loginLocal('anna', PW);
    const r = await a.post('/api/auth/password', { currentPassword: 'x'.repeat(10000), newPassword: 'y' });
    assert.equal(r.status, 413);
  });

  test('Massenzuweisung: interne Felder lassen sich nicht setzen', async () => {
    const c = new Client(p.url);
    await c.loginLocal('sa', PW);
    const anna = p.app.db.get<{ id: string }>("SELECT id FROM users WHERE username = 'anna'")!;
    await c.put(`/api/admin/users/${anna.id}`, { kind: 'entra', password_hash: 'x', must_change_password: 1, username: 'root', totp_enabled: 1 });
    const row = p.app.db.get<{ kind: string; password_hash: string; username: string; totp_enabled: number }>('SELECT * FROM users WHERE id = ?', anna.id)!;
    assert.equal(row.kind, 'local');
    assert.equal(row.username, 'anna');
    assert.notEqual(row.password_hash, 'x');
    assert.equal(row.totp_enabled, 0);
  });

  test('Formular-Definition: kaputte Regex und unbekannte Platzhalter werden abgelehnt', async () => {
    const c = new Client(p.url);
    await c.loginLocal('sa', PW);
    const def = (await c.get(`/api/admin/systems/${systemId}/forms/${formId}`)).json.definition;
    def.fields[0].pattern = '(a+)+(';
    assert.equal((await c.put(`/api/admin/systems/${systemId}/forms/${formId}/draft`, { definition: def })).status, 422);
    def.fields[0].pattern = undefined;
    def.settings.titleTemplate = '{{gibtsnicht}}';
    assert.equal((await c.put(`/api/admin/systems/${systemId}/forms/${formId}/draft`, { definition: def })).status, 422);
  });

  test('Prüfmuster laufen linear: kein ReDoS auch mit kurzer bösartiger Eingabe', () => {
    // Mit der normalen Engine blockiert dieses Muster bei ~30 Zeichen den Server sekundenlang
    for (const pattern of ['(a|aa)+', '([A-Za-z]+ ?)+', '(x+x+)+y']) {
      const def = { fields: [{ id: 't', type: 'text' as const, label: 'T', pattern }], settings: { titleTemplate: 'x', bodyTemplate: '' } };
      for (const input of ['a'.repeat(40) + '!', 'Abc '.repeat(30) + '!', 'x'.repeat(4000)]) {
        const started = Date.now();
        validateSubmission(def, { t: input });
        assert.ok(Date.now() - started < 200, `${pattern} mit ${input.length} Zeichen zu langsam`);
      }
    }
    const ok = { fields: [{ id: 't', type: 'text' as const, label: 'T', pattern: '[A-Za-z]{2}-\\d{4}' }], settings: { titleTemplate: 'x', bodyTemplate: '' } };
    assert.equal(validateSubmission(ok, { t: 'NB-0042' }).ok, true);
    assert.equal(validateSubmission(ok, { t: 'NB-42' }).ok, false);
  });

  test('Prüfmuster mit Rückverweis oder Lookaround werden beim Speichern abgelehnt', () => {
    for (const pattern of ['(a)\\1', '(?=a)a', '\\p{L}+']) {
      const problems = validateDefinition({ fields: [{ id: 't', type: 'text', label: 'T', pattern }], settings: { titleTemplate: 'x', bodyTemplate: '' } } as any);
      assert.ok(problems.some((x: string) => /nicht erlaubt/.test(x)), pattern);
    }
  });
});

describe('Uploads', () => {
  const file = (name: string, data: Buffer | string, type = 'application/pdf') => ({ name, type, data: Buffer.from(data).toString('base64') });
  const submit = async (files: unknown) => {
    const a = new Client(p.url);
    await a.loginLocal('anna', PW);
    return a.post(`/api/portal/forms/${formId}/submit`, { values, files: { anhang: files } });
  };

  test('Virenscanner blockiert Schadsoftware (EICAR)', async () => {
    const r = await submit([file('rechnung.txt', EICAR, 'text/plain')]);
    assert.equal(r.status, 422);
    assert.equal(r.json.code, 'virus_found');
  });

  test('getarnte Dateien werden am Inhalt erkannt', async () => {
    const exe = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(200, 1)]);
    for (const f of [file('bericht.pdf', exe), file('bild.png', '<html><script>alert(1)</script></html>', 'image/png'), file('x.html', '<html></html>', 'text/html'), file('x.svg', '<svg onload=alert(1)>', 'image/svg+xml'), file('pdf.exe', '%PDF-1.4 x')]) {
      const r = await submit([f]);
      assert.equal(r.status, 422, f.name);
      assert.equal(r.json.code, 'bad_file', f.name);
    }
  });

  test('nicht erlaubte Dateiart für das Feld wird abgelehnt', async () => {
    // Feld erlaubt pdf, image, text – nicht office
    const docx = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(100)]);
    const r = await submit([file('a.docx', docx)]);
    assert.equal(r.status, 422);
  });

  test('Dateinamen werden bereinigt (Pfade, Steuerzeichen, RTL-Tricks)', async () => {
    const r = await submit([file('../../etc/‮gnp.exe\u0000.pdf', '%PDF-1.4 test')]);
    assert.equal(r.status, 201, r.text);
    const f = p.app.db.get<{ filename: string }>('SELECT filename FROM request_files ORDER BY rowid DESC LIMIT 1')!;
    assert.equal(f.filename, 'gnp.exe.pdf');
  });

  test('zu viele oder kaputt kodierte Dateien', async () => {
    assert.equal((await submit([file('a.pdf', '%PDF-1'), file('b.pdf', '%PDF-1'), file('c.pdf', '%PDF-1')])).status, 422);
    assert.equal((await submit([{ name: 'a.pdf', data: '!!!keinbase64' }])).status, 400);
  });

  test('Anhänge liegen bis zur Zustellung nur verschlüsselt auf der Platte und werden danach gelöscht', async () => {
    const r = await submit([file('geheim.pdf', '%PDF-1.4 STRENG-GEHEIM-12345')]);
    assert.equal(r.status, 201);
    const dir = join(p.app.uploadsDir, r.json.id);
    const files = readdirSync(dir);
    assert.equal(files.length, 1);
    assert.ok(!readFileSync(join(dir, files[0])).includes(Buffer.from('STRENG-GEHEIM')));
    while (await deliverNext(p.app)) { /* zustellen */ }
    assert.equal(existsSync(dir), false);
  });

  test('ist der Virenscanner aus, werden Uploads abgelehnt (fail closed)', async () => {
    const saved = p.app.clamav;
    p.app.clamav = new ClamAv('127.0.0.1', 1);
    try {
      const r = await submit([file('a.pdf', '%PDF-1.4 x')]);
      assert.equal(r.status, 503);
    } finally { p.app.clamav = saved; }
  });
});

describe('Logos', () => {
  test('SVG mit Skript oder externen Verweisen wird abgelehnt', async () => {
    const c = new Client(p.url);
    await c.loginLocal('sa', PW);
    for (const svgText of [
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      '<svg onload="alert(1)"></svg>',
      '<svg><a href="javascript:alert(1)"><rect/></a></svg>',
      '<svg><image href="https://evil.example/x.png"/></svg>',
      '<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg>&x;</svg>',
      '<svg><foreignObject><iframe src="x"/></foreignObject></svg>',
    ]) {
      const r = await c.post(`/api/admin/systems/${systemId}/assets`, { kind: 'logo', data: Buffer.from(svgText).toString('base64') });
      assert.equal(r.status, 422, svgText);
    }
  });

  test('Logos werden mit Sandbox-CSP und festem Typ ausgeliefert', async () => {
    const c = new Client(p.url);
    await c.loginLocal('sa', PW);
    const ok = await c.post(`/api/admin/systems/${systemId}/assets`, { kind: 'logo', data: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>').toString('base64') });
    assert.equal(ok.status, 201);
    const r = await new Client(p.url).get(`/api/assets/${ok.json.id}`);
    assert.equal(r.headers.get('content-type'), 'image/svg+xml');
    assert.match(r.headers.get('content-security-policy') ?? '', /sandbox/);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  });
});

describe('Pfade und URLs', () => {
  test('kein Pfad-Traversal bei statischen Dateien und Assets', async () => {
    const c = new Client(p.url);
    for (const path of ['/../../etc/passwd', '/%2e%2e/%2e%2e/etc/passwd', '/..%2f..%2fetc%2fpasswd', '/.env', '/app/../../package.json', '/api/assets/..%2F..%2Fportal.sqlite', '/%00']) {
      const r = await c.get(path);
      assert.ok(!r.text.includes('root:') && !r.text.includes('"devDependencies"') && !r.text.includes('SQLite format'), path);
    }
  });

  test('SSRF: Ticketsystem-Adresse darf nicht auf Metadaten-Dienste oder Loopback zeigen', async () => {
    const q = await startPortal({ env: 'development', allowPrivateTicketUrls: false });
    try {
      await createUser(q.app, { username: 'sa', password: PW, role: 'Super-Admin' });
      const c = new Client(q.url);
      await c.loginLocal('sa', PW);
      for (const url of ['http://169.254.169.254', 'http://127.0.0.1:22', 'http://[::1]', 'http://10.0.0.5', 'file:///etc/passwd', 'gopher://x', 'https://user:pass@zammad.example']) {
        const r = await c.post('/api/admin/systems', { slug: 'x', name: 'X', baseUrl: url, apiToken: 't' });
        assert.equal(r.status, 422, url);
      }
    } finally { await q.close(); }
  });
});

describe('Gespeicherte Daten', () => {
  test('API-Token und Anfrageinhalte liegen nur verschlüsselt in der Datenbank', async () => {
    const a = new Client(p.url);
    await a.loginLocal('anna', PW);
    p.app.db.run("UPDATE ticket_systems SET status = 'maintenance' WHERE id = ?", systemId);
    const r = await a.post(`/api/portal/forms/${formId}/submit`, { values: { ...values, beschreibung: 'VERTRAULICH-98765' } });
    assert.equal(r.status, 201);
    p.app.db.run("UPDATE ticket_systems SET status = 'active' WHERE id = ?", systemId);
    p.app.db.raw.exec('PRAGMA wal_checkpoint(FULL)');
    const file = readFileSync(join(p.cfg.dataDir, 'portal.sqlite'));
    assert.ok(!file.includes(Buffer.from('test-token')), 'Token im Klartext');
    assert.ok(!file.includes(Buffer.from('VERTRAULICH-98765')), 'Inhalt im Klartext');
  });

  test('Passwörter werden mit scrypt gehasht', () => {
    const row = p.app.db.get<{ password_hash: string }>("SELECT password_hash FROM users WHERE username = 'anna'")!;
    assert.match(row.password_hash, /^scrypt\$131072\$8\$1\$/);
  });

  test('Audit-Log ist nur anhängbar und Manipulationen fallen auf', () => {
    assert.throws(() => p.app.db.run("UPDATE audit_log SET action = 'x'"), /nur anhängbar/);
    assert.throws(() => p.app.db.run('DELETE FROM audit_log'), /nur anhängbar/);
    assert.equal(verifyAuditChain(p.app.db).ok, true);
    // Angreifer mit Dateizugriff entfernt den Schutz und ändert einen Eintrag
    p.app.db.raw.exec("DROP TRIGGER audit_log_no_update; UPDATE audit_log SET actor_name = 'niemand' WHERE seq = 2;");
    const v = verifyAuditChain(p.app.db);
    assert.equal(v.ok, false);
    assert.equal(v.brokenAt, 2);
  });

  test('Audit-Export schützt vor CSV-Formel-Injection', async () => {
    const c = new Client(p.url);
    await c.loginLocal('sa', PW);
    p.app.db.raw.exec("CREATE TRIGGER IF NOT EXISTS audit_log_no_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log ist nur anhängbar'); END;");
    await new Client(p.url).post('/api/auth/local/login', { username: '=HYPERLINK("http://evil")', password: 'x' });
    const r = await c.get('/api/admin/audit/export');
    assert.equal(r.status, 200);
    assert.ok(r.text.includes(`"'=HYPERLINK`));
  });
});

describe('Entra-Benutzer', () => {
  test('Gruppen aus dem Token steuern Rechte; App-Rollen werden als approle:… geführt', async () => {
    const role = p.app.db.get<{ id: string }>("SELECT id FROM roles WHERE name = 'Auditor'")!;
    p.app.db.run("INSERT INTO role_assignments (id, role_id, subject_type, subject_value, system_id, created_at) VALUES ('ra-test', ?, 'group', 'it-admins', NULL, ?)", role.id, Date.now());
    const ben = new Client(p.url);
    await ben.loginEntra(p, ENTRA_USERS[1].oid); // Ben ist in it-admins
    assert.equal((await ben.get('/api/admin/audit')).status, 200);
    const anna = new Client(p.url);
    await anna.loginEntra(p, ENTRA_USERS[0].oid);
    assert.equal((await anna.get('/api/admin/audit')).status, 403);
  });
});
