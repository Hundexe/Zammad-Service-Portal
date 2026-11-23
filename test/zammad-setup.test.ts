// Zammad-Zuordnung, Einrichtung durch das Portal, Abhängigkeiten (Core Workflows) und Übernahme aus 1.x.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startPortal, Client, createSystem, createUser, type Portal } from './helpers.ts';
import { applySetup, checkSetup, workflowDefs } from '../src/server/services/zammad-setup.ts';
import { getSystem } from '../src/server/services/systems.ts';
import { planMigration, runMigration } from '../src/server/services/zammad-migrate.ts';
import { normalizeMapping } from '../src/shared/zammad-model.ts';
import { uuid } from '../src/server/db/db.ts';

let p: Portal;
let su: Client;
let sysId: string;
const sys = () => getSystem(p.app, sysId)!;

before(async () => {
  p = await startPortal();
  sysId = createSystem(p.app, p.zammad.url);
  await createUser(p.app, { username: 'chef', role: 'Super-Admin' });
  su = new Client(p.url);
  await su.loginLocal('chef', 'Test-Passwort-123!');
  // Wie eine bestehende Zammad-Installation: eigene Ticketart mit „Störung“
  p.zammad.state.attributes.push({ id: 90, object: 'Ticket', name: 'ticketart', display: 'Ticketart', data_type: 'select', active: true, editable: true, data_option: { options: { stoerung: 'Störung', anfrage: 'Anfrage', problem: 'Problem' } } });
  await su.put('/api/admin/settings/features', { features: { status: true, incidents: true, maintenance: true, problems: true } });
});
after(async () => { await p.close(); });

test('Zuordnung prüfen: ungültige Namen, doppelte Attribute, Systemfelder', () => {
  assert.throws(() => normalizeMapping({ attrs: { kind: 'Portal Art' } }), /ungültig/);
  assert.throws(() => normalizeMapping({ attrs: { kind: 'state_id' } }), /ungültig/);
  assert.throws(() => normalizeMapping({ attrs: { kind: 'x_art', phase: 'x_art' } }), /mehrfach/);
  assert.throws(() => normalizeMapping({ kinds: { incident: { hide: ['state_id'] } } }), /nicht ausblenden/);
  assert.throws(() => normalizeMapping({ kinds: { incident: { fields: { portal_art: 'x' } } } }), /nicht erlaubt/);
  assert.throws(() => normalizeMapping({ approval: { pendingTags: ['a,b'] } }), /ungültiger Tag/);
  const m = normalizeMapping({ attrs: { locations: 'standort' }, kinds: { maintenance: { group: '', tags: ['Wartung'], hide: ['sec_status'] } } });
  assert.equal(m.attrs.locations, 'standort');
  assert.equal(m.attrs.kind, 'portal_art', 'Rest bleibt Standard');
  assert.equal(m.kinds.maintenance.group, '');
});

test('Ohne Admin-Rechte in Zammad: Prüfung meldet das verständlich, Hinweis in der Übersicht', async () => {
  p.zammad.setAdmin(false);
  p.zammad.state.attributes; // Attributliste ist lesbar, Anlegen nicht
  const r = await su.post(`/api/admin/systems/${sysId}/zammad/check`);
  assert.equal(r.status, 200);
  assert.match(r.json.report.error ?? '', /403|Not authorized/);
  const w: string[] = (await su.get('/api/admin/overview')).json.warnings;
  assert.ok(w.some((x) => /Admin-Rechte/.test(x)), w.join('\n'));
  assert.equal((await su.post(`/api/admin/systems/${sysId}/zammad/apply`)).status, 502);
  p.zammad.setAdmin(true);
});

test('Überschneidungen: vorhandene Attribute und Werte werden vorgeschlagen', async () => {
  const r = (await su.post(`/api/admin/systems/${sysId}/zammad/check`)).json.report;
  assert.equal(r.error, null);
  const s = r.suggestions;
  assert.ok(s.some((x: any) => x.type === 'attr' && x.key === 'locations' && x.attribute === 'standort'));
  assert.ok(s.some((x: any) => x.type === 'kind' && x.kind === 'incident' && x.attribute === 'ticketart' && x.value === 'stoerung'));
  assert.ok(s.some((x: any) => x.type === 'kind' && x.kind === 'problem' && x.attribute === 'ticketart' && x.value === 'problem'));
  assert.ok(!s.some((x: any) => x.type === 'kind' && x.kind === 'maintenance'), 'keine Wartung in der Ticketart');
  assert.ok(r.others.some((a: any) => a.name === 'sec_status'), 'übrige Felder zum Ausblenden');
});

test('Eigene Struktur: Gruppe, Zusatzwerte, Tags, Standort-Attribut, ausgeblendete Felder – Portal richtet ein', async () => {
  const put = await su.put(`/api/admin/systems/${sysId}/zammad`, { mapping: {
    attrs: { locations: 'standort' },
    kinds: {
      incident: { group: 'IT-Support', fields: { ticketart: 'stoerung' }, tags: [] },
      maintenance: { group: 'IT-Support', fields: { ticketart: 'wartung' }, tags: ['Wartung'], hide: ['sec_status', 'dringend'] },
      problem: { group: 'IT-Support', fields: { ticketart: 'problem', gibtsnicht: 'x' } },
    },
    affectedTags: ['betroffen'],
  } });
  assert.equal(put.status, 200, put.text);
  const r = put.json.report;
  assert.deepEqual(r.missing.groups, [], 'vorhandene Gruppe genügt');
  assert.ok(r.missing.options.some((o: any) => o.attribute === 'ticketart' && o.values.includes('wartung')), 'fehlender Wert wird ergänzt');
  assert.ok(r.problems.some((x: string) => /gibtsnicht/.test(x)), 'fremdes Attribut legt das Portal nicht an');
  assert.ok(!r.missing.attributes.some((a: any) => a.name === 'portal_standorte'), 'umgelenkt auf standort');
  const applied = await su.post(`/api/admin/systems/${sysId}/zammad/apply`);
  assert.equal(applied.status, 201, applied.text);
  assert.ok(applied.json.created.some((c: string) => /Abhängigkeit/.test(c)));
  const ticketart = p.zammad.state.attributes.find((a: any) => a.name === 'ticketart');
  assert.deepEqual(Object.keys(ticketart.data_option.options), ['stoerung', 'anfrage', 'problem', 'wartung'], 'vorhandene Werte bleiben');
  assert.ok(!p.zammad.state.groups.some((g) => g.name === 'Störungen'));
  // Abhängigkeiten: Wartung blendet die gewählten Felder aus, Portal-Standort ist das vorhandene Feld
  const wf = p.zammad.state.workflows.find((w: any) => w.name === 'Portal: Wartung')!;
  assert.equal(wf.perform['ticket.sec_status'].operator, 'hide');
  assert.equal(wf.perform['ticket.dringend'].operator, 'hide');
  assert.equal(wf.perform['ticket.standort'].operator, 'show');
  assert.equal(wf.perform['ticket.portal_stoerung_beginn'], undefined, 'Störungsfelder nicht bei Wartungen');
  // Zweiter Lauf ändert die Abhängigkeiten nur (keine Doppelten)
  const n = p.zammad.state.workflows.length;
  await applySetup(p.app, sys());
  assert.equal(p.zammad.state.workflows.length, n);
  assert.deepEqual(workflowDefs(p.app, sys()).map((d) => d.name).sort(), p.zammad.state.workflows.map((w: any) => w.name).sort());

  // Wartung anlegen: Zusatzwerte, Tags, Standort als Einfachauswahl
  const now = Date.now();
  const m = await su.post(`/api/admin/systems/${sysId}/maintenances`, { title: 'Netzwerk', body: 'Umbau', startsAt: now + 3600_000, endsAt: now + 7200_000, locations: ['Standort Nord'] });
  assert.equal(m.status, 201, m.text);
  const t = p.zammad.state.tickets.find((x) => `${sysId}.${x.id}` === m.json.maintenance.id)!;
  assert.equal(t.ticketart, 'wartung');
  assert.equal(t.standort, 'nord', 'Einfachauswahl bekommt einen Wert');
  assert.ok(t.tags.includes('Wartung'));
  assert.equal(p.zammad.state.groups.find((g) => g.id === t.group_id)!.name, 'IT-Support');
  assert.deepEqual(m.json.maintenance.locations, ['Standort Nord']);
  assert.equal((await su.post(`/api/admin/systems/${sysId}/maintenances`, { title: 'X', startsAt: now + 10, endsAt: now + 20, locations: ['Mond'] })).status, 422);
});

test('Abhängigkeiten abschaltbar', async () => {
  await su.put(`/api/admin/systems/${sysId}/zammad`, { mapping: { workflows: false } });
  assert.deepEqual(workflowDefs(p.app, sys()), []);
  assert.deepEqual((await checkSetup(p.app, sys())).workflows, []);
  await su.put(`/api/admin/systems/${sysId}/zammad`, { mapping: {} });
});

test('Übernahme aus 1.x: Probe, Lauf, kein zweites Mal', async () => {
  await applySetup(p.app, sys());
  const t = Date.now();
  const db = p.app.db;
  const svc = db.get<{ id: string }>('SELECT id FROM services WHERE system_id = ?', sysId)?.id ?? (() => {
    const id = uuid();
    db.run("INSERT INTO services (id, system_id, name, zkey, created_at, updated_at) VALUES (?, ?, 'VPN', 'vpn', ?, ?)", id, sysId, t, t);
    return id;
  })();
  db.run("INSERT INTO problems (id, number, system_id, title, state, description, root_cause, workaround, public, owner, created_at, updated_at) VALUES ('p1', 1, ?, 'Zertifikat', 'known_error', 'Läuft ab', 'Keine Überwachung', 'Neu verbinden', 1, 'Team Netz', ?, ?)", sysId, t, t);
  db.run("INSERT INTO incidents (id, number, system_id, title, impact, major, state, locations, started_at, problem_id, created_at, updated_at) VALUES ('i1', 1, ?, 'VPN weg', 'major_outage', 1, 'identified', '[\"Zentrale\"]', ?, 'p1', ?, ?)", sysId, t - 3600_000, t, t);
  db.run('INSERT INTO incident_services (incident_id, service_id) VALUES (?, ?)', 'i1', svc);
  db.run("INSERT INTO incident_updates (id, incident_id, state, body, created_at) VALUES ('u1', 'i1', 'investigating', 'Wir prüfen', ?), ('u2', 'i1', 'identified', 'Zertifikat', ?)", t - 3600_000, t - 60_000);
  db.run("INSERT INTO maintenances (id, system_id, title, body, starts_at, ends_at, locations, cancelled, created_at, updated_at) VALUES ('m1', ?, 'Alt', 'vorbei', ?, ?, '[]', 0, ?, ?)", sysId, t - 7200_000, t - 3600_000, t, t);
  const plan = await planMigration(p.app);
  assert.deepEqual(plan.map((x) => [x.incidents, x.maintenances, x.problems, x.ready]), [[1, 1, 1, true]], JSON.stringify(plan));
  const before = p.zammad.state.tickets.length;
  const res = await runMigration(p.app);
  assert.deepEqual(res[0]!.errors, []);
  assert.equal(p.zammad.state.tickets.length, before + 3);
  const inc = p.zammad.state.tickets.find((x) => x.title === 'VPN weg')!;
  const prb = p.zammad.state.tickets.find((x) => x.title === 'Zertifikat')!;
  assert.equal(inc.portal_problem, prb.id);
  assert.equal(inc.portal_phase, 'identified');
  assert.equal(prb.portal_workaround, 'Neu verbinden');
  assert.equal(p.zammad.state.articles.filter((a) => a.ticket_id === inc.id && !a.internal).length, 2, 'beide Updates');
  const mnt = p.zammad.state.tickets.find((x) => x.title === 'Alt')!;
  assert.equal(p.zammad.state.states.find((s) => s.id === mnt.state_id)!.name, 'closed', 'vorbei → geschlossen');
  assert.deepEqual(await planMigration(p.app), []);
  await runMigration(p.app);
  assert.equal(p.zammad.state.tickets.length, before + 3, 'nichts doppelt');
});
