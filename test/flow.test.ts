// Ende-zu-Ende: Anmeldung, Formular, Ticket in Zammad, eigene Tickets ansehen, antworten.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startPortal, Client, createSystem, createForm, ENTRA_USERS, TENANT_B, type Portal } from './helpers.ts';
import { deliverNext } from '../src/server/services/requests.ts';

let p: Portal;
let systemId: string;
let formId: string;

before(async () => {
  p = await startPortal();
  systemId = createSystem(p.app, p.zammad.url);
  formId = createForm(p.app, systemId);
});
after(async () => { await p.close(); });

test('Entra-Anmeldung legt Benutzer an und öffnet eine Sitzung', async () => {
  const c = new Client(p.url);
  const r = await c.loginEntra(p, ENTRA_USERS[0].oid, '/tickets');
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/tickets');
  const me = await c.get('/api/me');
  assert.equal(me.status, 200);
  assert.equal(me.json.user.displayName, 'Anna Becker');
  assert.equal(me.json.user.department, 'Vertrieb');
  assert.equal(me.json.state, 'active');
});

test('Benutzer aus dem zweiten Tenant (Vertrauensstellung) kann sich anmelden', async () => {
  const c = new Client(p.url);
  await c.loginEntra(p, ENTRA_USERS[1].oid);
  const me = await c.get('/api/me');
  assert.equal(me.status, 200);
  assert.equal(me.json.user.email, 'ben.krause@example.org');
  const row = p.app.db.get<{ tenant_id: string }>('SELECT tenant_id FROM users WHERE email = ?', 'ben.krause@example.org');
  assert.equal(row?.tenant_id, TENANT_B);
});

test('Formular absenden → Ticket in Zammad mit Tag, Attributen und Anhang', async () => {
  const c = new Client(p.url);
  await c.loginEntra(p, ENTRA_USERS[0].oid);
  const systems = await c.get('/api/portal/systems');
  assert.equal(systems.json.systems.length, 1);
  const forms = await c.get(`/api/portal/systems/${systemId}/forms`);
  assert.equal(forms.json.forms[0].id, formId);
  const form = await c.get(`/api/portal/forms/${formId}`);
  const standort = form.json.definition.fields.find((f: any) => f.id === 'standort');
  assert.equal(standort.type, 'select');
  assert.deepEqual(standort.options.map((o: any) => o.value), ['nord', 'sued', 'homeoffice']);
  const kategorie = form.json.definition.fields.find((f: any) => f.id === 'kategorie');
  assert.ok(kategorie.options.some((o: any) => o.value === 'Hardware::Laptop' && o.label === 'Hardware › Laptop'));

  const pdf = Buffer.from('%PDF-1.4\n%Test\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');
  const r = await c.post(`/api/portal/forms/${formId}/submit`, {
    values: { betreff: 'Laptop startet nicht', beschreibung: 'Seit heute <b>schwarz</b>', standort: 'nord', kategorie: 'Hardware::Laptop' },
    files: { anhang: [{ name: 'fehler.pdf', type: 'application/pdf', data: pdf.toString('base64') }] },
  });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.json.title, 'Störung: Laptop startet nicht');

  assert.equal(await deliverNext(p.app), true);
  const req = p.app.db.get<{ status: string; ticket_number: string; payload: string | null }>('SELECT status, ticket_number, payload FROM requests WHERE id = ?', r.json.id)!;
  assert.equal(req.status, 'delivered');
  assert.equal(req.payload, null, 'Inhalt wird nach Zustellung gelöscht');

  const ticket = p.zammad.state.tickets.find((t) => t.number === req.ticket_number)!;
  assert.equal(ticket.title, 'Störung: Laptop startet nicht');
  assert.deepEqual(ticket.tags.sort(), ['service-portal', 'stoerung']);
  assert.equal(ticket.standort, 'nord');
  assert.equal(ticket.sec_status, 'Hardware::Laptop');
  const article = p.zammad.state.articles.find((a) => a.ticket_id === ticket.id)!;
  assert.match(article.body, /Seit heute &lt;b&gt;schwarz&lt;\/b&gt;/, 'Eingaben werden HTML-escaped');
  assert.equal(article.attachments[0].filename, 'fehler.pdf');
  const create = p.zammad.state.requests.find((x) => x.method === 'POST' && x.path === '/api/v1/tickets')!;
  // X-On-Behalf-Of trägt die Zammad-ID des Kunden, nicht die E-Mail-Adresse
  const anna = p.zammad.state.users.find((u) => u.email === 'anna.becker@example.org')!;
  assert.equal(create.onBehalfOf, String(anna.id));
  assert.equal(ticket.customer_id, anna.id);
});

test('Meine Tickets: nur eigene, ohne interne Notizen; Antwort landet in Zammad', async () => {
  const c = new Client(p.url);
  await c.loginEntra(p, ENTRA_USERS[0].oid);
  const list = await c.get(`/api/portal/systems/${systemId}/tickets?refresh=1`);
  assert.equal(list.status, 200);
  assert.ok(list.json.tickets.length >= 2);
  assert.ok(list.json.tickets.every((t: any) => !t.closed));
  assert.ok(!list.json.tickets.some((t: any) => t.title.includes('Geheim')));
  const closed = await c.get(`/api/portal/systems/${systemId}/tickets?overview=${list.json.overviews[1].id}`);
  assert.ok(closed.json.tickets.every((t: any) => t.closed));

  const printer = list.json.tickets.find((t: any) => t.title.startsWith('Drucker'));
  const detail = await c.get(`/api/portal/systems/${systemId}/tickets/${printer.id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.json.articles.length, 2, 'interne Notiz ist nicht sichtbar');
  assert.equal(detail.json.articles[1].text, 'Hallo, wir haben den Toner bestellt. Er kommt morgen.');

  const reply = await c.post(`/api/portal/systems/${systemId}/tickets/${printer.id}/reply`, { text: 'Danke!\nGruß Anna' });
  assert.equal(reply.status, 200, reply.text);
  const last = p.zammad.state.articles.filter((a) => a.ticket_id === printer.id).at(-1)!;
  assert.equal(last.body, 'Danke!<br>Gruß Anna');
  assert.equal(last.sender, 'Customer');
});

test('Zammad nicht erreichbar → Anfrage bleibt in der Warteschlange und wird später zugestellt', async () => {
  const c = new Client(p.url);
  await c.loginEntra(p, ENTRA_USERS[2].oid);
  const r = await c.post(`/api/portal/forms/${formId}/submit`, { values: { betreff: 'Test Ausfall', beschreibung: 'x', standort: 'homeoffice' } });
  assert.equal(r.status, 201);
  p.zammad.failNext(1, 503);
  await deliverNext(p.app);
  let row = p.app.db.get<{ status: string; attempts: number; last_error: string }>('SELECT status, attempts, last_error FROM requests WHERE id = ?', r.json.id)!;
  assert.equal(row.status, 'queued');
  assert.match(row.last_error, /503/);
  p.app.db.run('UPDATE requests SET next_attempt_at = 0 WHERE id = ?', r.json.id);
  await deliverNext(p.app);
  row = p.app.db.get<{ status: string; attempts: number; last_error: string }>('SELECT status, attempts, last_error FROM requests WHERE id = ?', r.json.id)!;
  assert.equal(row.status, 'delivered');
});
