// Connector für Zammad (REST-API v1).
// Lese- und Schreibzugriffe für Kunden laufen mit "X-On-Behalf-Of": Zammad prüft
// dann selbst, ob der Kunde das Ticket sehen darf. Das Portal prüft zusätzlich.
import {
  ConnectorError, type ZammadAttribute, type ArticleSummary, type Attachment, type Connector, type CreateTicketInput,
  type CustomerRef, type SystemMetadata, type TicketSummary, type TicketSystemConfig,
  type AgentArticle, type AttributeDef, type LinkType, type NewAgentTicket, type NewArticle, type SearchCondition, type SetupInfo, type WorkflowDef, type AdminKind, type StateType, STATE_TYPE_IDS, type ZTicket,
} from './types.ts';
import { isProtectedZammadField } from '../../shared/form.ts';
import { log } from '../log.ts';
import { escapeHtml, textToHtml } from '../../shared/template.ts';

/** Kennung in der Notiz eines Core Workflows: „[portal:<schlüssel>]“ */
export const WORKFLOW_MARK = '[portal:';

const STATE_TTL = 10 * 60_000;
const closedByType = new Map<string, { at: number; names: Set<string> }>();
const CLOSED_TYPES = new Set(['closed', 'merged', 'removed']);
function isClosedType(s: Json): boolean {
  if (typeof s.state_type === 'string') return CLOSED_TYPES.has(s.state_type);
  const id = Number(s.state_type_id);
  return [STATE_TYPE_IDS.closed, STATE_TYPE_IDS.merged, STATE_TYPE_IDS.removed].includes(id);
}
/** Zwischengespeicherte Status-Typen vergessen (nach Änderungen an den Status in Zammad) */
export function forgetClosedStates(systemId?: string): void {
  if (systemId) closedByType.delete(systemId); else closedByType.clear();
}

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

const QUOTE_MAX = 500_000;
const quoteDate = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

/**
 * Verlauf wie bei E-Mails: Die letzte für den Kunden sichtbare Nachricht (interne Notizen sind schon
 * herausgefiltert) wird als Zitat angehängt – sie enthält ihrerseits die früheren Zitate.
 * In Zammad steht so der ganze Verlauf in der Antwort; das Portal klappt das Zitat ein.
 */
export function quoteOf(articles: ArticleSummary[]): string {
  const last = [...articles].sort((a, b) => a.id - b.id).at(-1);
  if (!last || !last.body.trim() || last.body.length > QUOTE_MAX) return '';
  const when = Number.isNaN(Date.parse(last.createdAt)) ? '' : `Am ${quoteDate.format(new Date(last.createdAt)).replace(',', ' um')} `;
  const who = last.from || (last.sender === 'Customer' ? 'Kunde' : 'IT-Service');
  const body = last.contentType.includes('html') ? last.body : textToHtml(last.body);
  return `<br><div>${when ? escapeHtml(when) : ''}schrieb ${escapeHtml(who)}:</div><blockquote type="cite">${body}</blockquote>`;
}

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
    // Mit Status (z. B. „wartet auf Freigabe“) legt der API-Benutzer an – Kunden dürfen keinen Status setzen
    const onBehalf = this.sys.creationMode === 'on_behalf_of' && !input.state;
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
    if (input.state) body.state = input.state;
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

  /**
   * Welche Status gelten als erledigt? Die Liste in den Einstellungen und zusätzlich jeder Zammad-Status vom Typ
   * geschlossen, zusammengeführt oder entfernt – so stimmt „erledigt“ auch bei umbenannten Status („9 Erledigt“).
   */
  private async loadClosedStates(): Promise<void> {
    const hit = closedByType.get(this.sys.id);
    if (hit && Date.now() - hit.at < STATE_TTL) return;
    let names = new Set<string>();
    try {
      const list = await this.call('GET', '/api/v1/ticket_states?per_page=500&expand=true');
      names = new Set((list ?? []).filter((x: Json) => isClosedType(x)).map((x: Json) => String(x.name)));
    } catch { /* ohne Leserecht: nur die Liste aus den Einstellungen */ }
    closedByType.set(this.sys.id, { at: Date.now(), names });
  }

  private summary(t: Json): TicketSummary {
    const state = String(t.state ?? t.state_id ?? '');
    return {
      id: Number(t.id),
      number: String(t.number ?? ''),
      title: String(t.title ?? ''),
      state,
      closed: this.sys.closedStates.includes(state) || (closedByType.get(this.sys.id)?.names.has(state) ?? false),
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
    await this.loadClosedStates();
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

  async ticketsUpdatedSince(since: string): Promise<{ id: number; title: string; customerId: number; updatedAt: string }[]> {
    // Ohne Suchbegriff mit Bedingung: Zammad sucht direkt in der Datenbank (unabhängig von Elasticsearch)
    const q = new URLSearchParams({
      'condition[ticket.updated_at][operator]': 'after (absolute)',
      'condition[ticket.updated_at][value]': since,
      sort_by: 'updated_at', order_by: 'desc', limit: '200', expand: 'true',
    });
    let raw: Json[];
    try {
      raw = ZammadConnector.ticketList(await this.call('GET', `/api/v1/tickets/search?${q}`));
    } catch (err) {
      if (!(err instanceof ConnectorError) || ![400, 404, 422, 500].includes(err.status ?? 0)) throw err;
      // Ältere Versionen: neueste zuerst über die Liste, dann selbst filtern
      raw = ZammadConnector.ticketList(await this.call('GET', '/api/v1/tickets?expand=true&per_page=100&sort_by=updated_at&order_by=desc'));
    }
    return raw
      .map((t) => ({ id: Number(t.id), title: String(t.title ?? ''), customerId: Number(t.customer_id), updatedAt: String(t.updated_at ?? '') }))
      .filter((t) => Number.isSafeInteger(t.id) && Number.isSafeInteger(t.customerId) && t.updatedAt >= since);
  }

  async findTicketByNumber(number: string): Promise<TicketSummary | null> {
    await this.loadClosedStates();
    if (!/^\d{1,20}$/.test(number)) return null;
    const q = new URLSearchParams({
      'condition[ticket.number][operator]': 'is',
      'condition[ticket.number][value]': number,
      limit: '5', expand: 'true',
    });
    const t = ZammadConnector.ticketList(await this.call('GET', `/api/v1/tickets/search?${q}`)).find((x) => String(x.number) === number);
    return t ? this.summary(t) : null;
  }

  async ticketInfo(ticketId: number): Promise<TicketSummary | null> {
    await this.loadClosedStates();
    const t = await this.call('GET', `/api/v1/tickets/${ticketId}?expand=true`);
    return t && t.id !== undefined ? this.summary(t) : null;
  }

  async addTag(ticketId: number, tag: string): Promise<void> {
    await this.call('POST', '/api/v1/tags/add', { body: { object: 'Ticket', o_id: ticketId, item: tag } });
  }

  async removeTag(ticketId: number, tag: string): Promise<void> {
    await this.call('DELETE', '/api/v1/tags/remove', { body: { object: 'Ticket', o_id: ticketId, item: tag } });
  }

  async agentReplies(ticketId: number): Promise<{ id: number; createdAt: string; contentType: string; body: string }[]> {
    const arts = ((await this.call('GET', `/api/v1/ticket_articles/by_ticket/${ticketId}`)) ?? []) as Json[];
    return (Array.isArray(arts) ? arts : [])
      .filter((a) => a.internal !== true && a.internal !== 'true' && String(a.sender ?? '') === 'Agent')
      .map((a) => ({ id: Number(a.id), createdAt: String(a.created_at ?? ''), contentType: String(a.content_type ?? 'text/plain'), body: String(a.body ?? '').slice(0, 50_000) }));
  }

  async getTicket(customer: CustomerRef, ticketId: number): Promise<{ ticket: TicketSummary; articles: ArticleSummary[] } | null> {
    await this.loadClosedStates();
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
    await this.loadClosedStates();
    const candidates = (await this.listTickets(customer)).filter((t) =>
      t.customerId === customer.customerId && t.title === title && (!t.createdAt || Date.parse(t.createdAt) >= since - 120_000));
    for (const t of candidates.slice(0, 10)) {
      const detail = await this.getTicket(customer, t.id);
      if (detail?.articles[0]?.body.includes(requestId)) return { id: t.id, number: t.number };
    }
    return null;
  }

  // ================================================================ Zammad als einzige Datenquelle (ab 2.0)

  private full(t: Json): ZTicket {
    const s = this.summary(t);
    const tags = Array.isArray(t.tags) ? t.tags.map(String) : undefined;
    return { ...s, fields: { ...t }, closeAt: t.close_at ? String(t.close_at) : null, ...(tags ? { tags } : {}) };
  }

  async getTicketFull(ticketId: number): Promise<ZTicket | null> {
    await this.loadClosedStates();
    if (!Number.isSafeInteger(ticketId) || ticketId <= 0) return null;
    const t = await this.call('GET', `/api/v1/tickets/${ticketId}?expand=true`);
    return t && t.id !== undefined ? this.full(t) : null;
  }

  async searchTickets(conditions: Record<string, SearchCondition>, limit = 200): Promise<ZTicket[]> {
    await this.loadClosedStates();
    const q = new URLSearchParams({ sort_by: 'updated_at', order_by: 'desc', limit: String(Math.min(Math.max(limit, 1), 200)), expand: 'true' });
    for (const [k, raw] of Object.entries(conditions)) {
      if (!/^[a-z][a-z0-9_.]{0,60}$/.test(k)) throw new ConnectorError(`Ungültige Bedingung ${k}`, false);
      const c = typeof raw === 'object' ? raw : { operator: 'is' as const, value: raw };
      q.set(`condition[ticket.${k}][operator]`, c.operator);
      if (Array.isArray(c.value)) c.value.forEach((v) => q.append(`condition[ticket.${k}][value][]`, String(v)));
      else q.set(`condition[ticket.${k}][value]`, String(c.value));
    }
    return ZammadConnector.ticketList(await this.call('GET', `/api/v1/tickets/search?${q}`)).map((t) => this.full(t))
      .filter((t) => Number.isSafeInteger(t.id));
  }

  private selfCache: number | null = null;
  async selfId(): Promise<number> {
    if (this.selfCache) return this.selfCache;
    const me = await this.call('GET', '/api/v1/users/me');
    if (!me?.id) throw new ConnectorError('API-Benutzer nicht ermittelbar', true);
    this.selfCache = Number(me.id);
    return this.selfCache;
  }

  async tags(ticketId: number): Promise<string[]> {
    const r = await this.call('GET', `/api/v1/tags?object=Ticket&o_id=${ticketId}`);
    return Array.isArray(r?.tags) ? r.tags.map(String) : [];
  }

  async updateTicket(ticketId: number, changes: { title?: string; state?: string; group?: string; fields?: Record<string, unknown> }): Promise<ZTicket> {
    await this.loadClosedStates();
    const body: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(changes.fields ?? {})) if (/^[a-z][a-z0-9_]{0,60}$/.test(k) && !SYSTEM_ATTRIBUTES.includes(k)) body[k] = v;
    if (changes.title !== undefined) body.title = changes.title;
    if (changes.state !== undefined) body.state = changes.state;
    if (changes.group !== undefined) body.group = changes.group;
    const t = await this.call('PUT', `/api/v1/tickets/${ticketId}?expand=true`, { body });
    if (!t?.id) throw new ConnectorError(`Ticket ${ticketId} nicht gefunden`, false, 404);
    return this.full(t);
  }

  private articleBody(a: NewArticle): Record<string, unknown> {
    return {
      body: a.body,
      content_type: a.contentType ?? 'text/html',
      type: a.type ?? 'note',
      internal: a.internal ?? false,
      sender: a.sender ?? (a.asCustomer ? 'Customer' : 'Agent'),
      ...(a.subject ? { subject: a.subject } : {}),
      ...(a.type === 'email' && a.to ? { to: a.to } : {}),
      attachments: (a.attachments ?? []).map((x) => ({ filename: x.filename, data: x.data.toString('base64'), 'mime-type': x.mime })),
    };
  }

  async createAgentTicket(input: NewAgentTicket): Promise<ZTicket> {
    await this.loadClosedStates();
    const body: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input.fields ?? {})) if (/^[a-z][a-z0-9_]{0,60}$/.test(k) && !SYSTEM_ATTRIBUTES.includes(k)) body[k] = v;
    Object.assign(body, { title: input.title, group: input.group, customer_id: input.customerId, article: { subject: input.article.subject ?? input.title, ...this.articleBody(input.article) } });
    if (input.state) body.state = input.state;
    if (input.tags?.length) body.tags = input.tags.join(',');
    const t = await this.call('POST', '/api/v1/tickets?expand=true', {
      body, onBehalfOf: input.article.asCustomer ? this.behalf(input.article.asCustomer) : undefined,
    });
    if (!t?.id) throw new ConnectorError('Zammad hat kein Ticket zurückgegeben', true);
    return this.full(t);
  }

  async addArticle(ticketId: number, article: NewArticle): Promise<number> {
    const r = await this.call('POST', '/api/v1/ticket_articles', {
      body: { ticket_id: ticketId, ...this.articleBody(article) },
      onBehalfOf: article.asCustomer ? this.behalf(article.asCustomer) : undefined,
    });
    if (!r?.id) throw new ConnectorError('Zammad hat den Artikel nicht angelegt', true);
    return Number(r.id);
  }

  async agentArticles(ticketId: number): Promise<AgentArticle[]> {
    const arts = ((await this.call('GET', `/api/v1/ticket_articles/by_ticket/${ticketId}?expand=true`)) ?? []) as Json[];
    return (Array.isArray(arts) ? arts : []).map((a) => ({
      id: Number(a.id),
      from: String(a.from ?? ''),
      sender: String(a.sender ?? ''),
      createdAt: String(a.created_at ?? ''),
      contentType: String(a.content_type ?? 'text/plain'),
      body: String(a.body ?? ''),
      internal: a.internal === true || a.internal === 'true',
      type: String(a.type ?? ''),
      subject: String(a.subject ?? ''),
      attachments: (Array.isArray(a.attachments) ? a.attachments : []).map((f: Json) => ({
        id: Number(f.id), filename: String(f.filename ?? 'datei'), size: Number(f.size ?? 0),
        mime: String(f.preferences?.['Content-Type'] ?? f.preferences?.['Mime-Type'] ?? 'application/octet-stream'),
      })),
    })).sort((a, b) => a.id - b.id);
  }

  async agentAttachment(ticketId: number, articleId: number, attachmentId: number) {
    const article = (await this.agentArticles(ticketId)).find((a) => a.id === articleId);
    const file = article?.attachments.find((f) => f.id === attachmentId);
    if (!article || !file) return null;
    const r = await this.call('GET', `/api/v1/ticket_attachment/${ticketId}/${articleId}/${attachmentId}`, { raw: true });
    return r ? { data: r.buf as Buffer, mime: file.mime, filename: file.filename } : null;
  }

  async links(ticketId: number): Promise<{ type: LinkType; ticketId: number }[]> {
    const r = await this.call('GET', `/api/v1/links?link_object=Ticket&link_object_value=${ticketId}`);
    const list = Array.isArray(r?.links) ? r.links : [];
    return list.filter((l: Json) => l.link_object === 'Ticket' && ['normal', 'parent', 'child'].includes(l.link_type))
      .map((l: Json) => ({ type: l.link_type as LinkType, ticketId: Number(l.link_object_value) }))
      .filter((l: { ticketId: number }) => Number.isSafeInteger(l.ticketId));
  }

  async addLink(parentNumber: string, childId: number, type: 'parent' | 'normal' = 'parent'): Promise<void> {
    await this.call('POST', '/api/v1/links/add', { body: {
      link_type: type, link_object_target: 'Ticket', link_object_target_value: childId, link_object_source: 'Ticket', link_object_source_number: parentNumber,
    } });
  }

  async removeLink(parentId: number, childId: number, type: 'parent' | 'normal' = 'parent'): Promise<void> {
    await this.call('DELETE', '/api/v1/links/remove', { body: {
      link_type: type, link_object_source: 'Ticket', link_object_source_value: parentId, link_object_target: 'Ticket', link_object_target_value: childId,
    } });
  }

  async setupInfo(): Promise<SetupInfo> {
    const [groups, states, attrs] = await Promise.all([
      this.call('GET', '/api/v1/groups?per_page=500'),
      this.call('GET', '/api/v1/ticket_states?per_page=500&expand=true'),
      this.call('GET', '/api/v1/object_manager_attributes'),
    ]);
    closedByType.set(this.sys.id, { at: Date.now(), names: new Set((states ?? []).filter((x: Json) => isClosedType(x)).map((x: Json) => String(x.name))) });
    const typeOf = (s: Json): StateType | null => {
      const byName = typeof s.state_type === 'string' ? s.state_type : null;
      if (byName && byName in STATE_TYPE_IDS) return byName as StateType;
      const id = Number(s.state_type_id);
      return (Object.entries(STATE_TYPE_IDS).find(([, v]) => v === id)?.[0] as StateType | undefined) ?? null;
    };
    return {
      groups: (groups ?? []).map((g: Json) => ({ id: Number(g.id), name: String(g.name), active: g.active !== false })),
      states: (states ?? []).map((s: Json) => ({
        id: Number(s.id), name: String(s.name), active: s.active !== false, stateTypeId: s.state_type_id === undefined ? null : Number(s.state_type_id),
        type: typeOf(s), defaultCreate: s.default_create === true, defaultFollowUp: s.default_follow_up === true,
      })),
      attributes: (attrs ?? []).filter((a: Json) => a.object === 'Ticket').map((a: Json) => ({
        id: Number(a.id), name: String(a.name), display: String(a.display ?? a.name), dataType: String(a.data_type ?? ''),
        options: a.data_option?.options && typeof a.data_option.options === 'object' && !Array.isArray(a.data_option.options)
          ? Object.fromEntries(Object.entries(a.data_option.options).map(([k, v]) => [k, String(v)]))
          : Object.fromEntries(flattenOptions(a.data_option?.options).map((o) => [o.value, o.label])),
      })),
    };
  }

  async createGroup(name: string): Promise<void> {
    await this.call('POST', '/api/v1/groups', { body: { name, active: true, note: 'Angelegt vom Self-Service-Portal' } });
  }

  async adminList(kind: AdminKind): Promise<{ id: number; name: string; [k: string]: unknown }[]> {
    const r = await this.call('GET', `/api/v1/${kind}?per_page=500`);
    return (Array.isArray(r) ? r : []).map((x: Json) => ({ ...x, id: Number(x.id), name: String(x.name ?? '') }));
  }

  async adminCreate(kind: AdminKind, body: Record<string, unknown>): Promise<{ id: number }> {
    const r = await this.call('POST', `/api/v1/${kind}`, { body });
    if (!r?.id) throw new ConnectorError(`Zammad hat ${kind} nicht angelegt`, false);
    return { id: Number(r.id) };
  }

  async createState(name: string, type: StateType, opts: { ignoreEscalation?: boolean } = {}): Promise<void> {
    // Typ-ID aus einem vorhandenen Status dieses Typs (Namen sind frei wählbar), sonst die ID der Grundinstallation
    const states = (await this.call('GET', '/api/v1/ticket_states?per_page=500&expand=true')) as Json[];
    const like = (states ?? []).find((s) => s.state_type === type && s.state_type_id);
    const typeId = like ? Number(like.state_type_id) : STATE_TYPE_IDS[type];
    await this.call('POST', '/api/v1/ticket_states', { body: { name, state_type_id: typeId, active: true, ignore_escalation: opts.ignoreEscalation ?? true, note: 'Angelegt vom Self-Service-Portal' } });
  }


  async saveAttribute(def: AttributeDef, existingId?: number): Promise<void> {
    const opt: Record<string, unknown> = { null: true };
    switch (def.dataType) {
      case 'input': Object.assign(opt, { type: 'text', maxlength: 255 }); break;
      case 'textarea': Object.assign(opt, { type: 'textarea', maxlength: 5000, rows: 4 }); break;
      case 'select': Object.assign(opt, { options: def.options ?? {}, default: '', nulloption: true, multiple: false }); break;
      case 'multiselect': Object.assign(opt, { options: def.options ?? {}, default: [] }); break;
      case 'boolean': Object.assign(opt, { options: { true: 'Ja', false: 'Nein' }, default: false }); break;
      case 'datetime': Object.assign(opt, { future: true, past: true, diff: null }); break;
      case 'date': Object.assign(opt, { diff: null }); break;
      case 'integer': Object.assign(opt, { min: 0, max: 2147483647 }); break;
    }
    const shown = { shown: true, required: false };
    const body = {
      object: 'Ticket', name: def.name, display: def.display, data_type: def.dataType, data_option: opt, active: true,
      position: def.position ?? 1500,
      screens: { create_middle: { 'ticket.agent': shown }, edit: { 'ticket.agent': shown } },
    };
    if (existingId) await this.call('PUT', `/api/v1/object_manager_attributes/${existingId}`, { body });
    else await this.call('POST', '/api/v1/object_manager_attributes', { body });
  }

  async workflows(): Promise<{ id: number; name: string; active: boolean; note: string }[]> {
    const list = await this.call('GET', '/api/v1/core_workflows?per_page=500');
    return (Array.isArray(list) ? list : []).map((w: Json) => ({ id: Number(w.id), name: String(w.name ?? ''), active: w.active !== false, note: String(w.note ?? '') }));
  }

  async saveWorkflow(def: WorkflowDef, existingId?: number): Promise<void> {
    const field = (k: string) => `ticket.${k}`;
    const body = {
      // changeable: true – nur solche zeigt Zammad über die API (Liste, Suche, Ändern); sonst findet das Portal sie nie wieder
      name: def.name, object: 'Ticket', active: true, priority: def.priority, stop_after_match: false, changeable: true,
      preferences: { screen: ['create_middle', 'edit'] },
      condition_saved: {},
      condition_selected: Object.fromEntries(Object.entries(def.condition).map(([k, c]) => [field(k), c.value ? { operator: c.operator, value: c.value } : { operator: c.operator }])),
      perform: Object.fromEntries(Object.entries(def.perform).map(([k, op]) => [field(k), { operator: op, [op]: 'true' }])),
      note: `${WORKFLOW_MARK}${def.key}] Angelegt und gepflegt vom Self-Service-Portal – Änderungen hier überschreibt „In Zammad einrichten“.`,
    };
    if (existingId) await this.call('PUT', `/api/v1/core_workflows/${existingId}`, { body });
    else await this.call('POST', '/api/v1/core_workflows', { body });
  }

  async adminUpdate(kind: AdminKind, id: number, body: Record<string, unknown>): Promise<void> {
    await this.call('PUT', `/api/v1/${kind}/${id}`, { body });
  }

  async executeMigrations(): Promise<void> {
    await this.call('POST', '/api/v1/object_manager_attributes_execute_migrations', { body: {} });
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
        body: bodyHtml + quoteOf(detail.articles),
        content_type: 'text/html',
        type: 'web',
        internal: false,
        sender: 'Customer',
        attachments: attachments.map((a) => ({ filename: a.filename, data: a.data.toString('base64'), 'mime-type': a.mime })),
      },
    });
  }
}
