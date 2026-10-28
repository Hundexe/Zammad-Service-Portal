// Verwaltung: Anfragen abbrechen, die noch nicht in Zammad sind.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { startPortal, Client, createSystem, createForm, createUser, ENTRA_USERS, type Portal } from './helpers.ts';
import { deliverNext } from '../src/server/services/requests.ts';
import { emptyDefinition } from '../src/server/services/forms.ts';
import type { FormDefinition } from '../src/shared/form.ts';

const [ANNA, , ALEX] = ENTRA_USERS;
let p: Portal;
let systemId: string;
let formId: string;
let admin: Client;

const PDF = Buffer.from('%PDF-1.4\n%Test\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');
const login = async (oid: string) => { const c = new Client(p.url); await c.loginEntra(p, oid); return c; };
const row = (id: string) => p.app.db.get<{ status: string; payload: string | null; last_error: string | null }>('SELECT status, payload, last_error FROM requests WHERE id = ?', id)!;

async function ask(c: Client, chef?: string) {
  const r = await c.post(`/api/portal/forms/${formId}/submit`, {
    values: { programm: 'Testprogramm', lizenz: chef ? 'kosten' : 'frei', ...(chef ? { chef } : {}) },
    files: { anhang: [{ name: 'a.pdf', type: 'application/pdf', data: PDF.toString('base64') }] },
  });
  assert.equal(r.status, 201, r.text);
  return r.json.id as string;
}

before(async () => {
  p = await startPortal();
  systemId = createSystem(p.app, p.zammad.url);
  formId = createForm(p.app, systemId, {
    ...emptyDefinition(),
    fields: [
      { id: 'programm', type: 'text', label: 'Programm', required: true },
      { id: 'lizenz', type: 'select', label: 'Lizenz', required: true, options: [{ value: 'frei', label: 'kostenlos' }, { value: 'kosten', label: 'kostenpflichtig' }] },
      { id: 'anhang', type: 'file', label: 'Angebot', maxFiles: 1, accept: ['pdf'] },
      { id: 'chef', type: 'approver', label: 'Freigabe', visibleIf: { field: 'lizenz', op: 'eq', value: 'kosten' } },
    ],
    settings: { ...emptyDefinition().settings, titleTemplate: 'Software: {{programm}}', group: 'IT-Support' },
  } as FormDefinition, 'software');
  await createUser(p.app, { username: 'it-admin', role: 'Super-Admin' });
  admin = new Client(p.url);
  await admin.loginLocal('it-admin', 'Test-Passwort-123!');
  await login(ALEX.oid);
});
after(async () => { await p.close(); });

test('fehlgeschlagene Anfrage abbrechen: gelöscht, nicht mehr erneut sendbar, Person benachrichtigt', async () => {
  const a = await login(ANNA.oid);
  const id = await ask(a);
  p.zammad.failNext(1, 403);
  await deliverNext(p.app);
  assert.equal(row(id).status, 'failed');
  const r = await admin.post(`/api/admin/requests/${id}/cancel`, { reason: 'Doppelt gestellt' });
  assert.equal(r.status, 200, r.text);
  assert.equal(row(id).status, 'cancelled');
  assert.equal(row(id).payload, null);
  assert.match(row(id).last_error!, /Abgebrochen von it-admin: Doppelt gestellt/);
  assert.equal(existsSync(join(p.app.uploadsDir, id)), false, 'Anhänge gelöscht');
  assert.equal((await admin.post(`/api/admin/requests/${id}/retry`)).status, 409);
  assert.equal((await admin.post(`/api/admin/requests/${id}/cancel`)).status, 409, 'nur einmal');
  const n = (await a.get('/api/portal/notifications')).json.notifications;
  assert.ok(n.some((m: any) => m.kind === 'request.cancelled' && /Doppelt gestellt/.test(m.body)));
  const mine = (await a.get('/api/portal/requests')).json.requests.find((x: any) => x.id === id);
  assert.equal(mine.status, 'cancelled');
  assert.ok(p.app.db.get("SELECT 1 FROM audit_log WHERE action = 'request.cancelled' AND target_id = ?", id));
  const list = (await admin.get('/api/admin/requests?status=cancelled')).json.requests;
  assert.ok(list.some((x: any) => x.id === id));
});

test('wartende Anfrage abbrechen – der Worker stellt sie nicht mehr zu', async () => {
  const a = await login(ANNA.oid);
  const id = await ask(a);
  assert.equal(row(id).status, 'queued');
  assert.equal((await admin.post(`/api/admin/requests/${id}/cancel`, {})).status, 200);
  const before = p.zammad.state.tickets.length;
  while (await deliverNext(p.app)) { /* nichts mehr da */ }
  assert.equal(p.zammad.state.tickets.length, before);
});

test('Anfrage, die auf eine Freigabe wartet, abbrechen: Freigabe endet, freigebende Person benachrichtigt', async () => {
  const a = await login(ANNA.oid);
  const id = await ask(a, ALEX.email);
  const ap = p.app.db.get<{ id: string }>('SELECT id FROM approvals WHERE request_id = ?', id)!;
  assert.equal((await admin.post(`/api/admin/requests/${id}/cancel`, {})).status, 200);
  assert.equal(p.app.db.get<{ status: string }>('SELECT status FROM approvals WHERE id = ?', ap.id)!.status, 'cancelled');
  const x = await login(ALEX.oid);
  assert.equal((await x.post(`/api/portal/approvals/${ap.id}/approve`, {})).status, 409);
  const d = await x.get(`/api/portal/approvals/${ap.id}`);
  assert.equal(d.json.approval.status, 'cancelled');
  assert.equal(d.json.summary, null);
  assert.ok((await x.get('/api/portal/notifications')).json.notifications.some((m: any) => m.kind === 'request.cancelled'));
});

test('Rechte: nur mit „Ticketsystem verwalten“; zugestellte Anfragen nicht', async () => {
  const a = await login(ANNA.oid);
  const id = await ask(a);
  assert.ok([403, 404].includes((await a.post(`/api/admin/requests/${id}/cancel`, {})).status), 'normaler Benutzer');
  assert.equal(row(id).status, 'queued');
  await deliverNext(p.app);
  assert.equal(row(id).status, 'delivered');
  assert.equal((await admin.post(`/api/admin/requests/${id}/cancel`, {})).status, 409);
  assert.equal((await admin.post('/api/admin/requests/00000000-0000-0000-0000-000000000000/cancel', {})).status, 404);
  // Während der Zustellung nicht
  const id2 = await ask(a);
  p.app.db.run("UPDATE requests SET status = 'sending' WHERE id = ?", id2);
  const r = await admin.post(`/api/admin/requests/${id2}/cancel`, {});
  assert.equal(r.status, 409);
  assert.match(r.json.error, /gerade zugestellt/);
});
