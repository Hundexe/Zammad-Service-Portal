// Funktionstests der Verwaltung über die API.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startPortal, Client, createUser, ENTRA_USERS, type Portal } from './helpers.ts';
import { deliverNext } from '../src/server/services/requests.ts';

let p: Portal;
let admin: Client;
let systemId: string;
let formId: string;
const PW = 'Sehr-geheimes-Passwort-42';

before(async () => {
  p = await startPortal();
  await createUser(p.app, { username: 'chef', password: PW, role: 'Super-Admin' });
  admin = new Client(p.url);
  await admin.loginLocal('chef', PW);
});
after(async () => { await p.close(); });

test('Ticketsystem anlegen, Verbindung testen, Stammdaten lesen', async () => {
  const r = await admin.post('/api/admin/systems', { slug: 'zentrale-it', name: 'Zentrale IT', baseUrl: p.zammad.url, apiToken: 'test-token', defaultGroup: 'Users' });
  assert.equal(r.status, 201, r.text);
  systemId = r.json.system.id;
  assert.equal(r.json.system.hasToken, true);
  assert.equal(r.json.system.portalTag, 'service-portal');
  const t = await admin.post(`/api/admin/systems/${systemId}/test`);
  assert.equal(t.json.ok, true);
  assert.equal(t.json.user, 'api-portal');
  const bad = await admin.put(`/api/admin/systems/${systemId}`, { apiToken: 'falsch' });
  assert.equal(bad.status, 200);
  assert.equal((await admin.post(`/api/admin/systems/${systemId}/test`)).json.ok, false);
  await admin.put(`/api/admin/systems/${systemId}`, { apiToken: 'test-token', portalTag: 'portal' });
  const meta = await admin.get(`/api/admin/systems/${systemId}/metadata?refresh=1`);
  assert.ok(meta.json.metadata.groups.some((g: any) => g.name === 'IT-Support::Hardware'));
  assert.ok(!meta.json.metadata.groups.some((g: any) => g.name.includes('deaktiviert')));
  assert.deepEqual(meta.json.metadata.fields.map((f: any) => f.name), ['sec_status', 'standort', 'dringend', 'kostenstelle']);
});

test('Zammad-Objekte freigeben – nur existierende und unterstützte', async () => {
  assert.equal((await admin.put(`/api/admin/systems/${systemId}/release`, { release: [{ name: 'gibtsnicht' }] })).status, 422);
  const r = await admin.put(`/api/admin/systems/${systemId}/release`, { release: [{ name: 'sec_status', allowedValues: ['Hardware::Laptop', 'Hardware::Monitor', 'erfunden'] }, { name: 'standort', allowedValues: null }] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.released[0].allowedValues, ['Hardware::Laptop', 'Hardware::Monitor']);
});

test('Formular anlegen, bearbeiten, veröffentlichen, Version wiederherstellen', async () => {
  const c = await admin.post(`/api/admin/systems/${systemId}/forms`, { slug: 'hardware', name: 'Hardware', category: 'Hardware' });
  assert.equal(c.status, 201);
  formId = c.json.form.id;
  const draft = (await admin.get(`/api/admin/systems/${systemId}/forms/${formId}`)).json.definition;
  draft.fields.push({ id: 'geraet', type: 'zammad', label: 'Gerät', attribute: 'sec_status', required: true });
  draft.fields.push({ id: 'ort', type: 'zammad', label: 'Ort', attribute: 'standort', required: true });
  draft.fields.push({ id: 'dringend', type: 'zammad', label: 'Dringend', attribute: 'dringend' });
  // dringend ist nicht freigegeben → Fehler
  assert.equal((await admin.put(`/api/admin/systems/${systemId}/forms/${formId}/draft`, { definition: draft })).status, 422);
  draft.fields.pop();
  draft.settings.titleTemplate = 'Hardware: {{geraet}}';
  draft.settings.group = 'IT-Support::Hardware';
  draft.settings.tags = ['hardware'];
  assert.equal((await admin.put(`/api/admin/systems/${systemId}/forms/${formId}/draft`, { definition: draft })).status, 200);
  const prev = await admin.post(`/api/admin/systems/${systemId}/forms/${formId}/preview`, { definition: draft });
  const geraet = prev.json.definition.fields.find((f: any) => f.id === 'geraet');
  assert.deepEqual(geraet.options.map((o: any) => o.value), ['Hardware::Laptop', 'Hardware::Monitor']);
  assert.equal((await admin.post(`/api/admin/systems/${systemId}/forms/${formId}/publish`)).json.status, 'published');
  const detail = await admin.get(`/api/admin/systems/${systemId}/forms/${formId}`);
  assert.equal(detail.json.form.published.version, 1);
  // zweite Version, dann erste wiederherstellen
  draft.fields[0].label = 'Version 2';
  await admin.put(`/api/admin/systems/${systemId}/forms/${formId}/draft`, { definition: draft });
  await admin.post(`/api/admin/systems/${systemId}/forms/${formId}/publish`);
  const v1 = (await admin.get(`/api/admin/systems/${systemId}/forms/${formId}`)).json.versions.find((v: any) => v.version === 1);
  assert.equal(v1.status, 'archived');
  const restored = await admin.post(`/api/admin/systems/${systemId}/forms/${formId}/versions/${v1.id}/restore`);
  assert.equal(restored.json.version.version, 3);
  assert.equal(restored.json.version.status, 'draft');
});

test('Benutzer sieht freigegebene Werte und Ticket bekommt Tags und Feldwerte', async () => {
  const u = new Client(p.url);
  await u.loginEntra(p, ENTRA_USERS[0].oid);
  const f = await u.get(`/api/portal/forms/${formId}`);
  const geraet = f.json.definition.fields.find((x: any) => x.id === 'geraet');
  assert.equal(f.json.definition.fields[0].label, 'Version 2');
  assert.equal(geraet.options.length, 2);
  const r = await u.post(`/api/portal/forms/${formId}/submit`, { values: { beschreibung: 'Bitte neuen Laptop', geraet: 'Hardware::Laptop', ort: 'sued' }, version: f.json.form.version });
  assert.equal(r.status, 201, r.text);
  // alte Formularversion wird erkannt
  assert.equal((await u.post(`/api/portal/forms/${formId}/submit`, { values: {}, version: 1 })).status, 409);
  while (await deliverNext(p.app)) { /* zustellen */ }
  const t = p.zammad.state.tickets.at(-1)!;
  assert.equal(t.title, 'Hardware: Hardware › Laptop');
  assert.equal(t.sec_status, 'Hardware::Laptop');
  assert.equal(t.standort, 'sued');
  assert.deepEqual(t.tags.sort(), ['hardware', 'portal']);
  assert.equal(t.group_id, 3);
});

test('Formular in anderes System kopieren', async () => {
  const s2 = await admin.post('/api/admin/systems', { slug: 'zwei', name: 'Zwei', baseUrl: p.zammad.url, apiToken: 'test-token' });
  const r = await admin.post(`/api/admin/systems/${systemId}/forms/${formId}/copy`, { targetSystemId: s2.json.system.id });
  assert.equal(r.status, 201);
  assert.equal(r.json.form.latest.status, 'draft');
});

test('Vorlagen und Übersichten', async () => {
  const t = await admin.post(`/api/admin/systems/${systemId}/templates`, { kind: 'body', name: 'Kurz', content: '{{alle_felder}}' });
  assert.equal(t.status, 201);
  assert.equal((await admin.put(`/api/admin/systems/${systemId}/templates/${t.json.id}`, { kind: 'body', name: 'Kurz 2', content: 'x' })).status, 200);
  const list = await admin.get(`/api/admin/systems/${systemId}/templates`);
  assert.ok(list.json.templates.some((x: any) => x.name === 'Kurz 2'));
  assert.equal((await admin.post(`/api/admin/systems/${systemId}/overviews`, { name: 'Alle', stateFilter: 'all', columns: ['number', 'title'], sortBy: 'created_at', sort: 5 })).status, 201);
  assert.equal((await admin.post(`/api/admin/systems/${systemId}/overviews`, { name: 'Böse', stateFilter: 'all', columns: ['password'] })).status, 422);
  const u = new Client(p.url);
  await u.loginEntra(p, ENTRA_USERS[0].oid);
  const ov = await u.get(`/api/portal/systems/${systemId}/overviews`);
  assert.deepEqual(ov.json.overviews.map((o: any) => o.name), ['Offene Tickets', 'Erledigt', 'Alle']);
});

test('Branding: Entwurf, Veröffentlichung, Logo', async () => {
  const before = await admin.get(`/api/admin/systems/${systemId}/branding`);
  const logo = await admin.post(`/api/admin/systems/${systemId}/assets`, { kind: 'logo', data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]).toString('base64') });
  assert.equal(logo.status, 201);
  const b = { ...before.json.published, headerColor: '#7a1f2b', logoDarkId: logo.json.id };
  const d = await admin.put(`/api/admin/systems/${systemId}/branding/draft`, { branding: b });
  assert.equal(d.status, 200);
  assert.equal((await admin.post(`/api/admin/systems/${systemId}/branding/publish`)).json.status, 'published');
  const u = new Client(p.url);
  await u.loginEntra(p, ENTRA_USERS[0].oid);
  const sys = (await u.get('/api/portal/systems')).json.systems.find((s: any) => s.id === systemId);
  assert.equal(sys.branding.headerColor, '#7a1f2b');
  assert.equal(sys.branding.logoDarkId, logo.json.id);
});

test('Lokalen Benutzer mit generiertem Passwort anlegen und zurücksetzen', async () => {
  const r = await admin.post('/api/admin/users', { username: 'm.muster', displayName: 'Max Muster', email: 'max@example.org', role: 'Benutzer' });
  assert.equal(r.status, 201);
  assert.equal(r.json.password.length, 20);
  const c = new Client(p.url);
  assert.equal((await c.loginLocal('m.muster', r.json.password)).json.state, 'password_change');
  const reset = await admin.post(`/api/admin/users/${r.json.id}/reset-password`, { resetTotp: true });
  assert.notEqual(reset.json.password, r.json.password);
  assert.equal((await c.get('/api/me')).status, 401, 'alte Sitzung beendet');
  const audit = await admin.get('/api/admin/audit?action=user');
  assert.ok(audit.json.entries.some((e: any) => e.action === 'user.password_reset'));
  assert.ok(!JSON.stringify(audit.json).includes(reset.json.password), 'Passwort steht nie im Audit-Log');
});

test('Rollen: eigene Rolle anlegen und einer Gruppe pro System zuordnen', async () => {
  const r = await admin.post('/api/admin/roles', { name: 'Nur Branding', permissions: ['branding.edit'] });
  assert.equal(r.status, 201);
  assert.equal((await admin.post('/api/admin/roles', { name: 'Böse', permissions: ['root'] })).status, 422);
  const a = await admin.post('/api/admin/role-assignments', { roleId: r.json.id, subjectType: 'group', subjectValue: 'grp-mitarbeiter', systemId });
  assert.equal(a.status, 201);
  const anna = new Client(p.url);
  await anna.loginEntra(p, ENTRA_USERS[0].oid);
  assert.equal((await anna.get(`/api/admin/systems/${systemId}/branding`)).status, 200);
  assert.equal((await anna.get(`/api/admin/systems/${systemId}/forms`)).status, 403);
  assert.equal((await admin.del(`/api/admin/role-assignments/${a.json.id}`)).status, 200);
  assert.equal((await anna.get(`/api/admin/systems/${systemId}/branding`)).status, 403);
});

test('Updates: nur verfügbare Versionen, nur ein Auftrag gleichzeitig', async () => {
  p.app.db.run("UPDATE update_state SET available = '[\"1.0.0\",\"1.1.0\"]', latest_version = '1.1.0' WHERE id = 1");
  assert.equal((await admin.post('/api/admin/updates/install', { version: '6.6.6' })).status, 422);
  assert.equal((await admin.post('/api/admin/updates/install', { version: '1.1.0' })).status, 201);
  assert.equal((await admin.post('/api/admin/updates/install', { version: '1.1.0' })).status, 409);
  const s = await admin.get('/api/admin/updates');
  assert.equal(s.json.jobs[0].status, 'requested');
});

test('Zustellung: fehlgeschlagene Anfrage erneut senden', async () => {
  const u = new Client(p.url);
  await u.loginEntra(p, ENTRA_USERS[0].oid);
  await u.post(`/api/portal/forms/${formId}/submit`, { values: { beschreibung: 'x', geraet: 'Hardware::Monitor', ort: 'nord' } });
  p.zammad.failNext(1, 422);
  await deliverNext(p.app);
  const failed = await admin.get('/api/admin/requests?status=failed');
  assert.equal(failed.json.requests.length, 1);
  assert.equal((await admin.post(`/api/admin/requests/${failed.json.requests[0].id}/retry`)).status, 200);
  await deliverNext(p.app);
  assert.equal((await admin.get('/api/admin/requests?status=failed')).json.requests.length, 0);
});

test('Übersicht und Audit-Prüfung', async () => {
  const o = await admin.get('/api/admin/overview');
  assert.equal(o.status, 200);
  assert.ok(o.json.requests7d.delivered >= 2, JSON.stringify(o.json.requests7d));
  const v = await admin.get('/api/admin/audit/verify');
  assert.equal(v.json.ok, true, JSON.stringify(v.json));
});
