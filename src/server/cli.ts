// Kommandozeile – ist auch der Einstiegspunkt des Containers.
//   serve                         Web-Server starten (Standard)
//   worker                        Zustell-Worker starten
//   user:create --username NAME [--role ROLLE] [--name "Anzeige"] [--email MAIL] [--department ABT]
//   user:reset-password --username NAME [--reset-totp]
//   user:unlock --username NAME
//   user:list
//   backup [--out DATEI]
//   audit:verify
//   secret:generate
//   healthcheck
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';

const [, , command = 'serve', ...rest] = process.argv;

function arg(name: string): string | undefined {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
}
const flag = (name: string) => rest.includes(`--${name}`);

function box(lines: string[]): void {
  const width = Math.max(...lines.map((l) => l.length)) + 4;
  console.log('┌' + '─'.repeat(width) + '┐');
  for (const l of lines) console.log('│  ' + l.padEnd(width - 2) + '│');
  console.log('└' + '─'.repeat(width) + '┘');
}

async function withApp<T>(fn: (app: import('./app.ts').App) => Promise<T> | T): Promise<T> {
  const { loadConfig } = await import('./config.ts');
  const { createApp } = await import('./app.ts');
  const { setLogLevel } = await import('./log.ts');
  setLogLevel('warn');
  const app = createApp(loadConfig());
  try { return await fn(app); } finally { app.db.close(); }
}

async function main(): Promise<void> {
  switch (command) {
    case 'serve':
      await import('./main.ts');
      return;
    case 'worker':
      process.argv[1] = new URL('./worker.ts', import.meta.url).pathname;
      await import('./worker.ts');
      return;
    case 'secret:generate':
      console.log(randomBytes(32).toString('base64'));
      return;
    case 'healthcheck': {
      const port = process.env.PORT ?? '3000';
      try {
        const r = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(4000) });
        process.exit(r.ok ? 0 : 1);
      } catch {
        process.exit(1);
      }
      return;
    }
    case 'user:create':
      await withApp(async (app) => {
        const { createLocalUser } = await import('./services/users.ts');
        const { audit } = await import('./services/audit.ts');
        const username = arg('username');
        if (!username) throw new Error('--username fehlt');
        const role = arg('role') ?? 'Benutzer';
        const u = await createLocalUser(app.db, {
          username, displayName: arg('name'), email: arg('email'), department: arg('department'),
          roleName: role === 'Benutzer' ? undefined : role,
        });
        audit(app.db, { name: 'Kommandozeile' }, { action: 'user.created', targetType: 'user', targetId: u.id, details: { username, rolle: role, via: 'cli' } });
        box([
          'Benutzer angelegt',
          '',
          `Benutzername: ${u.username}`,
          `Passwort:     ${u.password}`,
          `Rolle:        ${role}`,
          '',
          'Das Passwort wird nur jetzt angezeigt und muss bei der',
          'ersten Anmeldung geändert werden.' + (role !== 'Benutzer' ? ' Für Admin-Rollen wird' : ''),
          ...(role !== 'Benutzer' ? ['außerdem die Zwei-Faktor-Anmeldung (Authenticator-App) eingerichtet.'] : []),
        ]);
      });
      return;
    case 'user:reset-password':
      await withApp(async (app) => {
        const { resetLocalPassword } = await import('./services/users.ts');
        const { audit } = await import('./services/audit.ts');
        const username = arg('username');
        const row = app.db.get<{ id: string }>("SELECT id FROM users WHERE username = ? AND kind = 'local'", username ?? '');
        if (!row) throw new Error('Lokales Konto nicht gefunden');
        const pw = await resetLocalPassword(app.db, row.id, flag('reset-totp'));
        audit(app.db, { name: 'Kommandozeile' }, { action: 'user.password_reset', targetType: 'user', targetId: row.id, details: { via: 'cli', totpZurueckgesetzt: flag('reset-totp') } });
        box(['Neues Passwort gesetzt', '', `Benutzername: ${username}`, `Passwort:     ${pw}`, '', 'Muss bei der nächsten Anmeldung geändert werden.']);
      });
      return;
    case 'user:unlock':
      await withApp((app) => {
        const r = app.db.run("UPDATE users SET locked_until = NULL, failed_logins = 0, lock_count = 0 WHERE username = ? AND kind = 'local'", arg('username') ?? '');
        console.log(r.changes ? 'Entsperrt.' : 'Nicht gefunden.');
      });
      return;
    case 'user:list':
      await withApp((app) => {
        const rows = app.db.all<Record<string, unknown>>('SELECT kind, username, email, display_name, disabled, totp_enabled FROM users ORDER BY kind, display_name');
        console.table(rows);
      });
      return;
    case 'backup':
      await withApp((app) => {
        const dir = join(app.cfg.dataDir, 'backups');
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        const out = arg('out') ?? join(dir, `portal-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`);
        // VACUUM INTO schreibt nicht über vorhandene Dateien – alte Sicherung gleichen Namens ersetzen
        rmSync(out, { force: true });
        app.db.backupTo(out);
        console.log(`Sicherung geschrieben: ${out}`);
      });
      return;
    case 'audit:verify':
      await withApp(async (app) => {
        const { verifyAuditChain } = await import('./services/audit.ts');
        const r = verifyAuditChain(app.db);
        console.log(r.ok ? `Audit-Log unverändert (${r.count} Einträge).` : `Audit-Log beschädigt ab Eintrag ${r.brokenAt}!`);
        if (!r.ok) process.exitCode = 2;
      });
      return;
    case 'migrate':
      await withApp(() => console.log('Datenbank ist aktuell.'));
      return;
    default:
      console.error(`Unbekannter Befehl: ${command}`);
      process.exitCode = 64;
  }
}

main().catch((err) => {
  console.error(`Fehler: ${(err as Error).message}`);
  process.exit(1);
});
