// Datenbankzugriff über das in Node eingebaute SQLite (node:sqlite).
// Alle Abfragen laufen über vorbereitete Statements mit Parametern – nie über
// zusammengesetzte SQL-Strings mit Benutzereingaben.
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readdirSync, readFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export type Row = Record<string, unknown>;
export type Param = SQLInputValue;

export class Db {
  readonly raw: DatabaseSync;
  private cache = new Map<string, ReturnType<DatabaseSync['prepare']>>();

  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.raw = new DatabaseSync(file);
    this.raw.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      PRAGMA trusted_schema = OFF;
      PRAGMA secure_delete = ON;
    `);
  }

  private stmt(sql: string) {
    let s = this.cache.get(sql);
    if (!s) {
      s = this.raw.prepare(sql);
      this.cache.set(sql, s);
    }
    return s;
  }

  get<T = Row>(sql: string, ...params: Param[]): T | undefined {
    return this.stmt(sql).get(...params) as T | undefined;
  }

  all<T = Row>(sql: string, ...params: Param[]): T[] {
    return this.stmt(sql).all(...params) as T[];
  }

  run(sql: string, ...params: Param[]): { changes: number } {
    const r = this.stmt(sql).run(...params);
    return { changes: Number(r.changes) };
  }

  tx<T>(fn: () => T): T {
    this.raw.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.raw.exec('COMMIT');
      return out;
    } catch (err) {
      this.raw.exec('ROLLBACK');
      throw err;
    }
  }

  migrate(): number[] {
    this.raw.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)');
    const done = new Set(this.all<{ version: number }>('SELECT version FROM schema_migrations').map((r) => r.version));
    const dir = new URL('./migrations/', import.meta.url).pathname;
    const files = readdirSync(dir).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
    const applied: number[] = [];
    for (const f of files) {
      const version = Number.parseInt(f, 10);
      if (done.has(version)) continue;
      const sql = readFileSync(join(dir, f), 'utf8');
      this.tx(() => {
        this.raw.exec(sql);
        this.run('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)', version, Date.now());
      });
      applied.push(version);
    }
    return applied;
  }

  /** Konsistente Sicherung der laufenden Datenbank in eine Datei. */
  backupTo(file: string): void {
    this.raw.prepare('VACUUM INTO ?').run(file);
  }

  close(): void {
    this.raw.close();
  }
}

export const uuid = (): string => randomUUID();
export const now = (): number => Date.now();

export function parseJson<T>(s: unknown, fallback: T): T {
  if (typeof s !== 'string') return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}
