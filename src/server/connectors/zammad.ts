// Connector für Zammad (REST-API v1).
// Lese- und Schreibzugriffe für Kunden laufen mit "X-On-Behalf-Of": Zammad prüft
// dann selbst, ob der Kunde das Ticket sehen darf. Das Portal prüft zusätzlich.
import {
  ConnectorError, type ZammadAttribute, type ArticleSummary, type Attachment, type Connector, type CreateTicketInput,
  type CustomerRef, type SystemMetadata, type TicketSummary, type TicketSystemConfig,
} from './types.ts';
import { isProtectedZammadField } from '../../shared/form.ts';
import { log } from '../log.ts';

const MAX_RESPONSE = 30 * 1024 * 1024;
/** Aufrufe, die länger dauern, landen mit Dauer im Log – hilft bei „manchmal langsam“ */
const SLOW_CALL_MS = 2000;
// Organisation je Kunde – über Connector-Instanzen hinweg (für jede Anfrage entsteht ein neuer Connector)
const orgCache = new Map<string, { at: number; org: number | null }>();

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

/**
 * Ist ein Zammad nicht erreichbar (Verbindungsfehler, keine HTTP-Antwort), schlagen weitere Aufrufe für kurze
 * Zeit sofort fehl, statt jedes Mal bis zur Zeitüberschreitung zu warten – sonst hinge jede Seite, die Zammad
 * braucht. Ein erfolgreicher Aufruf (z. B. „Verbindung testen“) hebt die Sperre auf.
 */
const UNREACHABLE_PAUSE_MS = 30_000;
const unreachableUntil = new Map<string, number>();
export function resetReachability(): void { unreachableUntil.clear(); orgCache.clear(); }

export class ZammadConnector implements Connector {
  private sys: TicketSystemConfig;
  private fetchImpl: typeof fetch;

  constructor(sys: TicketSystemConfig, fetchImpl: typeof fetch = fetch) {
    this.sys = sys;
    this.fetchImpl = fetchImpl;
  }

  private url(path: string): string {
    // Basisadresse ohne Query/Fragment (Altbestand), Pfad wird immer angehängt – nie als Query
    const base = new URL(this.sys.baseUrl);
    base.search = '';
    base.hash = '';
    return base.toString().replace(/\/+$/, '') + path;
  }

  private async call(method: string, path: string, opts: { body?: unknown; onBehalfOf?: string; raw?: boolean; force?: boolean } = {}): Promise<Json> {
    const key = this.sys.baseUrl;
    const pausedUntil = unreachableUntil.get(key) ?? 0;
    if (!opts.force && pausedUntil > Date.now()) {
      throw new ConnectorError(`${this.sys.name} ist gerade nicht erreichbar (neuer Versuch in ${Math.ceil((pausedUntil - Date.now()) / 1000)} s)`, true);
    }
    const headers: Record<string, string> = {
      Authorization: `Token token=${this.sys.apiToken}`,
      Accept: 'application/json',
      'User-Agent': 'zammad-service-portal',
    };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    if (opts.onBehalfOf) headers['X-On-Behalf-Of'] = opts.onBehalfOf;
    let res: Response;
    const started = Date.now();
    try {
      res = await this.fetchImpl(this.url(path), {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        redirect: 'error',
        // Lesen: 10 s reichen, Anlegen mit Anhängen darf länger dauern
        signal: AbortSignal.timeout(method === 'GET' ? 10_000 : 20_000),
      });
    } catch (err) {
      unreachableUntil.set(key, Date.now() + UNREACHABLE_PAUSE_MS);
      throw new ConnectorError(`${this.sys.name} nicht erreichbar: ${(err as Error).message}`, true);
    }
    unreachableUntil.delete(key);
    const took = Date.now() - started;
    if (took > SLOW_CALL_MS) log.warn('Zammad antwortet langsam', { system: this.sys.name, method, path: path.split('?')[0], ms: took });
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
    // Abbruch beim Lesen der Antwort (Verbindung weg, Zeitüberschreitung) ist vorübergehend: erneut versuchen.
    // Die Zustellung prüft dann vor dem nächsten Anlegen, ob das Ticket schon existiert.
    const readBody = async <T>(fn: () => Promise<T>): Promise<T> => {
      try { return await fn(); } catch (err) { throw new ConnectorError(`${this.sys.name}: Antwort unvollständig (${(err as Error).message})`, true, res.status); }
    };
    if (opts.raw) {
      const buf = Buffer.from(await readBody(() => res.arrayBuffer()));
      if (buf.length > MAX_RESPONSE) throw new ConnectorError('Antwort von Zammad zu groß', false);
      return { buf, type: res.headers.get('content-type') ?? 'application/octet-stream', disposition: res.headers.get('content-disposition') ?? '' };
    }
    const text = await readBody(() => res.text());
    if (text.length > MAX_RESPONSE) throw new ConnectorError('Antwort von Zammad zu groß', false);
    if (!text) return {};
    try { return JSON.parse(text); } catch { throw new ConnectorError('Zammad lieferte kein JSON', false, res.status); }
  }

  async test(): Promise<{ user: string; version?: string }> {
    const me = await this.call('GET', '/api/v1/users/me', { force: true });
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
      organizationId: t.organization_id === null || t.organization_id === undefined || t.organization_id === '' ? null : Number(t.organization_id),
      createdAt: String(t.created_at ?? ''),
      updatedAt: String(t.updated_at ?? ''),
    };
  }

  /**
   * Darf der Kunde dieses Ticket im Portal sehen? Eigene Tickets immer; Tickets der eigenen Organisation nur mit
   * der Einstellung „Tickets der eigenen Organisation anzeigen“ – und nur wirklich derselben Organisation.
   * Was Zammad dem Konto sonst noch zeigt (z. B. als Agent in seinen Gruppen), gehört nicht ins Portal.
   */
  private mayView(customer: CustomerRef, t: TicketSummary, org: number | null): boolean {
    if (t.customerId === customer.customerId) return true;
    return this.sys.showOrgTickets && org !== null && t.organizationId === org;
  }

  /** Organisation des Kunden (nur gebraucht, wenn Organisations-Tickets angezeigt werden). */
  private async organizationOf(customer: CustomerRef): Promise<number | null> {
    if (!this.sys.showOrgTickets) return null;
    const cacheKey = `${this.sys.baseUrl}|${customer.customerId}`;
    const hit = orgCache.get(cacheKey);
    if (hit && Date.now() - hit.at < 10 * 60_000) return hit.org;
    let u: Json = null;
    try {
      u = await this.call('GET', `/api/v1/users/${this.behalf(customer)}`);
    } catch (err) {
      // Ohne Organisation nur die eigenen Tickets – sicherer als gar nichts anzuzeigen
      if (!(err instanceof ConnectorError) || err.retryable) throw err;
    }
    const org = u?.organization_id === null || u?.organization_id === undefined || u?.organization_id === '' ? null : Number(u.organization_id);
    if (orgCache.size > 5000) orgCache.clear();
    orgCache.set(cacheKey, { at: Date.now(), org: Number.isSafeInteger(org) && (org as number) > 0 ? org : null });
    return orgCache.get(cacheKey)!.org;
  }

  private static ticketList(res: Json): Json[] {
    if (Array.isArray(res)) return res;
    if (Array.isArray(res?.records)) return res.records;
    const ids = Array.isArray(res?.tickets) ? res.tickets : Array.isArray(res?.record_ids) ? res.record_ids : null;
    return ids ? ids.map((id: number) => res.assets?.Ticket?.[id]).filter(Boolean) : [];
  }

  /**
   * Tickets mit einer Bedingung suchen (z. B. customer_id = 42), neueste zuerst. Ohne Suchbegriff sucht Zammad
   * direkt in der Datenbank – unabhängig von Elasticsearch und immer aktuell.
   */
  private async searchBy(field: 'customer_id' | 'organization_id', value: number, onBehalfOf: string | undefined): Promise<Json[]> {
    const q = new URLSearchParams({
      [`condition[ticket.${field}][operator]`]: 'is',
      [`condition[ticket.${field}][value]`]: String(value),
      sort_by: 'updated_at', order_by: 'desc', limit: '200', expand: 'true',
    });
    return ZammadConnector.ticketList(await this.call('GET', `/api/v1/tickets/search?${q}`, { onBehalfOf }));
  }

  /** Alter Weg für Zammad-Versionen ohne Suche mit Bedingung. */
  private async listTicketsLegacy(customer: CustomerRef): Promise<Json[]> {
    const out: Json[] = [];
    if (this.sys.creationMode === 'on_behalf_of') {
      for (let page = 1; page <= 5; page++) {
        const list = (await this.call('GET', `/api/v1/tickets?expand=true&per_page=100&page=${page}`, { onBehalfOf: this.behalf(customer) })) as Json[];
        if (!Array.isArray(list) || list.length === 0) break;
        out.push(...list);
        if (list.length < 100) break;
      }
      return out;
    }
    return ZammadConnector.ticketList(await this.call('GET', `/api/v1/tickets/search?query=${encodeURIComponent(`customer_id:${customer.customerId}`)}&limit=200&expand=true`));
  }

  async listTickets(customer: CustomerRef): Promise<TicketSummary[]> {
    // Früher: alle für das Konto sichtbaren Tickets seitenweise (älteste zuerst) und dann filtern. Ist der Kunde in
    // Zammad zugleich Agent, sieht er dort Tausende Tickets – die eigenen neuen lagen dann jenseits der ersten Seiten.
    const onBehalfOf = this.sys.creationMode === 'on_behalf_of' ? this.behalf(customer) : undefined;
    // Organisation und eigene Tickets gleichzeitig abfragen statt nacheinander
    const [orgResult, own] = await Promise.allSettled([this.organizationOf(customer), this.searchBy('customer_id', customer.customerId, onBehalfOf)]);
    if (orgResult.status === 'rejected') throw orgResult.reason;
    const org = orgResult.value;
    let raw: Json[];
    try {
      if (own.status === 'rejected') throw own.reason;
      raw = own.value;
      if (org !== null) raw.push(...await this.searchBy('organization_id', org, onBehalfOf));
    } catch (err) {
      // Ältere Zammad-Versionen kennen die Suche mit Bedingung nicht – dann wie bisher
      if (!(err instanceof ConnectorError) || ![400, 404, 422, 500].includes(err.status ?? 0)) throw err;
      raw = await this.listTicketsLegacy(customer);
    }
    const seen = new Set<number>();
    return raw.map((t) => this.summary(t))
      .filter((t) => Number.isSafeInteger(t.id) && !seen.has(t.id) && seen.add(t.id) && this.mayView(customer, t, org))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
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
    if (!this.mayView(customer, ticket, ticket.customerId === customer.customerId ? null : await this.organizationOf(customer))) return null;
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
    // Organisations-Tickets sind nur lesbar: antworten nur in eigene Tickets (sonst im Namen anderer)
    if (detail.ticket.customerId !== customer.customerId) throw new ConnectorError('Ticket nicht gefunden', false, 404);
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
