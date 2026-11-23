// Worker: stellt Anfragen zu und räumt regelmäßig auf.
import type { App } from './app.ts';
import { deliverNext, purgeOld } from './services/requests.ts';
import { purgeExpiredSessions } from './auth/sessions.ts';
import { approvalHousekeeping, upgradeWaitingApprovals } from './services/approvals.ts';
import { itsmHousekeeping } from './services/itsm.ts';
import { checkAll } from './services/zammad-setup.ts';
import { purgeNotifications } from './services/notifications.ts';
import { watchTickets } from './services/ticket-watch.ts';
import { checkForUpdates } from './services/update-notify.ts';
import { checkEntraAccounts } from './services/account-check.ts';
import type { EntraClient } from './auth/oidc.ts';
import { log, setLogLevel } from './log.ts';

export function startWorker(app: App, intervalMs = 2000, deps: { entra?: Pick<EntraClient, 'accountEnabled'> } = {}): () => void {
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
  // Optional: nur benachrichtigen – alle 6 Stunden oder wenn in der Verwaltung „Jetzt nach Updates suchen“ geklickt wurde
  let lastUpdateCheck = 0;
  const updates = () => {
    if (!app.cfg.updateNotify?.enabled || stopped) return;
    const requested = Number(app.db.get<{ value: string }>("SELECT value FROM settings WHERE key = 'update.check_requested'")?.value ?? 0);
    if (Date.now() - lastUpdateCheck < 6 * 3600_000 && requested <= lastUpdateCheck) return;
    lastUpdateCheck = Date.now();
    void checkForUpdates(app);
  };
  const t4 = app.cfg.updateNotify?.enabled ? setInterval(updates, 60_000) : null;
  if (t4) setTimeout(updates, 30_000);
  // Optional: Konten mit offener Sitzung in Entra prüfen (deaktiviert → Sitzungen beenden)
  let checking = false;
  const accounts = async () => {
    if (checking || stopped || !deps.entra) return;
    checking = true;
    try {
      const r = await checkEntraAccounts(app, deps.entra);
      if (r.ended) log.info('Kontoprüfung Entra', r);
    } catch (err) {
      log.warn('Kontoprüfung Entra fehlgeschlagen', { error: (err as Error).message });
    } finally {
      checking = false;
    }
  };
  const minutes = app.cfg.entra.accountCheckMinutes ?? 0;
  const t5 = deps.entra && minutes > 0 ? setInterval(() => void accounts(), minutes * 60_000) : null;
  if (t5) void accounts();
  // Alle fünf Minuten in Zammad: Fristen der Freigaben, Tickets der Betroffenen, beendete Wartungen;
  // stündlich prüfen, ob Zammad zur Zuordnung passt (Hinweise in der Verwaltung)
  let zammadBusy = false;
  let lastSetupCheck = 0;
  const zammad = async () => {
    if (zammadBusy || stopped) return;
    zammadBusy = true;
    try {
      if (Date.now() - lastSetupCheck > 3600_000) { lastSetupCheck = Date.now(); await checkAll(app); }
      await approvalHousekeeping(app);
      await itsmHousekeeping(app);
    } catch (err) {
      log.warn('Arbeiten in Zammad fehlgeschlagen', { error: (err as Error).message });
    } finally {
      zammadBusy = false;
    }
  };
  try { upgradeWaitingApprovals(app); } catch (err) { log.error('Übernahme wartender Freigaben fehlgeschlagen', { error: (err as Error).message }); }
  const t6 = setInterval(() => void zammad(), 5 * 60_000);
  void zammad();
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
    if (t4) clearInterval(t4);
    if (t5) clearInterval(t5);
    clearInterval(t6);
  };
}

// Direkt gestartet: eigener Prozess / Container
if (import.meta.url === `file://${process.argv[1]}`) {
  const { loadConfig } = await import('./config.ts');
  const { createApp } = await import('./app.ts');
  const cfg = loadConfig();
  setLogLevel(cfg.logLevel);
  const app = createApp(cfg);
  const { EntraClient } = await import('./auth/oidc.ts');
  const entra = cfg.entra.enabled && (cfg.entra.accountCheckMinutes ?? 0) > 0 ? new EntraClient(cfg) : undefined;
  const stop = startWorker(app, 2000, { entra });
  log.info('Worker gestartet', { version: cfg.version });
  const shutdown = () => { stop(); setTimeout(() => { app.db.close(); process.exit(0); }, 500); };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
