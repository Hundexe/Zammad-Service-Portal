// Datenbank-Helfer des Update-Dienstes ohne Docker (siehe store.ts).
//
// Läuft mit den Rechten des Dienstbenutzers, nicht als root. Liest Aufträge zeilenweise als JSON von stdin
// und antwortet zeilenweise auf stdout: run/get (SQL vom Updater), backup, restore, close.
// Aufrufer ist ausschließlich der Update-Dienst (root) – der Helfer hat keinen offenen Port.
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { Db } from '../src/server/db/db.ts';
import { backupInto, restoreInto, type Param } from './store.ts';

const dataDir = process.argv[2];
if (!dataDir) { console.error('Aufruf: db-agent.ts <Datenverzeichnis>'); process.exit(64); }
if (typeof process.getuid === 'function' && process.getuid() === 0 && process.env.ZSP_DB_AGENT_ALLOW_ROOT !== '1') {
  console.error('db-agent.ts läuft nicht als root');
  process.exit(77);
}

// Neue Dateien (WAL, Sicherungen) nur für den Dienstbenutzer lesbar – unabhängig von der Umask des Updaters
process.umask(0o077);
let db: Db | null = new Db(join(dataDir, 'portal.sqlite'));
const open = (): Db => (db ??= new Db(join(dataDir, 'portal.sqlite')));

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  let msg: { id: number; op: string; sql?: string; params?: Param[]; name?: string; keep?: number };
  try { msg = JSON.parse(line); } catch { return; }
  const reply = (ok: boolean, result?: unknown, error?: string) => process.stdout.write(JSON.stringify({ id: msg.id, ok, result, error }) + '\n');
  try {
    const params = (Array.isArray(msg.params) ? msg.params : []).filter((p) => p === null || typeof p === 'string' || typeof p === 'number');
    switch (msg.op) {
      case 'run': open().run(String(msg.sql), ...params); return reply(true);
      case 'get': return reply(true, open().get(String(msg.sql), ...params) ?? null);
      case 'backup': return reply(true, backupInto(open(), dataDir, String(msg.name), Math.max(1, Math.min(10, Number(msg.keep) || 3))));
      case 'restore':
        db?.close();
        db = null;
        restoreInto(dataDir, String(msg.name));
        open();
        return reply(true);
      case 'close':
        db?.close();
        db = null;
        return reply(true);
      default:
        return reply(false, undefined, `Unbekannter Auftrag ${msg.op}`);
    }
  } catch (err) {
    reply(false, undefined, (err as Error).message);
  }
});
rl.on('close', () => { db?.close(); process.exit(0); });
