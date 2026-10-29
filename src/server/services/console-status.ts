// Kurzer Status für die Anmeldekonsole des Servers (/etc/issue.d, siehe deploy/native/install.sh).
// Bewusst leichtgewichtig: läuft jede Minute – kein Virenscanner-Test, keine Microsoft-Abfrage, keine Audit-Prüfung.
import { connect } from 'node:net';
import type { App } from '../app.ts';

export interface ConsoleStatus {
  version: string;
  queued: number;
  failed: number;
  awaitingApproval: number;
  oldestQueuedMinutes: number | null;
  systems: { name: string; status: string; target: string; reachable: boolean | null; ms: number | null }[];
}

/** Baut nur eine TCP-Verbindung auf (kein HTTP, kein Token): erreicht der Server den Zammad-Port? */
function tcpCheck(host: string, port: number, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve) => {
    const t = Date.now();
    const sock = connect({ host, port });
    const done = (ok: boolean) => { sock.destroy(); resolve(ok ? Date.now() - t : null); };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

export async function consoleStatus(app: App, timeoutMs = 3000): Promise<ConsoleStatus> {
  const count = (s: string) => app.db.get<{ n: number }>('SELECT COUNT(*) n FROM requests WHERE status = ?', s)!.n;
  const oldest = app.db.get<{ t: number | null }>("SELECT MIN(COALESCE(queued_at, created_at)) t FROM requests WHERE status IN ('queued','sending')")!.t;
  const rows = app.db.all<{ name: string; status: string; base_url: string }>('SELECT name, status, base_url FROM ticket_systems ORDER BY name');
  const systems = await Promise.all(rows.map(async (r) => {
    let url: URL | null = null;
    try { url = new URL(r.base_url); } catch { /* ungültige Adresse */ }
    if (!url) return { name: r.name, status: r.status, target: '?', reachable: false, ms: null };
    const port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80);
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const target = `${url.hostname}:${port}`;
    if (r.status === 'inactive') return { name: r.name, status: r.status, target, reachable: null, ms: null };
    const ms = await tcpCheck(host, port, timeoutMs);
    return { name: r.name, status: r.status, target, reachable: ms !== null, ms };
  }));
  return {
    version: app.cfg.version,
    queued: count('queued') + count('sending'),
    failed: count('failed'),
    awaitingApproval: count('awaiting_approval'),
    oldestQueuedMinutes: oldest ? Math.floor((Date.now() - oldest) / 60_000) : null,
    systems,
  };
}
