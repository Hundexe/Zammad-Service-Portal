// ITSM-Grundausstattung: Vorschau, Anlegen, nichts doppelt, Vorhandenes bleibt.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startPortal, Client, createSystem, createUser, type Portal } from './helpers.ts';
import { normalizeBaseline, PRIORITY_NAMES } from '../src/shared/zammad-baseline.ts';

let p: Portal;
let su: Client;
let sysId: string;

before(async () => {
  p = await startPortal();
  sysId = createSystem(p.app, p.zammad.url);
  await createUser(p.app, { username: 'chef', role: 'Super-Admin' });
  su = new Client(p.url);
  await su.loginLocal('chef', 'Test-Passwort-123!');
  // Stufe 2 geht an einen Benutzer, den es in Zammad gibt
  await su.get('/api/me');
});
after(async () => { await p.close(); });

test('Einstellungen werden geprüft', () => {
  assert.throws(() => normalizeBaseline({ calendar: { from: '18:00', to: '08:00' } }), /Arbeitszeit/);
  assert.throws(() => normalizeBaseline({ calendar: { days: ['mon', 'feiertag'] } }), /Arbeitstage/);
  assert.throws(() => normalizeBaseline({ sla: { response: [30, 60, 240] } }), /vier Werte/);
  assert.throws(() => normalizeBaseline({ sla: { response: [300, 60, 240, 480], solution: [240, 480, 1440, 2400] } }), /kürzer/);
  assert.throws(() => normalizeBaseline({ autoClose: { remindDays: 5, closeDays: 3 } }), /nach der Erinnerung/);
  assert.throws(() => normalizeBaseline({ escalation: { stage2Email: 'keine-adresse' } }), /ungültig/);
  assert.throws(() => normalizeBaseline({ customerLink: 'http://unsicher.example.org' }), /https/);
  assert.equal(normalizeBaseline({}).calendar.timezone, 'Europe/Berlin');
});

test('Vorschau, Anlegen, zweiter Lauf legt nichts doppelt an', async () => {
  const d = (await su.get(`/api/admin/systems/${sysId}/zammad/baseline`)).json;
  assert.equal(d.defaults.customerLink, 'https://portal.test', 'Standard: Adresse des Portals');
  const options = { ...d.defaults, escalation: { stage2Hours: 4, stage2Email: 'support@example.org' }, customerLink: 'https://hilfe.example.org' };
  const pv = await su.post(`/api/admin/systems/${sysId}/zammad/baseline/preview`, { options });
  assert.equal(pv.status, 200, pv.text);
  const items = pv.json.items as { kind: string; name: string; status: string }[];
  assert.ok(items.every((i) => i.status === 'neu'), JSON.stringify(items.filter((i) => i.status !== 'neu')));
  assert.equal(items.filter((i) => i.kind === 'trigger' && i.name.includes('Priorität')).length, 9, 'Matrix 3 × 3');

  const r = await su.post(`/api/admin/systems/${sysId}/zammad/baseline/apply`, { options });
  assert.equal(r.status, 201, r.text);
  assert.deepEqual(r.json.errors, []);
  const z = p.zammad.state;
  for (const n of PRIORITY_NAMES) assert.ok(z.priorities.some((x) => x.name === n), n);
  for (const n of ['In Bearbeitung', 'Warten auf Rückmeldung', 'Warten auf Dritte', 'Gelöst']) assert.ok(z.states.some((x) => x.name === n), n);
  assert.equal((z.states.find((x) => x.name === 'Warten auf Rückmeldung') as any).ignore_escalation, true, 'Warten hält die SLA an');
  assert.equal((z.states.find((x) => x.name === 'In Bearbeitung') as any).ignore_escalation, false);
  assert.ok(z.attributes.some((a: any) => a.name === 'itsm_ticketart'));
  // SLAs mit Kalender und Prioritäten
  const cal = z.admin.calendars![0];
  assert.equal(cal.business_hours.mon.active, true);
  assert.equal(cal.business_hours.sat.active, false);
  assert.deepEqual(cal.business_hours.mon.timeframes, [['08:00', '17:00']]);
  const p1 = z.priorities.find((x) => x.name === 'P1 Kritisch')!;
  const sla1 = z.admin.slas!.find((x) => x.name === 'SLA P1 Kritisch');
  assert.deepEqual(sla1.condition, { 'ticket.priority_id': { operator: 'is', value: [String(p1.id)] } });
  assert.equal(sla1.first_response_time, 30);
  assert.equal(sla1.calendar_id, cal.id);
  // Matrix: ganze Organisation + hoch → P1
  const m = z.admin.triggers!.find((x) => x.name === 'ITSM – Priorität Ganze Organisation + Hoch');
  assert.ok(m, z.admin.triggers!.map((x) => x.name).join('\n'));
  assert.equal(m.perform['ticket.priority_id'].value, String(p1.id));
  // Nachrichten: neutral, mit Link fürs Portal, ohne Firmennamen
  const ack = z.admin.triggers!.find((x) => x.name === 'ITSM – Eingangsbestätigung');
  assert.match(ack.perform['notification.email'].body, /hilfe\.example\.org/);
  assert.deepEqual(ack.perform['notification.email'].recipient, ['ticket_customer']);
  // Schließen und Eskalation
  const esc1 = z.admin.triggers!.find((x) => x.name === 'ITSM – Eskalation Stufe 1');
  assert.equal(esc1.activator, 'time');
  const esc2 = z.admin.jobs!.find((x) => x.name === 'ITSM – Eskalation Stufe 2');
  assert.deepEqual(esc2.perform['notification.email'].recipient, ['userid_2']);
  assert.ok(z.admin.jobs!.some((x) => x.name === 'ITSM – Gelöst nach Frist schließen'));
  // Übersichten für Agenten
  assert.ok(z.admin.overviews!.some((x) => x.name === 'Eskaliert' && x.role_ids[0] === 2));
  assert.ok(z.admin.overviews!.some((x) => x.name === 'Offene Störungen'));

  const counts = () => [z.priorities.length, z.states.length, z.admin.triggers!.length, z.admin.jobs!.length, z.admin.overviews!.length, z.admin.slas!.length].join();
  const before = counts();
  const again = await su.post(`/api/admin/systems/${sysId}/zammad/baseline/apply`, { options });
  assert.deepEqual(again.json.created, []);
  assert.equal(counts(), before);
  assert.ok(again.json.items.every((i: any) => i.status === 'vorhanden'));
});

test('Ähnliche Felder in Zammad: Prioritätsmatrix wird übersprungen, vorhandene Ticketart genutzt', async () => {
  const other = createSystem(p.app, p.zammad.url, { slug: 'zweit', name: 'Zweit' });
  // ein zweites Zammad mit eigenen Feldern „Auswirkung“ und „Ticketart“
  const { startMockZammad } = await import('../tools/mock-zammad.ts');
  const z2 = await startMockZammad({ quiet: true });
  try {
    p.app.db.run('UPDATE ticket_systems SET base_url = ? WHERE id = ?', z2.url, other);
    z2.state.attributes.push({ id: 91, object: 'Ticket', name: 'auswirkung', display: 'Auswirkung', data_type: 'select', active: true, editable: true, data_option: { options: { a: 'A' } } });
    z2.state.attributes.push({ id: 92, object: 'Ticket', name: 'ticketart', display: 'Ticketart', data_type: 'select', active: true, editable: true, data_option: { options: { stoerung: 'Störung' } } });
    const options = (await su.get(`/api/admin/systems/${other}/zammad/baseline`)).json.defaults;
    const items = (await su.post(`/api/admin/systems/${other}/zammad/baseline/preview`, { options })).json.items;
    assert.ok(items.filter((i: any) => i.part === 'priority').every((i: any) => i.status === 'übersprungen'));
    assert.equal(items.find((i: any) => i.part === 'types').status, 'übersprungen');
    const r = await su.post(`/api/admin/systems/${other}/zammad/baseline/apply`, { options });
    assert.equal(r.status, 201, r.text);
    assert.ok(!z2.state.attributes.some((a: any) => a.name === 'itsm_auswirkung'));
    const inc = z2.state.admin.overviews!.find((x) => x.name === 'Offene Störungen');
    assert.deepEqual(inc.condition['ticket.ticketart'], { operator: 'is', value: ['stoerung'] }, 'vorhandene Ticketart');
  } finally { await z2.close(); }
});

test('Nur mit Recht „Ticketsystem verwalten“, Anlegen braucht Bestätigung', async () => {
  await createUser(p.app, { username: 'desk', role: 'Service-Desk', systemId: sysId });
  const desk = new Client(p.url);
  await desk.loginLocal('desk', 'Test-Passwort-123!');
  assert.equal((await desk.post(`/api/admin/systems/${sysId}/zammad/baseline/preview`, {})).status, 403);
  assert.equal((await desk.post(`/api/admin/systems/${sysId}/zammad/baseline/apply`, {})).status, 403);
});
