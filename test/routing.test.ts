// Weiterleitung aus einem Formular in ein anderes Ticketsystem (Auswahl im Formular bestimmt das Ziel).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startPortal, Client, createSystem, createForm, createUser, ENTRA_USERS, type Portal } from './helpers.ts';
import { startMockZammad, type MockZammad } from '../tools/mock-zammad.ts';
import { deliverNext } from '../src/server/services/requests.ts';
import { emptyDefinition } from '../src/server/services/forms.ts';
import { routeOf, validateDefinition, type FormDefinition } from '../src/shared/form.ts';
import { buildExport } from '../src/server/services/transfer.ts';

const [ANNA] = ENTRA_USERS;
const PW = 'Test-Passwort-123!';
let p: Portal;
let z2: MockZammad;
let zentral: string;
let nord: string;
let formId: string;

function routed(target: string, group?: string): FormDefinition {
  return {
    ...emptyDefinition(),
    fields: [
      { id: 'betreff', type: 'text', label: 'Betreff', required: true },
      { id: 'bereich', type: 'select', label: 'Wofür?', required: true, options: [{ value: 'it', label: 'IT' }, { value: 'haustechnik', label: 'Haustechnik' }],
        mapping: { target: 'system', routes: { haustechnik: { system: target, ...(group ? { group } : {}) } } } },
      { id: 'standort', type: 'select', label: 'Standort', options: [{ value: 'nord', label: 'Nord' }], mapping: { target: 'zammad_field', name: 'standort' } },
      { id: 'team', type: 'select', label: 'Team', options: [{ value: 'IT-Support::Netzwerk', label: 'Netzwerk' }], mapping: { target: 'group' } },
    ],
    settings: { ...emptyDefinition().settings, titleTemplate: 'Anfrage: {{betreff}}', group: 'IT-Support', tags: ['anfrage'] },
  } as FormDefinition;
}

const deliverAll = async () => { while (await deliverNext(p.app)) { /* zustellen */ } };

async function adminClient(user: string, role: string, systemId?: string): Promise<Client> {
  await createUser(p.app, { username: user, password: PW, role, systemId });
  const c = new Client(p.url);
  await c.loginLocal(user, PW);
  return c;
}

before(async () => {
  p = await startPortal();
  z2 = await startMockZammad({ quiet: true, customers: [{ email: 'anna.becker@example.org', firstname: 'Anna', lastname: 'Becker' }] });
  zentral = createSystem(p.app, p.zammad.url);
  nord = createSystem(p.app, z2.url, { slug: 'haustechnik', name: 'Haustechnik', released: [{ name: 'dringend', allowedValues: null }] });
  p.app.db.run("UPDATE ticket_systems SET allowed_groups = ?, default_group = 'IT-Support::Hardware' WHERE id = ?", JSON.stringify(['IT-Support::Hardware', 'IT-Support::Netzwerk']), nord);
  formId = createForm(p.app, zentral, routed(nord), 'anfrage');
});
after(async () => { await z2.close(); await p.close(); });

test('routeOf: nur sichtbare Auswahlfelder mit Eintrag leiten weiter', () => {
  const d = routed('x');
  assert.deepEqual(routeOf(d, { bereich: 'haustechnik' }), { system: 'x', field: 'bereich' });
  assert.equal(routeOf(d, { bereich: 'it' }), null);
  d.fields[1].visibleIf = { field: 'betreff', op: 'eq', value: 'nie' };
  assert.equal(routeOf(d, { betreff: 'a', bereich: 'haustechnik' }), null);
});

test('Formularprüfung: Weiterleitung nur bei Auswahlfeldern, bekannte Werte, höchstens ein Feld', () => {
  const d = routed('x');
  assert.deepEqual(validateDefinition(d), []);
  const multi = routed('x');
  multi.fields[1].type = 'multiselect';
  assert.ok(validateDefinition(multi).some((x) => x.includes('nur ein Auswahlfeld')));
  const unknown = routed('x');
  unknown.fields[1].mapping!.routes = { gibtsnicht: { system: 'x' } };
  assert.ok(validateDefinition(unknown).some((x) => x.includes('unbekannten Wert')));
  const two = routed('x');
  two.fields.push({ ...two.fields[1], id: 'zweites' });
  assert.ok(validateDefinition(two).some((x) => x.includes('nur ein Feld')));
  const bad = routed('../x');
  assert.ok(validateDefinition(bad).some((x) => x.includes('gültiges Ticketsystem')));
});

test('Auswahl „Haustechnik“: Ticket landet im anderen Ticketsystem mit dessen Standardgruppe', async () => {
  const c = new Client(p.url);
  await c.loginEntra(p, ANNA.oid);
  const before1 = p.zammad.state.tickets.length;
  const r = await c.post(`/api/portal/forms/${formId}/submit`, { values: { betreff: 'Heizung', bereich: 'haustechnik', standort: 'nord', team: 'IT-Support::Netzwerk' } });
  assert.equal(r.status, 201, r.text);
  assert.deepEqual(r.json.system, { id: nord, name: 'Haustechnik' });
  const row = p.app.db.get<{ system_id: string }>('SELECT system_id FROM requests WHERE id = ?', r.json.id)!;
  assert.equal(row.system_id, nord);
  await deliverAll();
  assert.equal(p.zammad.state.tickets.length, before1, 'nichts im ursprünglichen System');
  const t = z2.state.tickets.at(-1)! as any;
  assert.equal(t.title, 'Anfrage: Heizung');
  // Gruppenfeld des Formulars gilt nur im eigenen System – im Ziel die Standardgruppe
  assert.equal(z2.state.requests.filter((x) => x.method === 'POST' && x.path === '/api/v1/tickets').at(-1)!.body.group, 'IT-Support::Hardware');
  // „standort“ ist im Ziel nicht freigegeben: nicht als Feld, aber im Text
  const body = z2.state.requests.filter((x) => x.method === 'POST' && x.path === '/api/v1/tickets').at(-1)!.body;
  assert.equal(body.standort, undefined);
  assert.match(body.article.body, /Nord/);
  assert.ok(String(body.tags).includes('service-portal'));
});

test('Auswahl „IT“: bleibt im eigenen System, Gruppenfeld gilt', async () => {
  const c = new Client(p.url);
  await c.loginEntra(p, ANNA.oid);
  const r = await c.post(`/api/portal/forms/${formId}/submit`, { values: { betreff: 'Drucker', bereich: 'it', team: 'IT-Support::Netzwerk' } });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.json.system, null);
  await deliverAll();
  const body = p.zammad.state.requests.filter((x) => x.method === 'POST' && x.path === '/api/v1/tickets').at(-1)!.body;
  assert.equal(body.group, 'IT-Support::Netzwerk');
});

test('Deaktiviertes Ziel: Anfrage wird abgelehnt statt still im falschen System zu landen', async () => {
  const c = new Client(p.url);
  await c.loginEntra(p, ANNA.oid);
  p.app.db.run("UPDATE ticket_systems SET status = 'inactive' WHERE id = ?", nord);
  const r = await c.post(`/api/portal/forms/${formId}/submit`, { values: { betreff: 'X', bereich: 'haustechnik' } });
  assert.equal(r.status, 422);
  assert.equal(r.json.code ?? r.json.error, 'route_target_missing');
  p.app.db.run("UPDATE ticket_systems SET status = 'active' WHERE id = ?", nord);
});

test('Ohne „Anfragen stellen“ im Ziel wird die Anfrage abgelehnt', async () => {
  const all = p.app.db.get<{ id: string; role_id: string }>("SELECT id, role_id FROM role_assignments WHERE subject_type = 'all' AND system_id IS NULL")!;
  p.app.db.run('UPDATE role_assignments SET system_id = ? WHERE id = ?', zentral, all.id);
  try {
    const c = new Client(p.url);
    await c.loginEntra(p, ANNA.oid);
    const r = await c.post(`/api/portal/forms/${formId}/submit`, { values: { betreff: 'X', bereich: 'haustechnik' } });
    assert.equal(r.status, 403, r.text);
    assert.equal(p.app.db.get<{ n: number }>("SELECT COUNT(*) n FROM requests WHERE system_id = ? AND title IS NOT NULL AND status = 'queued'", nord)!.n, 0);
  } finally {
    p.app.db.run('UPDATE role_assignments SET system_id = NULL WHERE id = ?', all.id);
  }
});

test('Verwaltung: Weiterleitung nur in Systeme, für die man das Recht hat; Gruppe muss im Ziel erlaubt sein', async () => {
  const editor = await adminClient('editor-zentral', 'Ziel-Admin', zentral);
  const put = (def: FormDefinition) => editor.put(`/api/admin/systems/${zentral}/forms/${formId}/draft`, { definition: def });
  const r1 = await put(routed(nord));
  assert.equal(r1.status, 422);
  assert.ok((r1.json.details as string[]).some((x) => x.includes('fehlt Ihnen das Recht')), r1.text);

  const both = await adminClient('editor-beide', 'Super-Admin');
  const r2 = await both.put(`/api/admin/systems/${zentral}/forms/${formId}/draft`, { definition: routed(nord, 'Users') });
  assert.equal(r2.status, 422);
  assert.ok((r2.json.details as string[]).some((x) => x.includes('nicht erlaubt')), r2.text);
  const r3 = await both.put(`/api/admin/systems/${zentral}/forms/${formId}/draft`, { definition: routed(nord, 'IT-Support::Netzwerk') });
  assert.equal(r3.status, 200, r3.text);
  const r4 = await both.put(`/api/admin/systems/${zentral}/forms/${formId}/draft`, { definition: routed('gibt-es-nicht') });
  assert.equal(r4.status, 422);
  // Kürzel statt ID funktioniert (so steht es in Exportdateien)
  const r5 = await both.put(`/api/admin/systems/${zentral}/forms/${formId}/draft`, { definition: routed('haustechnik') });
  assert.equal(r5.status, 200, r5.text);
});

test('Export: Ziel der Weiterleitung steht als Kürzel in der Datei', async () => {
  const ex = await buildExport(p.app) as any;
  const s = ex.systems.find((x: any) => x.slug === 'zentrale-it');
  const def = s.forms.find((f: any) => f.slug === 'anfrage').versions[0].definition;
  assert.equal(def.fields[1].mapping.routes.haustechnik.system, 'haustechnik');
});
