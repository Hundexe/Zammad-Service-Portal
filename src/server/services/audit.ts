// Audit-Log mit Hash-Kette: jede Zeile enthält den Hash ihrer Vorgängerin.
import { sha256 } from '../crypto.ts';
import type { Db } from '../db/db.ts';

export interface Actor { id?: string | null; name?: string | null; ip?: string | null }

export interface AuditEntry {
  action: string;
  targetType?: string;
  targetId?: string | null;
  systemId?: string | null;
  details?: unknown;
}

const GENESIS = '0'.repeat(64);

function rowHash(prev: string, r: { at: number; actor_id: string | null; actor_name: string | null; action: string; target_type: string | null; target_id: string | null; system_id: string | null; details: string | null; ip: string | null }): string {
  return sha256(prev + '\n' + JSON.stringify([r.at, r.actor_id, r.actor_name, r.action, r.target_type, r.target_id, r.system_id, r.details, r.ip]));
}

/** Schreibt einen Eintrag. Läuft in einer eigenen Transaktion, falls keine offen ist. */
export function audit(db: Db, actor: Actor, e: AuditEntry): void {
  const write = () => {
    const last = db.get<{ hash: string }>('SELECT hash FROM audit_log ORDER BY seq DESC LIMIT 1');
    const prev = last?.hash ?? GENESIS;
    const row = {
      at: Date.now(),
      actor_id: actor.id ?? null,
      actor_name: actor.name ?? null,
      action: e.action,
      target_type: e.targetType ?? null,
      target_id: e.targetId ?? null,
      system_id: e.systemId ?? null,
      details: e.details === undefined ? null : JSON.stringify(e.details),
      ip: actor.ip ?? null,
    };
    db.run(
      `INSERT INTO audit_log (at, actor_id, actor_name, action, target_type, target_id, system_id, details, ip, prev_hash, hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.at, row.actor_id, row.actor_name, row.action, row.target_type, row.target_id, row.system_id, row.details, row.ip,
      prev, rowHash(prev, row),
    );
  };
  if (db.raw.isTransaction) write();
  else db.tx(write);
}

/** Prüft die Hash-Kette. Gibt die erste fehlerhafte Sequenznummer zurück oder null. */
export function verifyAuditChain(db: Db): { ok: boolean; brokenAt: number | null; count: number } {
  let prev = GENESIS;
  let count = 0;
  for (const r of db.raw.prepare('SELECT * FROM audit_log ORDER BY seq').iterate() as Iterable<Record<string, any>>) {
    count++;
    if (r.prev_hash !== prev || rowHash(prev, r as any) !== r.hash) return { ok: false, brokenAt: Number(r.seq), count };
    prev = r.hash;
  }
  return { ok: true, brokenAt: null, count };
}

/** Kleiner Unterschied zweier Objekte für das Audit-Log (Geheimnisse werden ausgeblendet). */
export function diff(before: Record<string, unknown> | undefined, after: Record<string, unknown> | undefined): Record<string, { vorher: unknown; nachher: unknown }> {
  const out: Record<string, { vorher: unknown; nachher: unknown }> = {};
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  for (const k of keys) {
    const a = before?.[k], b = after?.[k];
    if (JSON.stringify(a) === JSON.stringify(b)) continue;
    const secret = /token|secret|password|hash/i.test(k);
    out[k] = { vorher: secret ? (a ? '[gesetzt]' : null) : a, nachher: secret ? (b ? '[gesetzt]' : null) : b };
  }
  return out;
}
