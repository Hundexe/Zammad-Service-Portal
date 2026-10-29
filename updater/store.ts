// Datenbankzugriff des Update-Dienstes.
//
// Mit Docker läuft der Updater als eigener Container-Benutzer und öffnet die Datenbank direkt (LocalStore).
// Ohne Docker läuft er als root (git, systemctl, install.sh). Die Datenbank öffnet dann ein Helfer-Prozess
// mit den Rechten des Dienstbenutzers (AgentStore → db-agent.ts): root liest und schreibt nie selbst Dateien
// im Datenverzeichnis, die dem Dienstbenutzer gehören. Eine manipulierte Datenbank oder ein untergeschobener
// Link im Datenverzeichnis kann so höchstens die Rechte des Dienstbenutzers nutzen, nicht root.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { chmodSync, constants as fsc, copyFileSync, lstatSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Db } from '../src/server/db/db.ts';

export type Param = string | number | null;

export interface Store {
  run(sql: string, ...params: Param[]): Promise<void>;
  get<T>(sql: string, ...params: Param[]): Promise<T | undefined>;
  /** Sicherung nach <dataDir>/backups/<name>; behält die letzten `keep` Sicherungen vor Updates */
  backup(name: string, keep: number): Promise<string>;
  /** Datenbank aus <dataDir>/backups/<name> wiederherstellen */
  restore(name: string): Promise<void>;
  close(): Promise<void>;
}

export const BACKUP_NAME = /^vor-update-[0-9A-Za-z.+-]+-auf-[0-9A-Za-z.+-]+-[0-9TZ-]+\.sqlite$/;

/** Kein Link, keine Datei mit mehreren Namen (Hardlink) – sonst Abbruch */
function assertPlain(p: string, kind: 'file' | 'dir'): void {
  let st;
  try { st = lstatSync(p); } catch { return; }
  if (st.isSymbolicLink() || (kind === 'file' && st.isFile() && st.nlink > 1) || (kind === 'dir' && !st.isDirectory())) {
    throw new Error(`${p} ist ein Link oder unerwartet – abgebrochen`);
  }
}

export function backupInto(db: Db, dataDir: string, name: string, keep: number): string {
  if (!BACKUP_NAME.test(name)) throw new Error('Ungültiger Name der Sicherung');
  const dir = join(dataDir, 'backups');
  assertPlain(dir, 'dir');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, name);
  db.backupTo(file);
  try { chmodSync(file, 0o600); } catch { /* best effort */ }
  // Nur die letzten Sicherungen vor Updates behalten (sie enthalten Inhalte über die Aufbewahrungsfrist hinaus)
  const old = readdirSync(dir).filter((f) => /^vor-update-.*\.sqlite$/.test(f))
    .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t).map((x) => x.f);
  for (const f of old.slice(keep)) rmSync(join(dir, f), { force: true });
  return file;
}

/** Datenbankdatei ersetzen – die Verbindung muss vorher geschlossen sein. */
export function restoreInto(dataDir: string, name: string): string {
  if (!BACKUP_NAME.test(name)) throw new Error('Ungültiger Name der Sicherung');
  const src = join(dataDir, 'backups', name);
  assertPlain(join(dataDir, 'backups'), 'dir');
  assertPlain(src, 'file');
  const target = join(dataDir, 'portal.sqlite');
  // Erst entfernen (auch einen evtl. untergeschobenen Link), dann exklusiv neu anlegen – nie in ein Linkziel schreiben
  for (const ext of ['', '-wal', '-shm']) rmSync(target + ext, { force: true });
  copyFileSync(src, target, fsc.COPYFILE_EXCL);
  return target;
}

/** Direkt im eigenen Prozess (Docker, Tests) */
export class LocalStore implements Store {
  db: Db;
  private dataDir: string;
  constructor(dataDir: string) { this.dataDir = dataDir; this.db = new Db(join(dataDir, 'portal.sqlite')); }
  async run(sql: string, ...params: Param[]): Promise<void> { this.db.run(sql, ...params); }
  async get<T>(sql: string, ...params: Param[]): Promise<T | undefined> { return this.db.get<T>(sql, ...params); }
  async backup(name: string, keep: number): Promise<string> { return backupInto(this.db, this.dataDir, name, keep); }
  async restore(name: string): Promise<void> {
    this.db.close();
    const target = restoreInto(this.dataDir, name);
    this.db = new Db(target);
  }
  async close(): Promise<void> { this.db.close(); }
}

/** Über den Helfer-Prozess db-agent.ts, gestartet mit den Rechten des Dienstbenutzers */
export class AgentStore implements Store {
  private child: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private seq = 0;
  private buf = '';
  private dataDir: string;
  private user: { uid: number; gid: number } | null;
  private agentScript: string;

  /** user = null nur für Tests: Helfer läuft dann mit den eigenen Rechten */
  constructor(dataDir: string, user: { uid: number; gid: number } | null, agentScript = new URL('./db-agent.ts', import.meta.url).pathname) {
    this.dataDir = dataDir;
    this.user = user;
    this.agentScript = agentScript;
  }

  private start(): ChildProcessWithoutNullStreams {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', this.agentScript, this.dataDir], {
      stdio: ['pipe', 'pipe', 'pipe'],
      // Rechte abgeben: Dienstbenutzer und seine Gruppe, keine Zusatzgruppen von root
      ...(this.user ? { uid: this.user.uid, gid: this.user.gid } : {}),
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', NODE_OPTIONS: '', ...(this.user ? {} : { ZSP_DB_AGENT_ALLOW_ROOT: '1' }) },
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      this.buf += chunk;
      let nl;
      while ((nl = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, nl);
        this.buf = this.buf.slice(nl + 1);
        let msg: { id: number; ok: boolean; result?: unknown; error?: string };
        try { msg = JSON.parse(line); } catch { continue; }
        const p = this.pending.get(msg.id);
        if (!p) continue;
        this.pending.delete(msg.id);
        if (msg.ok) p.resolve(msg.result); else p.reject(new Error(msg.error ?? 'Datenbank-Helfer: Fehler'));
      }
    });
    child.stderr.on('data', (d) => process.stderr.write(d));
    child.on('exit', (code) => {
      this.child = null;
      this.buf = '';
      for (const p of this.pending.values()) p.reject(new Error(`Datenbank-Helfer beendet (Exit ${code})`));
      this.pending.clear();
    });
    return child;
  }

  private call<T>(op: string, payload: Record<string, unknown> = {}): Promise<T> {
    const child = this.child ?? (this.child = this.start());
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      child.stdin.write(JSON.stringify({ id, op, ...payload }) + '\n');
    });
  }

  async run(sql: string, ...params: Param[]): Promise<void> { await this.call('run', { sql, params }); }
  get<T>(sql: string, ...params: Param[]): Promise<T | undefined> { return this.call<T | undefined>('get', { sql, params }).then((r) => r ?? undefined); }
  backup(name: string, keep: number): Promise<string> { return this.call<string>('backup', { name, keep }); }
  async restore(name: string): Promise<void> { await this.call('restore', { name }); }
  async close(): Promise<void> {
    if (!this.child) return;
    const child = this.child;
    await this.call('close').catch(() => undefined);
    child.stdin.end();
  }
}
