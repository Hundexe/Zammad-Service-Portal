// Service-Status, Störungen, Wartungen, Probleme und Funktionsschalter.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startPortal, Client, createSystem, createForm, createUser, ENTRA_USERS, type Portal } from './helpers.ts';
import { startMockZammad, type MockZammad } from '../tools/mock-zammad.ts';
import { deliverNext } from '../src/server/services/requests.ts';
import { emptyDefinition } from '../src/server/services/forms.ts';
import type { FormDefinition } from '../src/shared/form.ts';

const [ANNA] = ENTRA_USERS;
const PW = 'Test-Passwort-123!';
let p: Portal;
let z2: MockZammad;
let zentral: string;
let nord: string;
let su: Client;
let anna: Client;
let formId: string;

const deliverAll = async () => { while (await deliverNext(p.app)) { /* zustellen */ } };

async function adminClient(name: string, role: string, systemId?: string): Promise<Client> {
  await createUser(p.app, { username: name, password: PW, role, systemId });
  const c = new Client(p.url);
  await c.loginLocal(name, PW);
  return c;
}

function form(services: string[] = []): FormDefinition {
  return {
    ...emptyDefinition(),
    fields: [
      { id: 'betreff', type: 'text', label: 'Betreff', required: true },
      { id: 'chef', type: 'approver', label: 'Wer gibt frei?', mapping: { target: 'article' } },
    ],
    settings: { ...emptyDefinition().settings, titleTemplate: 'VPN: {{betreff}}', group: 'IT-Support', services },
  } as FormDefinition;
}

before(async () => {
  p = await startPortal();
  z2 = await startMockZammad({ quiet: true });
  zentral = createSystem(p.app, p.zammad.url);
  nord = createSystem(p.app, z2.url, { slug: 'nord', name: 'IT Nord' });
  su = await adminClient('chef', 'Super-Admin');
  anna = new Client(p.url);
  await anna.loginEntra(p, ANNA.oid);
});
after(async () => { await z2.close(); await p.close(); });

test('Neue Funktionen sind zunächst aus, bestehende an', async () => {
  const me = await anna.get('/api/me');
  assert.equal(me.json.features.incidents, false);
  assert.equal(me.json.features.approvals, true);
  assert.equal((await anna.get('/api/portal/status')).status, 404);
  const r = await su.get('/api/admin/settings/features');
  assert.equal(r.status, 200);
  assert.ok(r.json.info.length >= 7);
});

test('Funktionen schalten nur mit „Globale Einstellungen ändern“, ungültige Werte werden abgelehnt', async () => {
  const sd = await adminClient('desk', 'Service-Desk', zentral);
  assert.equal((await sd.put('/api/admin/settings/features', { features: { incidents: true } })).status, 403);
  assert.equal((await su.put('/api/admin/settings/features', { features: { incidents: 'ja' } })).status, 422);
  assert.equal((await su.put('/api/admin/settings/features', { features: { locations: ['x'.repeat(81)] } })).status, 422);
  const r = await su.put('/api/admin/settings/features', { features: { status: true, incidents: true, maintenance: true, problems: true, locations: ['Zentrale', 'Standort Nord'] } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.features.approvals, true, 'nicht genannte Schalter bleiben');
  assert.ok(p.app.db.get("SELECT 1 FROM audit_log WHERE action = 'settings.features'"));
});

let vpn: string;
let m365: string;

test('Services anlegen; Rechte gelten je Ticketsystem', async () => {
  const r = await su.post(`/api/admin/systems/${zentral}/services`, { name: 'VPN', description: 'Zugang von außen' });
  assert.equal(r.status, 201, r.text);
  vpn = r.json.service.id;
  m365 = (await su.post(`/api/admin/systems/${zentral}/services`, { name: 'Microsoft 365' })).json.service.id;
  const desk = await adminClient('desk-nord', 'Service-Desk', nord);
  assert.equal((await desk.post(`/api/admin/systems/${zentral}/services`, { name: 'Fremd' })).status, 403);
  assert.equal((await desk.post(`/api/admin/systems/${nord}/services`, { name: 'Drucker' })).status, 201);
  // Service aus einem anderen System lässt sich nicht an eine Störung hängen
  const other = (await su.get('/api/admin/itsm')).json.services.find((s: any) => s.systemId === nord).id;
  assert.equal((await su.post(`/api/admin/systems/${zentral}/incidents`, { title: 'X', body: 'Y', impact: 'degraded', serviceIds: [other] })).status, 422);
  // Übersicht: Desk für Nord sieht nur Nord
  const list = (await desk.get('/api/admin/itsm')).json;
  assert.deepEqual(list.systems.map((s: any) => s.id), [nord]);
  assert.ok(list.services.every((s: any) => s.systemId === nord));
});

let incidentId: string;

test('Große Störung: Status, Banner, „Ich bin auch betroffen“ und Benachrichtigung bei Updates', async () => {
  const r = await su.post(`/api/admin/systems/${zentral}/incidents`, {
    title: 'VPN nicht erreichbar', body: 'Wir untersuchen das Problem.', impact: 'major_outage', major: true, serviceIds: [vpn], locations: ['Zentrale'],
  });
  assert.equal(r.status, 201, r.text);
  incidentId = r.json.incident.id;
  assert.equal(r.json.incident.number, 'INC-0001');
  assert.equal((await su.post(`/api/admin/systems/${zentral}/incidents`, { title: 'X', body: 'Y', impact: 'degraded', locations: ['Mond'] })).status, 422);

  const status = (await anna.get('/api/portal/status')).json;
  assert.equal(status.services.find((s: any) => s.id === vpn).status, 'major_outage');
  assert.equal(status.services.find((s: any) => s.id === m365).status, 'operational');
  assert.equal(status.incidents[0].title, 'VPN nicht erreichbar');
  const banner = (await anna.get('/api/portal/status/banner')).json;
  assert.equal(banner.major.length, 1);

  const a = await anna.post(`/api/portal/incidents/${incidentId}/affected`, { affected: true });
  assert.equal(a.status, 200, a.text);
  assert.equal(a.json.count, 1);
  assert.equal((await anna.post(`/api/portal/incidents/${incidentId}/affected`, { affected: true })).json.count, 1, 'doppelt zählt nicht');
  const detail = (await su.get(`/api/admin/systems/${zentral}/incidents/${incidentId}`)).json;
  assert.equal(detail.affected[0].email, ANNA.email);

  assert.equal((await su.post(`/api/admin/systems/${zentral}/incidents/${incidentId}/updates`, { state: 'identified', body: 'Zertifikat abgelaufen, wird erneuert.' })).status, 200);
  const n = (await anna.get('/api/portal/notifications')).json;
  assert.ok(n.notifications.some((x: any) => x.kind === 'incident.update' && x.link === `/stoerungen/${incidentId}`), JSON.stringify(n));
  const pub = (await anna.get(`/api/portal/incidents/${incidentId}`)).json;
  assert.equal(pub.updates.length, 2);
  assert.equal(pub.updates[0].by, undefined, 'keine Namen der Bearbeiter im Portal');
  assert.equal(pub.incident.mine, true);
});

test('Formular mit Service: Hinweis auf die Störung, Ticket bekommt den Tag der Störung', async () => {
  formId = createForm(p.app, zentral, form([vpn]), 'vpn');
  const f = (await anna.get(`/api/portal/forms/${formId}`)).json;
  assert.equal(f.notices.incidents.length, 1);
  assert.equal(f.notices.incidents[0].mine, true);
  const r = await anna.post(`/api/portal/forms/${formId}/submit`, { values: { betreff: 'Geht nicht', chef: 'alex.berger@example.org' } });
  // Freigabe ist an: die Anfrage wartet – Tag steht trotzdem schon im Ticket-Inhalt
  assert.equal(r.status, 201, r.text);
  assert.ok(r.json.approval);
});

test('Funktion „Freigabe durch Vorgesetzte“ aus: Freigabefeld entfällt, Anfrage geht direkt; Tag inc-0001 im Ticket', async () => {
  await su.put('/api/admin/settings/features', { features: { approvals: false } });
  const f = (await anna.get(`/api/portal/forms/${formId}`)).json;
  assert.ok(!f.definition.fields.some((x: any) => x.type === 'approver'));
  const r = await anna.post(`/api/portal/forms/${formId}/submit`, { values: { betreff: 'Immer noch kaputt' } });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.json.approval, null);
  await deliverAll();
  const body = p.zammad.state.requests.filter((x) => x.method === 'POST' && x.path === '/api/v1/tickets').at(-1)!.body;
  assert.ok(String(body.tags).includes('inc-0001'), String(body.tags));
  await su.put('/api/admin/settings/features', { features: { approvals: true } });
});

test('Wartung: vorab angekündigt, im Zeitfenster Status „Wartung“; Absagen', async () => {
  const now = Date.now();
  const soon = await su.post(`/api/admin/systems/${zentral}/maintenances`, { title: 'Update Mailserver', body: 'Kurze Unterbrechungen', startsAt: now + 3600_000, endsAt: now + 7200_000, serviceIds: [m365] });
  assert.equal(soon.status, 201, soon.text);
  assert.equal((await su.post(`/api/admin/systems/${zentral}/maintenances`, { title: 'X', startsAt: now + 10, endsAt: now })).status, 422);
  let status = (await anna.get('/api/portal/status')).json;
  assert.equal(status.services.find((s: any) => s.id === m365).status, 'operational');
  assert.equal(status.maintenances.length, 1);
  const running = await su.post(`/api/admin/systems/${zentral}/maintenances`, { title: 'Läuft', startsAt: now - 60_000, endsAt: now + 3600_000, serviceIds: [m365] });
  status = (await anna.get('/api/portal/status')).json;
  assert.equal(status.services.find((s: any) => s.id === m365).status, 'maintenance');
  assert.equal((await anna.get('/api/portal/status/banner')).json.maintenanceNow.length, 1);
  await su.post(`/api/admin/systems/${zentral}/maintenances/${running.json.maintenance.id}/cancel`);
  status = (await anna.get('/api/portal/status')).json;
  assert.equal(status.services.find((s: any) => s.id === m365).status, 'operational');
});

test('Problem: Ticket aus Zammad verknüpfen setzt den Tag dort, bekannter Fehler erscheint im Portal', async () => {
  const pr = await su.post(`/api/admin/systems/${zentral}/problems`, { title: 'VPN-Zertifikat läuft unbemerkt ab', serviceId: vpn, rootCause: 'Keine Überwachung', workaround: 'Neu verbinden' });
  assert.equal(pr.status, 201, pr.text);
  const id = pr.json.problem.id;
  assert.equal(pr.json.problem.number, 'PRB-0001');
  const ticket = p.zammad.state.tickets.at(-1)!;
  const link = await su.post(`/api/admin/systems/${zentral}/problems/${id}/tickets`, { number: ticket.number });
  assert.equal(link.status, 200, link.text);
  assert.ok(ticket.tags.includes('prb-0001'));
  assert.equal((await su.post(`/api/admin/systems/${zentral}/problems/${id}/tickets`, { number: '999999' })).status, 422);
  const detail = (await su.get(`/api/admin/systems/${zentral}/problems/${id}`)).json;
  assert.equal(detail.tickets[0].number, ticket.number);
  // Störung dem Problem zuordnen
  assert.equal((await su.put(`/api/admin/systems/${zentral}/incidents/${incidentId}`, { problemId: id })).status, 200);
  assert.equal((await su.get(`/api/admin/systems/${zentral}/problems/${id}`)).json.problem.incidents[0].number, 'INC-0001');
  // Noch nicht öffentlich
  assert.equal((await anna.get('/api/portal/status')).json.problems.length, 0);
  await su.put(`/api/admin/systems/${zentral}/problems/${id}`, { title: 'VPN-Zertifikat läuft unbemerkt ab', state: 'known_error', public: true, workaround: 'Neu verbinden' });
  const pub = (await anna.get('/api/portal/status')).json.problems;
  assert.equal(pub.length, 1);
  assert.equal(pub[0].workaround, 'Neu verbinden');
  assert.equal(pub[0].rootCause, undefined, 'Ursache bleibt intern');
  assert.equal((await su.del(`/api/admin/systems/${zentral}/problems/${id}/tickets/${ticket.id}`)).status, 200);
  assert.ok(!ticket.tags.includes('prb-0001'));
});

test('Behoben: Status zurück, Betroffene benachrichtigt, „betroffen“ nicht mehr möglich', async () => {
  await su.post(`/api/admin/systems/${zentral}/incidents/${incidentId}/updates`, { state: 'resolved', body: 'Zertifikat erneuert, VPN läuft.' });
  const status = (await anna.get('/api/portal/status')).json;
  assert.equal(status.services.find((s: any) => s.id === vpn).status, 'operational');
  assert.equal(status.incidents.find((i: any) => i.id === incidentId).state, 'resolved');
  assert.equal((await anna.post(`/api/portal/incidents/${incidentId}/affected`, { affected: true })).status, 409);
  assert.equal((await anna.get('/api/portal/status/banner')).json.major.length, 0);
});

test('Störungen anderer Ticketsysteme bleiben unsichtbar', async () => {
  // Nord nur für eine Gruppe, die Anna nicht hat
  p.app.db.run('UPDATE ticket_systems SET visible_groups = ? WHERE id = ?', JSON.stringify(['grp-nord']), nord);
  const r = await su.post(`/api/admin/systems/${nord}/incidents`, { title: 'Drucker Nord', body: 'Kaputt', impact: 'degraded', major: true });
  assert.equal(r.status, 201, r.text);
  assert.equal((await anna.get(`/api/portal/incidents/${r.json.incident.id}`)).status, 404);
  assert.equal((await anna.post(`/api/portal/incidents/${r.json.incident.id}/affected`, {})).status, 404);
  assert.ok(!(await anna.get('/api/portal/status')).json.incidents.some((i: any) => i.id === r.json.incident.id));
  assert.equal((await anna.get('/api/portal/status/banner')).json.major.length, 0);
});

test('Funktion aus: Portal liefert nichts mehr, Formular ohne Hinweise', async () => {
  await su.put('/api/admin/settings/features', { features: { status: false, incidents: false, maintenance: false, problems: false } });
  assert.equal((await anna.get('/api/portal/status')).status, 404);
  assert.equal((await anna.get(`/api/portal/incidents/${incidentId}`)).status, 404);
  const f = (await anna.get(`/api/portal/forms/${formId}`)).json;
  assert.deepEqual(f.notices, { incidents: [], maintenances: [] });
  const b = (await anna.get('/api/portal/status/banner')).json;
  assert.equal(b.major.length + b.maintenanceNow.length, 0);
});
