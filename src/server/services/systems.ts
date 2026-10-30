// Ticketsysteme: Konfiguration, Sichtbarkeit, Connector-Erzeugung.
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { App } from '../app.ts';
import { parseJson } from '../db/db.ts';
import type { AuthUser } from './rbac.ts';
import { can } from './rbac.ts';
import { ZammadConnector } from '../connectors/zammad.ts';
import type { Connector, TicketSystemConfig } from '../connectors/types.ts';
import { DEFAULT_BRANDING, type Branding } from '../../shared/branding.ts';
import { hostAllowed, blockedAddress, blockedHostname, guardedFetch } from '../net/guarded-fetch.ts';

export interface SystemRow {
  id: string; slug: string; name: string; type: 'zammad'; base_url: string; api_token: string | null;
  default_group: string | null; creation_mode: 'on_behalf_of' | 'customer_field'; status: 'active' | 'maintenance' | 'inactive';
  visible_groups: string; require_approval: number; show_org_tickets: number; allow_replies: number;
  closed_states: string; portal_tag: string; released_attributes: string; sort: number; created_at: number; updated_at: number;
  /** JSON-Liste erlaubter Zammad-Gruppen (leer = keine Einschränkung) */
  allowed_groups: string; hide_agent_names: number;
}

/** Zammad-Gruppen, in die das Portal Tickets anlegen darf. Leer = keine Einschränkung. */
export function allowedGroups(sys: SystemRow): string[] {
  return parseJson<string[]>(sys.allowed_groups, []);
}

export function getSystem(app: App, id: string): SystemRow | undefined {
  return app.db.get<SystemRow>('SELECT * FROM ticket_systems WHERE id = ?', id);
}

/** Ticketsystem über ID oder Kürzel (Weiterleitungen aus übertragenen Konfigurationen tragen das Kürzel). */
export function findSystem(app: App, ref: string): SystemRow | undefined {
  return getSystem(app, ref) ?? app.db.get<SystemRow>('SELECT * FROM ticket_systems WHERE slug = ?', ref);
}

export function listSystems(app: App): SystemRow[] {
  return app.db.all<SystemRow>('SELECT * FROM ticket_systems ORDER BY sort, name');
}

export function groupsMatch(required: string[], user: AuthUser): boolean {
  if (required.length === 0) return true;
  const mine = new Set(user.groups.map((g) => g.toLowerCase()));
  return required.some((g) => mine.has(g.toLowerCase()));
}

/** Darf der Benutzer im Portal Anfragen an dieses System stellen? */
export function systemVisibleTo(sys: SystemRow, user: AuthUser): boolean {
  return sys.status !== 'inactive' && can(user, 'portal.use', sys.id) && groupsMatch(parseJson<string[]>(sys.visible_groups, []), user);
}

export function connectorConfig(app: App, sys: SystemRow): TicketSystemConfig {
  return {
    id: sys.id,
    name: sys.name,
    type: sys.type,
    baseUrl: sys.base_url,
    apiToken: sys.api_token ? app.box.decrypt('system-token', sys.api_token) : '',
    defaultGroup: sys.default_group,
    creationMode: sys.creation_mode,
    showOrgTickets: sys.show_org_tickets === 1,
    closedStates: parseJson<string[]>(sys.closed_states, ['closed', 'merged', 'removed']),
    hideAgentNames: sys.hide_agent_names === 1,
  };
}

let fetchOverride: typeof fetch | undefined;
/** Nur für Tests: eigenen fetch für Connectoren setzen. */
export function setConnectorFetch(f: typeof fetch | undefined): void { fetchOverride = f; }

/** SSRF-Schutz: Loopback und eigene Dienstnamen nur in Tests oder mit ALLOW_LOOPBACK_TICKET_URLS (Demo). */
export function guardOptions(app: App) {
  return {
    allowPrivate: app.cfg.allowPrivateTicketUrls, allowLoopback: app.cfg.allowLoopbackTicketUrls,
    blockedCidrs: app.cfg.ticketUrlBlockedCidrs, allowedHosts: app.cfg.ticketUrlAllowedHosts,
  };
}

export function connectorFor(app: App, sys: SystemRow): Connector {
  const cfg = connectorConfig(app, sys);
  switch (sys.type) {
    case 'zammad':
      return new ZammadConnector(cfg, fetchOverride ?? guardedFetch(guardOptions(app)));
    default:
      throw new Error(`Unbekannter Systemtyp ${sys.type}`);
  }
}

/** Prüft die URL eines Ticketsystems (Schutz vor SSRF auf Metadaten-Dienste u. Ä.). */
export async function validateSystemUrl(app: App, url: string): Promise<string | null> {
  let u: URL;
  try { u = new URL(url); } catch { return 'Ungültige URL'; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'Nur http(s) erlaubt';
  if (u.username || u.password) return 'Zugangsdaten gehören nicht in die URL';
  // Auf dem Rohtext prüfen: ein leeres „?“ oder „#“ ergibt leere search/hash, würde aber den API-Pfad zur Query machen
  if (u.search || u.hash || /[?#]/.test(url)) return 'URL ohne Parameter angeben';
  if (app.cfg.env === 'production' && u.protocol !== 'https:' && !process.env.ALLOW_HTTP_TICKET_URLS) return 'In Produktion nur https:// (oder ALLOW_HTTP_TICKET_URLS setzen)';
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!hostAllowed(host, app.cfg.ticketUrlAllowedHosts)) return `Adresse nicht erlaubt (${host} steht nicht in TICKET_URL_ALLOWED_HOSTS)`;
  const nameProblem = blockedHostname(host, guardOptions(app));
  if (nameProblem) return `Adresse nicht erlaubt (${nameProblem})`;
  let addrs: string[];
  try {
    addrs = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
  } catch {
    return `Hostname ${host} nicht auflösbar`;
  }
  for (const a of addrs) {
    const why = blockedAddress(a, guardOptions(app));
    if (why) return `Adresse nicht erlaubt: ${a} (${why})`;
  }
  return null;
}

export function publishedBranding(app: App, systemId: string | null): Branding {
  if (!systemId) return globalBranding(app);
  const row = app.db.get<{ data: string }>("SELECT data FROM branding_versions WHERE system_id = ? AND status = 'published' ORDER BY version DESC LIMIT 1", systemId);
  return { ...DEFAULT_BRANDING, ...parseJson<Partial<Branding>>(row?.data, {}) };
}

export function globalBranding(app: App): Branding {
  const row = app.db.get<{ value: string }>("SELECT value FROM settings WHERE key = 'branding.global'");
  return { ...DEFAULT_BRANDING, ...parseJson<Partial<Branding>>(row?.value, {}) };
}
