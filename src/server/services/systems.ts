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

export interface SystemRow {
  id: string; slug: string; name: string; type: 'zammad'; base_url: string; api_token: string | null;
  default_group: string | null; creation_mode: 'on_behalf_of' | 'customer_field'; status: 'active' | 'maintenance' | 'inactive';
  visible_groups: string; require_approval: number; show_org_tickets: number; allow_replies: number;
  closed_states: string; portal_tag: string; released_attributes: string; sort: number; created_at: number; updated_at: number;
}

export function getSystem(app: App, id: string): SystemRow | undefined {
  return app.db.get<SystemRow>('SELECT * FROM ticket_systems WHERE id = ?', id);
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
  };
}

let fetchOverride: typeof fetch | undefined;
/** Nur für Tests: eigenen fetch für Connectoren setzen. */
export function setConnectorFetch(f: typeof fetch | undefined): void { fetchOverride = f; }

export function connectorFor(app: App, sys: SystemRow): Connector {
  const cfg = connectorConfig(app, sys);
  switch (sys.type) {
    case 'zammad':
      return new ZammadConnector(cfg, fetchOverride ?? fetch);
    default:
      throw new Error(`Unbekannter Systemtyp ${sys.type}`);
  }
}

function blockedIp(ip: string, allowPrivate: boolean): boolean {
  const v4 = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  if (isIP(v4) === 4) {
    const [a, b] = v4.split('.').map(Number);
    if (a === 169 && b === 254) return true; // Link-Local / Cloud-Metadaten
    if (a === 0 || a >= 224) return true;
    if (a === 127) return true;
    if (!allowPrivate && (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127))) return true;
    return false;
  }
  const l = ip.toLowerCase();
  if (l === '::' || l === '::1' || l.startsWith('fe80') || l.startsWith('ff')) return true;
  if (!allowPrivate && (l.startsWith('fc') || l.startsWith('fd'))) return true;
  return false;
}

/** Prüft die URL eines Ticketsystems (Schutz vor SSRF auf Metadaten-Dienste u. Ä.). */
export async function validateSystemUrl(app: App, url: string): Promise<string | null> {
  let u: URL;
  try { u = new URL(url); } catch { return 'Ungültige URL'; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'Nur http(s) erlaubt';
  if (u.username || u.password) return 'Zugangsdaten gehören nicht in die URL';
  if (u.search || u.hash) return 'URL ohne Parameter angeben';
  if (app.cfg.env === 'production' && u.protocol !== 'https:' && !process.env.ALLOW_HTTP_TICKET_URLS) return 'In Produktion nur https:// (oder ALLOW_HTTP_TICKET_URLS setzen)';
  const host = u.hostname.replace(/^\[|\]$/g, '');
  let addrs: string[];
  try {
    addrs = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
  } catch {
    return `Hostname ${host} nicht auflösbar`;
  }
  if (app.cfg.env !== 'test' && addrs.some((a) => blockedIp(a, app.cfg.allowPrivateTicketUrls))) return 'Adresse nicht erlaubt (Loopback, Link-Local oder Metadaten-Dienst)';
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
