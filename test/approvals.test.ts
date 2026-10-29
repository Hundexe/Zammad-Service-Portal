// Freigabe durch Vorgesetzte: Ablauf, Sicherheit, Fristen, Benachrichtigungen.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startPortal, Client, createSystem, createForm, createUser, ENTRA_USERS, type Portal } from './helpers.ts';
import { deliverNext, purgeOld } from '../src/server/services/requests.ts';
import { approvalHousekeeping } from '../src/server/services/approvals.ts';
import { collectStatus } from '../src/server/services/status.ts';
import { notify, registerChannel } from '../src/server/services/notifications.ts';
import { emptyDefinition } from '../src/server/services/forms.ts';
import { validateDefinition, validateSubmission, type FormDefinition } from '../src/shared/form.ts';
import { Db } from '../src/server/db/db.ts';

const [ANNA, BEN, ALEX] = ENTRA_USERS;
let p: Portal;
let systemId: string;
let formId: string;
let knownOnlyFormId: string;
const anna = () => login(ANNA.oid);
const ben = () => login(BEN.oid);
const alex = () => login(ALEX.oid);

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

const approvalOf = (requestId: string) => p.app.db.get<{ id: string; status: string; approver_email: string; summary: string | null; comment: string | null; expires_at: number; reminded_at: number | null }>('SELECT * FROM approvals WHERE request_id = ?', requestId)!;
const requestRow = (id: string) => p.app.db.get<{ status: string; payload: string | null; ticket_number: string | null; queued_at: number | null }>('SELECT status, payload, ticket_number, queued_at FROM requests WHERE id = ?', id)!;
const deliverAll = async () => { while (await deliverNext(p.app)) { /* zustellen */ } };

before(async () => {
  p = await startPortal();
  systemId = createSystem(p.app, p.zammad.url);
  formId = createForm(p.app, systemId, softwareForm(), 'software');
  knownOnlyFormId = createForm(p.app, systemId, softwareForm(true), 'software-bekannt');
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

test('Anfrage mit Freigabe wartet im Portal; erst nach der Freigabe entsteht das Ticket', async () => {
  const a = await anna();
  const ticketsBefore = p.zammad.state.tickets.length;
  const r = await ask(a, 'alex.berger@example.org');
  assert.equal(r.status, 201, r.text);
  assert.deepEqual(r.json.approval, { email: 'alex.berger@example.org', name: 'Alex Berger', known: true });
  assert.equal(requestRow(r.json.id).status, 'awaiting_approval');
  assert.equal(requestRow(r.json.id).queued_at, null);
  assert.equal(await deliverNext(p.app), false, 'Worker fasst wartende Anfragen nicht an');
  assert.equal(p.zammad.state.tickets.length, ticketsBefore);

  // Anna sieht den Status in "Meine Anfragen" und unter "Noch nicht übermittelt"
  const mine = await a.get('/api/portal/requests');
  const entry = mine.json.requests.find((x: any) => x.id === r.json.id);
  assert.equal(entry.status, 'awaiting_approval');
  assert.equal(entry.approval.approverName, 'Alex Berger');
  const pending = await a.get(`/api/portal/systems/${systemId}/tickets`);
  assert.ok(pending.json.pending.some((x: any) => x.id === r.json.id));

  // Alex: Glocke und Freigaben
  const x = await alex();
  const count = await x.get('/api/portal/notifications/count');
  assert.ok(count.json.unread >= 1);
  assert.ok(count.json.approvalsOpen >= 1);
  const list = await x.get('/api/portal/approvals');
  const item = list.json.approvals.find((i: any) => i.title === 'Software: Grafikprogramm' && i.status === 'pending');
  assert.ok(item);
  assert.equal(item.requesterName, 'Anna Becker');
  const detail = await x.get(`/api/portal/approvals/${item.id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.json.summary.requester.email, 'anna.becker@example.org');
  assert.deepEqual(detail.json.summary.fields.map((f: any) => f.label), ['Programm', 'Lizenz']);
  assert.equal(detail.json.files[0].filename, 'angebot.pdf');
  const file = await x.get(`/api/portal/approvals/${item.id}/files/${detail.json.files[0].id}`);
  assert.equal(file.status, 200);
  assert.equal(file.headers.get('content-type'), 'application/octet-stream');
  assert.match(file.text, /%PDF/);

  // Freigeben → Warteschlange → Ticket mit Vermerk und Tag
  const ok = await x.post(`/api/portal/approvals/${item.id}/approve`, { comment: 'Kostenstelle <4711>' });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(requestRow(r.json.id).status, 'queued');
  assert.ok(requestRow(r.json.id).queued_at);
  const again = await x.post(`/api/portal/approvals/${item.id}/approve`, {});
  assert.equal(again.status, 409, 'nur einmal entscheiden');
  await deliverAll();
  const row = requestRow(r.json.id);
  assert.equal(row.status, 'delivered');
  const ticket = p.zammad.state.tickets.find((t) => t.number === row.ticket_number)!;
  assert.ok(ticket.tags.includes('freigegeben'));
  const article = p.zammad.state.articles.find((art) => art.ticket_id === ticket.id)!;
  assert.match(article.body, /Freigegeben<\/strong> von Alex Berger \(alex\.berger@example\.org\)/);
  assert.match(article.body, /Kostenstelle &lt;4711&gt;/, 'Hinweis wird escaped');
  assert.ok(article.body.indexOf('Freigegeben') < article.body.indexOf('Erstellt über das Service-Portal'));
  assert.equal(article.attachments[0].filename, 'angebot.pdf');
  assert.equal(approvalOf(r.json.id).summary, null, 'Inhalt für die freigebende Person ist nach der Entscheidung gelöscht');

  // Anna wird benachrichtigt; Alex' Hinweis gilt als gelesen
  const n = await a.get('/api/portal/notifications');
  assert.ok(n.json.notifications.some((m: any) => m.kind === 'approval.approved' && m.title === 'Freigegeben: Software: Grafikprogramm' && !m.read));
  const alexN = await x.get('/api/portal/notifications');
  assert.ok(alexN.json.notifications.filter((m: any) => m.link === `/freigaben/${item.id}`).every((m: any) => m.read));
  const done = await x.get('/api/portal/approvals?status=done');
  const d = done.json.approvals.find((i: any) => i.id === item.id);
  assert.equal(d.status, 'approved');
  assert.equal(d.comment, 'Kostenstelle <4711>');
  // Audit
  assert.ok(p.app.db.get("SELECT 1 FROM audit_log WHERE action = 'approval.approved' AND target_id = ?", r.json.id));
  assert.ok(p.app.db.get("SELECT 1 FROM audit_log WHERE action = 'approval.requested' AND target_id = ?", r.json.id));
});

test('Ohne sichtbares Freigabe-Feld geht die Anfrage direkt in die Zustellung', async () => {
  const a = await anna();
  const r = await a.post(`/api/portal/forms/${formId}/submit`, { values: { programm: 'Editor', lizenz: 'frei', chef: 'alex.berger@example.org' }, files: {} });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.json.approval, null);
  assert.equal(requestRow(r.json.id).status, 'queued');
  assert.equal(p.app.db.get('SELECT 1 FROM approvals WHERE request_id = ?', r.json.id), undefined);
  await deliverAll();
});

test('Ablehnen: Begründung nötig, Inhalt und Anhänge werden gelöscht, kein Ticket', async () => {
  const a = await anna();
  const r = await ask(a, 'alex.berger@example.org', { programm: 'Spiel' });
  const ap = approvalOf(r.json.id);
  assert.ok(existsSync(join(p.app.uploadsDir, r.json.id)));
  const x = await alex();
  const noReason = await x.post(`/api/portal/approvals/${ap.id}/reject`, { comment: '  ' });
  assert.equal(noReason.status, 422);
  const tooLong = await x.post(`/api/portal/approvals/${ap.id}/reject`, { comment: 'x'.repeat(2001) });
  assert.equal(tooLong.status, 422);
  const no = await x.post(`/api/portal/approvals/${ap.id}/reject`, { comment: 'Nicht dienstlich' });
  assert.equal(no.status, 200, no.text);
  const row = requestRow(r.json.id);
  assert.equal(row.status, 'rejected');
  assert.equal(row.payload, null);
  assert.equal(existsSync(join(p.app.uploadsDir, r.json.id)), false, 'Anhänge gelöscht');
  assert.equal(p.app.db.get<{ n: number }>('SELECT COUNT(*) n FROM request_files WHERE request_id = ? AND stored = 1', r.json.id)!.n, 0);
  assert.equal(await deliverNext(p.app), false);
  assert.ok(!p.zammad.state.tickets.some((t) => t.title === 'Software: Spiel'));
  const mine = await a.get('/api/portal/requests');
  const e = mine.json.requests.find((q: any) => q.id === r.json.id);
  assert.equal(e.status, 'rejected');
  assert.equal(e.approval.comment, 'Nicht dienstlich');
  const n = await a.get('/api/portal/notifications');
  assert.ok(n.json.notifications.some((m: any) => m.kind === 'approval.rejected' && /Nicht dienstlich/.test(m.body)));
  // Abgelehnte Anfragen erscheinen nicht mehr unter "Noch nicht übermittelt"
  const t = await a.get(`/api/portal/systems/${systemId}/tickets`);
  assert.ok(!t.json.pending.some((x2: any) => x2.id === r.json.id));
});

test('Sicherheit: nur die eingetragene Person sieht und entscheidet – sonst 404', async () => {
  const a = await anna();
  const r = await ask(a, 'alex.berger@example.org', { programm: 'Fremdzugriff' });
  const ap = approvalOf(r.json.id);
  const b = await ben();
  for (const res of [
    await b.get(`/api/portal/approvals/${ap.id}`),
    await b.post(`/api/portal/approvals/${ap.id}/approve`, {}),
    await b.post(`/api/portal/approvals/${ap.id}/reject`, { comment: 'nein' }),
    await a.get(`/api/portal/approvals/${ap.id}`),
    await a.post(`/api/portal/approvals/${ap.id}/approve`, {}),
  ]) assert.equal(res.status, 404);
  const files = p.app.db.get<{ id: string }>('SELECT id FROM request_files WHERE request_id = ?', r.json.id)!;
  assert.equal((await b.get(`/api/portal/approvals/${ap.id}/files/${files.id}`)).status, 404);
  assert.ok(!(await b.get('/api/portal/approvals')).json.approvals.some((x: any) => x.id === ap.id));
  // Fremde dürfen die Anfrage weder zurückziehen noch umleiten
  assert.equal((await b.post(`/api/portal/requests/${r.json.id}/withdraw`)).status, 404);
  assert.equal((await b.post(`/api/portal/requests/${r.json.id}/approver`, { email: 'ben.krause@example.org' })).status, 404);
  // Ungültige IDs
  assert.equal((await b.get('/api/portal/approvals/..%2F..%2Fetc')).status, 404);

  // Lokales Konto mit der Adresse eines Microsoft-Kontos bekommt weder Freigabe noch Benachrichtigung
  await createUser(p.app, { username: 'falscher-alex', email: 'alex.berger@example.org' });
  const local = new Client(p.url);
  await local.loginLocal('falscher-alex', 'Test-Passwort-123!');
  assert.equal((await local.get(`/api/portal/approvals/${ap.id}`)).status, 404);
  assert.equal((await local.post(`/api/portal/approvals/${ap.id}/approve`, {})).status, 404);
  assert.equal((await local.get('/api/portal/approvals')).json.approvals.length, 0);
  assert.equal((await local.get('/api/portal/notifications')).json.notifications.length, 0);
  assert.equal((await local.get('/api/portal/notifications/count')).json.approvalsOpen, 0);
  assert.equal(requestRow(r.json.id).status, 'awaiting_approval');
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
  // Ohne die Einstellung geht auch eine unbekannte Adresse – mit Hinweis
  const free = await ask(a, 'neu.chefin@example.org');
  assert.equal(free.status, 201);
  assert.deepEqual(free.json.approval, { email: 'neu.chefin@example.org', name: null, known: false });
});

test('Zurückziehen und andere Person wählen', async () => {
  const a = await anna();
  const r = await ask(a, 'alex.berger@example.org', { programm: 'Zurück' });
  const ap = approvalOf(r.json.id);
  // Andere Person: Alex verliert den Zugriff, Ben bekommt ihn
  assert.equal((await a.post(`/api/portal/requests/${r.json.id}/approver`, { email: 'anna.becker@example.org' })).status, 422);
  assert.equal((await a.post(`/api/portal/requests/${r.json.id}/approver`, { email: 'alex.berger@example.org' })).status, 422, 'gleiche Person');
  assert.equal((await a.post(`/api/portal/requests/${r.json.id}/approver`, { email: 'quatsch' })).status, 422);
  const moved = await a.post(`/api/portal/requests/${r.json.id}/approver`, { email: 'Ben.Krause@example.org' });
  assert.equal(moved.status, 200, moved.text);
  assert.equal(approvalOf(r.json.id).approver_email, 'ben.krause@example.org');
  const x = await alex();
  assert.equal((await x.get(`/api/portal/approvals/${ap.id}`)).status, 404);
  assert.ok((await x.get('/api/portal/notifications')).json.notifications.some((m: any) => m.kind === 'approval.reassigned'));
  const b = await ben();
  assert.equal((await b.get(`/api/portal/approvals/${ap.id}`)).status, 200);

  // Zurückziehen: gelöscht, Ben benachrichtigt, Entscheidung nicht mehr möglich
  const w = await a.post(`/api/portal/requests/${r.json.id}/withdraw`);
  assert.equal(w.status, 200);
  assert.equal(requestRow(r.json.id).status, 'withdrawn');
  assert.equal(requestRow(r.json.id).payload, null);
  assert.equal(existsSync(join(p.app.uploadsDir, r.json.id)), false);
  assert.equal((await b.post(`/api/portal/approvals/${ap.id}/approve`, {})).status, 409);
  assert.equal((await a.post(`/api/portal/requests/${r.json.id}/withdraw`)).status, 409);
  assert.ok((await b.get('/api/portal/notifications')).json.notifications.some((m: any) => m.kind === 'approval.withdrawn'));
});

test('Fristen: Erinnerung nach N Tagen, Ablauf löscht die Anfrage und benachrichtigt beide', async () => {
  const a = await anna();
  const r = await ask(a, 'alex.berger@example.org', { programm: 'Frist' });
  const ap = approvalOf(r.json.id);
  const day = 86400_000;
  // 4 Tage alt → Erinnerung (Standard: nach 3 Tagen)
  p.app.db.run('UPDATE approvals SET created_at = created_at - ?, expires_at = expires_at - ? WHERE id = ?', 4 * day, 4 * day, ap.id);
  const first = approvalHousekeeping(p.app);
  assert.ok(first.reminded >= 1);
  assert.ok(approvalOf(r.json.id).reminded_at);
  assert.equal(approvalHousekeeping(p.app).reminded, 0, 'nur eine Erinnerung');
  const x = await alex();
  assert.ok((await x.get('/api/portal/notifications')).json.notifications.some((m: any) => m.kind === 'approval.reminder' && /Frist/.test(m.title)));
  // Frist abgelaufen
  p.app.db.run('UPDATE approvals SET expires_at = ? WHERE id = ?', Date.now() - 1000, ap.id);
  assert.ok(approvalHousekeeping(p.app).expired >= 1);
  assert.equal(approvalOf(r.json.id).status, 'expired');
  assert.equal(requestRow(r.json.id).status, 'expired');
  assert.equal(requestRow(r.json.id).payload, null);
  assert.equal(existsSync(join(p.app.uploadsDir, r.json.id)), false);
  assert.equal((await x.post(`/api/portal/approvals/${ap.id}/approve`, {})).status, 409);
  assert.ok((await a.get('/api/portal/notifications')).json.notifications.some((m: any) => m.kind === 'approval.expired'));
  assert.ok((await x.get('/api/portal/notifications')).json.notifications.some((m: any) => m.kind === 'approval.expired'));
  // Eine Entscheidung genau nach Fristende wird abgelehnt, auch wenn der Worker noch nicht aufgeräumt hat
  const r2 = await ask(a, 'alex.berger@example.org', { programm: 'Knapp' });
  const ap2 = approvalOf(r2.json.id);
  p.app.db.run('UPDATE approvals SET expires_at = ? WHERE id = ?', Date.now() - 1, ap2.id);
  assert.equal((await x.post(`/api/portal/approvals/${ap2.id}/approve`, {})).status, 409);
  assert.equal(requestRow(r2.json.id).status, 'awaiting_approval');
});

test('Personensuche: nur Microsoft-Konten, ohne sich selbst, Platzhalter wirkungslos', async () => {
  const a = await anna();
  assert.deepEqual((await a.get('/api/portal/people?q=a')).json.people, []);
  const r = await a.get('/api/portal/people?q=example');
  const emails = r.json.people.map((x: any) => x.email);
  assert.ok(emails.includes('alex.berger@example.org'));
  assert.ok(!emails.includes('anna.becker@example.org'), 'nicht sich selbst');
  assert.equal(emails.filter((e: string) => e === 'alex.berger@example.org').length, 1, 'keine lokalen Konten (falscher-alex hat dieselbe Adresse)');
  assert.ok(!r.json.people.some((x: any) => x.name === 'falscher-alex'));
  assert.ok(r.json.people.length <= 8);
  assert.deepEqual((await a.get('/api/portal/people?q=%25%25')).json.people, [], '% ist kein Platzhalter');
  assert.deepEqual((await a.get('/api/portal/people?q=__')).json.people, [], '_ ist kein Platzhalter');
  assert.equal((await new Client(p.url).get('/api/portal/people?q=example')).status, 401);
});

test('Benachrichtigungen: gelesen markieren nur für eigene', async () => {
  const a = await anna();
  const b = await ben();
  const before = (await a.get('/api/portal/notifications')).json;
  const theirs = before.notifications.find((n: any) => !n.read);
  assert.ok(theirs);
  const foreign = await b.post('/api/portal/notifications/read', { ids: [theirs.id] });
  assert.equal(foreign.json.marked, 0);
  const own = await a.post('/api/portal/notifications/read', { ids: [theirs.id] });
  assert.equal(own.json.marked, 1);
  const all = await a.post('/api/portal/notifications/read', {});
  assert.equal(all.json.unread, 0);
  assert.equal((await a.get('/api/portal/notifications/count')).json.unread, 0);
});

test('Weitere Kanäle (z. B. später E-Mail) hängen sich an, Fehler stören nicht', async () => {
  const seen: string[] = [];
  const off1 = registerChannel({ name: 'test', deliver: (_app, n) => { seen.push(n.title); } });
  const off2 = registerChannel({ name: 'kaputt', deliver: () => { throw new Error('kaputt'); } });
  try {
    notify(p.app, { to: { email: 'x@example.org' }, kind: 'approval.requested', title: 'Kanaltest' });
    assert.deepEqual(seen, ['Kanaltest']);
    assert.ok(p.app.db.get("SELECT 1 FROM notifications WHERE title = 'Kanaltest'"));
  } finally { off1(); off2(); }
});

test('Betrieb: Warten auf Freigabe zählt nicht als Zustellstau; Aufräumen nach einem Jahr', async () => {
  const a = await anna();
  const r = await ask(a, 'alex.berger@example.org', { programm: 'Alt' });
  p.app.db.run('UPDATE requests SET created_at = created_at - ? WHERE id = ?', 3 * 86400_000, r.json.id);
  const s1 = await collectStatus(p.app);
  assert.ok(s1.outbox.awaitingApproval >= 1);
  assert.ok(!s1.problems.some((x) => /wartet seit/.test(x)));
  // Nach Freigabe zählt die Zeit ab der Freigabe, nicht ab dem Absenden
  const x = await alex();
  const ap = approvalOf(r.json.id);
  assert.equal((await x.post(`/api/portal/approvals/${ap.id}/approve`, {})).status, 200);
  const s2 = await collectStatus(p.app);
  assert.ok(!s2.problems.some((m) => /wartet seit/.test(m)), s2.problems.join());
  await deliverAll();
  // Abgelehnte/abgelaufene Einträge verschwinden wie zugestellte nach einem Jahr
  const old = await ask(a, 'alex.berger@example.org', { programm: 'Uralt' });
  const ap2 = approvalOf(old.json.id);
  await x.post(`/api/portal/approvals/${ap2.id}/reject`, { comment: 'nein' });
  p.app.db.run('UPDATE requests SET created_at = ? WHERE id = ?', Date.now() - 366 * 86400_000, old.json.id);
  purgeOld(p.app);
  assert.equal(p.app.db.get('SELECT 1 FROM requests WHERE id = ?', old.json.id), undefined);
  assert.equal(p.app.db.get('SELECT 1 FROM approvals WHERE id = ?', ap2.id), undefined, 'Freigabe wird mit gelöscht');
});

test('Migrationen 004 und 005 erhalten bestehende Anfragen und Anhänge', () => {
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
    assert.deepEqual(db.migrate(), [4, 5, 6, 7]);
    const r = db.get<{ status: string; queued_at: number }>("SELECT status, queued_at FROM requests WHERE id = 'r1'")!;
    assert.equal(r.status, 'queued');
    assert.equal(r.queued_at, t - 5000);
    assert.ok(db.get("SELECT 1 FROM request_files WHERE id = 'f1'"), 'Anhänge bleiben erhalten');
    assert.equal(db.get<{ foreign_keys: number }>('PRAGMA foreign_keys')!.foreign_keys, 1, 'Fremdschlüssel wieder an');
    // Neue Status sind erlaubt, Unsinn nicht
    db.run("UPDATE requests SET status = 'awaiting_approval' WHERE id = 'r1'");
    db.run("UPDATE requests SET status = 'cancelled' WHERE id = 'r1'");
    assert.throws(() => db.run("UPDATE requests SET status = 'quatsch' WHERE id = 'r1'"));
    // Kaskade funktioniert weiterhin
    db.run("DELETE FROM requests WHERE id = 'r1'");
    assert.equal(db.get("SELECT 1 FROM request_files WHERE id = 'f1'"), undefined);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
