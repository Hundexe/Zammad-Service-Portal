// Stammdaten aus Zammad (Gruppen, Status, Prioritäten, Ticket-Attribute) mit Zwischenspeicher
// sowie die Freigabe von Zammad-Objekten (Ticket-Attributen) für das Portal.
import type { App } from '../app.ts';
import { parseJson } from '../db/db.ts';
import type { SystemMetadata, ZammadAttribute } from '../connectors/types.ts';
import { connectorFor, type SystemRow } from './systems.ts';
import { isProtectedZammadField } from '../../shared/form.ts';
import { log } from '../log.ts';

const TTL = 15 * 60_000;

export async function getMetadata(app: App, sys: SystemRow, refresh = false): Promise<SystemMetadata> {
  const cached = app.db.get<{ data: string; fetched_at: number }>('SELECT data, fetched_at FROM system_metadata WHERE system_id = ?', sys.id);
  if (cached && !refresh && Date.now() - cached.fetched_at < TTL) return parseJson<SystemMetadata>(cached.data, emptyMeta());
  try {
    const meta = await connectorFor(app, sys).metadata();
    app.db.run(
      'INSERT INTO system_metadata (system_id, data, fetched_at) VALUES (?, ?, ?) ON CONFLICT(system_id) DO UPDATE SET data = excluded.data, fetched_at = excluded.fetched_at',
      sys.id, JSON.stringify(meta), Date.now(),
    );
    return meta;
  } catch (err) {
    if (cached) {
      log.warn('Zammad-Stammdaten nicht abrufbar, nutze Zwischenspeicher', { system: sys.slug, error: (err as Error).message });
      return parseJson<SystemMetadata>(cached.data, emptyMeta());
    }
    throw err;
  }
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
