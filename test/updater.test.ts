// Tests des Update-Dienstes mit simuliertem Docker/Git.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync, symlinkSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db, uuid } from '../src/server/db/db.ts';
import { Updater, compareVersions, setEnvValue, readEnvFile, type Exec, type UpdaterConfig } from '../updater/updater.ts';

function setup(opts: { healthyVersion: (call: number) => string | null; failCmd?: RegExp; mode?: 'docker' | 'native' }) {
  const dir = mkdtempSync(join(tmpdir(), 'zsp-upd-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '1.0.0' }));
  mkdirSync(join(dir, '.git'));
  const db = new Db(join(dir, 'portal.sqlite'));
  db.migrate();
  db.run("INSERT INTO settings (key, value) VALUES ('marker', 'vorher')");
  db.close();
  const envFile = join(dir, '.env');
  writeFileSync(envFile, '# Kommentar bleibt\nAPP_VERSION=1.0.0\nPUBLIC_URL=https://portal\n');
  const calls: string[] = [];
  const exec: Exec = async (cmd, args) => {
    const line = `${cmd} ${args.join(' ')}`;
    calls.push(line);
    if (opts.failCmd?.test(line)) return { code: 1, stdout: '', stderr: 'simulierter Fehler' };
    if (args.includes('tag') && args.includes('--list')) return { code: 0, stdout: 'v1.0.0\nv1.1.0\nv1.2.0\nkaputt\n', stderr: '' };
    if (args.includes('rev-parse') && args.includes('HEAD')) return { code: 0, stdout: 'abc123\n', stderr: '' };
    if (args.includes('show')) return { code: 0, stdout: '# Changelog\n## 1.2.0\n- Neu\n', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  let healthCalls = 0;
  const fetchImpl = (async () => {
    const v = opts.healthyVersion(++healthCalls);
    return new Response(JSON.stringify({ status: 'ok', version: v }), { status: v ? 200 : 503 });
  }) as unknown as typeof fetch;
  const cfg: UpdaterConfig = {
    dataDir: dir, portalDir: dir, composeFile: join(dir, 'docker-compose.yml'), envFile, projectName: 'test', source: 'git',
    gitRemote: 'origin', requireSignedTags: true, registryImage: 'ghcr.io/x/y', cosignIdentityRegexp: '.*', cosignIssuer: 'x',
    healthUrl: 'http://app/readyz', healthTimeoutMs: 50, checkIntervalMs: 3600_000, appUid: 65532, appGid: 65532,
    mode: opts.mode ?? 'docker', installScript: join(dir, 'deploy/native/install.sh'), services: ['zsp-web', 'zsp-worker'],
  };
  const u = new Updater(cfg, exec, fetchImpl);
  return { u, dir, calls, envFile, cleanup: () => { u.db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

function addJob(u: Updater, version: string): string {
  const id = uuid();
  u.db.run("INSERT INTO update_jobs (id, target_version, status, created_at) VALUES (?, ?, 'requested', ?)", id, version, Date.now());
  return id;
}

test('Versionen vergleichen und .env sicher ändern', () => {
  assert.ok(compareVersions('1.10.0', '1.9.9') > 0);
  assert.equal(compareVersions('v1.2.3', '1.2.3'), 0);
  const dir = mkdtempSync(join(tmpdir(), 'zsp-env-'));
  const f = join(dir, '.env');
  writeFileSync(f, '# x\nA=1\n');
  setEnvValue(f, 'A', '2');
  setEnvValue(f, 'B', '3');
  assert.equal(readFileSync(f, 'utf8'), '# x\nA=2\n\nB=3');
  assert.throws(() => setEnvValue(f, 'A', '1; rm -rf /'));
  assert.equal(readEnvFile(f).get('B'), '3');
  rmSync(dir, { recursive: true });
});

test('Prüfung findet neuere Versionen aus Git-Tags', async () => {
  const s = setup({ healthyVersion: () => '1.2.0' });
  try {
    await s.u.check();
    const st = s.u.db.get<{ available: string; latest_version: string; changelog: string }>('SELECT * FROM update_state WHERE id = 1')!;
    assert.deepEqual(JSON.parse(st.available), ['1.0.0', '1.1.0', '1.2.0']);
    assert.equal(st.latest_version, '1.2.0');
    assert.match(st.changelog, /1\.2\.0/);
  } finally { s.cleanup(); }
});

test('erfolgreiches Update: Signatur, Backup, Build, Neustart, Health', async () => {
  const s = setup({ healthyVersion: () => '1.2.0' });
  try {
    const id = addJob(s.u, '1.2.0');
    await s.u.tick();
    const job = s.u.db.get<{ status: string; log: string }>('SELECT * FROM update_jobs WHERE id = ?', id)!;
    assert.equal(job.status, 'succeeded', job.log);
    assert.ok(s.calls.some((c) => c.includes('verify-tag v1.2.0')), 'Signatur geprüft');
    assert.ok(s.calls.some((c) => c.includes('checkout --detach --force v1.2.0')));
    assert.ok(s.calls.some((c) => c.includes('compose -p test') && c.includes('build --pull app')));
    assert.ok(s.calls.some((c) => c.includes('up -d --no-deps app worker')));
    assert.match(job.log, /Datenbank gesichert/);
    assert.equal(readEnvFile(s.envFile).get('APP_VERSION'), '1.2.0');
    assert.match(readFileSync(s.envFile, 'utf8'), /# Kommentar bleibt/);
  } finally { s.cleanup(); }
});

test('unsignierter Tag: nichts wird verändert', async () => {
  const s = setup({ healthyVersion: () => '1.2.0', failCmd: /verify-tag/ });
  try {
    const id = addJob(s.u, '1.2.0');
    await s.u.tick();
    const job = s.u.db.get<{ status: string }>('SELECT * FROM update_jobs WHERE id = ?', id)!;
    assert.equal(job.status, 'failed');
    assert.ok(!s.calls.some((c) => c.includes('checkout')));
    assert.equal(readEnvFile(s.envFile).get('APP_VERSION'), '1.0.0');
  } finally { s.cleanup(); }
});

test('neue Version startet nicht: automatische Rücksetzung inkl. Datenbank', async () => {
  // Health meldet zunächst nie 1.2.0, nach dem Rollback aber 1.0.0
  const s = setup({ healthyVersion: () => '1.0.0' });
  try {
    const id = addJob(s.u, '1.2.0');
    // Simuliert eine Migration der neuen Version, die Daten verändert
    const origSwitch = (s.u as any).switchTo.bind(s.u);
    (s.u as any).switchTo = async (v: string, log: (x: string) => void) => {
      await origSwitch(v, log);
      s.u.db.run("UPDATE settings SET value = 'kaputt-migriert' WHERE key = 'marker'");
    };
    await s.u.tick();
    const job = s.u.db.get<{ status: string; log: string }>('SELECT * FROM update_jobs WHERE id = ?', id)!;
    assert.equal(job.status, 'rolled_back', job.log);
    assert.equal(s.u.db.get<{ value: string }>("SELECT value FROM settings WHERE key = 'marker'")!.value, 'vorher', 'Datenbank wiederhergestellt');
    assert.ok(s.calls.some((c) => c.includes('checkout --detach --force abc123')), 'alter Stand ausgecheckt');
    assert.equal(readEnvFile(s.envFile).get('APP_VERSION'), '1.0.0');
  } finally { s.cleanup(); }
});

test('ungültige Versionsangaben werden nicht ausgeführt', async () => {
  const s = setup({ healthyVersion: () => null });
  try {
    await assert.rejects(() => s.u.runJob({ id: 'x', target_version: '1.0.0; rm -rf /' }));
    assert.equal(s.calls.length, 0);
  } finally { s.cleanup(); }
});

test('ohne Docker: Version aus package.json, Update über install.sh, kein Docker', async () => {
  const s = setup({ healthyVersion: () => '1.2.0', mode: 'native' });
  try {
    assert.equal(s.u.currentVersion(), '1.0.0');
    await s.u.check();
    assert.deepEqual(JSON.parse(s.u.db.get<{ available: string }>('SELECT available FROM update_state WHERE id = 1')!.available), ['1.0.0', '1.1.0', '1.2.0']);
    const id = addJob(s.u, '1.2.0');
    assert.equal(await s.u.tick(), true);
    const job = s.u.db.get<{ status: string; log: string }>('SELECT * FROM update_jobs WHERE id = ?', id)!;
    assert.equal(job.status, 'succeeded', job.log);
    assert.ok(s.calls.some((c) => c.includes('verify-tag v1.2.0')), 'Signatur geprüft');
    assert.ok(s.calls.some((c) => c.includes(`safe.directory=${s.dir}`)));
    const checkout = s.calls.findIndex((c) => c.includes('checkout --detach --force v1.2.0'));
    const install = s.calls.findIndex((c) => c === `bash ${join(s.dir, 'deploy/native/install.sh')} --ja`);
    assert.ok(checkout >= 0 && install > checkout, 'erst auschecken, dann installieren');
    assert.ok(!s.calls.some((c) => c.startsWith('docker')), 'kein Docker');
    assert.equal(readEnvFile(s.envFile).get('APP_VERSION'), '1.0.0', '.env bleibt unverändert');
    assert.equal(await s.u.tick(), false, 'kein weiterer Auftrag');
  } finally { s.cleanup(); }
});

test('ohne Docker: fehlgeschlagenes Update stoppt die Dienste und stellt alles wieder her', async () => {
  const s = setup({ healthyVersion: () => '1.0.0', mode: 'native' });
  try {
    const id = addJob(s.u, '1.2.0');
    const origSwitch = (s.u as any).switchTo.bind(s.u);
    (s.u as any).switchTo = async (v: string, log: (x: string) => void) => {
      await origSwitch(v, log);
      s.u.db.run("UPDATE settings SET value = 'kaputt-migriert' WHERE key = 'marker'");
    };
    await s.u.tick();
    const job = s.u.db.get<{ status: string; log: string }>('SELECT * FROM update_jobs WHERE id = ?', id)!;
    assert.equal(job.status, 'rolled_back', job.log);
    assert.equal(s.u.db.get<{ value: string }>("SELECT value FROM settings WHERE key = 'marker'")!.value, 'vorher');
    assert.ok(s.calls.includes('systemctl stop zsp-web zsp-worker'));
    assert.ok(s.calls.some((c) => c.includes('checkout --detach --force abc123')));
    assert.equal(s.calls.filter((c) => c.includes('install.sh --ja')).length, 2, 'neu und alt installiert');
  } finally { s.cleanup(); }
});

test('ohne Docker: fehlende Signaturdatei verhindert das Update', async () => {
  const s = setup({ healthyVersion: () => '1.2.0', mode: 'native' });
  try {
    s.u.cfg.allowedSignersFile = join(s.dir, 'gibt-es-nicht');
    const id = addJob(s.u, '1.2.0');
    await s.u.tick();
    const job = s.u.db.get<{ status: string; log: string }>('SELECT * FROM update_jobs WHERE id = ?', id)!;
    assert.equal(job.status, 'failed');
    assert.match(job.log, /Signaturschlüssel/);
    assert.ok(!s.calls.some((c) => c.includes('checkout') || c.includes('install.sh')));
  } finally { s.cleanup(); }
});

test('ohne Docker: Links im Datenverzeichnis werden nie übereignet (Schutz vor Rechteausweitung)', async (t) => {
  if (process.getuid?.() !== 0) { t.skip('nur als root prüfbar'); return; }
  const s = setup({ healthyVersion: () => '1.2.0', mode: 'native' });
  const victimDir = mkdtempSync(join(tmpdir(), 'zsp-opfer-'));
  try {
    s.u.cfg.appUid = 12345; s.u.cfg.appGid = 12345;
    const victim = join(victimDir, 'shadow');
    writeFileSync(victim, 'root:x');
    mkdirSync(join(s.dir, 'backups'), { recursive: true });
    writeFileSync(join(s.dir, 'backups', 'echt.sqlite'), 'x');
    symlinkSync(victim, join(s.dir, 'backups', 'link'));
    linkSync(victim, join(s.dir, 'backups', 'hardlink'));
    s.u.fixOwnership();
    assert.equal(statSync(victim).uid, 0, 'Linkziel bleibt bei root');
    assert.equal(statSync(join(s.dir, 'backups', 'echt.sqlite')).uid, 12345, 'echte Backups gehören dem Dienstbenutzer');
    // Backup-Ordner als Link auf ein Systemverzeichnis
    rmSync(join(s.dir, 'backups'), { recursive: true });
    symlinkSync(victimDir, join(s.dir, 'backups'));
    s.u.fixOwnership();
    assert.equal(statSync(victimDir).uid, 0);
    assert.equal(statSync(victim).uid, 0);
    // Updates laufen dann nicht
    const id = addJob(s.u, '1.2.0');
    await assert.rejects(() => s.u.tick(), /ist ein Link/);
    assert.equal(s.u.db.get<{ status: string }>('SELECT status FROM update_jobs WHERE id = ?', id)!.status, 'requested');
    assert.ok(!s.calls.some((c) => c.includes('install.sh')));
  } finally { s.cleanup(); rmSync(victimDir, { recursive: true, force: true }); }
});
