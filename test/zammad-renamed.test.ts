// Zammad mit umbenannten Status („1 Neu“, „2 In Arbeit“, „9 Erledigt“) und Core Workflows aus 2.0.0,
// die Zammad wegen changeable: false nicht mehr über die API zeigt.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startPortal, Client, createSystem, createUser, ENTRA_USERS, type Portal } from './helpers.ts';
import { applySetup, checkSetup, lockedWorkflows } from '../src/server/services/zammad-setup.ts';
import { getSystem } from '../src/server/services/systems.ts';
import { itsmHousekeeping } from '../src/server/services/itsm.ts';
import { resetStateCache } from '../src/server/services/zammad-states.ts';

const [ANNA] = ENTRA_USERS;
let p: Portal;
let su: Client;
let anna: Client;
let sysId: string;
const sys = () => getSystem(p.app, sysId)!;
const stateOf = (id: number) => p.zammad.state.states.find((s) => s.id === p.zammad.state.tickets.find((t) => t.id === id)!.state_id)!.name;
const ticketOf = (ref: string) => Number(ref.split('.')[1]);

before(async () => {
  p = await startPortal({}, { renamedStates: true });
  sysId = createSystem(p.app, p.zammad.url);
  await createUser(p.app, { username: 'chef', role: 'Super-Admin' });
  su = new Client(p.url);
  await su.loginLocal('chef', 'Test-Passwort-123!');
  anna = new Client(p.url);
  await anna.loginEntra(p, ANNA.oid);
  await su.put('/api/admin/settings/features', { features: { status: true, incidents: true, maintenance: true, problems: true, approvals: true } });
  // Von 2.0.0 angelegt: ohne changeable – für die API unsichtbar und nicht änderbar
  p.zammad.state.workflows.push({ id: 900, name: 'Portal: Felder ausblenden', object: 'Ticket', active: true, changeable: false, condition_saved: {}, condition_selected: {}, perform: {} });
});
after(async () => { await p.close(); });

test('Einrichtung: bereit nach applySetup, zweimal hintereinander ohne Fehler, gesperrter Workflow als Hinweis', async () => {
  const before = await checkSetup(p.app, sys());
  assert.equal(before.ready, false);
  assert.equal(before.error, null);
  assert.ok(!before.problems.some((x) => /Status/.test(x)), before.problems.join('\n'));
  assert.deepEqual(before.resolvedStates, { new: '1 Neu', open: '2 In Arbeit', closed: '9 Erledigt' });

  const first = await applySetup(p.app, sys());
  assert.equal(first.ready, true, JSON.stringify({ missing: first.missing, problems: first.problems, workflows: first.workflows }));
  assert.ok(first.missing.states.length === 0);
  assert.ok(p.zammad.state.states.some((s) => s.name === 'wartet auf Freigabe' && s.state_type_id === 2), 'Freigabe-Status vom Typ offen angelegt');
  assert.deepEqual(lockedWorkflows(p.app, sysId), ['Portal: Felder ausblenden']);
  assert.ok(first.notes.some((n) => /gesperrt/.test(n) && /changeable: true/.test(n)), first.notes.join('\n'));
  const count = p.zammad.state.workflows.length;

  const second = await applySetup(p.app, sys());
  assert.equal(second.ready, true);
  assert.equal(second.created.filter((c) => /Abhängigkeit/.test(c)).length, 0, 'nichts doppelt angelegt');
  assert.equal(p.zammad.state.workflows.length, count);
  assert.ok((await checkSetup(p.app, sys())).ready);

  // Neue Workflows tragen die Kennung in der Notiz und sind änderbar
  const wf = p.zammad.state.workflows.find((w) => w.name === 'Portal: Wartung')!;
  assert.equal(wf.changeable, true);
  assert.match(String(wf.note), /\[portal:kind-maintenance\]/);
});

test('Freigegebener Workflow wird wiedergefunden, auch wenn er in Zammad umbenannt wurde', async () => {
  const locked = p.zammad.state.workflows.find((w) => w.id === 900)!;
  locked.changeable = true; // so wie nach dem Freigabe-Befehl auf dem Zammad-Server
  const r = await applySetup(p.app, sys());
  assert.equal(r.ready, true);
  assert.equal(locked.perform['ticket.portal_art'], undefined);
  assert.equal(locked.perform['ticket.portal_wartung_beginn'].operator, 'hide', 'alter Workflow aktualisiert statt neu angelegt');
  assert.deepEqual(lockedWorkflows(p.app, sysId), []);
  const wf = p.zammad.state.workflows.find((w) => w.name === 'Portal: Wartung')!;
  wf.name = 'Wartung (Portal)';
  const n = p.zammad.state.workflows.length;
  assert.equal((await applySetup(p.app, sys())).ready, true);
  assert.equal(p.zammad.state.workflows.length, n, 'über die Kennung gefunden');
});

test('Störung: betroffen, nicht mehr betroffen, behoben – mit den umbenannten Status', async () => {
  const svc = (await su.post(`/api/admin/systems/${sysId}/services`, { name: 'VPN' })).json.service.id;
  const inc = await su.post(`/api/admin/systems/${sysId}/incidents`, { title: 'VPN weg', body: 'Wir prüfen.', impact: 'major_outage', serviceIds: [svc] });
  assert.equal(inc.status, 201, inc.text);
  const id = inc.json.incident.id;
  assert.equal(stateOf(ticketOf(id)), '1 Neu');
  const a = await anna.post(`/api/portal/incidents/${id}/affected`, { affected: true });
  assert.equal(a.status, 200, a.text);
  const child = p.zammad.state.tickets.find((t) => t.portal_stoerung === ticketOf(id))!;
  assert.equal(stateOf(child.id), '1 Neu');
  assert.equal((await anna.post(`/api/portal/incidents/${id}/affected`, { affected: false })).status, 200);
  assert.equal(stateOf(child.id), '9 Erledigt');
  assert.equal((await anna.post(`/api/portal/incidents/${id}/affected`, { affected: true })).status, 200);
  const again = p.zammad.state.tickets.filter((t) => t.portal_stoerung === ticketOf(id)).at(-1)!;
  assert.notEqual(again.id, child.id, 'geschlossenes Ticket zählt nicht mehr – neues Ticket');
  assert.equal(stateOf(again.id), '1 Neu');
  const done = await su.post(`/api/admin/systems/${sysId}/incidents/${id}/updates`, { state: 'resolved', body: 'Läuft wieder.' });
  assert.equal(done.status, 200, done.text);
  assert.equal(stateOf(ticketOf(id)), '9 Erledigt');
  assert.equal(stateOf(again.id), '9 Erledigt', 'Betroffene mit geschlossen');
});

test('Wartung: Absagen und Abschluss durch den Worker schließen mit „9 Erledigt“', async () => {
  const now = Date.now();
  const cancel = await su.post(`/api/admin/systems/${sysId}/maintenances`, { title: 'Absage', startsAt: now + 3600_000, endsAt: now + 7200_000 });
  assert.equal(cancel.status, 201, cancel.text);
  assert.equal((await su.post(`/api/admin/systems/${sysId}/maintenances/${cancel.json.maintenance.id}/cancel`)).status, 200);
  assert.equal(stateOf(ticketOf(cancel.json.maintenance.id)), '9 Erledigt');
  const run = await su.post(`/api/admin/systems/${sysId}/maintenances`, { title: 'Läuft ab', startsAt: now + 3600_000, endsAt: now + 7200_000 });
  const t = p.zammad.state.tickets.find((x) => x.id === ticketOf(run.json.maintenance.id))!;
  t.portal_wartung_beginn = new Date(now - 5000).toISOString();
  t.portal_wartung_ende = new Date(now - 1000).toISOString();
  assert.equal((await itsmHousekeeping(p.app)).maintenancesClosed, 1);
  assert.equal(stateOf(t.id), '9 Erledigt');
});

test('Problem: schließen und wieder öffnen', async () => {
  const pr = await su.post(`/api/admin/systems/${sysId}/problems`, { title: 'Zertifikat läuft ab', rootCause: 'Keine Überwachung' });
  assert.equal(pr.status, 201, pr.text);
  const id = pr.json.problem.id;
  assert.equal((await su.put(`/api/admin/systems/${sysId}/problems/${id}`, { title: 'Zertifikat läuft ab', state: 'closed' })).status, 200);
  assert.equal(stateOf(ticketOf(id)), '9 Erledigt');
  assert.equal((await su.put(`/api/admin/systems/${sysId}/problems/${id}`, { title: 'Zertifikat läuft ab', state: 'analysis' })).status, 200);
  assert.equal(stateOf(ticketOf(id)), '2 In Arbeit');
});

test('Status aus der Zuordnung hat Vorrang; unbekannter Name fällt auf den Typ zurück und wird gemeldet', async () => {
  const put = await su.put(`/api/admin/systems/${sysId}/zammad`, { mapping: { states: { open: '3 Rückfrage', closed: 'Gibt es nicht' } } });
  assert.equal(put.status, 200, put.text);
  const r = await checkSetup(p.app, sys());
  assert.equal(r.resolvedStates.open, '3 Rückfrage');
  assert.equal(r.resolvedStates.closed, '9 Erledigt');
  assert.ok(r.notes.some((n) => /Gibt es nicht/.test(n)), r.notes.join('\n'));
  assert.equal(r.problems.length, 0);
  // Ohne jeden Status vom Typ „geschlossen“: verständlicher Fehler statt „Status open gibt es nicht“
  const saved = p.zammad.state.states.map((s) => ({ ...s }));
  for (const s of p.zammad.state.states) if ([5, 6, 7].includes(s.state_type_id)) s.active = false;
  resetStateCache(sysId);
  const r2 = await checkSetup(p.app, sys());
  assert.ok(r2.problems.some((x) => /Typ „closed“/.test(x)), r2.problems.join('\n'));
  p.zammad.state.states.splice(0, p.zammad.state.states.length, ...saved);
  resetStateCache(sysId);
  await su.put(`/api/admin/systems/${sysId}/zammad`, { mapping: {} });
});

test('Übersichten in Zammad: Freigabe, Störungen, Wartungen, Probleme und je Formular; Namen anpassbar', async () => {
  const { createForm } = await import('./helpers.ts');
  const formId = createForm(p.app, sysId, undefined, 'software');
  const ov = () => p.zammad.state.admin.overviews!;
  assert.deepEqual(ov().map((o) => o.link).sort(), ['portal_approvals', 'portal_incidents', 'portal_maintenance', 'portal_problems']);
  const inc = ov().find((o) => o.link === 'portal_incidents')!;
  assert.equal(inc.name, 'Störungen');
  assert.deepEqual(inc.role_ids, [2]);
  assert.deepEqual(inc.condition['ticket.portal_art'], { operator: 'is', value: ['stoerung'] });
  const ids: string[] = inc.condition['ticket.state_id'].value;
  const closed = p.zammad.state.states.filter((s) => [5, 6, 7].includes(s.state_type_id)).map((s) => String(s.id));
  assert.ok(ids.length > 0 && !ids.some((i) => closed.includes(i)), 'nur nicht geschlossene Status');
  assert.ok(ids.includes(String(p.zammad.state.states.find((s) => s.name === 'wartet auf Freigabe')!.id)), 'auch wartende');
  assert.deepEqual(ov().find((o) => o.link === 'portal_approvals')!.condition, { 'ticket.portal_freigabe': { operator: 'is', value: ['ausstehend'] } });

  // Umbenennen und eigene Übersicht je Formular
  const put = await su.put(`/api/admin/systems/${sysId}/zammad`, { mapping: { overviews: { builtin: { incidents: { name: 'Offene Störungen (Portal)' }, problems: { active: false } }, forms: [{ formId, name: 'Software-Anfragen' }] } } });
  assert.equal(put.status, 200, put.text);
  const chk = await checkSetup(p.app, sys());
  assert.deepEqual(chk.missing.overviews, ['Software-Anfragen']);
  const r = await applySetup(p.app, sys());
  assert.equal(r.ready, true, JSON.stringify(r.missing));
  assert.equal(ov().filter((o) => o.link === 'portal_incidents').length, 1, 'kein zweites Mal angelegt');
  assert.equal(ov().find((o) => o.link === 'portal_incidents')!.name, 'Offene Störungen (Portal)');
  const sw = ov().find((o) => o.name === 'Software-Anfragen')!;
  assert.match(sw.link, /^portal_form_/);
  assert.deepEqual(sw.condition['ticket.portal_formular'], { operator: 'contains', value: formId });
  const n = ov().length;
  await applySetup(p.app, sys());
  assert.equal(ov().length, n);
  // Ungültige Formular-Angabe
  assert.equal((await su.put(`/api/admin/systems/${sysId}/zammad`, { mapping: { overviews: { forms: [{ formId: 'x' }] } } })).status, 422);
});

test('Benennung anpassbar: Feld- und Art-Bezeichnungen, Vorsilbe der Abhängigkeiten', async () => {
  const put = await su.put(`/api/admin/systems/${sysId}/zammad`, { mapping: { names: { attrs: { kind: 'Vorgangsart' }, kinds: { incident: 'Ausfall' }, workflowPrefix: 'SSP – ' } } });
  assert.equal(put.status, 200, put.text);
  const chk = await checkSetup(p.app, sys());
  assert.ok(chk.missing.labels.some((l) => l.attribute === 'portal_art' && l.to === 'Vorgangsart'));
  assert.ok(chk.missing.labels.some((l) => l.attribute === 'portal_art' && l.to === 'Ausfall'));
  assert.equal(chk.ready, false);
  const r = await applySetup(p.app, sys());
  assert.equal(r.ready, true, JSON.stringify({ m: r.missing, w: r.workflows }));
  const attr = p.zammad.state.attributes.find((a) => a.name === 'portal_art')!;
  assert.equal(attr.display, 'Vorgangsart');
  assert.equal(attr.data_option.options.stoerung, 'Ausfall');
  // Workflows über die Kennung gefunden und umbenannt – keine Dubletten
  const wfs = p.zammad.state.workflows.filter((w) => /\[portal:kind-incident\]/.test(String(w.note)));
  assert.equal(wfs.length, 1);
  assert.equal(wfs[0].name, 'SSP – Ausfall');
  assert.equal((await su.put(`/api/admin/systems/${sysId}/zammad`, { mapping: { names: { workflowPrefix: '' } } })).status, 422);
  await su.put(`/api/admin/systems/${sysId}/zammad`, { mapping: {} });
  assert.equal((await applySetup(p.app, sys())).ready, true);
  assert.equal(p.zammad.state.attributes.find((a) => a.name === 'portal_art')!.display, 'Portal: Art');
});

