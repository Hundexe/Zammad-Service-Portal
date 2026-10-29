// Benachrichtigung im Portal, wenn in Zammad ein Bearbeiter antwortet
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startPortal, Client, createSystem, createForm, ENTRA_USERS, type Portal } from './helpers.ts';
import { deliverNext } from '../src/server/services/requests.ts';
import { watchSystem } from '../src/server/services/ticket-watch.ts';
import { listNotifications } from '../src/server/services/notifications.ts';
import { toAuthUser, getUser } from '../src/server/services/users.ts';
import type { SystemRow } from '../src/server/services/systems.ts';

let p: Portal;
let sysId = '';
let ticketId = 0;
let userId = '';
const sys = () => p.app.db.get<SystemRow>('SELECT * FROM ticket_systems WHERE id = ?', sysId)!;
const tick = () => new Promise((r) => setTimeout(r, 10));
const inbox = () => listNotifications(p.app, toAuthUser(p.app.db, getUser(p.app.db, userId)!)).filter((n) => n.kind === 'ticket.reply');

before(async () => {
  p = await startPortal();
  sysId = createSystem(p.app, p.zammad.url, { slug: 'watch' });
  const formId = createForm(p.app, sysId);
  const c = new Client(p.url);
  await c.loginEntra(p, ENTRA_USERS[0].oid);
  const r = await c.post(`/api/portal/forms/${formId}/submit`, { values: { betreff: 'Drucker streikt', beschreibung: 'x', standort: 'nord' } });
  assert.equal(r.status, 201, r.text);
  await deliverNext(p.app);
  ticketId = p.app.db.get<{ ticket_id: number }>('SELECT ticket_id FROM requests WHERE id = ?', r.json.id)!.ticket_id;
  userId = p.app.db.get<{ id: string }>('SELECT id FROM users WHERE entra_oid = ?', ENTRA_USERS[0].oid)!.id;
});
after(async () => { await p.close(); });

test('Erster Lauf setzt nur den Startpunkt – keine Nachrichten für Altes', async () => {
  assert.ok(ticketId > 0);
  assert.equal(await watchSystem(p.app, sys()), 0);
  assert.equal(inbox().length, 0);
});

test('Antwort eines Bearbeiters → Benachrichtigung mit Titel, Auszug und Link; interne Notiz nicht', async () => {
  await tick();
  p.zammad.addAgentReply(ticketId, '<div>Wir tauschen heute den Toner.</div><div data-signature="true">Gruß Sabine</div><blockquote type="cite">alt</blockquote>');
  p.zammad.addAgentReply(ticketId, '<p>Intern: Lieferant anrufen</p>', true);
  assert.equal(await watchSystem(p.app, sys()), 1);
  const [n] = inbox();
  assert.equal(n.title, 'Neue Antwort: Störung: Drucker streikt');
  assert.equal(n.body, 'Wir tauschen heute den Toner.');
  assert.equal(n.link, `/s/${sysId}/tickets/${ticketId}`);
  // Nochmal abrufen: nichts doppelt
  assert.equal(await watchSystem(p.app, sys()), 0);
  // Nur interne Notiz: keine Nachricht
  p.zammad.addAgentReply(ticketId, '<p>Noch intern</p>', true);
  assert.equal(await watchSystem(p.app, sys()), 0);
  assert.equal(inbox().length, 1);
});

test('Mehrere Antworten seit dem letzten Abruf: eine Nachricht mit Anzahl', async () => {
  await tick();
  p.zammad.addAgentReply(ticketId, '<p>Erstens</p>');
  p.zammad.addAgentReply(ticketId, '<p>Zweitens</p>');
  assert.equal(await watchSystem(p.app, sys()), 1);
  assert.equal(inbox()[0].title, 'Neue Antwort: Störung: Drucker streikt (2 neue Nachrichten)');
  assert.equal(inbox()[0].body, 'Zweitens');
});

test('Tickets von Personen, die das Portal nicht kennt, werden nicht gelesen', async () => {
  const foreign = p.zammad.state.tickets.find((t) => t.title === 'Geheimes Ticket einer anderen Person')!;
  p.zammad.addAgentReply(foreign.id, '<p>Antwort</p>');
  const before = p.zammad.state.requests.length;
  assert.equal(await watchSystem(p.app, sys()), 0);
  assert.ok(!p.zammad.state.requests.slice(before).some((r) => r.path.includes(`/by_ticket/${foreign.id}`)));
});

test('Ältere Zammad-Versionen ohne Suche mit Bedingung: Liste als Rückfall', async () => {
  p.zammad.setLegacySearch(true);
  try {
    await tick();
    p.zammad.addAgentReply(ticketId, '<p>Über die Liste gefunden</p>');
    assert.equal(await watchSystem(p.app, sys()), 1);
    assert.equal(inbox()[0].body, 'Über die Liste gefunden');
  } finally {
    p.zammad.setLegacySearch(false);
  }
});
