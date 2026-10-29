// Worker: stellt Anfragen zu und räumt regelmäßig auf.
import type { App } from './app.ts';
import { deliverNext, purgeOld } from './services/requests.ts';
import { purgeExpiredSessions } from './auth/sessions.ts';
import { approvalHousekeeping } from './services/approvals.ts';
import { purgeNotifications } from './services/notifications.ts';
import { watchTickets } from './services/ticket-watch.ts';
import { log, setLogLevel } from './log.ts';

export function startWorker(app: App, intervalMs = 2000): () => void {
  let stopped = false;
  let running = false;
  const tick = async () => {
    if (running || stopped) return;
    running = true;
    try {
      // Mehrere fällige Anfragen nacheinander abarbeiten
      for (let i = 0; i < 20 && !stopped; i++) {
        if (!(await deliverNext(app))) break;
      }
    } catch (err) {
      log.error('Worker-Fehler', { error: (err as Error).message });
    } finally {
      running = false;
    }
  };
  const housekeeping = () => {
    try {
      approvalHousekeeping(app);
      const n = purgeOld(app);
      purgeExpiredSessions(app);
      purgeNotifications(app);
      if (n) log.info('Alte Anfragedaten gelöscht', { anzahl: n });
    } catch (err) {
      log.error('Aufräumen fehlgeschlagen', { error: (err as Error).message });
    }
  };
  // Neue Antworten in Zammad → Benachrichtigung im Portal
  let watching = false;
  const watch = async () => {
    if (watching || stopped) return;
    watching = true;
    try {
      const n = await watchTickets(app);
      if (n) log.info('Benachrichtigungen zu neuen Antworten', { anzahl: n });
    } catch (err) {
      log.warn('Abruf neuer Antworten fehlgeschlagen', { error: (err as Error).message });
    } finally {
      watching = false;
    }
  };
  const t3 = app.cfg.ticketWatchSeconds > 0 ? setInterval(() => void watch(), app.cfg.ticketWatchSeconds * 1000) : null;
  if (t3) void watch();
  const t1 = setInterval(() => void tick(), intervalMs);
  // Stündlich: Fristen der Freigaben, Aufbewahrung, Sitzungen
  const t2 = setInterval(housekeeping, 3600_000);
  housekeeping();
  void tick();
  return () => {
    stopped = true;
    clearInterval(t1);
    clearInterval(t2);
    if (t3) clearInterval(t3);
  };
}

// Direkt gestartet: eigener Prozess / Container
if (import.meta.url === `file://${process.argv[1]}`) {
  const { loadConfig } = await import('./config.ts');
  const { createApp } = await import('./app.ts');
  const cfg = loadConfig();
  setLogLevel(cfg.logLevel);
  const app = createApp(cfg);
  const stop = startWorker(app);
  log.info('Worker gestartet', { version: cfg.version });
  const shutdown = () => { stop(); setTimeout(() => { app.db.close(); process.exit(0); }, 500); };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
