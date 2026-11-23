// Gemeinsame Schnittstelle aller Ticketsystem-Connectoren.

export interface TicketSystemConfig {
  id: string;
  name: string;
  type: 'zammad';
  baseUrl: string;
  apiToken: string;
  defaultGroup: string | null;
  creationMode: 'on_behalf_of' | 'customer_field';
  showOrgTickets: boolean;
  closedStates: string[];
  /** Namen von Agenten in Antworten durch den Systemnamen ersetzen */
  hideAgentNames?: boolean;
}

export interface Attachment { filename: string; mime: string; data: Buffer }

export interface CustomerRef { customerId: number; email: string }

export interface TicketSummary {
  id: number;
  number: string;
  title: string;
  state: string;
  closed: boolean;
  priority: string | null;
  group: string | null;
  customerId: number;
  /** Organisation des Tickets (für „Tickets der eigenen Organisation anzeigen“) */
  organizationId: number | null;
  createdAt: string;
  updatedAt: string;
}

/** Ticket mit allen Attributen (Sicht des API-Benutzers) – für Freigaben, Störungen, Wartungen, Probleme */
export interface ZTicket extends TicketSummary {
  /** Eigene Ticket-Attribute (z. B. freigabe_status, auswirkung) */
  fields: Record<string, unknown>;
  /** Zeitpunkt des Schließens (ISO), sonst null */
  closeAt: string | null;
  tags?: string[];
}

/** Artikel aus Sicht des API-Benutzers (auch interne Notizen) */
export interface AgentArticle extends ArticleSummary {
  internal: boolean;
  type: string;
  subject: string;
}

export interface NewArticle {
  body: string;
  /** text/html (Standard) oder text/plain */
  contentType?: string;
  /** note (Standard) oder email (Zammad verschickt sie über den E-Mail-Kanal) */
  type?: 'note' | 'email' | 'web';
  internal?: boolean;
  subject?: string;
  /** Empfänger bei type = email */
  to?: string;
  /** Absenderrolle im Ticket (Standard: Agent) */
  sender?: 'Agent' | 'Customer' | 'System';
  /** Im Namen dieses Kunden schreiben (X-On-Behalf-Of) – nur in dessen eigenem Ticket */
  asCustomer?: CustomerRef;
  attachments?: Attachment[];
}

export interface NewAgentTicket {
  customerId: number;
  title: string;
  group: string;
  state?: string;
  fields?: Record<string, unknown>;
  tags?: string[];
  article: NewArticle;
}

export type LinkType = 'normal' | 'parent' | 'child';

export interface ArticleSummary {
  id: number;
  from: string;
  sender: 'Customer' | 'Agent' | 'System' | string;
  createdAt: string;
  contentType: string;
  body: string;
  attachments: { id: number; filename: string; size: number; mime: string }[];
}

export interface CreateTicketInput {
  customer: CustomerRef;
  title: string;
  group: string;
  priority?: string;
  bodyHtml: string;
  attachments: Attachment[];
  fields: Record<string, unknown>;
  tags: string[];
  /** Status beim Anlegen (z. B. „wartet auf Freigabe“) – legt das Ticket als API-Benutzer an, Absender bleibt der Kunde */
  state?: string;
}

/** Bedingung für die Suche: Wert = genaue Übereinstimmung; Tags: enthält einen der Werte */
export type SearchCondition = string | number | boolean | { operator: 'is' | 'is not' | 'contains one'; value: string | number | boolean | (string | number)[] };

export interface SystemMetadata {
  groups: { id: number; name: string }[];
  states: { id: number; name: string }[];
  priorities: { id: number; name: string }[];
  fields: ZammadAttribute[];
}

export interface ZammadAttribute {
  name: string;
  display: string;
  /** Zammad-Datentyp: input, textarea, select, multiselect, tree_select, multi_tree_select, boolean, integer, date … */
  type: string;
  options?: { value: string; label: string }[];
  /** Vom Portal unterstützter Typ (null = nicht unterstützt) */
  portalType: 'text' | 'textarea' | 'select' | 'multiselect' | 'checkbox' | 'number' | 'date' | null;
}

export class ConnectorError extends Error {
  retryable: boolean;
  status?: number;

  constructor(message: string, retryable: boolean, status?: number) {
    super(message);
    this.retryable = retryable;
    this.status = status;
  }
}

export interface Connector {
  test(): Promise<{ user: string; version?: string }>;
  metadata(): Promise<SystemMetadata>;
  findCustomer(email: string): Promise<CustomerRef | null>;
  findOrCreateCustomer(user: { email: string; displayName: string }): Promise<CustomerRef>;
  createTicket(input: CreateTicketInput): Promise<{ id: number; number: string }>;
  listTickets(customer: CustomerRef): Promise<TicketSummary[]>;
  /** Für die Benachrichtigung: Tickets, die sich seit `since` geändert haben (Sicht des API-Benutzers) */
  ticketsUpdatedSince(since: string): Promise<{ id: number; title: string; customerId: number; updatedAt: string }[]>;
  /** Für die Benachrichtigung: öffentliche Antworten von Bearbeitern in einem Ticket (keine internen Notizen) */
  agentReplies(ticketId: number): Promise<{ id: number; createdAt: string; contentType: string; body: string }[]>;
  getTicket(customer: CustomerRef, ticketId: number): Promise<{ ticket: TicketSummary; articles: ArticleSummary[] } | null>;
  getAttachment(customer: CustomerRef, ticketId: number, articleId: number, attachmentId: number): Promise<{ data: Buffer; mime: string; filename: string } | null>;
  addReply(customer: CustomerRef, ticketId: number, bodyHtml: string, attachments: Attachment[]): Promise<void>;
  /** Ticket, das zu einer Portal-Anfrage schon angelegt wurde (Schutz vor Duplikaten nach Abbruch). */
  findTicketForRequest(customer: CustomerRef, requestId: string, title: string, since: number): Promise<{ id: number; number: string } | null>;
  /** Ticket über die Ticketnummer (als API-Benutzer, für Probleme und Störungen in der Verwaltung) */
  findTicketByNumber(number: string): Promise<TicketSummary | null>;
  /** Ticket über die ID (als API-Benutzer) – null, wenn es nicht (mehr) existiert */
  ticketInfo(ticketId: number): Promise<TicketSummary | null>;
  /** Tag am Ticket setzen bzw. entfernen – so bleibt die Zuordnung in Zammad sichtbar */
  addTag(ticketId: number, tag: string): Promise<void>;
  removeTag(ticketId: number, tag: string): Promise<void>;

  // ---- Zammad als einzige Datenquelle (ab 2.0): alles als API-Benutzer
  /** Ticket mit Attributen; null, wenn es nicht existiert */
  getTicketFull(ticketId: number): Promise<ZTicket | null>;
  /** Tickets mit Bedingungen (Wert = genaue Übereinstimmung), neueste zuerst */
  searchTickets(conditions: Record<string, SearchCondition>, limit?: number): Promise<ZTicket[]>;
  /** ID des API-Benutzers (Kunde der Tickets für Störungen, Wartungen und Probleme) */
  selfId(): Promise<number>;
  /** Tags eines Tickets */
  tags(ticketId: number): Promise<string[]>;
  /** Titel, Status, Gruppe und eigene Attribute ändern */
  updateTicket(ticketId: number, changes: { title?: string; state?: string; group?: string; fields?: Record<string, unknown> }): Promise<ZTicket>;
  createAgentTicket(input: NewAgentTicket): Promise<ZTicket>;
  addArticle(ticketId: number, article: NewArticle): Promise<number>;
  /** Alle Artikel inkl. interner Notizen */
  agentArticles(ticketId: number): Promise<AgentArticle[]>;
  agentAttachment(ticketId: number, articleId: number, attachmentId: number): Promise<{ data: Buffer; mime: string; filename: string } | null>;
  /** Verknüpfungen aus Sicht des Tickets: child = Kind dieses Tickets, parent = Eltern-Ticket */
  links(ticketId: number): Promise<{ type: LinkType; ticketId: number }[]>;
  /** parentId wird Eltern-Ticket von childId (type parent) bzw. normale Verknüpfung */
  addLink(parentNumber: string, childId: number, type?: 'parent' | 'normal'): Promise<void>;
  removeLink(parentId: number, childId: number, type?: 'parent' | 'normal'): Promise<void>;
  // ---- Einrichtung (braucht Admin-Rechte in Zammad)
  setupInfo(): Promise<SetupInfo>;
  createGroup(name: string): Promise<void>;
  createState(name: string, likeState: string, opts?: { ignoreEscalation?: boolean }): Promise<void>;
  /** Verwaltungsobjekte in Zammad (Grundausstattung): Liste bzw. Anlegen */
  adminList(kind: AdminKind): Promise<{ id: number; name: string; [k: string]: unknown }[]>;
  adminCreate(kind: AdminKind, body: Record<string, unknown>): Promise<{ id: number }>;
  saveAttribute(def: AttributeDef, existingId?: number): Promise<void>;
  executeMigrations(): Promise<void>;
  /** Core Workflows (Abhängigkeiten zwischen Feldern) */
  workflows(): Promise<{ id: number; name: string; active: boolean }[]>;
  saveWorkflow(def: WorkflowDef, existingId?: number): Promise<void>;
}

export type AdminKind = 'ticket_priorities' | 'calendars' | 'slas' | 'triggers' | 'jobs' | 'overviews' | 'roles' | 'ticket_states';

/** Core Workflow für Tickets: Bedingung (Feld → Operator/Wert) und Wirkung (Feld → show/hide) */
export interface WorkflowDef {
  name: string;
  priority: number;
  condition: Record<string, { operator: 'is' | 'is set'; value?: string[] }>;
  perform: Record<string, 'show' | 'hide'>;
}

export interface AttributeDef {
  name: string;
  display: string;
  dataType: 'input' | 'textarea' | 'select' | 'multiselect' | 'boolean' | 'datetime' | 'date' | 'integer';
  options?: Record<string, string>;
  position?: number;
}

export interface SetupInfo {
  groups: { id: number; name: string; active: boolean }[];
  states: { id: number; name: string; active: boolean; stateTypeId: number | null }[];
  attributes: { id: number; name: string; display: string; dataType: string; options: Record<string, string> }[];
}
