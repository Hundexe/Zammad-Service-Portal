// Update-Dienst des Service-Portals.
//
// Ablauf eines Updates (angefordert in der Admin-Oberfläche):
//   1. Version prüfen (Git-Tag bzw. Image vorhanden, Signatur gültig)
//   2. Datenbank sichern (konsistente Kopie per SQLite "VACUUM INTO")
//   3. neue Version holen und bauen (git) bzw. ziehen (registry)
//   4. app + worker neu starten
//   5. warten, bis /readyz die neue Version meldet
//   6. bei Fehler: Datenbank und alte Version wiederherstellen
//
// Der Dienst hat keinen offenen Port. Er liest Aufträge aus der Datenbank und
// spricht Docker nur über einen Socket-Proxy mit eingeschränkten Rechten an.
//
// Installation ohne Docker (INSTALL_MODE=native): Der Dienst läuft als systemd-Unit
// "zammad-service-portal-updater". Statt Images zu bauen, checkt er den signierten Tag aus
// und führt deploy/native/install.sh --ja aus (baut die Oberfläche, startet die Dienste neu).
import { execFile } from 'node:child_process';
import { closeSync, constants as fsc, copyFileSync, existsSync, fchownSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Db } from '../src/server/db/db.ts';

export interface ExecResult { code: number; stdout: string; stderr: string }
export type Exec = (cmd: string, args: string[], opts?: { cwd?: string; timeoutMs?: number; env?: Record<string, string> }) => Promise<ExecResult>;

export interface UpdaterConfig {
  /** docker = Docker Compose, native = systemd-Dienste ohne Docker */
  mode: 'docker' | 'native';
  dataDir: string;
  portalDir: string;
  composeFile: string;
  envFile: string;
  projectName: string;
  source: 'git' | 'registry';
  gitRemote: string;
  requireSignedTags: boolean;
  allowedSignersFile?: string;
  registryImage: string;
  registryUser?: string;
  registryToken?: string;
  cosignKey?: string;
  cosignIdentityRegexp: string;
  cosignIssuer: string;
  healthUrl: string;
  healthTimeoutMs: number;
  checkIntervalMs: number;
  appUid: number;
  appGid: number;
  /** nur native: Installationsskript und systemd-Units von Web und Worker */
  installScript: string;
  services: string[];
}

export const realExec: Exec = (cmd, args, opts = {}) => new Promise((resolve) => {
  execFile(cmd, args, { cwd: opts.cwd, timeout: opts.timeoutMs ?? 15 * 60_000, maxBuffer: 20 * 1024 * 1024, env: { ...process.env, ...opts.env } }, (err, stdout, stderr) => {
    resolve({ code: err ? (typeof (err as any).code === 'number' ? (err as any).code : 1) : 0, stdout: String(stdout), stderr: String(stderr) });
  });
});

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)$/;
export function compareVersions(a: string, b: string): number {
  const pa = SEMVER.exec(a)?.slice(1).map(Number) ?? [0, 0, 0];
  const pb = SEMVER.exec(b)?.slice(1).map(Number) ?? [0, 0, 0];
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

export function readEnvFile(file: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!existsSync(file)) return map;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m) map.set(m[1], m[2].replace(/^["']|["']$/g, ''));
  }
  return map;
}

/** Setzt einen Wert in der .env, ohne Kommentare oder andere Zeilen zu verändern. */
export function setEnvValue(file: string, key: string, value: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(value)) throw new Error(`Ungültiger Wert für ${key}`);
  const lines = existsSync(file) ? readFileSync(file, 'utf8').split('\n') : [];
  let found = false;
  const out = lines.map((l) => {
    if (new RegExp(`^\\s*${key}\\s*=`).test(l)) { found = true; return `${key}=${value}`; }
    return l;
  });
  if (!found) out.push(`${key}=${value}`);
  writeFileSync(file, out.join('\n'));
}

export class Updater {
  cfg: UpdaterConfig;
  exec: Exec;
  fetchImpl: typeof fetch;
  db: Db;
  private lastCheck = 0;

  constructor(cfg: UpdaterConfig, exec: Exec = realExec, fetchImpl: typeof fetch = fetch) {
    this.cfg = cfg;
    this.exec = exec;
    this.fetchImpl = fetchImpl;
    this.assertNoLinks();
    this.db = new Db(join(cfg.dataDir, 'portal.sqlite'));
    this.fixOwnership();
  }

  get native(): boolean { return this.cfg.mode === 'native'; }

  /** git-Aufruf im Portal-Verzeichnis (safe.directory: das Repository gehört evtl. einem anderen Benutzer als root) */
  private git(...args: string[]): string[] {
    return ['-C', this.cfg.portalDir, '-c', `safe.directory=${this.cfg.portalDir}`, ...args];
  }

  /**
   * Ohne Docker läuft der Updater als root, das Portal als Dienstbenutzer. Legt der Updater die
   * Datenbank-Nebendateien (-wal, -shm) oder Backups an, gehören sie root – das Portal könnte dann nicht
   * mehr schreiben. Deshalb nach jedem Schritt dem Dienstbenutzer zurückgeben.
   */
  //
  // Sicherheit: Das Datenverzeichnis gehört dem Dienstbenutzer. Er könnte dort symbolische oder harte
  // Links auf Systemdateien (z. B. /etc/shadow) anlegen. Deshalb nie einem Link folgen: Datei mit
  // O_NOFOLLOW öffnen, am offenen Handle prüfen (nur echte Datei/Verzeichnis, genau ein Link) und dort
  // den Besitzer setzen (fchown) – so gibt es auch kein Zeitfenster zwischen Prüfen und Ändern.
  fixOwnership(): void {
    if (!this.native) return;
    const { dataDir } = this.cfg;
    for (const ext of ['', '-wal', '-shm']) this.ownSafe(join(dataDir, `portal.sqlite${ext}`), 'file');
    const backups = join(dataDir, 'backups');
    if (this.ownSafe(backups, 'dir')) {
      for (const f of readdirSync(backups)) this.ownSafe(join(backups, f), 'file');
    }
  }

  /** Setzt den Besitzer ohne Links zu folgen. true = war ein echtes Objekt der erwarteten Art. */
  private ownSafe(path: string, kind: 'file' | 'dir'): boolean {
    let fd: number;
    try {
      fd = openSync(path, fsc.O_RDONLY | fsc.O_NOFOLLOW | fsc.O_NONBLOCK | (kind === 'dir' ? fsc.O_DIRECTORY : 0));
    } catch {
      return false; // fehlt, ist ein symbolischer Link (ELOOP) oder etwas anderes
    }
    try {
      const st = fstatSync(fd);
      const ok = kind === 'dir' ? st.isDirectory() : st.isFile() && st.nlink === 1;
      if (!ok) return false;
      try { fchownSync(fd, this.cfg.appUid, this.cfg.appGid); } catch { /* ohne CHOWN-Recht (Tests) */ }
      return true;
    } finally {
      closeSync(fd);
    }
  }

  /** Ohne Docker: Abbruch, wenn Datenbank oder Backup-Ordner ein symbolischer Link ist (Schutz vor Rechteausweitung). */
  assertNoLinks(): void {
    if (!this.native) return;
    const { dataDir } = this.cfg;
    for (const p of [dataDir, ...['', '-wal', '-shm'].map((e) => join(dataDir, `portal.sqlite${e}`)), join(dataDir, 'backups')]) {
      let st;
      try { st = lstatSync(p); } catch { continue; }
      if (st.isSymbolicLink() || (st.isFile() && st.nlink > 1)) throw new Error(`${p} ist ein Link – Update-Dienst bricht ab (möglicher Angriff, bitte prüfen).`);
    }
  }

  private compose(...args: string[]): string[] {
    return ['compose', '-p', this.cfg.projectName, '-f', this.cfg.composeFile, '--env-file', this.cfg.envFile, ...args];
  }

  private async must(cmd: string, args: string[], log: (s: string) => void, opts: { cwd?: string; timeoutMs?: number; env?: Record<string, string> } = {}): Promise<string> {
    log(`$ ${cmd} ${args.join(' ')}`);
    const r = await this.exec(cmd, args, opts);
    const tail = (r.stdout + r.stderr).trim().split('\n').slice(-15).join('\n');
    if (tail) log(tail);
    if (r.code !== 0) throw new Error(`${cmd} ${args[0]} fehlgeschlagen (Exit ${r.code})`);
    return r.stdout;
  }

  currentVersion(): string {
    if (this.native) {
      try { return String(JSON.parse(readFileSync(join(this.cfg.portalDir, 'package.json'), 'utf8')).version); } catch { return '0.0.0'; }
    }
    const env = readEnvFile(this.cfg.envFile);
    return (this.cfg.source === 'git' ? env.get('APP_VERSION') : env.get('IMAGE_TAG')) ?? '0.0.0';
  }

  heartbeat(): void {
    try { writeFileSync('/tmp/updater-heartbeat', String(Date.now())); } catch { /* nur im Container relevant */ }
    this.db.run('UPDATE update_state SET updater_seen_at = ?, current_version = ? WHERE id = 1', Date.now(), this.currentVersion());
  }

  // ------------------------------------------------------------ Prüfen
  async availableVersions(): Promise<{ versions: string[]; changelog: string }> {
    if (this.cfg.source === 'git') {
      const noop = () => undefined;
      if (this.native && !existsSync(join(this.cfg.portalDir, '.git'))) throw new Error(`${this.cfg.portalDir} ist kein Git-Verzeichnis – Updates brauchen eine Installation per setup.sh (git clone).`);
      await this.must('git', this.git('fetch', '--tags', '--force', '--prune', this.cfg.gitRemote), noop, { timeoutMs: 120_000 });
      const out = await this.must('git', this.git('tag', '--list', 'v*'), noop);
      const versions = out.split('\n').map((t) => t.trim()).filter((t) => SEMVER.test(t)).map((t) => t.slice(1)).sort(compareVersions);
      let changelog = '';
      const latest = versions.at(-1);
      if (latest) {
        const r = await this.exec('git', this.git('show', `v${latest}:CHANGELOG.md`));
        if (r.code === 0) changelog = r.stdout.split(/\n(?=## )/).slice(0, 4).join('\n').slice(0, 8000);
      }
      return { versions, changelog };
    }
    // Registry (z. B. GHCR): Tags über die Registry-API lesen
    const m = /^([^/]+)\/(.+)$/.exec(this.cfg.registryImage);
    if (!m) throw new Error('REGISTRY_IMAGE ungültig');
    const [, host, repo] = m;
    const auth = this.cfg.registryUser && this.cfg.registryToken ? { Authorization: `Basic ${Buffer.from(`${this.cfg.registryUser}:${this.cfg.registryToken}`).toString('base64')}` } : undefined;
    const tok = await this.fetchImpl(`https://${host}/token?scope=repository:${repo}:pull&service=${host}`, { headers: auth, signal: AbortSignal.timeout(15000) });
    const token = ((await tok.json().catch(() => ({}))) as { token?: string }).token;
    const r = await this.fetchImpl(`https://${host}/v2/${repo}/tags/list?n=500`, { headers: token ? { Authorization: `Bearer ${token}` } : undefined, signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`Registry antwortet mit ${r.status}`);
    const tags = ((await r.json()) as { tags?: string[] }).tags ?? [];
    return { versions: tags.filter((t) => SEMVER.test(t)).map((t) => t.replace(/^v/, '')).sort(compareVersions), changelog: '' };
  }

  async check(): Promise<void> {
    try {
      const { versions, changelog } = await this.availableVersions();
      const current = this.currentVersion();
      const available = versions.filter((v) => compareVersions(v, current) >= 0).slice(-10);
      this.db.run('UPDATE update_state SET available = ?, latest_version = ?, changelog = ?, checked_at = ?, last_error = NULL, current_version = ? WHERE id = 1',
        JSON.stringify(available), versions.at(-1) ?? null, changelog, Date.now(), current);
    } catch (err) {
      this.db.run('UPDATE update_state SET checked_at = ?, last_error = ? WHERE id = 1', Date.now(), (err as Error).message.slice(0, 500));
    }
    this.lastCheck = Date.now();
  }

  checkDue(): boolean {
    const requested = Number(this.db.get<{ value: string }>("SELECT value FROM settings WHERE key = 'update.check_requested'")?.value ?? 0);
    return Date.now() - this.lastCheck > this.cfg.checkIntervalMs || requested > this.lastCheck;
  }

  // ------------------------------------------------------------ Update
  private backupFile(from: string, to: string): string {
    const dir = join(this.cfg.dataDir, 'backups');
    this.assertNoLinks();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, `vor-update-${from}-auf-${to}-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`);
    this.db.backupTo(file);
    return file;
  }

  private restoreDb(backup: string): void {
    this.db.close();
    const target = join(this.cfg.dataDir, 'portal.sqlite');
    // Erst entfernen (auch einen evtl. untergeschobenen Link), dann exklusiv neu anlegen – nie in ein Linkziel schreiben
    for (const ext of ['', '-wal', '-shm']) rmSync(target + ext, { force: true });
    copyFileSync(backup, target, fsc.COPYFILE_EXCL);
    this.ownSafe(target, 'file');
    this.assertNoLinks();
    this.db = new Db(target);
    this.fixOwnership();
  }

  private async waitHealthy(version: string, log: (s: string) => void): Promise<void> {
    const deadline = Date.now() + this.cfg.healthTimeoutMs;
    let last = '';
    while (Date.now() < deadline) {
      try {
        const r = await this.fetchImpl(this.cfg.healthUrl, { signal: AbortSignal.timeout(4000) });
        const j = (await r.json().catch(() => ({}))) as { version?: string };
        last = `HTTP ${r.status}, Version ${j.version ?? '?'}`;
        if (r.ok && j.version === version) { log(`Gesund: ${last}`); return; }
      } catch (err) { last = (err as Error).message; }
      await new Promise((res) => setTimeout(res, 3000));
    }
    throw new Error(`Neue Version meldet sich nicht gesund (${last})`);
  }

  /** nur native: Installationsskript der ausgecheckten Version ausführen (baut, startet Web und Worker neu) */
  private async runInstall(log: (s: string) => void): Promise<void> {
    this.fixOwnership();
    await this.must('bash', [this.cfg.installScript, '--ja'], log, { cwd: this.cfg.portalDir, timeoutMs: 30 * 60_000, env: { ZSP_FROM_UPDATER: '1' } });
  }

  private async switchTo(version: string, log: (s: string) => void): Promise<void> {
    if (this.native) {
      await this.must('git', this.git('checkout', '--detach', '--force', `v${version}`), log);
      await this.runInstall(log);
      return;
    }
    if (this.cfg.source === 'git') {
      await this.must('git', this.git('checkout', '--detach', '--force', `v${version}`), log);
      setEnvValue(this.cfg.envFile, 'APP_VERSION', version);
      await this.must('docker', this.compose('build', '--pull', 'app'), log, { timeoutMs: 30 * 60_000 });
    } else {
      setEnvValue(this.cfg.envFile, 'IMAGE_TAG', version);
      await this.must('docker', this.compose('pull', 'app', 'worker'), log, { timeoutMs: 20 * 60_000 });
    }
    await this.must('docker', this.compose('up', '-d', '--no-deps', 'app', 'worker'), log, { timeoutMs: 10 * 60_000 });
  }

  private async verify(version: string, log: (s: string) => void): Promise<void> {
    if (this.cfg.source === 'git') {
      await this.must('git', this.git('rev-parse', '--verify', `refs/tags/v${version}`), log);
      if (this.cfg.requireSignedTags) {
        if (this.cfg.allowedSignersFile && !existsSync(this.cfg.allowedSignersFile)) throw new Error(`Datei mit erlaubten Signaturschlüsseln fehlt: ${this.cfg.allowedSignersFile}`);
        const extra = this.cfg.allowedSignersFile ? ['-c', `gpg.ssh.allowedSignersFile=${this.cfg.allowedSignersFile}`] : [];
        await this.must('git', this.git(...extra, 'verify-tag', `v${version}`), log);
        log('Tag-Signatur gültig.');
      } else {
        log('Hinweis: Tag-Signaturen werden nicht geprüft (UPDATE_REQUIRE_SIGNED_TAGS=false).');
      }
      return;
    }
    const image = `${this.cfg.registryImage}:${version}`;
    const args = this.cfg.cosignKey
      ? ['verify', '--key', this.cfg.cosignKey, image]
      : ['verify', '--certificate-identity-regexp', this.cfg.cosignIdentityRegexp, '--certificate-oidc-issuer', this.cfg.cosignIssuer, image];
    await this.must('cosign', args, log, { timeoutMs: 120_000 });
    log('Image-Signatur gültig.');
  }

  async runJob(job: { id: string; target_version: string }): Promise<'succeeded' | 'rolled_back' | 'failed'> {
    const target = job.target_version;
    if (!SEMVER.test(target)) throw new Error('Ungültige Version');
    const lines: string[] = [];
    const log = (s: string) => {
      lines.push(`[${new Date().toISOString().slice(11, 19)}] ${s}`);
      this.db.run('UPDATE update_jobs SET log = ? WHERE id = ?', lines.join('\n').slice(-60000), job.id);
    };
    this.db.run("UPDATE update_jobs SET status = 'running', started_at = ? WHERE id = ?", Date.now(), job.id);
    const from = this.currentVersion();
    const prevRef = this.cfg.source === 'git' || this.native ? (await this.exec('git', this.git('rev-parse', 'HEAD'))).stdout.trim() : '';
    let backup = '';
    try {
      log(`Update von ${from} auf ${target}`);
      await this.verify(target, log);
      backup = this.backupFile(from, target);
      log(`Datenbank gesichert: ${backup}`);
      await this.switchTo(target, log);
      await this.waitHealthy(target, log);
      this.db.run('UPDATE update_state SET current_version = ? WHERE id = 1', target);
      this.db.run("UPDATE update_jobs SET status = 'succeeded', finished_at = ? WHERE id = ?", Date.now(), job.id);
      log('Update erfolgreich.');
      return 'succeeded';
    } catch (err) {
      log(`FEHLER: ${(err as Error).message}`);
      if (!backup) {
        this.db.run("UPDATE update_jobs SET status = 'failed', finished_at = ? WHERE id = ?", Date.now(), job.id);
        log('Es wurde nichts verändert.');
        return 'failed';
      }
      log('Rolle zurück …');
      try {
        if (this.native) {
          if (!prevRef) throw new Error('Vorheriger Stand unbekannt');
          await this.must('systemctl', ['stop', ...this.cfg.services], log);
          this.restoreDb(backup);
          log('Datenbank wiederhergestellt.');
          await this.must('git', this.git('checkout', '--detach', '--force', prevRef), log);
          await this.runInstall(log);
          await this.waitHealthy(from, log);
          this.db.run("UPDATE update_jobs SET status = 'rolled_back', finished_at = ? WHERE id = ?", Date.now(), job.id);
          log(`Zurückgerollt auf ${from}.`);
          return 'rolled_back';
        }
        await this.must('docker', this.compose('stop', 'app', 'worker'), log);
        this.restoreDb(backup);
        log('Datenbank wiederhergestellt.');
        if (this.cfg.source === 'git') {
          await this.must('git', this.git('checkout', '--detach', '--force', prevRef), log);
          setEnvValue(this.cfg.envFile, 'APP_VERSION', from);
          await this.must('docker', this.compose('build', 'app'), log, { timeoutMs: 30 * 60_000 });
        } else {
          setEnvValue(this.cfg.envFile, 'IMAGE_TAG', from);
        }
        await this.must('docker', this.compose('up', '-d', '--no-deps', 'app', 'worker'), log);
        await this.waitHealthy(from, log);
        this.db.run("UPDATE update_jobs SET status = 'rolled_back', finished_at = ? WHERE id = ?", Date.now(), job.id);
        log(`Zurückgerollt auf ${from}.`);
        return 'rolled_back';
      } catch (rollbackErr) {
        log(`ROLLBACK FEHLGESCHLAGEN: ${(rollbackErr as Error).message} – bitte manuell eingreifen (siehe docs/BETRIEB.md).`);
        this.db.run("UPDATE update_jobs SET status = 'failed', finished_at = ? WHERE id = ?", Date.now(), job.id);
        return 'failed';
      }
    }
  }

  /** Ein Durchlauf. Rückgabe: true, wenn ein Update-Auftrag bearbeitet wurde. */
  async tick(): Promise<boolean> {
    try {
      this.assertNoLinks();
      this.heartbeat();
      if (this.checkDue()) await this.check();
      const job = this.db.get<{ id: string; target_version: string }>("SELECT id, target_version FROM update_jobs WHERE status = 'requested' ORDER BY created_at LIMIT 1");
      if (!job) return false;
      await this.runJob(job);
      await this.check();
      return true;
    } finally {
      this.fixOwnership();
    }
  }
}

export function configFromEnv(): UpdaterConfig {
  const env = process.env;
  const native = env.INSTALL_MODE === 'native';
  const portalDir = env.PORTAL_DIR ?? '/opt/zammad-service-portal';
  const dataDir = env.DATA_DIR ?? (native ? '/var/lib/zammad-service-portal' : '/data');
  // Ohne Docker: Dateien gehören dem Dienstbenutzer, dem auch das Datenverzeichnis gehört
  let owner = { uid: 65532, gid: 65532 };
  if (native) { try { owner = statSync(dataDir); } catch { /* Verzeichnis fehlt noch */ } }
  return {
    mode: native ? 'native' : 'docker',
    dataDir,
    portalDir,
    composeFile: env.COMPOSE_FILE_PATH ?? join(portalDir, 'deploy/docker-compose.yml'),
    envFile: env.ENV_FILE_PATH ?? join(portalDir, 'deploy/.env'),
    projectName: env.COMPOSE_PROJECT_NAME ?? 'service-portal',
    source: !native && env.UPDATE_SOURCE === 'registry' ? 'registry' : 'git',
    gitRemote: env.UPDATE_GIT_REMOTE ?? 'origin',
    requireSignedTags: (env.UPDATE_REQUIRE_SIGNED_TAGS ?? 'true') !== 'false',
    allowedSignersFile: env.UPDATE_ALLOWED_SIGNERS || (native ? '/etc/zammad-service-portal/allowed_signers' : undefined),
    registryImage: env.REGISTRY_IMAGE ?? 'ghcr.io/hundexe/zammad-service-portal',
    registryUser: env.REGISTRY_USER || undefined,
    registryToken: env.REGISTRY_TOKEN_FILE ? readFileSync(env.REGISTRY_TOKEN_FILE, 'utf8').trim() : undefined,
    cosignKey: env.COSIGN_KEY || undefined,
    cosignIdentityRegexp: env.COSIGN_IDENTITY_REGEXP ?? '^https://github.com/Hundexe/Zammad-Service-Portal/',
    cosignIssuer: env.COSIGN_ISSUER ?? 'https://token.actions.githubusercontent.com',
    healthUrl: env.APP_HEALTH_URL ?? (native ? `http://127.0.0.1:${env.PORT || 3000}/readyz` : 'http://app:3000/readyz'),
    healthTimeoutMs: Number(env.HEALTH_TIMEOUT_SECONDS ?? 180) * 1000,
    checkIntervalMs: Number(env.CHECK_INTERVAL_HOURS ?? 6) * 3600_000,
    appUid: owner.uid,
    appGid: owner.gid,
    installScript: join(portalDir, 'deploy/native/install.sh'),
    services: ['zammad-service-portal', 'zammad-service-portal-worker'],
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cfg = configFromEnv();
  // Warten, bis die App die Datenbank angelegt hat
  while (!existsSync(join(cfg.dataDir, 'portal.sqlite'))) await new Promise((r) => setTimeout(r, 5000));
  const u = new Updater(cfg);
  console.log(JSON.stringify({ time: new Date().toISOString(), level: 'info', msg: 'Updater gestartet', mode: cfg.mode, source: cfg.source, version: u.currentVersion() }));
  let stop = false;
  process.on('SIGTERM', () => { stop = true; });
  while (!stop) {
    let didJob = false;
    try { didJob = await u.tick(); } catch (err) { console.error(JSON.stringify({ time: new Date().toISOString(), level: 'error', msg: (err as Error).message })); }
    // Ohne Docker: nach einem Update beenden – systemd startet den Updater mit dem neuen Code neu
    if (didJob && u.native) break;
    await new Promise((r) => setTimeout(r, 30_000));
  }
  u.db.close();
}
