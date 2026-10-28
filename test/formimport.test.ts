// Verwaltung: Formulare aus einer Datei übernehmen.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startPortal, Client, createSystem, createForm, createUser, ENTRA_USERS, type Portal } from './helpers.ts';

let p: Portal;
let systemId: string;
let admin: Client;

const softwareForm = (approver = true) => ({
  slug: 'software-anfordern', name: 'Software anfordern', category: 'Anträge', sort: 40, description: 'Ein Programm beantragen.',
  definition: {
    fields: [
      { id: 'software', type: 'text', label: 'Welche Software?', required: true, mapping: { target: 'article' } },
      { id: 'standort', type: 'zammad', attribute: 'standort', label: 'Standort', required: true },
      ...(approver ? [{ id: 'freigabe', type: 'approver', label: 'Wer gibt den Antrag frei?', mapping: { target: 'article' } }] : []),
    ],
    settings: { titleTemplate: 'Software Anfrage: {{software}} – {{benutzer.name}}', bodyTemplate: '<p>Neu.</p>\n{{alle_felder}}', tags: ['Software Anfrage'], successText: 'Danke!' },
  },
});
const call = (body: unknown) => admin.post(`/api/admin/systems/${systemId}/forms/import`, body);

before(async () => {
  p = await startPortal();
  systemId = createSystem(p.app, p.zammad.url);
  createForm(p.app, systemId, undefined, 'stoerung');
  await createUser(p.app, { username: 'it-admin', role: 'Super-Admin' });
  admin = new Client(p.url);
  await admin.loginLocal('it-admin', 'Test-Passwort-123!');
});
after(async () => { await p.close(); });

test('Vorschau, dann übernehmen: neues Formular mit Freigabe-Feld, sofort nutzbar', async () => {
  const dry = await call({ forms: [softwareForm()], templates: [{ kind: 'success', name: 'Antrag eingegangen', content: 'Danke!' }], publish: true, dryRun: true });
  assert.equal(dry.status, 200, dry.text);
  assert.deepEqual(dry.json.plan.forms.map((f: any) => [f.slug, f.action]), [['software-anfordern', 'create']]);
  assert.equal(dry.json.plan.publish, 'published');
  assert.equal(p.app.db.get("SELECT 1 FROM forms WHERE slug = 'software-anfordern'"), undefined, 'Vorschau ändert nichts');
  const r = await call({ forms: [softwareForm()], templates: [{ kind: 'success', name: 'Antrag eingegangen', content: 'Danke!' }], publish: true });
  assert.equal(r.status, 200, r.text);
  assert.ok(p.app.db.get("SELECT 1 FROM templates WHERE system_id = ? AND name = 'Antrag eingegangen'", systemId));
  const form = p.app.db.get<{ id: string }>("SELECT id FROM forms WHERE slug = 'software-anfordern'")!;
  const anna = new Client(p.url);
  await anna.loginEntra(p, ENTRA_USERS[0].oid);
  await new Client(p.url).loginEntra(p, ENTRA_USERS[2].oid);
  const sent = await anna.post(`/api/portal/forms/${form.id}/submit`, { values: { software: 'Visio', standort: 'nord', freigabe: ENTRA_USERS[2].email } });
  assert.equal(sent.status, 201, sent.text);
  assert.equal(sent.json.approval.email, ENTRA_USERS[2].email);
});

test('Gleiches Kürzel: neue Version; unverändert wird erkannt; bestehende Formulare bleiben', async () => {
  const same = await call({ forms: [softwareForm()], publish: true, dryRun: true });
  assert.equal(same.json.plan.forms[0].action, 'unchanged');
  const changed = await call({ forms: [{ ...softwareForm(), name: 'Software beantragen' }], publish: false });
  assert.equal(changed.status, 200, changed.text);
  const form = p.app.db.get<{ id: string; name: string }>("SELECT id, name FROM forms WHERE slug = 'software-anfordern'")!;
  assert.equal(form.name, 'Software beantragen');
  const versions = p.app.db.all<{ version: number; status: string }>('SELECT version, status FROM form_versions WHERE form_id = ? ORDER BY version', form.id);
  assert.deepEqual(versions.map((v) => v.status), ['published', 'draft'], 'ohne Veröffentlichen bleibt ein Entwurf');
  assert.ok(p.app.db.get("SELECT 1 FROM forms WHERE slug = 'stoerung'"), 'andere Formulare bleiben');
});

test('Fehlerhafte Formulare werden mit Grund abgelehnt, nichts wird geändert', async () => {
  const before = p.app.db.get<{ n: number }>('SELECT COUNT(*) n FROM form_versions')!.n;
  const bad = softwareForm();
  (bad.definition.fields as any[]).push({ id: 'chef2', type: 'approver', label: 'Zweite Freigabe' });
  const unreleased = { ...softwareForm(), slug: 'anders', definition: { ...softwareForm().definition, fields: [{ id: 'x', type: 'zammad', attribute: 'nicht_freigegeben', label: 'X' }] } };
  const r = await call({ forms: [bad, unreleased], publish: true });
  assert.equal(r.status, 422);
  assert.ok(r.json.details.some((d: string) => /nur ein Feld/.test(d)));
  assert.ok(r.json.details.some((d: string) => /nicht freigegeben/.test(d)));
  assert.equal(p.app.db.get<{ n: number }>('SELECT COUNT(*) n FROM form_versions')!.n, before);
  assert.equal((await call({ forms: [] })).status, 422);
});

test('Rechte: ohne „Formulare bearbeiten“ nicht', async () => {
  const user = new Client(p.url);
  await user.loginEntra(p, ENTRA_USERS[0].oid);
  assert.ok([403, 404].includes((await user.post(`/api/admin/systems/${systemId}/forms/import`, { forms: [softwareForm()] })).status));
});
