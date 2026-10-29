// Identität über die E-Mail-Adresse (Sicherheitstest 28.10.2026: ST-02, ST-06, ST-07, ST-25).
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startPortal, Client, createSystem, createForm, createUser, ENTRA_USERS, TENANT_A, TENANT_B, type Portal } from './helpers.ts';
import { emptyDefinition } from '../src/server/services/forms.ts';
import { vetEntraEmail } from '../src/server/services/users.ts';
import { uuid } from '../src/server/db/db.ts';
import type { FormDefinition } from '../src/shared/form.ts';

const [ANNA, BEN, ALEX] = ENTRA_USERS;
let p: Portal;
let systemId: string;
let formId: string;
let groupFormId: string;

function approvalForm(groups?: string[]): FormDefinition {
  return {
    ...emptyDefinition(),
    fields: [
      { id: 'programm', type: 'text', label: 'Programm', required: true },
      { id: 'chef', type: 'approver', label: 'Wer gibt frei?', approverGroups: groups, mapping: { target: 'article' } },
    ],
    settings: { ...emptyDefinition().settings, titleTemplate: 'Software: {{programm}}', group: 'IT-Support' },
  } as FormDefinition;
}

async function login(oid: string): Promise<Client> {
  const c = new Client(p.url);
  await c.loginEntra(p, oid);
  return c;
}
const ask = (c: Client, approver: string, form = formId) => c.post(`/api/portal/forms/${form}/submit`, { values: { programm: 'Visio', chef: approver } });
const approvalId = (requestId: string) => p.app.db.get<{ id: string }>('SELECT id FROM approvals WHERE request_id = ?', requestId)!.id;
const emailOf = (oid: string) => p.app.db.get<{ email: string | null }>('SELECT email FROM users WHERE entra_oid = ?', oid)?.email;

before(async () => {
  p = await startPortal();
  systemId = createSystem(p.app, p.zammad.url);
  formId = createForm(p.app, systemId, approvalForm(), 'software');
  groupFormId = createForm(p.app, systemId, approvalForm(['grp-fuehrung']), 'hardware');
  await createUser(p.app, { username: 'super', role: 'Super-Admin' });
});
after(async () => { await p.close(); });
beforeEach(() => {
  for (const k of Object.keys(p.entra.verifiedDomains)) delete p.entra.verifiedDomains[k];
  for (const k of Object.keys(p.entra.graphMail)) delete p.entra.graphMail[k];
  p.app.cfg.entra.tenantDomains = {};
  p.entraClient.clearDomainCache();
});

test('Mail-Domain muss zum Tenant gehören: fremder Tenant mit fremder Adresse bekommt keine Adresse', async () => {
  // Tenant B hat nur die eigene Domain verifiziert, sein Admin setzt bei Ben aber Annas Adresse
  p.entra.verifiedDomains[TENANT_B] = ['tenant-b.example'];
  p.entra.graphMail[BEN.oid] = ANNA.email;
  const ben = await login(BEN.oid);
  assert.equal(emailOf(BEN.oid), null, 'Adresse nicht übernommen');
  const tickets = await ben.get(`/api/portal/systems/${systemId}/tickets`);
  assert.ok(tickets.status !== 200 || (tickets.json.tickets ?? []).length === 0, 'keine fremden Tickets');
  assert.ok(p.app.db.get("SELECT 1 FROM audit_log WHERE action = 'login.email_rejected'"));
  // Anna selbst (Tenant A, Domain verifiziert) behält ihre Adresse
  await login(ANNA.oid);
  assert.equal(emailOf(ANNA.oid), ANNA.email);
});

test('ENTRA_TENANT_DOMAINS hat Vorrang vor Graph', async () => {
  p.app.cfg.entra.tenantDomains = { [TENANT_A.toLowerCase()]: ['firma-a.example'] };
  await login(ALEX.oid);
  assert.equal(emailOf(ALEX.oid), null, 'example.org ist für Tenant A nicht konfiguriert');
  p.app.cfg.entra.tenantDomains = { [TENANT_A.toLowerCase()]: ['example.org'] };
  await login(ALEX.oid);
  assert.equal(emailOf(ALEX.oid), ALEX.email);
});

test('vetEntraEmail: ohne bekannte Domains nur bei einem einzigen Tenant übernehmen', () => {
  assert.equal(vetEntraEmail('a@x.de', null, true).email, 'a@x.de');
  assert.equal(vetEntraEmail('a@x.de', null, false).email, null);
  assert.equal(vetEntraEmail('a@X.de', ['x.de'], false).email, 'a@X.de');
  assert.equal(vetEntraEmail('a@sub.x.de', ['x.de'], false).email, null);
});

test('E-Mail lokaler Konten setzt nur ein Super-Admin', async () => {
  const roleId = uuid();
  p.app.db.run("INSERT INTO roles (id, name, description, permissions, builtin) VALUES (?, 'Nur Benutzer', '', '[\"user.manage\"]', 0)", roleId);
  const uid = await createUser(p.app, { username: 'benutzerverwalter' });
  p.app.db.run("INSERT INTO role_assignments (id, role_id, subject_type, subject_value, system_id, created_at) VALUES (?, ?, 'user', ?, NULL, ?)", uuid(), roleId, uid, Date.now());
  const c = new Client(p.url);
  await c.loginLocal('benutzerverwalter', 'Test-Passwort-123!');
  const r = await c.post('/api/admin/users', { username: 'fake', displayName: 'Fake', email: 'nie.angemeldet@example.org' });
  assert.equal(r.status, 403, r.text);
  assert.equal((await c.post('/api/admin/users', { username: 'ohnemail', displayName: 'Ohne' })).status, 201);
  const s = new Client(p.url);
  await s.loginLocal('super', 'Test-Passwort-123!');
  assert.equal((await s.post('/api/admin/users', { username: 'mitmail', displayName: 'Mit', email: 'test.user@example.org' })).status, 201);
});

test('Lokale Konten können nicht freigeben, auch mit passender Adresse', async () => {
  await createUser(p.app, { username: 'zweitkonto', email: 'chef.lokal@example.org' });
  const anna = await login(ANNA.oid);
  const r = await ask(anna, 'chef.lokal@example.org');
  assert.equal(r.status, 201, r.text);
  const local = new Client(p.url);
  await local.loginLocal('zweitkonto', 'Test-Passwort-123!');
  assert.deepEqual((await local.get('/api/portal/approvals')).json.approvals, []);
  assert.equal((await local.get(`/api/portal/approvals/${approvalId(r.json.id)}`)).status, 404);
  assert.equal((await local.post(`/api/portal/approvals/${approvalId(r.json.id)}/approve`, {})).status, 404);
  assert.equal((await local.get('/api/portal/notifications/count')).json.unread, 0, 'keine Hinweise an die Adresse');
});

test('Freigabe-Gruppen: nur Mitglieder dürfen freigeben (kein Zweitkonto)', async () => {
  await login(ALEX.oid); // bekannt, aber nicht in grp-fuehrung
  const anna = await login(ANNA.oid);
  const r = await ask(anna, ALEX.email, groupFormId);
  assert.equal(r.status, 422);
  assert.match(r.json.details.chef, /nicht freigeben/);
  // Ben ist in it-admins – als Führungsgruppe freigeben lassen
  const itForm = createForm(p.app, systemId, approvalForm(['it-admins']), 'it-hardware');
  await login(BEN.oid);
  const ok = await ask(anna, BEN.email, itForm);
  assert.equal(ok.status, 201, ok.text + ' ben=' + emailOf(BEN.oid));
  const ben = await login(BEN.oid);
  assert.equal((await ben.get(`/api/portal/approvals/${approvalId(ok.json.id)}`)).status, 200);
});

test('Freigebende Person wechseln: Frist läuft weiter, höchstens drei Wechsel', async () => {
  for (const u of [ALEX, BEN]) await login(u.oid);
  const anna = await login(ANNA.oid);
  const r = await ask(anna, ALEX.email);
  assert.equal(r.status, 201, r.text);
  const before = p.app.db.get<{ expires_at: number }>('SELECT expires_at FROM approvals WHERE id = ?', approvalId(r.json.id))!.expires_at;
  const targets = [BEN.email, ALEX.email, BEN.email];
  for (const email of targets) {
    const x = await anna.post(`/api/portal/requests/${r.json.id}/approver`, { email });
    assert.equal(x.status, 200, x.text);
  }
  assert.equal(p.app.db.get<{ expires_at: number }>('SELECT expires_at FROM approvals WHERE id = ?', approvalId(r.json.id))!.expires_at, before, 'Frist unverändert');
  assert.equal((await anna.post(`/api/portal/requests/${r.json.id}/approver`, { email: ALEX.email })).status, 409, 'vierter Wechsel abgelehnt');
});

