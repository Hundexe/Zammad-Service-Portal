// Stammdaten aus Zammad (Gruppen, Status, Prioritäten, Ticket-Attribute) mit Zwischenspeicher
// sowie die Freigabe von Zammad-Objekten (Ticket-Attributen) für das Portal.
import type { App } from '../app.ts';
import { parseJson } from '../db/db.ts';
import type { SystemMetadata, ZammadAttribute } from '../connectors/types.ts';
import { connectorFor, type SystemRow } from './systems.ts';
import { isProtectedZammadField } from '../../shared/form.ts';
import { log } from '../log.ts';

const TTL = 15 * 60_000;

const inflight = new Map<string, Promise<SystemMetadata>>();
/** Letzter fehlgeschlagener Abruf je System (für den Hinweis in der Verwaltung) */
const lastFailure = new Map<string, { at: number; error: string }>();

/** Holt die Stammdaten aus Zammad; gleichzeitige Abrufe für dasselbe System teilen sich einen Aufruf. */
function fetchMetadata(app: App, sys: SystemRow): Promise<SystemMetadata> {
  let p = inflight.get(sys.id);
  if (!p) {
    p = connectorFor(app, sys).metadata().then((meta) => {
      app.db.run(
        'INSERT INTO system_metadata (system_id, data, fetched_at) VALUES (?, ?, ?) ON CONFLICT(system_id) DO UPDATE SET data = excluded.data, fetched_at = excluded.fetched_at',
        sys.id, JSON.stringify(meta), Date.now(),
      );
      lastFailure.delete(sys.id);
      return meta;
    }).catch((err) => {
      lastFailure.set(sys.id, { at: Date.now(), error: (err as Error).message.slice(0, 200) });
      throw err;
    }).finally(() => inflight.delete(sys.id));
    inflight.set(sys.id, p);
  }
  return p;
}

/**
 * Stammdaten mit Zwischenspeicher. Abgelaufene Daten werden sofort geliefert und im Hintergrund erneuert –
 * Seiten warten also nicht auf ein langsames oder nicht erreichbares Zammad. Nur ohne Zwischenspeicher
 * (erster Abruf) oder mit refresh wird gewartet.
 */
export async function getMetadata(app: App, sys: SystemRow, refresh = false): Promise<SystemMetadata> {
  const cached = app.db.get<{ data: string; fetched_at: number }>('SELECT data, fetched_at FROM system_metadata WHERE system_id = ?', sys.id);
  if (cached && !refresh) {
    if (Date.now() - cached.fetched_at >= TTL) {
      fetchMetadata(app, sys).catch((err) => log.warn('Zammad-Stammdaten nicht abrufbar, nutze Zwischenspeicher', { system: sys.slug, error: (err as Error).message }));
    }
    return parseJson<SystemMetadata>(cached.data, emptyMeta());
  }
  try {
    return await fetchMetadata(app, sys);
  } catch (err) {
    if (cached) {
      log.warn('Zammad-Stammdaten nicht abrufbar, nutze Zwischenspeicher', { system: sys.slug, error: (err as Error).message });
      return parseJson<SystemMetadata>(cached.data, emptyMeta());
    }
    throw err;
  }
}

/** Stand der zwischengespeicherten Stammdaten und ob der letzte Abruf aus Zammad fehlgeschlagen ist. */
export function metadataState(app: App, systemId: string): { fetchedAt: number | null; lastError: string | null } {
  const fetchedAt = app.db.get<{ fetched_at: number }>('SELECT fetched_at FROM system_metadata WHERE system_id = ?', systemId)?.fetched_at ?? null;
  const f = lastFailure.get(systemId);
  return { fetchedAt, lastError: f && (!fetchedAt || f.at > fetchedAt) ? f.error : null };
}

export function emptyMeta(): SystemMetadata {
  return { groups: [], states: [], priorities: [], fields: [] };
}

export interface ReleasedAttribute {
  name: string;
  /** null = alle Werte freigegeben */
  allowedValues: string[] | null;
}

export function releasedAttributes(sys: SystemRow): ReleasedAttribute[] {
  return parseJson<ReleasedAttribute[]>(sys.released_attributes, []).filter((a) => a && typeof a.name === 'string');
}

/** Liefert die freigegebenen Attribute mit den tatsächlich auswählbaren Optionen. */
export function releasedWithOptions(sys: SystemRow, meta: SystemMetadata): (ZammadAttribute & { allowedValues: string[] | null })[] {
  const out: (ZammadAttribute & { allowedValues: string[] | null })[] = [];
  for (const r of releasedAttributes(sys)) {
    const attr = meta.fields.find((f) => f.name === r.name);
    if (!attr || !attr.portalType) continue;
    const options = attr.options && r.allowedValues ? attr.options.filter((o) => r.allowedValues!.includes(o.value)) : attr.options;
    out.push({ ...attr, options, allowedValues: r.allowedValues });
  }
  return out;
}

export function validateRelease(input: unknown, meta: SystemMetadata): { release?: ReleasedAttribute[]; errors: string[] } {
  if (!Array.isArray(input)) return { errors: ['Liste erwartet'] };
  const errors: string[] = [];
  const release: ReleasedAttribute[] = [];
  const seen = new Set<string>();
  for (const item of input) {
    const name = String(item?.name ?? '');
    const attr = meta.fields.find((f) => f.name === name);
    if (!attr) { errors.push(`Attribut „${name}“ gibt es in Zammad nicht`); continue; }
    if (isProtectedZammadField(name)) { errors.push(`Attribut „${name}“ setzt das Portal selbst und kann nicht freigegeben werden`); continue; }
    if (!attr.portalType) { errors.push(`Attribut „${attr.display}“ (${attr.type}) wird im Portal nicht unterstützt`); continue; }
    if (seen.has(name)) continue;
    seen.add(name);
    let allowed: string[] | null = null;
    if (Array.isArray(item.allowedValues)) {
      const valid = new Set((attr.options ?? []).map((o) => o.value));
      allowed = item.allowedValues.map(String).filter((v: string) => valid.has(v));
    }
    release.push({ name, allowedValues: allowed });
  }
  return { release: errors.length ? undefined : release, errors };
}
