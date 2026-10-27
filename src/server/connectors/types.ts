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
  createdAt: string;
  updatedAt: string;
}

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
}

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
  getTicket(customer: CustomerRef, ticketId: number): Promise<{ ticket: TicketSummary; articles: ArticleSummary[] } | null>;
  getAttachment(customer: CustomerRef, ticketId: number, articleId: number, attachmentId: number): Promise<{ data: Buffer; mime: string; filename: string } | null>;
  addReply(customer: CustomerRef, ticketId: number, bodyHtml: string, attachments: Attachment[]): Promise<void>;
  /** Ticket, das zu einer Portal-Anfrage schon angelegt wurde (Schutz vor Duplikaten nach Abbruch). */
  findTicketForRequest(customer: CustomerRef, requestId: string, title: string, since: number): Promise<{ id: number; number: string } | null>;
}
