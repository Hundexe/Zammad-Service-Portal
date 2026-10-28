// „Meine Tickets“: welche Tickets das Portal aus Zammad zeigt.
// Anlass: Ist ein Kunde in Zammad zugleich Agent (z. B. Mitarbeitende der IT), sah er im Portal seine eigenen
// Tickets nicht – das Portal holte alle für ihn sichtbaren Tickets, älteste zuerst, nur die ersten 500.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startPortal, Client, createSystem, ENTRA_USERS, type Portal } from './helpers.ts';

const [ANNA, BEN] = ENTRA_USERS;
let p: Portal;
let systemId: string;

const setSystem = (cols: Record<string, unknown>) => { for (const [k, v] of Object.entries(cols)) p.app.db.run(`UPDATE ticket_systems SET ${k} = ? WHERE id = ?`, v as any, systemId); };
const login = async (oid: string) => { const c = new Client(p.url); await c.loginEntra(p, oid); return c; };
const list = async (c: Client) => (await c.get(`/api/portal/systems/${systemId}/tickets?refresh=1`)).json;
const now = Date.now();
const iso = (minAgo: number) => new Date(now - minAgo * 60_000).toISOString();

before(async () => {
  p = await startPortal();
  systemId = createSystem(p.app, p.zammad.url);
  // Ben ist in Zammad Agent und Kunde zugleich und sieht als Agent 600 fremde Tickets
  const ben = { id: 900, login: BEN.email, email: BEN.email, firstname: 'Ben', lastname: 'Krause', roles: ['Agent', 'Customer'], organization_id: 3 };
  p.zammad.state.users.push(ben);
  const fremd = p.zammad.state.users.find((u) => u.email === 'fremd@example.org')!;
  for (let i = 0; i < 600; i++) {
    p.zammad.state.tickets.push({ id: 20000 + i, number: String(80000 + i), title: `Fremdes Ticket ${i}`, group_id: 2, state_id: 2, priority_id: 2, customer_id: fremd.id, organization_id: 2, created_at: iso(10000), updated_at: iso(10000 - i), tags: [] });
  }
  p.zammad.state.tickets.push(
    { id: 30001, number: '90001', title: 'Hardware-Problem: PC – Ben Krause', group_id: 3, state_id: 1, priority_id: 2, customer_id: ben.id, organization_id: 3, created_at: iso(8), updated_at: iso(8), tags: [] },
    { id: 30002, number: '90002', title: 'Software Anfrage – Ben Krause', group_id: 2, state_id: 2, priority_id: 2, customer_id: ben.id, organization_id: 3, created_at: iso(52), updated_at: iso(52), tags: [] },
    { id: 30003, number: '90003', title: 'Erledigt – Ben Krause', group_id: 2, state_id: 4, priority_id: 2, customer_id: ben.id, organization_id: 3, created_at: iso(5000), updated_at: iso(4000), tags: [] },
  );
  p.zammad.state.articles.push({ id: 40001, ticket_id: 30001, from: 'Ben Krause', sender: 'Customer', body: '<p>PC startet nicht</p>', content_type: 'text/html', internal: false, created_at: iso(8), attachments: [] });
});
after(async () => { await p.close(); });

test('Agent, der zugleich Kunde ist, sieht seine eigenen Tickets – und nur diese', async () => {
  const c = await login(BEN.oid);
  for (const mode of ['on_behalf_of', 'customer_field']) {
    setSystem({ creation_mode: mode });
    const open = await list(c);
    assert.equal(open.unavailable, false, mode);
    assert.deepEqual(open.tickets.map((t: any) => t.number), ['90001', '90002'], `${mode}: eigene offene Tickets, neueste zuerst`);
    const closed = (await c.get(`/api/portal/systems/${systemId}/tickets?refresh=1&overview=${open.overviews[1].id}`)).json;
    assert.deepEqual(closed.tickets.map((t: any) => t.number), ['90003'], mode);
    // Verlauf des eigenen Tickets
    const d = await c.get(`/api/portal/systems/${systemId}/tickets/30001`);
    assert.equal(d.status, 200, d.text);
    assert.equal(d.json.articles[0].text, 'PC startet nicht');
    // Tickets, die er nur als Agent sieht, gibt es im Portal nicht
    assert.equal((await c.get(`/api/portal/systems/${systemId}/tickets/20005`)).status, 404, mode);
  }
  setSystem({ creation_mode: 'on_behalf_of' });
});

test('Liste fragt gezielt nach dem Kunden (Datenbank, ohne Suchindex) statt alle Tickets durchzublättern', async () => {
  const c = await login(BEN.oid);
  const before = p.zammad.state.requests.length;
  await list(c);
  const calls = p.zammad.state.requests.slice(before).filter((r) => r.path.startsWith('/api/v1/tickets'));
  assert.equal(calls.length, 1);
  assert.match(decodeURIComponent(calls[0].path), /condition\[ticket\.customer_id\]\[value\]=900/);
  assert.match(calls[0].path, /sort_by=updated_at&order_by=desc/);
  assert.ok(!calls[0].path.includes('query='), 'kein Suchbegriff → Zammad sucht in der Datenbank, auch ohne Elasticsearch');
});

test('Organisations-Tickets: nur dieselbe Organisation, auch im Modus mit Agenten-Token', async () => {
  const c = await login(ANNA.oid);
  const anna = p.zammad.state.users.find((u) => u.email === ANNA.email)!;
  p.zammad.state.tickets.push({ id: 31001, number: '91001', title: 'Ticket einer Kollegin', group_id: 2, state_id: 2, priority_id: 2, customer_id: 2, organization_id: anna.organization_id, created_at: iso(30), updated_at: iso(30), tags: [] });
  setSystem({ show_org_tickets: 1 });
  for (const mode of ['on_behalf_of', 'customer_field']) {
    setSystem({ creation_mode: mode });
    const ids = (await list(c)).tickets.map((t: any) => t.id);
    assert.ok(ids.includes(31001), `${mode}: Kollegin derselben Organisation`);
    assert.ok(!ids.some((id: number) => id >= 20000 && id < 21000), `${mode}: keine fremde Organisation`);
    assert.equal((await c.get(`/api/portal/systems/${systemId}/tickets/20001`)).status, 404, `${mode}: Detail fremder Organisation`);
    assert.equal((await c.get(`/api/portal/systems/${systemId}/tickets/30001`)).status, 404, `${mode}: Detail fremder Organisation (Agent-Kunde)`);
  }
  setSystem({ show_org_tickets: 0, creation_mode: 'on_behalf_of' });
  assert.ok(!(await list(c)).tickets.some((t: any) => t.id === 31001), 'aus: keine Organisations-Tickets');
});

test('Ältere Zammad-Versionen ohne Suche mit Bedingung: bisheriger Weg', async () => {
  const c = await login(ANNA.oid);
  p.zammad.setLegacySearch(true);
  try {
    for (const mode of ['on_behalf_of', 'customer_field']) {
      setSystem({ creation_mode: mode });
      const r = await list(c);
      assert.equal(r.unavailable, false, mode);
      assert.ok(r.tickets.some((t: any) => t.title === 'Drucker im 2. OG druckt nur leere Seiten'), mode);
    }
  } finally {
    p.zammad.setLegacySearch(false);
    setSystem({ creation_mode: 'on_behalf_of' });
  }
});
