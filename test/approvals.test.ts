// Freigabe durch Vorgesetzte (ab 2.0 im Ticket): Ablauf, Sicherheit, Fristen, Benachrichtigungen.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startPortal, Client, createSystem, createForm, createUser, ENTRA_USERS, type Portal } from './helpers.ts';
import { deliverNext } from '../src/server/services/requests.ts';
import { approvalHousekeeping, berlinDay } from '../src/server/services/approvals.ts';
import { applySetup } from '../src/server/services/zammad-setup.ts';
import { getSystem } from '../src/server/services/systems.ts';
import { notify, registerChannel } from '../src/server/services/notifications.ts';
import { emptyDefinition } from '../src/server/services/forms.ts';
import { validateDefinition, validateSubmission, type FormDefinition } from '../src/shared/form.ts';
import { Db } from '../src/server/db/db.ts';

const [, , ALEX] = ENTRA_USERS;
let p: Portal;
let systemId: string;
let formId: string;
let knownOnlyFormId: string;
const anna = () => login(ENTRA_USERS[0]!.oid);
const ben = () => login(ENTRA_USERS[1]!.oid);
const alex = () => login(ALEX!.oid);

async function login(oid: string): Promise<Client> {
  const c = new Client(p.url);
  await c.loginEntra(p, oid);
  return c;
}

function softwareForm(knownOnly = false): FormDefinition {
  return {
    ...emptyDefinition(),
    fields: [
      { id: 'programm', type: 'text', label: 'Programm', required: true },
      { id: 'lizenz', type: 'select', label: 'Lizenz', required: true, options: [{ value: 'frei', label: 'kostenlos' }, { value: 'kosten', label: 'kostenpflichtig' }] },
      { id: 'anhang', type: 'file', label: 'Angebot', maxFiles: 1, accept: ['pdf'] },
      { id: 'chef', type: 'approver', label: 'Wer gibt frei?', visibleIf: { field: 'lizenz', op: 'eq', value: 'kosten' }, knownOnly: knownOnly || undefined, mapping: { target: 'article' } },
    ],
    settings: { ...emptyDefinition().settings, titleTemplate: 'Software: {{programm}}', group: 'IT-Support', tags: ['software'] },
  } as FormDefinition;
}

const PDF = Buffer.from('%PDF-1.4\n%Test\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');

async function ask(c: Client, approver: string, extra: Record<string, unknown> = {}, form = formId) {
  return c.post(`/api/portal/forms/${form}/submit`, {
    values: { programm: 'Grafikprogramm', lizenz: 'kosten', chef: approver, ...extra },
    files: { anhang: [{ name: 'angebot.pdf', type: 'application/pdf', data: PDF.toString('base64') }] },
  });
}

const requestRow = (id: string) => p.app.db.get<{ status: string; payload: string | null; ticket_id: number | null; ticket_number: string | null; title: string }>('SELECT status, payload, ticket_id, ticket_number, title FROM requests WHERE id = ?', id)!;
const deliverAll = async () => { while (await deliverNext(p.app)) { /* zustellen */ } };
/** Anfrage stellen, zustellen, Ticket und Kennung der Freigabe liefern */
async function asked(c: Client, approver: string, extra: Record<string, unknown> = {}) {
  const r = await ask(c, approver, extra);
  assert.equal(r.status, 201, r.text);
  await deliverAll();
  const row = requestRow(r.json.id);
  const ticket = p.zammad.state.tickets.find((t) => t.id === row.ticket_id)!;
  return { id: r.json.id as string, ticket, ref: `${systemId}.${ticket.id}` };
}
const stateName = (t: { state_id: number }) => p.zammad.state.states.find((s) => s.id === t.state_id)!.name;
const articlesOf = (id: number) => p.zammad.state.articles.filter((a) => a.ticket_id === id);

before(async () => {
  p = await startPortal();
  systemId = createSystem(p.app, p.zammad.url);
  formId = createForm(p.app, systemId, softwareForm(), 'software');
  knownOnlyFormId = createForm(p.app, systemId, softwareForm(true), 'software-bekannt');
  // Das Portal richtet Zammad ein: Status „wartet auf Freigabe“ und Attribute
  const setup = await applySetup(p.app, getSystem(p.app, systemId)!);
  assert.equal(setup.ready, true, JSON.stringify(setup));
  // Alle drei einmal anmelden, damit sie dem Portal bekannt sind
  await anna(); await ben(); await alex();
});
after(async () => { await p.close(); });

test('Formular-Schema: Freigabe-Feld ist Pflicht sobald sichtbar, höchstens eins, nur Tickettext', () => {
  const def = softwareForm();
  assert.deepEqual(validateDefinition(def), []);
  assert.match(validateDefinition({ ...def, fields: [...def.fields, { id: 'chef2', type: 'approver', label: 'Noch einer' }] }).join(), /nur ein Feld/);
  assert.match(validateDefinition({ ...def, fields: def.fields.map((f) => f.type === 'approver' ? { ...f, mapping: { target: 'tag' as const } } : f) }).join(), /nur in den Tickettext/);
  assert.equal(validateSubmission(def, { programm: 'x', lizenz: 'kosten' }).errors.chef, 'Bitte die freigebende Person angeben');
  assert.equal(validateSubmission(def, { programm: 'x', lizenz: 'frei' }).ok, true, 'unsichtbar → keine Freigabe nötig');
  assert.match(validateSubmission(def, { programm: 'x', lizenz: 'kosten', chef: 'kein-mail' }).errors.chef, /E-Mail-Adresse/);
  assert.equal(validateSubmission(def, { programm: 'x', lizenz: 'kosten', chef: ' Alex.Berger@Example.org ' }).values.chef, 'alex.berger@example.org');
});

test('Anfrage mit Freigabe: Ticket sofort in Zammad („wartet auf Freigabe“), Entscheidung im Portal schreibt ins Ticket', async () => {
  const a = await anna();
  const r = await ask(a, 'alex.berger@example.org');
  assert.equal(r.status, 201, r.text);
  assert.deepEqual(r.json.approval, { email: 'alex.berger@example.org', name: 'Alex Berger', known: true });
  assert.equal(requestRow(r.json.id).status, 'queued', 'geht sofort in die Zustellung');
  await deliverAll();
  const row = requestRow(r.json.id);
  assert.equal(row.status, 'delivered');
  assert.equal(row.payload, null);
  assert.notEqual(row.title, 'Software: Grafikprogramm', 'Titel liegt nur noch in Zammad');
  const ticket = p.zammad.state.tickets.find((t) => t.id === row.ticket_id)!;
  assert.equal(stateName(ticket), 'wartet auf Freigabe');
  assert.equal(ticket.portal_freigabe, 'ausstehend');
  assert.equal(ticket.portal_freigabe_durch, 'alex.berger@example.org');
  assert.equal(ticket.portal_freigabe_bis, berlinDay(Date.now() + 14 * 86400_000));
  assert.equal(ticket.portal_formular, formId);
  assert.ok(!ticket.tags.includes('freigegeben'));
  // Zammad schickt die E-Mail an die freigebende Person (Link ins Portal)
  const mail = articlesOf(ticket.id).find((x) => x.type === 'email')!;
  assert.equal(mail.to, 'alex.berger@example.org');
  assert.match(mail.body, new RegExp(`/freigaben/${systemId}\\.${ticket.id}`));
  const ref = `${systemId}.${ticket.id}`;

  // Anna sieht den Stand live aus Zammad
  const mine = await a.get('/api/portal/requests');
  const entry = mine.json.requests.find((x: any) => x.id === r.json.id);
  assert.equal(entry.status, 'awaiting_approval');
  assert.equal(entry.title, 'Software: Grafikprogramm');
  assert.equal(entry.approval.approverName, 'Alex Berger');
  assert.equal(entry.approval.status, 'pending');

  // Alex: Glocke und Freigaben
  const x = await alex();
  const count = await x.get('/api/portal/notifications/count');
  assert.ok(count.json.unread >= 1);
  assert.ok(count.json.approvalsOpen >= 1);
  const list = await x.get('/api/portal/approvals');
  const item = list.json.approvals.find((i: any) => i.id === ref);
  assert.ok(item, JSON.stringify(list.json));
  assert.equal(item.status, 'pending');
  assert.equal(item.requesterName, 'Anna Becker');
  assert.equal(item.ticketNumber, ticket.number);
  const detail = await x.get(`/api/portal/approvals/${ref}`);
  assert.equal(detail.status, 200, detail.text);
  assert.equal(detail.json.summary.requester.email, 'anna.becker@example.org');
  assert.deepEqual(detail.json.summary.fields.map((f: any) => f.label), ['Programm', 'Lizenz']);
  assert.equal(detail.json.files[0].filename, 'angebot.pdf');
  const file = await x.get(`/api/portal/approvals/${ref}/files/${detail.json.files[0].id}`);
  assert.equal(file.status, 200);
  assert.match(file.text, /%PDF/);

  // Freigeben → Status „new“, Attribute, Tag, Notiz, E-Mail an Anna
  const ok = await x.post(`/api/portal/approvals/${ref}/approve`, { comment: 'Kostenstelle <4711>' });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(stateName(ticket), 'new');
  assert.equal(ticket.portal_freigabe, 'genehmigt');
  assert.ok(ticket.portal_freigabe_am);
  assert.ok(ticket.tags.includes('freigegeben'));
  const note = articlesOf(ticket.id).find((art) => art.subject === 'Freigegeben')!;
  assert.match(note.body, /Freigegeben<\/strong> von Alex Berger \(alex\.berger@example\.org\)/);
  assert.match(note.body, /Kostenstelle &lt;4711&gt;/, 'Hinweis wird escaped');
  assert.equal(note.internal, false);
  assert.ok(articlesOf(ticket.id).some((art) => art.type === 'email' && art.to === 'anna.becker@example.org'));
  assert.equal((await x.post(`/api/portal/approvals/${ref}/approve`, {})).status, 409, 'nur einmal entscheiden');

  // Anna wird benachrichtigt; Alex' Hinweis gilt als gelesen
  const n = await a.get('/api/portal/notifications');
  assert.ok(n.json.notifications.some((m: any) => m.kind === 'approval.approved' && m.title === 'Freigegeben: Software: Grafikprogramm' && !m.read));
  const alexN = await x.get('/api/portal/notifications');
  assert.ok(alexN.json.notifications.filter((m: any) => m.link === `/freigaben/${ref}`).every((m: any) => m.read));
  const done = await x.get('/api/portal/approvals?status=done');
  assert.equal(done.json.approvals.find((i: any) => i.id === ref).status, 'approved');
  // Nach der Entscheidung zeigt das Portal den Inhalt nicht mehr
  assert.equal((await x.get(`/api/portal/approvals/${ref}`)).json.summary, null);
  assert.ok(p.app.db.get("SELECT 1 FROM audit_log WHERE action = 'approval.approved' AND target_id = ?", ref));
  assert.ok(p.app.db.get("SELECT 1 FROM audit_log WHERE action = 'approval.requested' AND target_id = ?", r.json.id));
  assert.equal(p.app.db.get<{ n: number }>('SELECT COUNT(*) n FROM approvals')!.n, 0, 'nichts mehr in der alten Tabelle');
});

test('Ohne sichtbares Freigabe-Feld: normales Ticket ohne Freigabe-Angaben', async () => {
  const a = await anna();
  const r = await a.post(`/api/portal/forms/${formId}/submit`, { values: { programm: 'Editor', lizenz: 'frei', chef: 'alex.berger@example.org' }, files: {} });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.json.approval, null);
  await deliverAll();
  const t = p.zammad.state.tickets.find((x) => x.id === requestRow(r.json.id).ticket_id)!;
  assert.equal(stateName(t), 'new');
  assert.equal(t.portal_freigabe, undefined);
  assert.equal(t.portal_formular, formId);
});

test('Ablehnen: Begründung nötig; Ticket geschlossen, Anna per E-Mail und Glocke informiert', async () => {
  const a = await anna();
  const { id, ticket, ref } = await asked(a, 'alex.berger@example.org', { programm: 'Spiel' });
  const x = await alex();
  assert.equal((await x.post(`/api/portal/approvals/${ref}/reject`, { comment: '  ' })).status, 422);
  assert.equal((await x.post(`/api/portal/approvals/${ref}/reject`, { comment: 'x'.repeat(2001) })).status, 422);
  const no = await x.post(`/api/portal/approvals/${ref}/reject`, { comment: 'Nicht dienstlich' });
  assert.equal(no.status, 200, no.text);
  assert.equal(stateName(ticket), 'closed');
  assert.equal(ticket.portal_freigabe, 'abgelehnt');
  assert.ok(articlesOf(ticket.id).some((art) => art.type === 'email' && art.to === 'anna.becker@example.org' && /Nicht dienstlich/.test(art.body)));
  const e = (await a.get('/api/portal/requests')).json.requests.find((q: any) => q.id === id);
  assert.equal(e.status, 'rejected');
  assert.ok((await a.get('/api/portal/notifications')).json.notifications.some((m: any) => m.kind === 'approval.rejected' && /Nicht dienstlich/.test(m.body)));
  assert.ok(!(await a.get(`/api/portal/systems/${systemId}/tickets`)).json.pending.some((q: any) => q.id === id));
});

test('Sicherheit: nur die eingetragene Person sieht und entscheidet – sonst 404', async () => {
  const a = await anna();
  const { id, ticket, ref } = await asked(a, 'alex.berger@example.org', { programm: 'Fremdzugriff' });
  const b = await ben();
  for (const res of [
    await b.get(`/api/portal/approvals/${ref}`),
    await b.post(`/api/portal/approvals/${ref}/approve`, {}),
    await b.post(`/api/portal/approvals/${ref}/reject`, { comment: 'nein' }),
    await a.get(`/api/portal/approvals/${ref}`),
    await a.post(`/api/portal/approvals/${ref}/approve`, {}),
  ]) assert.equal(res.status, 404);
  const first = articlesOf(ticket.id)[0]!;
  assert.equal((await b.get(`/api/portal/approvals/${ref}/files/${first.id}-${first.attachments[0]!.id}`)).status, 404);
  assert.ok(!(await b.get('/api/portal/approvals')).json.approvals.some((x: any) => x.id === ref));
  // Fremde dürfen die Anfrage weder zurückziehen noch umleiten
  assert.equal((await b.post(`/api/portal/requests/${id}/withdraw`)).status, 404);
  assert.equal((await b.post(`/api/portal/requests/${id}/approver`, { email: 'ben.krause@example.org' })).status, 404);
  // Ungültige Kennungen, fremde Tickets
  assert.equal((await b.get('/api/portal/approvals/..%2F..%2Fetc')).status, 404);
  assert.equal((await b.get(`/api/portal/approvals/${systemId}.99999`)).status, 404);
  const x = await alex();
  const other = p.zammad.state.tickets.find((t) => t.title === 'Geheimes Ticket einer anderen Person')!;
  assert.equal((await x.get(`/api/portal/approvals/${systemId}.${other.id}`)).status, 404, 'Ticket ohne Freigabe');
  // Anhänge anderer Nachrichten gibt es nicht über die Freigabe
  const x2 = await x.get(`/api/portal/approvals/${ref}/files/1-1`);
  assert.equal(x2.status, 404);

  // Lokales Konto mit der Adresse eines Microsoft-Kontos bekommt weder Freigabe noch Benachrichtigung
  await createUser(p.app, { username: 'falscher-alex', email: 'alex.berger@example.org' });
  const local = new Client(p.url);
  await local.loginLocal('falscher-alex', 'Test-Passwort-123!');
  assert.equal((await local.get(`/api/portal/approvals/${ref}`)).status, 404);
  assert.equal((await local.post(`/api/portal/approvals/${ref}/approve`, {})).status, 404);
  assert.equal((await local.get('/api/portal/approvals')).json.approvals.length, 0);
  assert.equal((await local.get('/api/portal/notifications')).json.notifications.length, 0);
  assert.equal((await local.get('/api/portal/notifications/count')).json.approvalsOpen, 0);
  assert.equal(ticket.portal_freigabe, 'ausstehend');
});

test('Sich selbst freigeben geht nicht – auch nicht mit anderer Schreibweise', async () => {
  const a = await anna();
  for (const email of ['anna.becker@example.org', 'Anna.Becker@EXAMPLE.org']) {
    const r = await ask(a, email);
    assert.equal(r.status, 422);
    assert.match(r.json.details.chef, /eigene Anfrage nicht selbst/);
  }
});

test('Nur bekannte Personen (Einstellung im Feld)', async () => {
  const a = await anna();
  const unknown = await ask(a, 'niemand@example.org', {}, knownOnlyFormId);
  assert.equal(unknown.status, 422);
  assert.match(unknown.json.details.chef, /noch nie im Portal angemeldet/);
  const known = await ask(a, 'ben.krause@example.org', {}, knownOnlyFormId);
  assert.equal(known.status, 201);
  const free = await ask(a, 'neu.chefin@example.org');
  assert.equal(free.status, 201);
  assert.deepEqual(free.json.approval, { email: 'neu.chefin@example.org', name: null, known: false });
  await deliverAll();
});

test('Zurückziehen und andere Person wählen', async () => {
  const a = await anna();
  const { id, ticket, ref } = await asked(a, 'alex.berger@example.org', { programm: 'Zurück' });
  assert.equal((await a.post(`/api/portal/requests/${id}/approver`, { email: 'anna.becker@example.org' })).status, 422);
  assert.equal((await a.post(`/api/portal/requests/${id}/approver`, { email: 'alex.berger@example.org' })).status, 422, 'gleiche Person');
  assert.equal((await a.post(`/api/portal/requests/${id}/approver`, { email: 'quatsch' })).status, 422);
  const moved = await a.post(`/api/portal/requests/${id}/approver`, { email: 'Ben.Krause@example.org' });
  assert.equal(moved.status, 200, moved.text);
  assert.equal(ticket.portal_freigabe_durch, 'ben.krause@example.org');
  assert.ok(articlesOf(ticket.id).some((art) => art.type === 'email' && art.to === 'ben.krause@example.org'));
  const x = await alex();
  assert.equal((await x.get(`/api/portal/approvals/${ref}`)).status, 404);
  assert.ok((await x.get('/api/portal/notifications')).json.notifications.some((m: any) => m.kind === 'approval.reassigned'));
  const b = await ben();
  assert.equal((await b.get(`/api/portal/approvals/${ref}`)).status, 200);

  const w = await a.post(`/api/portal/requests/${id}/withdraw`);
  assert.equal(w.status, 200, w.text);
  assert.equal(stateName(ticket), 'closed');
  assert.equal(ticket.portal_freigabe, 'zurueckgezogen');
  assert.equal((await b.post(`/api/portal/approvals/${ref}/approve`, {})).status, 409);
  assert.equal((await a.post(`/api/portal/requests/${id}/withdraw`)).status, 409);
  assert.ok((await b.get('/api/portal/notifications')).json.notifications.some((m: any) => m.kind === 'approval.withdrawn'));
  assert.equal((await a.get('/api/portal/requests')).json.requests.find((q: any) => q.id === id).status, 'withdrawn');
});

test('Fristen: einmal erinnern, Ablauf schließt das Ticket, in Zammad geschlossen = abgebrochen', async () => {
  const a = await anna();
  const { ticket, ref } = await asked(a, 'alex.berger@example.org', { programm: 'Frist' });
  const day = 86400_000;
  // 4 Tage alt → Erinnerung (Standard: nach 3 Tagen)
  ticket.created_at = new Date(Date.now() - 4 * day).toISOString();
  const mails = () => articlesOf(ticket.id).filter((art) => art.type === 'email' && art.to === 'alex.berger@example.org').length;
  const before = mails();
  assert.ok((await approvalHousekeeping(p.app)).reminded >= 1);
  assert.equal(mails(), before + 1, 'Erinnerung per E-Mail über Zammad');
  assert.equal((await approvalHousekeeping(p.app)).reminded, 0, 'nur eine Erinnerung');
  const x = await alex();
  assert.ok((await x.get('/api/portal/notifications')).json.notifications.some((m: any) => m.kind === 'approval.reminder' && /Frist/.test(m.title)));
  // Frist abgelaufen (gestern)
  ticket.portal_freigabe_bis = berlinDay(Date.now() - day);
  assert.equal((await x.post(`/api/portal/approvals/${ref}/approve`, {})).status, 409, 'nach Fristende keine Entscheidung mehr');
  assert.ok((await approvalHousekeeping(p.app)).expired >= 1);
  assert.equal(ticket.portal_freigabe, 'abgelaufen');
  assert.equal(stateName(ticket), 'closed');
  assert.ok((await a.get('/api/portal/notifications')).json.notifications.some((m: any) => m.kind === 'approval.expired'));
  assert.ok((await x.get('/api/portal/notifications')).json.notifications.some((m: any) => m.kind === 'approval.expired'));
  // Die IT schließt ein wartendes Ticket direkt in Zammad
  const second = await asked(a, 'alex.berger@example.org', { programm: 'Direkt geschlossen' });
  second.ticket.state_id = p.zammad.state.states.find((s) => s.name === 'closed')!.id;
  assert.ok((await approvalHousekeeping(p.app)).cancelled >= 1);
  assert.equal(second.ticket.portal_freigabe, 'abgebrochen');
  assert.equal((await x.get(`/api/portal/approvals/${second.ref}`)).json.approval.status, 'cancelled');
  assert.ok((await x.get('/api/portal/notifications')).json.notifications.some((m: any) => m.kind === 'request.cancelled'));
});

test('Personensuche: nur Microsoft-Konten, ohne sich selbst, Platzhalter wirkungslos', async () => {
  const a = await anna();
  assert.deepEqual((await a.get('/api/portal/people?q=a')).json.people, []);
  const r = await a.get('/api/portal/people?q=example');
  const emails = r.json.people.map((x: any) => x.email);
  assert.ok(emails.includes('alex.berger@example.org'));
  assert.ok(!emails.includes('anna.becker@example.org'), 'nicht sich selbst');
  assert.equal(emails.filter((e: string) => e === 'alex.berger@example.org').length, 1, 'keine lokalen Konten');
  assert.ok(r.json.people.length <= 8);
  assert.deepEqual((await a.get('/api/portal/people?q=%25%25')).json.people, [], '% ist kein Platzhalter');
  assert.deepEqual((await a.get('/api/portal/people?q=__')).json.people, [], '_ ist kein Platzhalter');
  assert.equal((await new Client(p.url).get('/api/portal/people?q=example')).status, 401);
});

test('Benachrichtigungen: gelesen markieren nur für eigene', async () => {
  const a = await anna();
  const b = await ben();
  notify(p.app, { to: { userId: p.app.db.get<{ id: string }>("SELECT id FROM users WHERE email = 'anna.becker@example.org' AND kind = 'entra'")!.id }, kind: 'request.cancelled', title: 'Test' });
  const theirs = (await a.get('/api/portal/notifications')).json.notifications.find((n: any) => !n.read);
  assert.ok(theirs);
  assert.equal((await b.post('/api/portal/notifications/read', { ids: [theirs.id] })).json.marked, 0);
  assert.equal((await a.post('/api/portal/notifications/read', { ids: [theirs.id] })).json.marked, 1);
  assert.equal((await a.post('/api/portal/notifications/read', {})).json.unread, 0);
  assert.equal((await a.get('/api/portal/notifications/count')).json.unread, 0);
});

test('Weitere Kanäle (z. B. später E-Mail) hängen sich an, Fehler stören nicht', async () => {
  const seen: string[] = [];
  const off1 = registerChannel({ name: 'test', deliver: (_app, n) => { seen.push(n.title); } });
  const off2 = registerChannel({ name: 'kaputt', deliver: () => { throw new Error('kaputt'); } });
  try {
    notify(p.app, { to: { email: 'x@example.org' }, kind: 'approval.requested', title: 'Kanaltest' });
    assert.deepEqual(seen, ['Kanaltest']);
    assert.ok(p.app.db.get("SELECT 1 FROM notifications WHERE email = 'x@example.org' AND kind = 'approval.requested'"));
  } finally { off1(); off2(); }
});

test('Zuordnung: eigener Status, Tags während der Freigabe, ohne E-Mails', async () => {
  const sys = getSystem(p.app, systemId)!;
  const su = new Client(p.url);
  await createUser(p.app, { username: 'chef-zuordnung', role: 'Super-Admin' });
  await su.loginLocal('chef-zuordnung', 'Test-Passwort-123!');
  const put = await su.put(`/api/admin/systems/${systemId}/zammad`, { mapping: { approval: { state: 'Freigabe offen', pendingTags: ['nicht eskalieren'], emailApprover: false, emailRequester: false } } });
  assert.equal(put.status, 200, put.text);
  assert.ok(put.json.report.missing.states.includes('Freigabe offen'));
  assert.equal((await su.put(`/api/admin/systems/${systemId}/zammad`, { mapping: { approval: { state: 'new' } } })).status, 422, 'gleich dem Status nach Freigabe');
  assert.equal((await su.put(`/api/admin/systems/${systemId}/zammad`, { mapping: { attrs: { approver: 'group_id' } } })).status, 422);
  await applySetup(p.app, getSystem(p.app, sys.id)!);
  const a = await anna();
  const { ticket, ref } = await asked(a, 'alex.berger@example.org', { programm: 'Mit Tags' });
  assert.equal(stateName(ticket), 'Freigabe offen');
  assert.ok(ticket.tags.includes('nicht eskalieren'));
  assert.ok(!articlesOf(ticket.id).some((art) => art.type === 'email'), 'keine E-Mail');
  const x = await alex();
  assert.equal((await x.post(`/api/portal/approvals/${ref}/approve`, {})).status, 200);
  assert.ok(!ticket.tags.includes('nicht eskalieren'), 'Tag nach der Entscheidung entfernt');
  assert.equal(stateName(ticket), 'new');
  // zurück auf Standard
  await su.put(`/api/admin/systems/${systemId}/zammad`, { mapping: {} });
});

test('Übergang aus 1.x: im Portal wartende Freigaben gehen als Ticket nach Zammad', async () => {
  const { upgradeWaitingApprovals } = await import('../src/server/services/approvals.ts');
  const a = await anna();
  const r = await a.post(`/api/portal/forms/${formId}/submit`, { values: { programm: 'Altlast', lizenz: 'frei' }, files: {} });
  // Wie in 1.x: Anfrage wartet im Portal, Freigabe-Zeile mit Frist
  p.app.db.run("UPDATE requests SET status = 'awaiting_approval' WHERE id = ?", r.json.id);
  p.app.db.run("INSERT INTO approvals (id, request_id, approver_email, approver_name, status, created_at, expires_at) VALUES ('alt-1', ?, 'Alex.Berger@example.org', 'Alex Berger', 'pending', ?, ?)",
    r.json.id, Date.now(), Date.now() + 5 * 86400_000);
  assert.equal(upgradeWaitingApprovals(p.app), 1);
  assert.equal(requestRow(r.json.id).status, 'queued');
  await deliverAll();
  const t = p.zammad.state.tickets.find((x) => x.id === requestRow(r.json.id).ticket_id)!;
  assert.equal(stateName(t), 'wartet auf Freigabe');
  assert.equal(t.portal_freigabe_durch, 'alex.berger@example.org');
  assert.equal(t.portal_freigabe_bis, berlinDay(Date.now() + 5 * 86400_000));
  assert.equal(p.app.db.get("SELECT 1 FROM approvals WHERE id = 'alt-1'"), undefined);
});

test('Migrationen bis 012 erhalten bestehende Anfragen und Anhänge', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zsp-mig-'));
  try {
    const db = new Db(join(dir, 'portal.db'));
    const migDir = new URL('../src/server/db/migrations/', import.meta.url).pathname;
    db.raw.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)');
    for (const [v, f] of [[1, '001_init.sql'], [2, '002_lockout.sql'], [3, '003_system_limits.sql']] as const) {
      db.raw.exec(readFileSync(join(migDir, f), 'utf8'));
      db.run('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)', v, Date.now());
    }
    const t = Date.now();
    db.run("INSERT INTO users (id, kind, username, display_name, created_at) VALUES ('u1', 'local', 'u1', 'U1', ?)", t);
    db.run("INSERT INTO ticket_systems (id, slug, name, base_url, api_token, created_at, updated_at) VALUES ('s1', 's1', 'S1', 'https://z.example.org', 'x', ?, ?)", t, t);
    db.run("INSERT INTO requests (id, user_id, system_id, form_id, form_version_id, title, payload, status, next_attempt_at, created_at) VALUES ('r1', 'u1', 's1', 'f', 'v', 'Alt', 'enc', 'queued', ?, ?)", t, t - 5000);
    db.run("INSERT INTO request_files (id, request_id, field_id, filename, mime, size, sha256) VALUES ('f1', 'r1', 'anhang', 'a.pdf', 'application/pdf', 1, 'x')");
    assert.deepEqual(db.migrate(), [4, 5, 6, 7, 8, 9, 10, 11, 12]);
    const r = db.get<{ status: string; queued_at: number }>("SELECT status, queued_at FROM requests WHERE id = 'r1'")!;
    assert.equal(r.status, 'queued');
    assert.equal(r.queued_at, t - 5000);
    assert.ok(db.get("SELECT 1 FROM request_files WHERE id = 'f1'"), 'Anhänge bleiben erhalten');
    assert.equal(db.get<{ zammad_mapping: string }>("SELECT zammad_mapping FROM ticket_systems WHERE id = 's1'")!.zammad_mapping, '{}');
    assert.equal(db.get<{ foreign_keys: number }>('PRAGMA foreign_keys')!.foreign_keys, 1, 'Fremdschlüssel wieder an');
    db.run("UPDATE requests SET status = 'cancelled' WHERE id = 'r1'");
    assert.throws(() => db.run("UPDATE requests SET status = 'quatsch' WHERE id = 'r1'"));
    db.run("DELETE FROM requests WHERE id = 'r1'");
    assert.equal(db.get("SELECT 1 FROM request_files WHERE id = 'f1'"), undefined);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
