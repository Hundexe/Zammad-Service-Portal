// Startpunkt des Web-Servers.
import { loadConfig } from './config.ts';
import { createApp } from './app.ts';
import { createServer } from './server.ts';
import { EntraClient } from './auth/oidc.ts';
import { log, setLogLevel } from './log.ts';
import { startWorker } from './worker.ts';
import { purgeExpiredSessions } from './auth/sessions.ts';

const cfg = loadConfig();
setLogLevel(cfg.logLevel);
const app = createApp(cfg);
const entra = cfg.entra.enabled ? new EntraClient(cfg) : null;
const { server } = createServer(app, { entra });

const users = app.db.get<{ n: number }>("SELECT COUNT(*) n FROM users")!.n;
if (users === 0 && !cfg.entra.enabled) {
  log.warn('Es gibt noch keinen Benutzer. Ersten Admin anlegen mit: docker compose exec app /nodejs/bin/node src/server/cli.ts user:create --username admin --role Super-Admin');
}

// Einzelprozess-Betrieb (z. B. Entwicklung): Worker im selben Prozess starten
const stopWorker = process.env.WORKER_INLINE === 'true' ? startWorker(app) : null;
const sessionTimer = setInterval(() => purgeExpiredSessions(app), 10 * 60_000);
sessionTimer.unref();

server.listen(cfg.port, cfg.host, () => {
  log.info('Self-Service-Portal gestartet', {
    port: cfg.port, version: cfg.version, entra: cfg.entra.enabled, localLogin: cfg.localLogin, clamav: Boolean(app.clamav),
    totpAdmins: cfg.localAdminRequireTotp, totpAlle: cfg.localUserRequireTotp, sperreNach: cfg.lockout.maxAttempts, sperreMinuten: cfg.lockout.minutes,
  });
  if (cfg.localLogin && !cfg.localAdminRequireTotp && !cfg.localUserRequireTotp) log.warn('LOCAL_ADMIN_REQUIRE_TOTP=false: lokale Admins melden sich ohne zweiten Faktor an – nicht empfohlen');
});

function shutdown(signal: string) {
  log.info('Beende', { signal });
  stopWorker?.();
  server.close(() => {
    app.db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
