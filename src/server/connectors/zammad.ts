// Connector für Zammad (REST-API v1).
// Lese- und Schreibzugriffe für Kunden laufen mit "X-On-Behalf-Of": Zammad prüft
// dann selbst, ob der Kunde das Ticket sehen darf. Das Portal prüft zusätzlich.
import {
  ConnectorError, type ZammadAttribute, type ArticleSummary, type Attachment, type Connector, type CreateTicketInput,
  type CustomerRef, type SystemMetadata, type TicketSummary, type TicketSystemConfig,
} from './types.ts';
import { isProtectedZammadField } from '../../shared/form.ts';

const MAX_RESPONSE = 30 * 1024 * 1024;

type Json = any;

const SYSTEM_ATTRIBUTES = ['title', 'customer_id', 'group_id', 'owner_id', 'state_id', 'priority_id', 'organization_id', 'pending_time', 'tags', 'number'];

const PORTAL_TYPES: Record<string, ZammadAttribute['portalType']> = {
  input: 'text', textarea: 'textarea', richtext: 'textarea', select: 'select', tree_select: 'select',
  multiselect: 'multiselect', multi_tree_select: 'multiselect', boolean: 'checkbox', integer: 'number', date: 'date',
};

/** Wandelt die Optionen eines Attributs in eine flache Liste. Baumwerte heißen in Zammad "Eltern::Kind". */
export function flattenOptions(raw: unknown): { value: string; label: string }[] {
  const out: { value: string; label: string }[] = [];
  const walk = (list: Json[], path: string[]) => {
    for (const o of list) {
      if (!o || typeof o !== 'object') continue;
      const name = String(o.name ?? o.value ?? '');
      const value = String(o.value ?? [...path, name].join('::'));
      out.push({ value, label: [...path, name].join(' › ') });
      if (Array.isArray(o.children) && o.children.length) walk(o.children, [...path, name]);
    }
  };
  if (Array.isArray(raw)) walk(raw, []);
  else if (raw && typeof raw === 'object') for (const [value, label] of Object.entries(raw as Record<string, unknown>)) out.push({ value, label: String(label) });
  return out.slice(0, 2000);
}

export function toAttribute(a: Json): ZammadAttribute {
  const type = String(a.data_type ?? 'input');
  const portalType = PORTAL_TYPES[type] ?? null;
  let options: ZammadAttribute['options'];
  if (type === 'boolean') {
    const o = a.data_option?.options ?? {};
    options = [{ value: 'true', label: String(o.true ?? 'Ja') }, { value: 'false', label: String(o.false ?? 'Nein') }];
  } else if (portalType === 'select' || portalType === 'multiselect') {
    options = flattenOptions(a.data_option?.options);
  }
  return { name: String(a.name), display: String(a.display ?? a.name), type, options, portalType };
}

const EMAIL_IN_TEXT = /<?[^\s<>"]+@[^\s<>"]+>?/g;

/**
 * Absender eines Artikels für die Anzeige im Portal: ohne E-Mail-Adressen, auf Wunsch ohne Agentennamen.
 * Kunden sehen so keine internen Adressen (Agenten, Verteiler, Weiterleitungen).
 */
export function displaySender(from: string, sender: string, systemName: string, hideAgentNames: boolean): string {
  if (hideAgentNames && sender !== 'Customer') return systemName;
  const name = from.replace(EMAIL_IN_TEXT, '').replace(/["']/g, '').replace(/\s+/g, ' ').trim();
  if (name) return name.slice(0, 120);
  return sender === 'Customer' ? 'Sie' : systemName;
}

/** Felder aus Formularen, die das Portal selbst setzt, werden nie übernommen. */
export function safeTicketFields(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields ?? {})) if (/^[a-z][a-z0-9_]{0,60}$/.test(k) && !isProtectedZammadField(k)) out[k] = v;
  return out;
}

export class ZammadConnector implements Connector {
  private sys: TicketSystemConfig;
  private fetchImpl: typeof fetch;

  constructor(sys: TicketSystemConfig, fetchImpl: typeof fetch = fetch) {
    this.sys = sys;
    this.fetchImpl = fetchImpl;
  }

  private url(path: string): string {
    return this.sys.baseUrl.replace(/\/+$/, '') + path;
  }

  private async call(method: string, path: string, opts: { body?: unknown; onBehalfOf?: string; raw?: boolean } = {}): Promise<Json> {
    const headers: Record<string, string> = {
      Authorization: `Token token=${this.sys.apiToken}`,
      Accept: 'application/json',
      'User-Agent': 'zammad-service-portal',
    };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    if (opts.onBehalfOf) headers['X-On-Behalf-Of'] = opts.onBehalfOf;
    let res: Response;
    try {
      res = await this.fetchImpl(this.url(path), {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        redirect: 'error',
        signal: AbortSignal.timeout(20000),
      });
    } catch (err) {
      throw new ConnectorError(`${this.sys.name} nicht erreichbar: ${(err as Error).message}`, true);
    }
    const len = Number(res.headers.get('content-length') ?? 0);
    if (len > MAX_RESPONSE) throw new ConnectorError('Antwort von Zammad zu groß', false, res.status);
    if (res.status === 404) return null;
    if (!res.ok) {
      const text = (await res.text().catch(() => '')).slice(0, 300);
      const retryable = res.status >= 500 || res.status === 429 || res.status === 408;
      let msg = `${this.sys.name}: HTTP ${res.status}`;
      try { const j = JSON.parse(text); if (j.error) msg += ` – ${String(j.error).slice(0, 200)}`; } catch { /* kein JSON */ }
      throw new ConnectorError(msg, retryable, res.status);
    }
    if (opts.raw) {
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > MAX_RESPONSE) throw new ConnectorError('Antwort von Zammad zu groß', false);
      return { buf, type: res.headers.get('content-type') ?? 'application/octet-stream', disposition: res.headers.get('content-disposition') ?? '' };
    }
    const text = await res.text();
    if (text.length > MAX_RESPONSE) throw new ConnectorError('Antwort von Zammad zu groß', false);
    if (!text) return {};
    try { return JSON.parse(text); } catch { throw new ConnectorError('Zammad lieferte kein JSON', false, res.status); }
  }

  async test(): Promise<{ user: string; version?: string }> {
    const me = await this.call('GET', '/api/v1/users/me');
    if (!me || typeof me !== 'object') throw new ConnectorError('Unerwartete Antwort', false);
    let version: string | undefined;
    try {
      const v = await this.call('GET', '/api/v1/version');
      version = typeof v?.version === 'string' ? v.version : undefined;
    } catch { /* nur mit Admin-Recht verfügbar */ }
    return { user: String(me.login ?? me.email ?? me.id), version };
  }

  async metadata(): Promise<SystemMetadata> {
    const [groups, states, priorities] = await Promise.all([
      this.call('GET', '/api/v1/groups?per_page=500'),
      this.call('GET', '/api/v1/ticket_states?per_page=500'),
      this.call('GET', '/api/v1/ticket_priorities?per_page=500'),
    ]);
    let fields: SystemMetadata['fields'] = [];
    try {
      const attrs = (await this.call('GET', '/api/v1/object_manager_attributes')) as Json[];
      fields = (attrs ?? [])
        .filter((a) => a.object === 'Ticket' && a.active !== false && a.editable !== false && !SYSTEM_ATTRIBUTES.includes(a.name))
        .map((a) => toAttribute(a));
    } catch { /* ohne admin.object-Recht keine Felder */ }
    const active = (list: Json[]) => (list ?? []).filter((x) => x.active !== false).map((x) => ({ id: Number(x.id), name: String(x.name) }));
    return { groups: active(groups), states: active(states), priorities: active(priorities), fields };
  }

  async findCustomer(rawEmail: string): Promise<CustomerRef | null> {
    const email = rawEmail.trim().toLowerCase();
    if (!email) return null;
    const found = (await this.call('GET', `/api/v1/users/search?query=${encodeURIComponent(email)}&limit=20`)) as Json[];
    const hit = (Array.isArray(found) ? found : []).find((u) => String(u.email ?? '').toLowerCase() === email);
    return hit ? { customerId: Number(hit.id), email } : null;
  }

  async findOrCreateCustomer(user: { email: string; displayName: string }): Promise<CustomerRef> {
    const email = user.email.trim().toLowerCase();
    if (!email) throw new ConnectorError('Benutzer hat keine E-Mail-Adresse', false);
    const hit = await this.findCustomer(email);
    if (hit) return hit;
    const parts = user.displayName.trim().split(/\s+/);
    const lastname = parts.length > 1 ? parts.pop()! : '';
    const created = await this.call('POST', '/api/v1/users', {
      body: { firstname: parts.join(' ') || email, lastname, email, roles: ['Customer'] },
    });
    if (!created?.id) throw new ConnectorError('Kunde konnte nicht angelegt werden', false);
    return { customerId: Number(created.id), email };
  }

  async createTicket(input: CreateTicketInput): Promise<{ id: number; number: string }> {
    const onBehalf = this.sys.creationMode === 'on_behalf_of';
    const body: Record<string, unknown> = {
      ...safeTicketFields(input.fields),
      title: input.title,
      group: input.group,
      customer_id: input.customer.customerId,
      article: {
        subject: input.title,
        body: input.bodyHtml,
        content_type: 'text/html',
        type: 'web',
        internal: false,
        sender: 'Customer',
        attachments: input.attachments.map((a) => ({ filename: a.filename, data: a.data.toString('base64'), 'mime-type': a.mime })),
      },
    };
    if (input.priority) body.priority = input.priority;
    if (input.tags.length) body.tags = input.tags.join(',');
    const t = await this.call('POST', '/api/v1/tickets', { body, onBehalfOf: onBehalf ? this.behalf(input.customer) : undefined });
    if (!t?.id) throw new ConnectorError('Zammad hat kein Ticket zurückgegeben', true);
    return { id: Number(t.id), number: String(t.number ?? t.id) };
  }

  /**
   * Wert für X-On-Behalf-Of: immer die Zammad-ID des Kunden, nie die E-Mail-Adresse.
   * Die ID ist eindeutig und ändert sich nicht, wenn sich die Adresse ändert oder in anderer Schreibweise vorliegt.
   */
  private behalf(customer: CustomerRef): string {
    if (!Number.isSafeInteger(customer.customerId) || customer.customerId <= 0) throw new ConnectorError('Ungültige Kunden-ID', false);
    return String(customer.customerId);
  }

  private summary(t: Json): TicketSummary {
    const state = String(t.state ?? t.state_id ?? '');
    return {
      id: Number(t.id),
      number: String(t.number ?? ''),
      title: String(t.title ?? ''),
      state,
      closed: this.sys.closedStates.includes(state),
      priority: t.priority !== undefined ? String(t.priority) : null,
      group: t.group !== undefined ? String(t.group) : null,
      customerId: Number(t.customer_id),
      createdAt: String(t.created_at ?? ''),
      updatedAt: String(t.updated_at ?? ''),
    };
  }

  private mayView(customer: CustomerRef, t: TicketSummary): boolean {
    return this.sys.showOrgTickets || t.customerId === customer.customerId;
  }

  async listTickets(customer: CustomerRef): Promise<TicketSummary[]> {
    const out: TicketSummary[] = [];
    if (this.sys.creationMode === 'on_behalf_of') {
      for (let page = 1; page <= 5; page++) {
        const list = (await this.call('GET', `/api/v1/tickets?expand=true&per_page=100&page=${page}`, { onBehalfOf: this.behalf(customer) })) as Json[];
        if (!Array.isArray(list) || list.length === 0) break;
        out.push(...list.map((t) => this.summary(t)));
        if (list.length < 100) break;
      }
    } else {
      const res = await this.call('GET', `/api/v1/tickets/search?query=${encodeURIComponent(`customer_id:${customer.customerId}`)}&limit=200&expand=true`);
      const list: Json[] = Array.isArray(res) ? res : Array.isArray(res?.tickets) ? res.tickets.map((id: number) => res.assets?.Ticket?.[id]).filter(Boolean) : [];
      out.push(...list.map((t) => this.summary(t)));
    }
    return out.filter((t) => this.mayView(customer, t));
  }

  async getTicket(customer: CustomerRef, ticketId: number): Promise<{ ticket: TicketSummary; articles: ArticleSummary[] } | null> {
    const onBehalfOf = this.sys.creationMode === 'on_behalf_of' ? this.behalf(customer) : undefined;
    let raw: Json;
    try {
      raw = await this.call('GET', `/api/v1/tickets/${ticketId}?expand=true`, { onBehalfOf });
    } catch (err) {
      // Kein Zugriff wird wie "gibt es nicht" behandelt – so lässt sich nicht erraten, welche Ticket-IDs existieren.
      if (err instanceof ConnectorError && (err.status === 403 || err.status === 401 && !!onBehalfOf)) return null;
      throw err;
    }
    if (!raw) return null;
    const ticket = this.summary(raw);
    if (!this.mayView(customer, ticket)) return null;
    const arts = ((await this.call('GET', `/api/v1/ticket_articles/by_ticket/${ticketId}?expand=true`, { onBehalfOf })) ?? []) as Json[];
    const articles: ArticleSummary[] = arts
      .filter((a) => a.internal !== true && a.internal !== 'true')
      .map((a) => ({
        id: Number(a.id),
        from: displaySender(String(a.from ?? ''), String(a.sender ?? ''), this.sys.name, this.sys.hideAgentNames === true),
        sender: String(a.sender ?? ''),
        createdAt: String(a.created_at ?? ''),
        contentType: String(a.content_type ?? 'text/plain'),
        body: String(a.body ?? ''),
        attachments: (Array.isArray(a.attachments) ? a.attachments : []).map((f: Json) => ({
          id: Number(f.id),
          filename: String(f.filename ?? 'datei'),
          size: Number(f.size ?? 0),
          mime: String(f.preferences?.['Content-Type'] ?? f.preferences?.['Mime-Type'] ?? 'application/octet-stream'),
        })),
      }));
    return { ticket, articles };
  }

  async getAttachment(customer: CustomerRef, ticketId: number, articleId: number, attachmentId: number) {
    const detail = await this.getTicket(customer, ticketId);
    const article = detail?.articles.find((a) => a.id === articleId);
    const file = article?.attachments.find((f) => f.id === attachmentId);
    if (!detail || !article || !file) return null;
    const onBehalfOf = this.sys.creationMode === 'on_behalf_of' ? this.behalf(customer) : undefined;
    const r = await this.call('GET', `/api/v1/ticket_attachment/${ticketId}/${articleId}/${attachmentId}`, { onBehalfOf, raw: true });
    if (!r) return null;
    return { data: r.buf as Buffer, mime: file.mime, filename: file.filename };
  }

  async findTicketForRequest(customer: CustomerRef, requestId: string, title: string, since: number): Promise<{ id: number; number: string } | null> {
    const candidates = (await this.listTickets(customer)).filter((t) =>
      t.customerId === customer.customerId && t.title === title && (!t.createdAt || Date.parse(t.createdAt) >= since - 120_000));
    for (const t of candidates.slice(0, 10)) {
      const detail = await this.getTicket(customer, t.id);
      if (detail?.articles[0]?.body.includes(requestId)) return { id: t.id, number: t.number };
    }
    return null;
  }

  async addReply(customer: CustomerRef, ticketId: number, bodyHtml: string, attachments: Attachment[]): Promise<void> {
    const detail = await this.getTicket(customer, ticketId);
    if (!detail) throw new ConnectorError('Ticket nicht gefunden', false, 404);
    const onBehalfOf = this.sys.creationMode === 'on_behalf_of' ? this.behalf(customer) : undefined;
    await this.call('POST', '/api/v1/ticket_articles', {
      onBehalfOf,
      body: {
        ticket_id: ticketId,
        body: bodyHtml,
        content_type: 'text/html',
        type: 'web',
        internal: false,
        sender: 'Customer',
        attachments: attachments.map((a) => ({ filename: a.filename, data: a.data.toString('base64'), 'mime-type': a.mime })),
      },
    });
  }
}
