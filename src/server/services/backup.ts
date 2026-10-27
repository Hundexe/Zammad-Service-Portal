// Prüfen und Wiederherstellen von Datenbank-Sicherungen (CLI: backup:verify, restore).
import { DatabaseSync } from 'node:sqlite';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { SecretBox } from '../crypto.ts';

const REQUIRED_TABLES = ['users', 'sessions', 'ticket_systems', 'forms', 'form_versions', 'roles', 'role_assignments', 'requests', 'audit_log', 'schema_migrations'];

export interface BackupReport {
  ok: boolean;
  problems: string[];
  file: string;
  sizeBytes: number;
  schemaVersion: number;
  knownVersion: number;
  counts: Record<string, number>;
  /** Passen die verschlüsselten Werte zum SECRET_KEY? null = nicht geprüft (keine verschlüsselten Werte) */
  keyMatches: boolean | null;
}

function knownSchemaVersion(): number {
  const dir = new URL('../db/migrations/', import.meta.url).pathname;
  return Math.max(0, ...readdirSync(dir).filter((f) => /^\d+_.*\.sql$/.test(f)).map((f) => Number.parseInt(f, 10)));
}

/** Prüft eine Sicherung, ohne sie zu verändern. */
export function verifyBackup(file: string, box?: SecretBox): BackupReport {
  const report: BackupReport = { ok: false, problems: [], file, sizeBytes: 0, schemaVersion: 0, knownVersion: knownSchemaVersion(), counts: {}, keyMatches: null };
  if (!existsSync(file)) { report.problems.push('Datei nicht gefunden'); return report; }
  report.sizeBytes = statSync(file).size;
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(file, { readOnly: true });
  } catch (err) {
    report.problems.push(`Keine SQLite-Datenbank: ${(err as Error).message}`);
    return report;
  }
  try {
    const integrity = db.prepare('PRAGMA integrity_check').all() as { integrity_check: string }[];
    if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') report.problems.push(`Integritätsprüfung fehlgeschlagen: ${integrity.map((r) => r.integrity_check).join('; ').slice(0, 300)}`);
    const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name));
    for (const t of REQUIRED_TABLES) if (!tables.has(t)) report.problems.push(`Tabelle ${t} fehlt`);
    if (tables.has('schema_migrations')) {
      report.schemaVersion = Number((db.prepare('SELECT MAX(version) v FROM schema_migrations').get() as { v: number | null }).v ?? 0);
      if (report.schemaVersion > report.knownVersion) report.problems.push(`Sicherung stammt aus einer neueren Version (Schema ${report.schemaVersion}, diese Version kennt ${report.knownVersion})`);
    }
    for (const t of ['users', 'ticket_systems', 'forms', 'requests', 'audit_log']) {
      if (tables.has(t)) report.counts[t] = Number((db.prepare(`SELECT COUNT(*) n FROM ${t}`).get() as { n: number }).n);
    }
    if (box && tables.has('ticket_systems')) {
      const row = db.prepare('SELECT api_token FROM ticket_systems WHERE api_token IS NOT NULL LIMIT 1').get() as { api_token: string } | undefined;
      if (row) {
        try { box.decrypt('system-token', row.api_token); report.keyMatches = true; } catch { report.keyMatches = false; }
        if (!report.keyMatches) report.problems.push('Verschlüsselte Werte passen nicht zum SECRET_KEY – mit diesem Schlüssel ist die Sicherung unbrauchbar');
      }
    }
  } catch (err) {
    report.problems.push(`Lesefehler: ${(err as Error).message}`);
  } finally {
    db.close();
  }
  report.ok = report.problems.length === 0;
  return report;
}

/**
 * Stellt eine Sicherung wieder her. Das Portal (App und Worker) muss dafür gestoppt sein.
 * Vorher wird der aktuelle Stand gesichert; WAL- und SHM-Dateien der alten Datenbank werden entfernt,
 * damit SQLite keine alten Änderungen über die wiederhergestellte Datei legt.
 */
export function restoreBackup(dataDir: string, file: string, box?: SecretBox): { safetyCopy: string | null; report: BackupReport } {
  const report = verifyBackup(file, box);
  if (!report.ok) throw new Error(`Sicherung ist nicht in Ordnung:\n  - ${report.problems.join('\n  - ')}`);
  const target = join(dataDir, 'portal.sqlite');
  let safetyCopy: string | null = null;
  if (existsSync(target)) {
    const dir = join(dataDir, 'backups');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    safetyCopy = join(dir, `vor-wiederherstellung-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`);
    // Konsistente Kopie inklusive noch nicht übernommener WAL-Inhalte
    const current = new DatabaseSync(target);
    try { current.prepare('VACUUM INTO ?').run(safetyCopy); } finally { current.close(); }
    chmodSync(safetyCopy, 0o600);
  }
  for (const suffix of ['', '-wal', '-shm', '-journal']) rmSync(target + suffix, { force: true });
  copyFileSync(file, target);
  chmodSync(target, 0o600);
  return { safetyCopy, report };
}
