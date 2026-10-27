// Review 2026-10: Tests zu den Punkten des externen Reviews (siehe docs/REVIEW-2026-10.md).
// Jeder describe-Block nennt das Issue, das er absichert.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { startPortal, Client, createSystem, createForm, createUser, ENTRA_USERS, sleep, type Portal } from './helpers.ts';
import { deliverNext, retryRequest } from '../src/server/services/requests.ts';
import { connectorFor, getSystem, validateSystemUrl } from '../src/server/services/systems.ts';
import { displaySender, safeTicketFields } from '../src/server/connectors/zammad.ts';
import { blockedAddress, blockedHostname, guardedFetch, guardedLookup, BlockedAddressError } from '../src/server/net/guarded-fetch.ts';
import { verifyBackup, restoreBackup } from '../src/server/services/backup.ts';
import { collectStatus, testScanner, eicar } from '../src/server/services/status.ts';
import { ClamAv } from '../src/server/services/clamav.ts';
import { loadConfig } from '../src/server/config.ts';
import { createApp, type App } from '../src/server/app.ts';
import { SecretBox } from '../src/server/crypto.ts';
import { onLog } from '../src/server/log.ts';
import { uuid } from '../src/server/db/db.ts';
import { emptyDefinition } from '../src/server/services/forms.ts';
import type { FormDefinition } from '../src/shared/form.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const PW = 'Sehr-geheimes-Passwort-42';
const [ANNA, BEN, ALEX] = ENTRA_USERS;

let p: Portal;
let systemId: string;
let formId: string;
const values = { betreff: 'Test', beschreibung: 'Beschreibung', standort: 'nord' };

before(async () => {
  p = await startPortal();
  systemId = createSystem(p.app, p.zammad.url);
  formId = createForm(p.app, systemId);
  await createUser(p.app, { username: 'sa', password: PW, role: 'Super-Admin' });
});
after(async () => { await p.close(); });

async function admin(): Promise<Client> {
  const c = new Client(p.url);
  const r = await c.loginLocal('sa', PW);
  assert.equal(r.status, 200, r.text);
  return c;
}
async function entra(user = ANNA): Promise<Client> {
  const c = new Client(p.url);
  await c.loginEntra(p, user.oid);
  return c;
}
/** Formulardefinition direkt in die Datenbank schreiben – an der Prüfung im Editor vorbei (wie eine Altlast). */
function forceDefinition(id: string, def: FormDefinition): void {
  p.app.db.run("UPDATE form_versions SET definition = ? WHERE form_id = ? AND status = 'published'", JSON.stringify(def), id);
}
function setSystem(cols: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(cols)) p.app.db.run(`UPDATE ticket_systems SET ${k} = ? WHERE id = ?`, v as any, systemId);
}
const zammadUser = (email: string) => p.zammad.state.users.find((u) => u.email === email)!;
const lastCreate = () => [...p.zammad.state.requests].reverse().find((x) => x.method === 'POST' && x.path === '/api/v1/tickets')!;

// ====================================================================================== #4
describe('#4 Zammad-Felder und Gruppen: nur freigegeben, nur erlaubt', () => {
  const draft = (c: Client, def: unknown) => c.put(`/api/admin/systems/${systemId}/forms/${formId}/draft`, { definition: def });
  const base = (): FormDefinition => ({
    ...emptyDefinition(),
    fields: [{ id: 'betreff', type: 'text', label: 'Betreff', required: true, mapping: { target: 'article' } }],
    settings: { ...emptyDefinition().settings, titleTemplate: '{{betreff}}', group: 'IT-Support' },
  } as FormDefinition);

  test('Editor: geschützte Zammad-Felder (owner_id, state_id, customer_id, …) sind nicht zuordenbar', async () => {
    const c = await admin();
    for (const name of ['owner_id', 'state_id', 'customer_id', 'organization_id', 'group_id', 'pending_time', 'article', 'tags', 'preferences', 'xyz_ids']) {
      const d = base();
      d.fields.push({ id: 'x', type: 'text', label: 'X', mapping: { target: 'zammad_field', name } } as any);
      const r = await draft(c, d);
      assert.equal(r.status, 422, name);
    }
  });

  test('Editor: freie Zuordnung nur in freigegebene Attribute', async () => {
    const c = await admin();
    const d = base();
    d.fields.push({ id: 'kst', type: 'text', label: 'Kostenstelle', mapping: { target: 'zammad_field', name: 'kostenstelle' } } as any);
    const r = await draft(c, d);
    assert.equal(r.status, 422);
    assert.match(JSON.stringify(r.json), /nicht freigegeben/);
    d.fields[1].mapping!.name = 'standort'; // freigegeben
    assert.equal((await draft(c, d)).status, 200);
  });

  test('Allowlist: Standardgruppe, Formulargruppe und Gruppen-Zuordnung müssen erlaubt sein', async () => {
    const c = await admin();
    const sys = (await c.get('/api/admin/systems')).json.systems.find((s: any) => s.id === systemId);
    assert.deepEqual(sys.allowedGroups, []);
    let r = await c.put(`/api/admin/systems/${systemId}`, { ...sys, allowedGroups: ['IT-Support::Hardware'], defaultGroup: 'IT-Support' });
    assert.equal(r.status, 422, 'Standardgruppe außerhalb der Allowlist');
    r = await c.put(`/api/admin/systems/${systemId}`, { ...sys, allowedGroups: ['IT-Support', 'IT-Support::Hardware'], defaultGroup: 'IT-Support' });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.system.allowedGroups, ['IT-Support', 'IT-Support::Hardware']);

    const d = base();
    d.settings.group = 'Users';
    assert.equal((await draft(c, d)).status, 422, 'Formulargruppe nicht erlaubt');
    d.settings.group = 'IT-Support';
    d.fields.push({ id: 'g', type: 'select', label: 'Bereich', options: [{ value: 'hw', label: 'HW' }, { value: 'x', label: 'X' }], mapping: { target: 'group', valueMap: { hw: 'IT-Support::Hardware', x: 'Users' } } } as any);
    assert.equal((await draft(c, d)).status, 422, 'Auswahlwert führt in nicht erlaubte Gruppe');
    d.fields[1].mapping!.valueMap = { hw: 'IT-Support::Hardware', x: 'IT-Support' };
    assert.equal((await draft(c, d)).status, 200);
    d.fields.push({ id: 'frei', type: 'text', label: 'Gruppe frei', mapping: { target: 'group' } } as any);
    assert.equal((await draft(c, d)).status, 422, 'Gruppe aus Freitext');

    const ov = await c.get('/api/admin/overview');
    assert.ok(!ov.json.warnings.some((w: string) => w.includes('Zentrale IT')), 'keine Warnung mehr, wenn eine Allowlist gesetzt ist');
  });

  test('Zustellung: Altlast-Formular mit geschützten Feldern und fremder Gruppe wird abgefangen', async () => {
    setSystem({ allowed_groups: JSON.stringify(['IT-Support']) });
    const legacy = createForm(p.app, systemId, undefined, 'altlast');
    const def = {
      ...emptyDefinition(),
      fields: [
        { id: 'betreff', type: 'text', label: 'Betreff', required: true, mapping: { target: 'article' } },
        { id: 'besitzer', type: 'text', label: 'Besitzer', mapping: { target: 'zammad_field', name: 'owner_id' } },
        { id: 'status', type: 'text', label: 'Status', mapping: { target: 'zammad_field', name: 'state_id' } },
        { id: 'kst', type: 'text', label: 'Kostenstelle', mapping: { target: 'zammad_field', name: 'kostenstelle' } },
        { id: 'ort', type: 'text', label: 'Ort', mapping: { target: 'zammad_field', name: 'standort' } },
      ],
      settings: { ...emptyDefinition().settings, titleTemplate: 'Altlast {{betreff}}', group: 'Users' },
    } as FormDefinition;
    forceDefinition(legacy, def);
    const c = await entra();
    let r = await c.post(`/api/portal/forms/${legacy}/submit`, { values: { betreff: 'x', besitzer: '1', status: '4', kst: '4711', ort: 'nord' } });
    assert.equal(r.status, 422);
    assert.equal(r.json.code, 'group_not_allowed');

    def.settings.group = 'IT-Support';
    forceDefinition(legacy, def);
    r = await c.post(`/api/portal/forms/${legacy}/submit`, { values: { betreff: 'x', besitzer: '1', status: '4', kst: '4711', ort: 'nord' } });
    assert.equal(r.status, 201, r.text);
    assert.equal(await deliverNext(p.app), true);
    const body = lastCreate().body;
    assert.equal(body.group, 'IT-Support');
    assert.equal(body.standort, 'nord', 'freigegebenes Attribut kommt an');
    for (const k of ['owner_id', 'state_id', 'kostenstelle']) assert.ok(!(k in body), `${k} darf nicht im Ticket landen`);
    setSystem({ allowed_groups: '[]' });
  });

  test('Connector entfernt geschützte Schlüssel als letzte Linie', () => {
    assert.deepEqual(
      safeTicketFields({ owner_id: 1, state_id: 4, group_id: 9, organization_id: 3, customer_id: 7, tag_ids: [1], 'kaputt key': 1, Standort: 'x', standort: 'nord', dringend: true }),
      { standort: 'nord', dringend: true },
    );
  });
});

// ====================================================================================== #5
describe('#5 Zuordnung Portal-Benutzer → Zammad-Kunde über die ID', () => {
  test('X-On-Behalf-Of trägt immer die Kunden-ID, bei jeder Anfrage dieselbe', async () => {
    const c = await entra(ANNA);
    for (let i = 0; i < 2; i++) {
      const r = await c.post(`/api/portal/forms/${formId}/submit`, { values });
      assert.equal(r.status, 201, r.text);
      assert.equal(await deliverNext(p.app), true);
    }
    const anna = zammadUser('anna.becker@example.org');
    const behalf = p.zammad.state.requests.filter((x) => x.onBehalfOf).map((x) => x.onBehalfOf);
    assert.ok(behalf.length >= 2);
    assert.ok(behalf.every((v) => v === String(anna.id)), `nur IDs, keine E-Mail: ${[...new Set(behalf)].join(', ')}`);
  });

  test('ein neuer Kunde wird genau einmal angelegt, auch bei mehreren Anfragen', async () => {
    const c = await entra(ALEX);
    for (let i = 0; i < 3; i++) {
      assert.equal((await c.post(`/api/portal/forms/${formId}/submit`, { values })).status, 201);
      await deliverNext(p.app);
    }
    assert.equal(p.zammad.state.users.filter((u) => u.email.toLowerCase() === 'alex.berger@example.org').length, 1);
  });

  test('E-Mail-Suche unabhängig von Groß-/Kleinschreibung und Leerzeichen', async () => {
    const sys = getSystem(p.app, systemId)!;
    const anna = zammadUser('anna.becker@example.org');
    const ref = await connectorFor(p.app, sys).findCustomer('  ANNA.Becker@Example.ORG ');
    assert.equal(ref?.customerId, anna.id);
    // Teiltreffer (z. B. "anna.becker@example.org.evil") zählen nicht
    assert.equal(await connectorFor(p.app, sys).findCustomer('becker@example.org'), null);
  });

  test('Änderung der E-Mail-Adresse: Zuordnung bleibt beim selben Kunden', async () => {
    const c = await entra(ANNA);
    const before = (await c.get(`/api/portal/systems/${systemId}/tickets?refresh=1`)).json.tickets.length;
    assert.ok(before > 0);
    const row = p.app.db.get<{ id: string }>('SELECT id FROM users WHERE entra_oid = ?', ANNA.oid)!;
    p.app.db.run("UPDATE users SET email = 'anna.neu@example.org' WHERE id = ?", row.id);
    const after = (await c.get(`/api/portal/systems/${systemId}/tickets?refresh=1`)).json.tickets.length;
    assert.equal(after, before, 'Tickets bleiben sichtbar');
    assert.equal(p.zammad.state.users.filter((u) => u.email === 'anna.neu@example.org').length, 0, 'kein zweiter Kunde');
    p.app.db.run("UPDATE users SET email = 'anna.becker@example.org' WHERE id = ?", row.id);
  });
});

// ====================================================================================== #6
describe('#6 Absender in Antworten: keine E-Mail-Adressen, Agentennamen optional', () => {
  test('displaySender', () => {
    assert.equal(displaySender('Sabine Support <support@example.org>', 'Agent', 'Zentrale IT', false), 'Sabine Support');
    assert.equal(displaySender('"Support" <support@example.org>', 'Agent', 'Zentrale IT', false), 'Support');
    assert.equal(displaySender('support@example.org', 'Agent', 'Zentrale IT', false), 'Zentrale IT');
    assert.equal(displaySender('Sabine Support', 'Agent', 'Zentrale IT', true), 'Zentrale IT');
    assert.equal(displaySender('Anna Becker <anna@example.org>', 'Customer', 'Zentrale IT', true), 'Anna Becker');
  });

  test('Ticketansicht zeigt keine Adressen; mit Option erscheinen Antworten als Systemname', async () => {
    const anna = zammadUser('anna.becker@example.org');
    const t = p.zammad.state.tickets.find((x) => x.customer_id === anna.id)!;
    p.zammad.state.articles.push({ id: 7001, ticket_id: t.id, from: 'Sabine Support <support@example.org>', sender: 'Agent', body: '<p>Antwort</p>', content_type: 'text/html', internal: false, created_at: new Date().toISOString(), attachments: [] });
    const c = await entra(ANNA);
    let r = await c.get(`/api/portal/systems/${systemId}/tickets/${t.id}`);
    assert.equal(r.status, 200, r.text);
    assert.ok(r.json.articles.every((a: any) => !a.from.includes('@')), JSON.stringify(r.json.articles.map((a: any) => a.from)));
    assert.equal(r.json.articles.find((a: any) => a.id === 7001).from, 'Sabine Support');
    setSystem({ hide_agent_names: 1 });
    r = await c.get(`/api/portal/systems/${systemId}/tickets/${t.id}`);
    for (const a of r.json.articles) assert.equal(a.from === 'Zentrale IT', a.sender !== 'Customer', `${a.sender}: ${a.from}`);
    setSystem({ hide_agent_names: 0 });
  });
});

// ====================================================================================== #3
describe('#3 Zugriffskontrolle (IDOR)', () => {
  test('normaler Benutzer: jede Admin-Route 403', async () => {
    const c = await entra(ANNA);
    for (const path of ['/api/admin/overview', '/api/admin/systems', `/api/admin/systems/${systemId}/forms`, '/api/admin/users', '/api/admin/audit', '/api/admin/roles', '/api/admin/requests']) {
      const r = await c.get(path);
      assert.ok(r.status === 403 || r.status === 404, `${path}: ${r.status}`);
      assert.ok(!r.text.includes('test-token'), path);
    }
  });

  test('fremde Benutzer-ID oder Kunden-ID im Request wird ignoriert', async () => {
    const c = await entra(ANNA);
    const fremd = zammadUser('fremd@example.org');
    const alexRow = p.app.db.get<{ id: string }>('SELECT id FROM users WHERE entra_oid = ?', ALEX.oid)!;
    const r = await c.post(`/api/portal/forms/${formId}/submit`, { values, userId: alexRow.id, user_id: alexRow.id, customer_id: fremd.id, customer: { email: 'fremd@example.org' } });
    assert.equal(r.status, 201);
    const row = p.app.db.get<{ user_id: string }>('SELECT user_id FROM requests WHERE id = ?', r.json.id)!;
    assert.notEqual(row.user_id, alexRow.id);
    await deliverNext(p.app);
    assert.equal(lastCreate().body.customer_id, zammadUser('anna.becker@example.org').id);
  });

  test('nicht sichtbares Ticketsystem: 404 auf Tickets, Formulare und Anhänge', async () => {
    const hidden = createSystem(p.app, p.zammad.url, { slug: 'versteckt', name: 'Versteckt' });
    p.app.db.run("UPDATE ticket_systems SET visible_groups = '[\"grp-geheim\"]' WHERE id = ?", hidden);
    const hiddenForm = createForm(p.app, hidden, undefined, 'geheim');
    const c = await entra(ANNA);
    for (const path of [`/api/portal/systems/${hidden}/tickets`, `/api/portal/systems/${hidden}/forms`, `/api/portal/forms/${hiddenForm}`, `/api/portal/systems/${hidden}/tickets/100`, `/api/portal/systems/${hidden}/tickets/100/articles/1000/attachments/1`]) {
      assert.equal((await c.get(path)).status, 404, path);
    }
    assert.equal((await c.post(`/api/portal/forms/${hiddenForm}/submit`, { values })).status, 404);
    assert.ok(!(await c.get('/api/portal/systems')).json.systems.some((s: any) => s.id === hidden));
  });

  test('Tickets der Organisation nur, wenn eingeschaltet', async () => {
    const kollege = p.zammad.state.users.find((u) => u.email === 'kollege@example.org') ?? (() => {
      const u = { id: 777, login: 'kollege@example.org', email: 'kollege@example.org', firstname: 'Karl', lastname: 'Kollege', roles: ['Customer'], organization_id: 1 };
      p.zammad.state.users.push(u);
      return u;
    })();
    const now = new Date().toISOString();
    p.zammad.state.tickets.push({ id: 9001, number: '69001', title: 'Ticket des Kollegen', group_id: 2, state_id: 2, priority_id: 2, customer_id: kollege.id, organization_id: 1, created_at: now, updated_at: now, tags: [] });
    p.zammad.state.articles.push({ id: 9101, ticket_id: 9001, from: 'Karl Kollege', sender: 'Customer', body: '<p>Kollege</p>', content_type: 'text/html', internal: false, created_at: now, attachments: [] });
    const c = await entra(ANNA);
    const ids = async () => (await c.get(`/api/portal/systems/${systemId}/tickets?refresh=1`)).json.tickets.map((t: any) => t.id);
    assert.ok(!(await ids()).includes(9001), 'aus: nicht in der Liste');
    assert.equal((await c.get(`/api/portal/systems/${systemId}/tickets/9001`)).status, 404, 'aus: Detail 404');
    setSystem({ show_org_tickets: 1 });
    assert.ok((await ids()).includes(9001), 'an: in der Liste');
    assert.equal((await c.get(`/api/portal/systems/${systemId}/tickets/9001`)).status, 200);
    // Fremde Organisation bleibt tabu
    const fremdTicket = p.zammad.state.tickets.find((t) => t.title.startsWith('Geheimes'))!;
    assert.equal((await c.get(`/api/portal/systems/${systemId}/tickets/${fremdTicket.id}`)).status, 404);
    setSystem({ show_org_tickets: 0 });
  });

  test('interne Notizen erscheinen nie – auch nicht im Modus mit Agenten-Token', async () => {
    const anna = zammadUser('anna.becker@example.org');
    const t = p.zammad.state.tickets.find((x) => x.customer_id === anna.id && p.zammad.state.articles.some((a) => a.ticket_id === x.id && a.internal))!;
    const c = await entra(ANNA);
    for (const mode of ['on_behalf_of', 'customer_field']) {
      setSystem({ creation_mode: mode });
      const r = await c.get(`/api/portal/systems/${systemId}/tickets/${t.id}`);
      assert.equal(r.status, 200, `${mode}: ${r.text}`);
      assert.ok(!r.text.includes('Interne Notiz'), mode);
      assert.ok(!r.text.includes('4711'), mode);
    }
    setSystem({ creation_mode: 'on_behalf_of' });
  });

  test('Anhänge: fremdes Ticket, fremder Artikel, interne Notiz → 404', async () => {
    const anna = zammadUser('anna.becker@example.org');
    const own = p.zammad.state.tickets.find((x) => x.customer_id === anna.id)!;
    const ownArticles = p.zammad.state.articles.filter((a) => a.ticket_id === own.id);
    const fremd = p.zammad.state.tickets.find((t) => t.title.startsWith('Geheimes'))!;
    const fremdArticle = p.zammad.state.articles.find((a) => a.ticket_id === fremd.id)!;
    const file = (id: number) => ({ id, filename: `datei-${id}.txt`, size: 4, data: Buffer.from('test'), mime: 'text/plain' });
    fremdArticle.attachments.push(file(8001));
    ownArticles[0].attachments.push(file(8002));
    const internal = { id: 7002, ticket_id: own.id, from: 'Sabine Support', sender: 'Agent', body: '<p>intern</p>', content_type: 'text/html', internal: true, created_at: new Date().toISOString(), attachments: [file(8003)] };
    p.zammad.state.articles.push(internal);
    const c = await entra(ANNA);
    const url = (t: number, a: number, f: number) => `/api/portal/systems/${systemId}/tickets/${t}/articles/${a}/attachments/${f}`;
    assert.equal((await c.get(url(own.id, ownArticles[0].id, 8002))).status, 200, 'eigener Anhang');
    assert.equal((await c.get(url(fremd.id, fremdArticle.id, 8001))).status, 404, 'fremdes Ticket');
    assert.equal((await c.get(url(own.id, ownArticles[0].id, 8001))).status, 404, 'Anhang eines fremden Artikels über eigenes Ticket');
    assert.equal((await c.get(url(own.id, fremdArticle.id, 8001))).status, 404, 'fremder Artikel unter eigenem Ticket');
    assert.equal((await c.get(url(own.id, internal.id, 8003))).status, 404, 'Anhang einer internen Notiz');
  });
});

// ====================================================================================== #7
describe('#7 SSRF: Prüfung der aufgelösten Adresse bei jeder Verbindung', () => {
  const strict = { allowPrivate: false, allowLoopback: false };
  test('gesperrte Adressen und Namen', () => {
    for (const ip of ['127.0.0.1', '::1', '169.254.169.254', 'fd00:ec2::254', '0.0.0.0', '224.0.0.1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:169.254.169.254', '10.1.2.3', '192.168.1.1', '172.20.0.5', '100.64.0.1', 'fd12::1']) {
      assert.ok(blockedAddress(ip, strict), ip);
    }
    assert.equal(blockedAddress('10.1.2.3', { allowPrivate: true, allowLoopback: false }), null, 'interne Zammad-Server erlaubt');
    assert.ok(blockedAddress('169.254.169.254', { allowPrivate: true, allowLoopback: true }), 'Metadaten-Dienst immer gesperrt');
    assert.equal(blockedAddress('203.0.113.10', strict), null);
    for (const h of ['localhost', 'app', 'worker', 'caddy', 'clamav', 'socket-proxy', 'updater', 'APP.', 'x.localhost']) assert.ok(blockedHostname(h, strict), h);
    assert.equal(blockedHostname('zammad.example.org', strict), null);
  });

  test('Namensauflösung: ein Name, der auf Loopback zeigt, wird beim Verbinden abgelehnt (DNS-Rebinding)', async () => {
    const lookup = guardedLookup({ allowPrivate: true, allowLoopback: false });
    const err = await new Promise<Error | null>((resolve) => lookup('localhost', { all: true }, (e) => resolve(e)));
    assert.ok(err instanceof BlockedAddressError, String(err));
  });

  test('guardedFetch: Loopback gesperrt, Weiterleitungen werden nicht verfolgt', async () => {
    const server: Server = createHttpServer((req, res) => {
      if (req.url === '/weiter') { res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' }); res.end(); return; }
      res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      await assert.rejects(guardedFetch(strict)(`${base}/`), BlockedAddressError);
      const open = guardedFetch({ allowPrivate: true, allowLoopback: true });
      assert.deepEqual(await (await open(`${base}/`)).json(), { ok: true });
      await assert.rejects(open(`${base}/weiter`), /Weiterleitung/);
      await assert.rejects(open('http://user:pw@example.org/'), /Zugangsdaten/);
      await assert.rejects(open('file:///etc/passwd'), /http/);
    } finally {
      server.close();
    }
  });

  test('Speichern: eigene Dienstnamen werden als Ticketsystem-Adresse abgelehnt', async () => {
    const fake = { cfg: { env: 'development', allowPrivateTicketUrls: true, allowLoopbackTicketUrls: false } } as unknown as App;
    for (const url of ['http://clamav:3310', 'http://app:3000', 'http://socket-proxy:2375', 'http://localhost:3000', 'http://127.0.0.1', 'http://169.254.169.254']) {
      assert.ok(await validateSystemUrl(fake, url), url);
    }
  });
});

// ====================================================================================== #8
describe('#8 Uploads: Grenzen aus der Konfiguration, Scanner-Test', () => {
  test('UPLOAD_MAX_FILE_MB / UPLOAD_MAX_TOTAL_MB mit festen Obergrenzen', () => {
    const load = (env: Record<string, string>) => {
      const saved = { ...process.env };
      Object.assign(process.env, env);
      try { return loadConfig({ secretKey: randomBytes(32), env: 'test' }); } finally { process.env = saved; }
    };
    assert.deepEqual(load({ UPLOAD_MAX_FILE_MB: '5', UPLOAD_MAX_TOTAL_MB: '12' }).upload, { maxFileMb: 5, maxTotalMb: 12 });
    assert.throws(() => load({ UPLOAD_MAX_FILE_MB: '50' }), /UPLOAD_MAX_FILE_MB/);
    assert.throws(() => load({ UPLOAD_MAX_TOTAL_MB: '100' }), /UPLOAD_MAX_TOTAL_MB/);
    assert.throws(() => load({ UPLOAD_MAX_FILE_MB: '0' }), /UPLOAD_MAX_FILE_MB/);
  });

  test('Formular und Antwort halten die Grenze aus der Konfiguration ein', async () => {
    const saved = p.app.cfg.upload;
    p.app.cfg.upload = { maxFileMb: 1, maxTotalMb: 1 };
    try {
      const c = await entra(ANNA);
      const form = await c.get(`/api/portal/forms/${formId}`);
      assert.equal(form.json.definition.fields.find((f: any) => f.type === 'file').maxSizeMb, 1, 'Anzeige angepasst');
      const big = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(1.5 * 1024 * 1024, 0x20)]).toString('base64');
      const r = await c.post(`/api/portal/forms/${formId}/submit`, { values, files: { anhang: [{ name: 'gross.pdf', type: 'application/pdf', data: big }] } });
      assert.equal(r.status, 422);
      assert.match(r.json.error, /zu groß/);
    } finally {
      p.app.cfg.upload = saved;
    }
  });

  test('scanner:test erkennt einen Scanner, der nichts findet', async () => {
    const fake = (detect: boolean) => new Promise<{ port: number; close: () => void }>((resolve) => {
      const s = createTcpServer((sock) => {
        let buf = Buffer.alloc(0);
        sock.on('data', (d) => {
          buf = Buffer.concat([buf, d]);
          if (buf.subarray(-4).equals(Buffer.alloc(4))) sock.end(detect && buf.includes(Buffer.from('EICAR-STANDARD')) ? 'stream: Eicar-Test-Signature FOUND\0' : 'stream: OK\0');
        });
      });
      s.listen(0, '127.0.0.1', () => resolve({ port: (s.address() as AddressInfo).port, close: () => s.close() }));
    });
    const good = await fake(true);
    const blind = await fake(false);
    try {
      const app = (port: number | null) => ({ clamav: port ? new ClamAv('127.0.0.1', port, 2000) : null, cfg: { clamav: { required: true } } }) as unknown as App;
      assert.equal((await testScanner(app(good.port))).status, 'ok');
      assert.equal((await testScanner(app(blind.port))).status, 'not_detecting');
      assert.equal((await testScanner(app(null))).status, 'missing');
      assert.equal((await testScanner(app(1))).status, 'down');
      assert.ok(eicar().includes(Buffer.from('EICAR-STANDARD-ANTIVIRUS-TEST-FILE')));
    } finally { good.close(); blind.close(); }
  });
});

// ====================================================================================== #10
describe('#10 Sicherung prüfen und wiederherstellen', () => {
  function tempApp(dir: string, key: Buffer): App {
    return createApp(loadConfig({ env: 'test', dataDir: dir, secretKey: key, entra: { enabled: false } as any }));
  }

  test('Sicherung → Änderung → Wiederherstellung', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zsp-restore-'));
    const key = randomBytes(32);
    try {
      let app = tempApp(dir, key);
      createSystem(app, 'https://zammad.example.org', { slug: 'sicher', name: 'Gesichert' });
      await createUser(app, { username: 'vorher', password: PW });
      const backup = join(dir, 'sicherung.sqlite');
      app.db.backupTo(backup);
      await createUser(app, { username: 'nachher', password: PW });
      app.db.close();

      const ok = verifyBackup(backup, new SecretBox(key));
      assert.equal(ok.ok, true, ok.problems.join('; '));
      assert.equal(ok.keyMatches, true);
      const wrongKey = verifyBackup(backup, new SecretBox(randomBytes(32)));
      assert.equal(wrongKey.ok, false);
      assert.equal(wrongKey.keyMatches, false);

      const r = restoreBackup(dir, backup, new SecretBox(key));
      assert.ok(r.safetyCopy && existsSync(r.safetyCopy));
      assert.ok(!existsSync(join(dir, 'portal.sqlite-wal')), 'alte WAL-Datei entfernt');
      app = tempApp(dir, key);
      assert.ok(app.db.get("SELECT 1 FROM users WHERE username = 'vorher'"));
      assert.equal(app.db.get("SELECT 1 FROM users WHERE username = 'nachher'"), undefined, 'Änderung nach der Sicherung ist weg');
      app.db.close();
      const safety = verifyBackup(r.safetyCopy!, new SecretBox(key));
      assert.equal(safety.ok, true);
      assert.equal(safety.counts.users, 2, 'Sicherheitskopie enthält den Stand vor der Wiederherstellung');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('kaputte oder fremde Dateien werden nicht wiederhergestellt', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zsp-restore-'));
    try {
      const junk = join(dir, 'kaputt.sqlite');
      writeFileSync(junk, randomBytes(4096));
      assert.equal(verifyBackup(junk).ok, false);
      assert.equal(verifyBackup(join(dir, 'gibtsnicht.sqlite')).ok, false);
      assert.throws(() => restoreBackup(dir, junk), /nicht in Ordnung/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('CLI: backup:verify und restore liefern Exit-Codes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zsp-cli-'));
    const key = randomBytes(32);
    const env = { ...process.env, NODE_ENV: 'production', DATA_DIR: dir, SECRET_KEY: key.toString('base64'), CLAMAV_REQUIRED: 'false', LOG_LEVEL: 'error', ENTRA_TENANT_ID: '', ENTRA_CLIENT_ID: '' };
    const cli = (...args: string[]) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', join(ROOT, 'src/server/cli.ts'), ...args], { env, encoding: 'utf8' });
    try {
      assert.equal(cli('backup', '--out', join(dir, 'b.sqlite')).status, 0);
      const v = cli('backup:verify', join(dir, 'b.sqlite'));
      assert.equal(v.status, 0, v.stdout + v.stderr);
      assert.match(v.stdout, /Schlüssel: (passt|nicht geprüft)/);
      writeFileSync(join(dir, 'x.sqlite'), 'kein sqlite');
      assert.equal(cli('backup:verify', join(dir, 'x.sqlite')).status, 2);
      assert.equal(cli('restore', join(dir, 'b.sqlite')).status, 64, 'ohne --yes passiert nichts');
      const r = cli('restore', join(dir, 'b.sqlite'), '--yes');
      assert.equal(r.status, 0, r.stdout + r.stderr);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ====================================================================================== #11
describe('#11 Zustellung (Outbox): Neustart, Absturz, Ausfall', () => {
  const submit = async () => {
    const c = await entra(ANNA);
    const r = await c.post(`/api/portal/forms/${formId}/submit`, { values: { ...values, betreff: `Outbox ${uuid().slice(0, 8)}` } });
    assert.equal(r.status, 201, r.text);
    return r.json as { id: string; title: string };
  };
  const req = (id: string) => p.app.db.get<{ status: string; attempts: number; next_attempt_at: number; ticket_number: string | null; payload: string | null; last_error: string | null }>('SELECT * FROM requests WHERE id = ?', id)!;
  const ticketsTitled = (title: string) => p.zammad.state.tickets.filter((t) => t.title === title).length;

  test('Neustart: eine neue App-Instanz auf denselben Daten stellt die wartende Anfrage zu', async () => {
    setSystem({ status: 'maintenance' });
    const r = await submit();
    assert.equal(await deliverNext(p.app), true);
    assert.equal(req(r.id).status, 'queued', 'Wartung: bleibt in der Warteschlange');
    setSystem({ status: 'active' });
    p.app.db.run('UPDATE requests SET next_attempt_at = 0 WHERE id = ?', r.id);
    const restarted = createApp(p.cfg);
    try {
      assert.equal(await deliverNext(restarted), true);
    } finally { restarted.db.close(); }
    assert.equal(req(r.id).status, 'delivered');
    assert.equal(ticketsTitled(r.title), 1);
  });

  test('Absturz während der Zustellung: hängende Anfrage wird nach 5 Minuten erneut zugestellt', async () => {
    const r = await submit();
    // Zustand wie nach einem Absturz: als "sending" markiert, Versuch gezählt, aber nie angekommen
    p.app.db.run("UPDATE requests SET status = 'sending', attempts = 1, next_attempt_at = ? WHERE id = ?", Date.now() - 6 * 60_000, r.id);
    assert.equal(await deliverNext(p.app), true);
    assert.equal(req(r.id).status, 'delivered');
    assert.equal(ticketsTitled(r.title), 1);
  });

  test('Antwort geht verloren (Ticket schon angelegt): kein zweites Ticket beim nächsten Versuch', async () => {
    const r = await submit();
    p.zammad.loseNextCreateResponse(1);
    assert.equal(await deliverNext(p.app), true);
    assert.equal(req(r.id).status, 'queued');
    assert.equal(ticketsTitled(r.title), 1, 'Zammad hat das Ticket angelegt');
    p.app.db.run('UPDATE requests SET next_attempt_at = 0 WHERE id = ?', r.id);
    assert.equal(await deliverNext(p.app), true);
    const row = req(r.id);
    assert.equal(row.status, 'delivered');
    assert.equal(ticketsTitled(r.title), 1, 'kein Duplikat');
    assert.equal(row.ticket_number, p.zammad.state.tickets.find((t) => t.title === r.title)!.number);
  });

  test('langer Ausfall: Wartezeiten wachsen bis 1 Stunde, nach 20 Versuchen „fehlgeschlagen“, danach erneut zustellbar', async () => {
    const r = await submit();
    p.zammad.failNext(10_000, 503);
    const delays: number[] = [];
    for (let i = 0; i < 25 && req(r.id).status === 'queued'; i++) {
      p.app.db.run('UPDATE requests SET next_attempt_at = 0 WHERE id = ?', r.id);
      const start = Date.now();
      await deliverNext(p.app);
      const row = req(r.id);
      if (row.status === 'queued') delays.push(Math.round((row.next_attempt_at - start) / 1000));
    }
    p.zammad.failNext(0);
    const row = req(r.id);
    assert.equal(row.status, 'failed');
    assert.equal(row.attempts, 20);
    assert.ok(row.payload, 'Inhalt bleibt für die erneute Zustellung erhalten');
    for (let i = 1; i < delays.length; i++) assert.ok(delays[i] >= delays[i - 1], `Wartezeit wächst: ${delays.join(',')}`);
    assert.ok(Math.max(...delays) <= 3600 + 1, 'höchstens 1 Stunde');
    assert.equal(delays[0], 60);
    assert.equal(retryRequest(p.app, r.id), true);
    assert.equal(await deliverNext(p.app), true);
    assert.equal(req(r.id).status, 'delivered');
    assert.equal(ticketsTitled(r.title), 1);
  });
});

// ====================================================================================== #12
describe('#12 Step-up über Entra übernimmt Gruppen und Sperren', () => {
  async function stepup(c: Client) {
    const s = await c.post('/api/auth/stepup', { returnTo: '/admin' });
    assert.equal(s.status, 200, s.text);
    const start = await c.get(s.json.redirect);
    assert.equal(start.status, 302);
    const authorize = await fetch(start.headers.get('location')!, { redirect: 'manual' });
    const cb = new URL(authorize.headers.get('location')!);
    return c.get(cb.pathname + cb.search);
  }

  test('entzogene Admin-Gruppe: nach dem Step-up keine Admin-Rechte mehr', async () => {
    const role = p.app.db.get<{ id: string }>("SELECT id FROM roles WHERE name = 'Ziel-Admin'")!;
    p.app.db.run("INSERT INTO role_assignments (id, role_id, subject_type, subject_value, system_id, created_at) VALUES (?, ?, 'group', 'it-admins', ?, ?)", uuid(), role.id, systemId, Date.now());
    const saved = [...BEN.groups!];
    try {
      const c = await entra(BEN);
      assert.equal((await c.get('/api/admin/systems')).status, 200, 'Gruppe it-admins → Ziel-Admin');
      BEN.groups = ['grp-mitarbeiter']; // in Entra aus der Gruppe entfernt
      const r = await stepup(c);
      assert.equal(r.status, 302);
      assert.notEqual(r.headers.get('location'), '/login?fehler=sso');
      assert.equal((await c.get('/api/admin/systems')).status, 403, 'Rechte sind sofort weg');
    } finally {
      BEN.groups = saved;
    }
  });

  test('im Portal deaktiviert, während Microsoft bestätigt: Step-up schlägt fehl, keine Sitzung bleibt nutzbar', async () => {
    const other = await entra(ALEX); // zweite Sitzung auf einem anderen Gerät
    const c = await entra(ALEX);
    const s = await c.post('/api/auth/stepup', { returnTo: '/' });
    const start = await c.get(s.json.redirect);
    const authorize = await fetch(start.headers.get('location')!, { redirect: 'manual' });
    p.app.db.run('UPDATE users SET disabled = 1 WHERE entra_oid = ?', ALEX.oid);
    const cb = new URL(authorize.headers.get('location')!);
    const r = await c.get(cb.pathname + cb.search);
    assert.equal(r.headers.get('location'), '/login?fehler=sso');
    assert.equal((await c.get('/api/me')).status, 401);
    assert.equal((await other.get('/api/me')).status, 401);
    p.app.db.run('UPDATE users SET disabled = 0 WHERE entra_oid = ?', ALEX.oid);
  });
});

// ====================================================================================== #13
describe('#13 Überwachung: Alarm bei lokaler Anmeldung, Status-Befehl', () => {
  test('jede lokale Anmeldung erzeugt einen Log-Eintrag mit alert=true', async () => {
    const seen: Record<string, unknown>[] = [];
    const off = onLog((e) => seen.push(e));
    try {
      await admin();
    } finally { off(); }
    const hit = seen.find((e) => e.event === 'local_login');
    assert.ok(hit, JSON.stringify(seen));
    assert.equal(hit!.alert, true);
    assert.equal(hit!.username, 'sa');
    assert.ok(!JSON.stringify(seen).includes(PW), 'kein Passwort im Log');
  });

  test('collectStatus meldet alte Warteschlange, Fehlschläge und Scanner', async () => {
    let s = await collectStatus(p.app, { maxQueueAgeMinutes: 30, maxFailed: 1000 });
    assert.equal(s.scanner.status, 'missing');
    assert.ok(s.warnings.some((w) => w.includes('Virenscanner')), 'Scanner nicht Pflicht im Test → nur Hinweis');
    const id = uuid();
    const user = p.app.db.get<{ id: string }>('SELECT id FROM users LIMIT 1')!.id;
    const form = p.app.db.get<{ id: string }>('SELECT id FROM forms LIMIT 1')!.id;
    const version = p.app.db.get<{ id: string }>('SELECT id FROM form_versions LIMIT 1')!.id;
    p.app.db.run("INSERT INTO requests (id, user_id, system_id, form_id, form_version_id, title, payload, status, attempts, next_attempt_at, created_at) VALUES (?, ?, ?, ?, ?, 'alt', NULL, 'queued', 3, ?, ?)",
      id, user, systemId, form, version, Date.now() + 3600_000, Date.now() - 2 * 3600_000);
    s = await collectStatus(p.app, { maxQueueAgeMinutes: 30, maxFailed: 1000 });
    assert.equal(s.ok, false);
    assert.ok(s.outbox.oldestQueuedMinutes! >= 119);
    assert.ok(s.problems.some((x) => x.includes('wartet seit')));
    p.app.db.run('DELETE FROM requests WHERE id = ?', id);
  });

  test('CLI status: Exit-Code 0 bei OK, 2 bei Problemen, --json maschinenlesbar', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zsp-status-'));
    const env = { ...process.env, NODE_ENV: 'production', DATA_DIR: dir, SECRET_KEY: randomBytes(32).toString('base64'), CLAMAV_REQUIRED: 'false', LOG_LEVEL: 'error', ENTRA_TENANT_ID: '', ENTRA_CLIENT_ID: '' };
    const cli = (...args: string[]) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', join(ROOT, 'src/server/cli.ts'), ...args], { env, encoding: 'utf8' });
    try {
      const ok = cli('status', '--json');
      assert.equal(ok.status, 0, ok.stdout + ok.stderr);
      assert.equal(JSON.parse(ok.stdout).ok, true);
      const bad = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', join(ROOT, 'src/server/cli.ts'), 'status'], { env: { ...env, CLAMAV_REQUIRED: 'true' }, encoding: 'utf8' });
      assert.equal(bad.status, 2, 'Pflicht-Scanner fehlt → Problem');
      assert.match(bad.stdout, /PROBLEM/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// Kleiner Sicherheitsgurt für die Doku: alle neuen Befehle stehen in der Hilfe der CLI
test('CLI-Hilfe nennt die neuen Befehle', () => {
  const head = execFileSync('sed', ['-n', '1,20p', join(ROOT, 'src/server/cli.ts')], { encoding: 'utf8' });
  for (const cmd of ['backup:verify', 'restore', 'status', 'scanner:test']) assert.ok(head.includes(cmd), cmd);
  void sleep;
});
