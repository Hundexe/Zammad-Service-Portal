// Zammad-Simulator für automatische Tests und Demo-Screenshots.
// Bildet die vom Portal genutzten Endpunkte der Zammad-REST-API v1 nach, inkl.
// Token-Prüfung, X-On-Behalf-Of und Rechteprüfung für Kunden.
// NICHT für den Produktivbetrieb.
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';

interface User { id: number; login: string; email: string; firstname: string; lastname: string; roles: string[]; organization_id: number | null }
interface Ticket { id: number; number: string; title: string; group_id: number; state_id: number; priority_id: number; customer_id: number; organization_id: number | null; created_at: string; updated_at: string; tags: string[]; [k: string]: unknown }
interface Article { id: number; ticket_id: number; from: string; sender: string; body: string; content_type: string; internal: boolean; created_at: string; type?: string; subject?: string; to?: string; attachments: { id: number; filename: string; size: number; data: Buffer; mime: string }[] }
interface Link { source: number; target: number; type: 'normal' | 'parent' }

export interface MockOptions { port?: number; token?: string; name?: string; customers?: { email: string; firstname: string; lastname: string }[]; quiet?: boolean }

export interface MockZammad {
  server: Server;
  url: string;
  state: { users: User[]; tickets: Ticket[]; articles: Article[]; links: Link[]; workflows: any[]; groups: { id: number; name: string; active: boolean }[]; states: { id: number; name: string; active: boolean; state_type_id: number }[]; attributes: any[]; requests: { method: string; path: string; onBehalfOf?: string; body?: any }[] };
  /** Wie ein Admin in Zammad: Gruppen, Status und Attribute fürs Portal schon vorhanden? (Standard: nein) */
  setAdmin: (on: boolean) => void;
  failNext: (n: number, status?: number) => void;
  /** Wie ältere Zammad-Versionen: Suche mit Bedingung wird nicht unterstützt */
  setLegacySearch: (on: boolean) => void;
  /** Die nächsten n Tickets werden angelegt, die Antwort geht aber verloren (504) – wie bei einer Zeitüberschreitung */
  loseNextCreateResponse: (n: number) => void;
  /** Antwort eines Bearbeiters (wie in der Zammad-Oberfläche) – für Tests und die Demo */
  addAgentReply: (ticketId: number, body: string, internal?: boolean) => number;
  close: () => Promise<void>;
}

const GROUPS_INIT = [
  { id: 1, name: 'Users', active: true },
  { id: 2, name: 'IT-Support', active: true },
  { id: 3, name: 'IT-Support::Hardware', active: true },
  { id: 4, name: 'IT-Support::Netzwerk', active: true },
  { id: 5, name: 'Alt (deaktiviert)', active: false },
];
const STATES_INIT = [
  { id: 1, name: 'new', active: true, state_type_id: 1 }, { id: 2, name: 'open', active: true, state_type_id: 2 }, { id: 3, name: 'pending reminder', active: true, state_type_id: 3 },
  { id: 4, name: 'closed', active: true, state_type_id: 5 }, { id: 5, name: 'merged', active: true, state_type_id: 7 }, { id: 7, name: 'pending close', active: true, state_type_id: 4 },
];
/** Status-Typen, die als „geschlossen“ zählen (closed, merged) */
const CLOSED_TYPES = [5, 7];
const PRIORITIES = [{ id: 1, name: '1 low', active: true }, { id: 2, name: '2 normal', active: true }, { id: 3, name: '3 high', active: true }];

const ATTRIBUTES_INIT = [
  { id: 1, object: 'Ticket', name: 'number', display: '#', data_type: 'input', active: true, editable: false, data_option: {} },
  { id: 2, object: 'Ticket', name: 'title', display: 'Title', data_type: 'input', active: true, editable: false, data_option: {} },
  { id: 3, object: 'Ticket', name: 'customer_id', display: 'Customer', data_type: 'user_autocompletion', active: true, editable: false, data_option: {} },
  { id: 4, object: 'Ticket', name: 'group_id', display: 'Group', data_type: 'tree_select', active: true, editable: false, data_option: {} },
  { id: 5, object: 'Ticket', name: 'state_id', display: 'State', data_type: 'select', active: true, editable: false, data_option: {} },
  { id: 6, object: 'Ticket', name: 'priority_id', display: 'Priority', data_type: 'select', active: true, editable: false, data_option: {} },
  { id: 7, object: 'Ticket', name: 'tags', display: 'Tags', data_type: 'tag', active: true, editable: false, data_option: {} },
  {
    id: 8, object: 'Ticket', name: 'sec_status', display: 'Sekundär Status', data_type: 'tree_select', active: true, editable: true,
    data_option: { options: [
      { name: 'Warten auf', value: 'Warten auf', children: [
        { name: 'Kunde', value: 'Warten auf::Kunde' }, { name: 'Lieferant', value: 'Warten auf::Lieferant' }, { name: 'Bestellung', value: 'Warten auf::Bestellung' },
      ] },
      { name: 'In Bearbeitung', value: 'In Bearbeitung' },
      { name: 'Hardware', value: 'Hardware', children: [{ name: 'Laptop', value: 'Hardware::Laptop' }, { name: 'Monitor', value: 'Hardware::Monitor' }, { name: 'Drucker', value: 'Hardware::Drucker' }] },
    ] },
  },
  { id: 9, object: 'Ticket', name: 'standort', display: 'Standort', data_type: 'select', active: true, editable: true, data_option: { options: { nord: 'Standort Nord', sued: 'Standort Süd', homeoffice: 'Homeoffice' } } },
  { id: 10, object: 'Ticket', name: 'dringend', display: 'Dringend', data_type: 'boolean', active: true, editable: true, data_option: { options: { true: 'Ja', false: 'Nein' } } },
  { id: 11, object: 'Ticket', name: 'kostenstelle', display: 'Kostenstelle', data_type: 'input', active: true, editable: true, data_option: {} },
  { id: 12, object: 'User', name: 'department', display: 'Abteilung', data_type: 'input', active: true, editable: true, data_option: {} },
];

const iso = (d: Date) => d.toISOString();

export async function startMockZammad(opts: MockOptions = {}): Promise<MockZammad> {
  const token = opts.token ?? 'test-token';
  const users: User[] = [
    { id: 1, login: 'api-portal', email: 'api-portal@example.org', firstname: 'Service', lastname: 'Portal', roles: ['Admin', 'Agent'], organization_id: null },
    { id: 2, login: 'agent', email: 'support@example.org', firstname: 'Sabine', lastname: 'Support', roles: ['Agent'], organization_id: null },
  ];
  const GROUPS = GROUPS_INIT.map((g) => ({ ...g }));
  const STATES = STATES_INIT.map((s) => ({ ...s }));
  const ATTRIBUTES: any[] = ATTRIBUTES_INIT.map((a) => structuredClone(a));
  const links: Link[] = [];
  const workflows: any[] = [];
  let isAdmin = true;
  const tickets: Ticket[] = [];
  const articles: Article[] = [];
  const requests: MockZammad['state']['requests'] = [];
  let nextUser = 10, nextTicket = 100, nextArticle = 1000, nextAtt = 5000, ticketNo = 61001;
  let failCount = 0, failStatus = 503, loseCreate = 0, legacySearch = false;

  const addCustomer = (email: string, firstname: string, lastname: string) => {
    const u: User = { id: nextUser++, login: email, email, firstname, lastname, roles: ['Customer'], organization_id: 1 };
    users.push(u);
    return u;
  };
  const addTicket = (customer: User, title: string, stateId: number, groupId: number, daysAgo: number, msgs: [string, string, boolean][]) => {
    const created = new Date(Date.now() - daysAgo * 86400_000);
    const t: Ticket = { id: nextTicket++, number: String(ticketNo++), title, group_id: groupId, state_id: stateId, priority_id: 2, customer_id: customer.id, organization_id: customer.organization_id, created_at: iso(created), updated_at: iso(new Date(created.getTime() + 3600_000 * 5)), tags: [] };
    tickets.push(t);
    msgs.forEach(([sender, body, internal], i) => articles.push({
      id: nextArticle++, ticket_id: t.id, from: sender === 'Customer' ? `${customer.firstname} ${customer.lastname}` : 'Sabine Support', sender, body,
      content_type: 'text/html', internal, created_at: iso(new Date(created.getTime() + i * 3600_000)), attachments: [],
    }));
    return t;
  };

  for (const c of opts.customers ?? []) {
    const u = addCustomer(c.email, c.firstname, c.lastname);
    addTicket(u, 'Drucker im 2. OG druckt nur leere Seiten', 2, 3, 3, [
      ['Customer', '<p>Der Drucker im 2. OG druckt seit heute Morgen nur leere Seiten.</p>', false],
      ['Agent', '<p>Hallo, wir haben den Toner bestellt. Er kommt <b>morgen</b>.</p>', false],
      ['Agent', '<p>Interne Notiz: Lieferant XY, Bestellung 4711</p>', true],
    ]);
    // Wie eine Anfrage aus dem Portal und eine Antwort aus Zammad mit Signatur und zitierter Anfrage
    const vpn = '<p>Neue Anfrage über das Self-Service-Portal.</p><p>Angefragt von ' + c.firstname + ' ' + c.lastname + '.</p>'
      + '<table border="1" cellpadding="4" cellspacing="0"><tr><th>Ab wann?</th><td>nächste Woche</td></tr><tr><th>Wofür?</th><td>Homeoffice an zwei Tagen pro Woche</td></tr><tr><th>Gerät</th><td>Notebook NB-0815</td></tr></table>'
      + '<p><small>Erstellt über das Self-Service-Portal · Anfrage 7d0c4f2e-demo</small></p>';
    addTicket(u, 'VPN-Zugang für Homeoffice', 3, 4, 6, [
      ['Customer', vpn, false],
      ['Agent', '<div>Bitte bestätigen Sie die Freigabe durch Ihre Führungskraft.</div><div><br></div><div data-signature="true" data-signature-id="1">Viele Grüße<br>Sabine Support<br>IT-Service · Tel. 100</div><br><blockquote type="cite">' + vpn + '</blockquote>', false],
    ]);
    addTicket(u, 'Neuer Monitor für Arbeitsplatz 14', 4, 3, 20, [
      ['Customer', '<p>Mein Monitor flackert.</p>', false],
      ['Agent', '<p>Neuer Monitor ist aufgebaut. Ticket wird geschlossen.</p>', false],
    ]);
  }
  // Ticket einer anderen Person (für Rechte-Tests)
  const other = addCustomer('fremd@example.org', 'Fritz', 'Fremd');
  other.organization_id = 2;
  addTicket(other, 'Geheimes Ticket einer anderen Person', 2, 2, 1, [['Customer', '<p>Das darf niemand anderes sehen.</p>', false]]);

  const name = (list: { id: number; name: string }[], id: number) => list.find((x) => x.id === id)?.name ?? '';
  const expandTicket = (t: Ticket) => ({ ...t, group: name(GROUPS, t.group_id), state: name(STATES, t.state_id), priority: name(PRIORITIES, t.priority_id), customer: users.find((u) => u.id === t.customer_id)?.login ?? '', tags: undefined });
  const isClosedState = (id: number) => CLOSED_TYPES.includes(STATES.find((s) => s.id === id)?.state_type_id ?? 0);
  const setState = (t: Ticket, raw: unknown): string | null => {
    const st = STATES.find((s) => s.name === raw || s.id === raw);
    if (!st) return `No lookup value found for 'state': ${String(raw)}`;
    const wasClosed = isClosedState(t.state_id);
    t.state_id = st.id;
    if (isClosedState(st.id) && !wasClosed) t.close_at = iso(new Date());
    if (!isClosedState(st.id)) t.close_at = null;
    return null;
  };
  const customAttr = (n: string) => ATTRIBUTES.find((a) => a.object === 'Ticket' && a.name === n && a.editable !== false);

  async function body(req: IncomingMessage): Promise<any> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const s = Buffer.concat(chunks).toString('utf8');
    return s ? JSON.parse(s) : {};
  }

  function send(res: ServerResponse, status: number, data: unknown) {
    const s = JSON.stringify(data);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(s) });
    res.end(s);
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://mock');
      const p = url.pathname;
      const onBehalfOf = req.headers['x-on-behalf-of'] as string | undefined;
      const entry: MockZammad['state']['requests'][number] = { method: req.method ?? 'GET', path: p + url.search, onBehalfOf };
      requests.push(entry);
      if (p === '/__mock/state') return send(res, 200, { tickets: tickets.map(expandTicket), articles: articles.map((a) => ({ ...a, attachments: a.attachments.map((x) => ({ ...x, data: undefined })) })), users });
      if (req.headers.authorization !== `Token token=${token}`) return send(res, 401, { error: 'authentication failed' });
      if (failCount > 0) { failCount--; return send(res, failStatus, { error: 'Simulierter Fehler' }); }

      let current: User = users[0];
      if (onBehalfOf) {
        const u = users.find((x) => x.email.toLowerCase() === onBehalfOf.toLowerCase() || x.login === onBehalfOf || String(x.id) === onBehalfOf);
        if (!u) return send(res, 422, { error: `No such user '${onBehalfOf}'` });
        current = u;
      }
      const isCustomer = current.roles.includes('Customer') && !current.roles.includes('Agent');
      const canSee = (t: Ticket) => !isCustomer || t.customer_id === current.id || (t.organization_id !== null && t.organization_id === current.organization_id);
      const json = req.method === 'POST' || req.method === 'PUT' || req.method === 'DELETE' ? await body(req) : undefined;
      entry.body = json;

      if (req.method === 'GET' && p === '/api/v1/users/me') return send(res, 200, { id: current.id, login: current.login, email: current.email });
      if (req.method === 'GET' && p === '/api/v1/version') return send(res, 200, { version: '6.5.0 (Simulator)' });
      if (req.method === 'GET' && p === '/api/v1/groups') return send(res, 200, GROUPS);
      if (req.method === 'GET' && p === '/api/v1/ticket_states') return send(res, 200, STATES);
      if (req.method === 'GET' && p === '/api/v1/ticket_priorities') return send(res, 200, PRIORITIES);
      if (req.method === 'GET' && p === '/api/v1/object_manager_attributes') return send(res, 200, ATTRIBUTES);
      if (req.method === 'GET' && p === '/api/v1/users/search') {
        const q = (url.searchParams.get('query') ?? '').toLowerCase();
        return send(res, 200, users.filter((u) => u.email.toLowerCase().includes(q) || u.login.toLowerCase().includes(q)).map((u) => ({ id: u.id, login: u.login, email: u.email, firstname: u.firstname, lastname: u.lastname })));
      }
      if (req.method === 'POST' && p === '/api/v1/users') {
        if (!json.email) return send(res, 422, { error: 'email required' });
        if (users.some((u) => u.email.toLowerCase() === String(json.email).toLowerCase())) return send(res, 422, { error: 'Email address is already used for other user.' });
        const u = addCustomer(String(json.email), String(json.firstname ?? ''), String(json.lastname ?? ''));
        return send(res, 201, { id: u.id, email: u.email, login: u.login });
      }
      if (req.method === 'POST' && p === '/api/v1/tickets') {
        const group = GROUPS.find((g) => g.name === json.group || g.id === json.group_id);
        if (!group) return send(res, 422, { error: 'No lookup value found for \'group\'' });
        const customer = users.find((u) => u.id === Number(json.customer_id ?? current.id));
        if (!customer) return send(res, 422, { error: 'customer not found' });
        if (isCustomer && customer.id !== current.id) return send(res, 403, { error: 'Not authorized' });
        const prio = json.priority ? PRIORITIES.find((x) => x.name === json.priority) : PRIORITIES[1];
        if (!prio) return send(res, 422, { error: 'No lookup value found for \'priority\'' });
        const t: Ticket = {
          id: nextTicket++, number: String(ticketNo++), title: String(json.title), group_id: group.id, state_id: 1, priority_id: prio.id,
          customer_id: customer.id, organization_id: customer.organization_id, created_at: iso(new Date()), updated_at: iso(new Date()),
          tags: typeof json.tags === 'string' ? json.tags.split(',').filter(Boolean) : [],
        };
        for (const a of ATTRIBUTES.filter((x) => x.editable && x.object === 'Ticket')) if (a.name in json) t[a.name] = json[a.name];
        if (json.state !== undefined || json.state_id !== undefined) {
          if (isCustomer) return send(res, 403, { error: 'Not authorized' });
          const err = setState(t, json.state ?? json.state_id);
          if (err) return send(res, 422, { error: err });
        }
        tickets.push(t);
        const art = json.article ?? {};
        const author = isCustomer || (art.sender ?? 'Customer') === 'Customer' ? customer : current;
        articles.push({
          id: nextArticle++, ticket_id: t.id, from: `${author.firstname} ${author.lastname}`, sender: art.sender ?? 'Customer', body: String(art.body ?? ''),
          content_type: art.content_type ?? 'text/html', internal: Boolean(art.internal), created_at: iso(new Date()),
          type: art.type ?? 'web', subject: art.subject, to: art.to,
          attachments: (art.attachments ?? []).map((x: any) => { const data = Buffer.from(x.data, 'base64'); return { id: nextAtt++, filename: x.filename, size: data.length, data, mime: x['mime-type'] }; }),
        });
        if (loseCreate > 0) { loseCreate--; return send(res, 504, { error: 'Gateway Timeout (simuliert)' }); }
        return send(res, 201, { ...expandTicket(t), tags: undefined });
      }
      if (req.method === 'GET' && p === '/api/v1/tickets') {
        const page = Number(url.searchParams.get('page') ?? 1), per = Number(url.searchParams.get('per_page') ?? 50);
        return send(res, 200, tickets.filter(canSee).slice((page - 1) * per, page * per).map(expandTicket));
      }
      if (req.method === 'GET' && p === '/api/v1/tickets/search') {
        // Wie Zammad: mit Suchbegriff über den Suchindex, ohne Suchbegriff mit Bedingung direkt in der Datenbank
        const cond: Record<string, string[]> = {};
        const not: Record<string, string[]> = {};
        let after: string | null = null;
        for (const [k, v] of url.searchParams) {
          const c = /^condition\[ticket\.([a-z_]+)\]\[value\](\[\])?$/.exec(k);
          if (!c) continue;
          const op = url.searchParams.get(`condition[ticket.${c[1]}][operator]`);
          if (c[1] === 'updated_at') after = v;
          else if (op === 'is not') (not[c[1]] ??= []).push(v);
          else (cond[c[1]] ??= []).push(v);
        }
        if (after !== null && legacySearch) return send(res, 500, { error: 'invalid selector' });
        if (Object.keys(cond).length && legacySearch) return send(res, 500, { error: 'invalid selector' });
        const m = /customer_id:(\d+)/.exec(url.searchParams.get('query') ?? '');
        const val = (t: Ticket, f: string) => (Array.isArray(t[f]) ? (t[f] as unknown[]).map(String) : [String(t[f] ?? '')]);
        // Wie Zammad: mehrere Werte = einer davon; Tags: „contains one“
        let list = tickets.filter((t) => canSee(t) && (!m || t.customer_id === Number(m[1])) && (after === null || t.updated_at > after)
          && Object.entries(cond).every(([f, v]) => v.some((x) => val(t, f).includes(x))) && Object.entries(not).every(([f, v]) => !v.some((x) => val(t, f).includes(x))));
        if (url.searchParams.get('sort_by') === 'updated_at') list = [...list].sort((a, b) => (url.searchParams.get('order_by') === 'desc' ? -1 : 1) * a.updated_at.localeCompare(b.updated_at));
        const limit = Number(url.searchParams.get('limit') ?? 50);
        return send(res, 200, list.slice(0, Math.min(limit, 200)).map(expandTicket));
      }
      if (req.method === 'GET' && p === '/api/v1/tags') {
        const t = tickets.find((x) => x.id === Number(url.searchParams.get('o_id')));
        if (!t || !canSee(t)) return send(res, 404, { error: 'not found' });
        return send(res, 200, { tags: t.tags });
      }
      if ((req.method === 'POST' && p === '/api/v1/tags/add') || (req.method === 'DELETE' && p === '/api/v1/tags/remove')) {
        if (isCustomer) return send(res, 403, { error: 'Not authorized' });
        const t = tickets.find((x) => x.id === Number(json.o_id));
        if (!t || json.object !== 'Ticket' || typeof json.item !== 'string') return send(res, 422, { error: 'invalid' });
        if (p.endsWith('/add')) { if (!t.tags.includes(json.item)) t.tags.push(json.item); } else t.tags = t.tags.filter((x) => x !== json.item);
        return send(res, 200, true);
      }
      let mt = /^\/api\/v1\/tickets\/(\d+)$/.exec(p);
      if (req.method === 'PUT' && mt) {
        const t = tickets.find((x) => x.id === Number(mt![1]));
        if (!t) return send(res, 404, { error: "Couldn't find Ticket" });
        if (isCustomer) return send(res, 403, { error: 'Not authorized' });
        if (json.title !== undefined) t.title = String(json.title);
        if (json.group !== undefined) {
          const g = GROUPS.find((x) => x.name === json.group);
          if (!g) return send(res, 422, { error: "No lookup value found for 'group'" });
          t.group_id = g.id;
        }
        if (json.state !== undefined) { const err = setState(t, json.state); if (err) return send(res, 422, { error: err }); }
        for (const [k, v] of Object.entries(json)) {
          if (['title', 'group', 'state', 'id'].includes(k)) continue;
          if (!customAttr(k)) return send(res, 422, { error: `Unknown attribute ${k}` });
          t[k] = v;
        }
        t.updated_at = iso(new Date());
        return send(res, 200, expandTicket(t));
      }
      void mt;
      if (req.method === 'GET' && p === '/api/v1/links') {
        const id = Number(url.searchParams.get('link_object_value'));
        const t = tickets.find((x) => x.id === id);
        if (!t) return send(res, 404, { error: 'not found' });
        if (isCustomer) return send(res, 403, { error: 'Not authorized' });
        const out: { link_type: string; link_object: string; link_object_value: number }[] = [];
        // Wie Zammad: aus Sicht des Tickets – „child“ = Kind dieses Tickets, „parent“ = sein Eltern-Ticket
        for (const l of links) {
          if (l.source === id) out.push({ link_type: l.type === 'parent' ? 'child' : 'normal', link_object: 'Ticket', link_object_value: l.target });
          else if (l.target === id) out.push({ link_type: l.type === 'parent' ? 'parent' : 'normal', link_object: 'Ticket', link_object_value: l.source });
        }
        return send(res, 200, { links: out, assets: {} });
      }
      if (req.method === 'POST' && p === '/api/v1/links/add') {
        if (isCustomer) return send(res, 403, { error: 'Not authorized' });
        const src = tickets.find((x) => x.number === String(json.link_object_source_number));
        const target = tickets.find((x) => x.id === Number(json.link_object_target_value));
        if (!src || !target || !['parent', 'normal'].includes(json.link_type)) return send(res, 422, { error: 'invalid link' });
        if (!links.some((l) => l.source === src.id && l.target === target.id && l.type === json.link_type)) links.push({ source: src.id, target: target.id, type: json.link_type });
        return send(res, 201, { result: 'ok' });
      }
      if (req.method === 'DELETE' && p === '/api/v1/links/remove') {
        if (isCustomer) return send(res, 403, { error: 'Not authorized' });
        const i = links.findIndex((l) => l.source === Number(json.link_object_source_value) && l.target === Number(json.link_object_target_value) && l.type === json.link_type);
        if (i < 0) return send(res, 422, { error: 'no such link' });
        links.splice(i, 1);
        return send(res, 200, { result: 'ok' });
      }
      if (req.method === 'POST' && p === '/api/v1/groups') {
        if (!isAdmin) return send(res, 403, { error: 'Not authorized (admin.group)' });
        if (GROUPS.some((g) => g.name === json.name)) return send(res, 422, { error: 'Name already exists' });
        GROUPS.push({ id: Math.max(...GROUPS.map((g) => g.id)) + 1, name: String(json.name), active: json.active !== false });
        return send(res, 201, GROUPS.at(-1));
      }
      if (req.method === 'POST' && p === '/api/v1/ticket_states') {
        if (!isAdmin) return send(res, 403, { error: 'Not authorized (admin.object)' });
        if (STATES.some((s) => s.name === json.name)) return send(res, 422, { error: 'Name already exists' });
        STATES.push({ id: Math.max(...STATES.map((s) => s.id)) + 1, name: String(json.name), active: true, state_type_id: Number(json.state_type_id) });
        return send(res, 201, STATES.at(-1));
      }
      let ma = /^\/api\/v1\/object_manager_attributes(?:\/(\d+))?$/.exec(p);
      if ((req.method === 'POST' || req.method === 'PUT') && ma) {
        if (!isAdmin) return send(res, 403, { error: 'Not authorized (admin.object)' });
        if (!/^[a-z][a-z0-9_]*$/.test(String(json.name ?? ''))) return send(res, 422, { error: 'invalid name' });
        if (req.method === 'POST') {
          if (ATTRIBUTES.some((a) => a.object === json.object && a.name === json.name)) return send(res, 422, { error: 'already exists' });
          ATTRIBUTES.push({ id: Math.max(...ATTRIBUTES.map((a) => a.id)) + 1, object: json.object, name: json.name, display: json.display, data_type: json.data_type, active: true, editable: true, data_option: json.data_option, to_migrate: true });
        } else {
          const a = ATTRIBUTES.find((x) => x.id === Number(ma![1]));
          if (!a) return send(res, 404, { error: 'not found' });
          Object.assign(a, { display: json.display, data_option: json.data_option, data_type: json.data_type });
        }
        return send(res, req.method === 'POST' ? 201 : 200, ATTRIBUTES.at(-1));
      }
      void ma;
      if (req.method === 'GET' && p === '/api/v1/core_workflows') {
        if (!isAdmin) return send(res, 403, { error: 'Not authorized (admin.core_workflow)' });
        return send(res, 200, workflows);
      }
      const mw = /^\/api\/v1\/core_workflows(?:\/(\d+))?$/.exec(p);
      if ((req.method === 'POST' || req.method === 'PUT') && mw) {
        if (!isAdmin) return send(res, 403, { error: 'Not authorized (admin.core_workflow)' });
        if (!json.name || json.object !== 'Ticket') return send(res, 422, { error: 'invalid' });
        if (req.method === 'POST') { workflows.push({ id: workflows.length + 1, ...json }); return send(res, 201, workflows.at(-1)); }
        const w = workflows.find((x) => x.id === Number(mw[1]));
        if (!w) return send(res, 404, { error: 'not found' });
        Object.assign(w, json);
        return send(res, 200, w);
      }
      if (req.method === 'POST' && p === '/api/v1/object_manager_attributes_execute_migrations') {
        if (!isAdmin) return send(res, 403, { error: 'Not authorized' });
        for (const a of ATTRIBUTES) delete a.to_migrate;
        return send(res, 200, { result: 'ok' });
      }
      let mu = /^\/api\/v1\/users\/(\d+)$/.exec(p);
      if (req.method === 'GET' && mu) {
        if (isCustomer) return send(res, 403, { error: 'Not authorized' });
        const u = users.find((x) => x.id === Number(mu![1]));
        return u ? send(res, 200, { id: u.id, email: u.email, organization_id: u.organization_id }) : send(res, 404, { error: 'not found' });
      }
      void mu;
      let m = /^\/api\/v1\/tickets\/(\d+)$/.exec(p);
      if (req.method === 'GET' && m) {
        const t = tickets.find((x) => x.id === Number(m![1]));
        if (!t) return send(res, 404, { error: "Couldn't find Ticket" });
        if (!canSee(t)) return send(res, 403, { error: 'Not authorized' });
        return send(res, 200, expandTicket(t));
      }
      m = /^\/api\/v1\/ticket_articles\/by_ticket\/(\d+)$/.exec(p);
      if (req.method === 'GET' && m) {
        const t = tickets.find((x) => x.id === Number(m![1]));
        if (!t) return send(res, 404, { error: 'not found' });
        if (!canSee(t)) return send(res, 403, { error: 'Not authorized' });
        return send(res, 200, articles.filter((a) => a.ticket_id === t.id && (!isCustomer || !a.internal)).map((a) => ({
          ...a, attachments: a.attachments.map((x) => ({ id: x.id, filename: x.filename, size: String(x.size), preferences: { 'Content-Type': x.mime } })),
        })));
      }
      m = /^\/api\/v1\/ticket_attachment\/(\d+)\/(\d+)\/(\d+)$/.exec(p);
      if (req.method === 'GET' && m) {
        const t = tickets.find((x) => x.id === Number(m![1]));
        const a = articles.find((x) => x.id === Number(m![2]) && x.ticket_id === Number(m![1]));
        const f = a?.attachments.find((x) => x.id === Number(m![3]));
        if (!t || !a || !f) return send(res, 404, { error: 'not found' });
        if (!canSee(t) || (isCustomer && a.internal)) return send(res, 403, { error: 'Not authorized' });
        res.writeHead(200, { 'Content-Type': f.mime, 'Content-Length': f.data.length });
        return res.end(f.data);
      }
      if (req.method === 'POST' && p === '/api/v1/ticket_articles') {
        const t = tickets.find((x) => x.id === Number(json.ticket_id));
        if (!t) return send(res, 404, { error: 'not found' });
        if (!canSee(t)) return send(res, 403, { error: 'Not authorized' });
        if (isCustomer && json.internal) return send(res, 403, { error: 'Not authorized' });
        if (json.type === 'email' && !json.to) return send(res, 422, { error: 'Need recipient' });
        articles.push({
          id: nextArticle++, ticket_id: t.id, from: `${current.firstname} ${current.lastname}`, sender: json.sender ?? 'Customer', body: String(json.body ?? ''),
          content_type: json.content_type ?? 'text/html', internal: Boolean(json.internal), created_at: iso(new Date()),
          type: json.type ?? 'note', subject: json.subject, to: json.to,
          attachments: (json.attachments ?? []).map((x: any) => { const data = Buffer.from(x.data, 'base64'); return { id: nextAtt++, filename: x.filename, size: data.length, data, mime: x['mime-type'] }; }),
        });
        t.updated_at = iso(new Date());
        // Wie Zammad (Standard-Trigger): Antwort des Kunden öffnet ein geschlossenes Ticket wieder
        if (t.state_id === 4 && (json.sender ?? 'Customer') === 'Customer') { t.state_id = 2; t.close_at = null; }
        return send(res, 201, { id: nextArticle - 1 });
      }
      return send(res, 404, { error: 'No route matches' });
    } catch (err) {
      send(res, 500, { error: (err as Error).message });
    }
  });

  await new Promise<void>((r) => server.listen(opts.port ?? 0, '127.0.0.1', () => r()));
  const addr = server.address();
  const url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : opts.port}`;
  if (!opts.quiet) console.log(`Zammad-Simulator „${opts.name ?? 'Zammad'}“ läuft auf ${url} (Token: ${token})`);
  return {
    server, url,
    state: { users, tickets, articles, links, workflows, groups: GROUPS, states: STATES, attributes: ATTRIBUTES, requests },
    setAdmin: (on) => { isAdmin = on; },
    failNext: (n, status = 503) => { failCount = n; failStatus = status; },
    setLegacySearch: (on) => { legacySearch = on; },
    loseNextCreateResponse: (n) => { loseCreate = n; },
    addAgentReply: (ticketId, body, internal = false) => {
      const t = tickets.find((x) => x.id === ticketId)!;
      articles.push({ id: nextArticle++, ticket_id: ticketId, from: 'Sabine Support', sender: 'Agent', body, content_type: 'text/html', internal, created_at: iso(new Date()), attachments: [] });
      t.updated_at = iso(new Date());
      return nextArticle - 1;
    },
    close: () => new Promise((r) => server.close(() => r())),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await startMockZammad({
    port: Number(process.env.PORT ?? 3100),
    token: process.env.MOCK_ZAMMAD_TOKEN ?? 'test-token',
    name: process.env.MOCK_ZAMMAD_NAME ?? 'Zammad',
    customers: [{ email: 'alex.berger@example.org', firstname: 'Alex', lastname: 'Berger' }],
  });
}
