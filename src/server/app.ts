// Gemeinsamer Anwendungskontext für Server, Worker und CLI.
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';
import { useLinearRegex } from '../shared/form.ts';
import type { Config } from './config.ts';
import { Db } from './db/db.ts';
import { SecretBox } from './crypto.ts';
import { ensureBuiltinRoles } from './services/rbac.ts';
import { sealLegacyTitles } from './services/request-title.ts';
import { qualifyForeignAppRoles } from './services/users.ts';
import { ClamAv } from './services/clamav.ts';
import { optionKey } from '../shared/zammad-model.ts';

export interface App {
  cfg: Config;
  db: Db;
  box: SecretBox;
  clamav: ClamAv | null;
  uploadsDir: string;
}

export function createApp(cfg: Config): App {
  // Prüfmuster aus Formularen linear auswerten (Schutz vor ReDoS), siehe shared/form.ts
  setFlagsFromString('--enable-experimental-regexp-engine');
  if (!useLinearRegex()) throw new Error('Lineare Regex-Engine nicht verfügbar – Node.js 22 oder neuer nötig');
  const db = new Db(cfg.dataDir === ':memory:' ? ':memory:' : join(cfg.dataDir, 'portal.sqlite'));
  db.migrate();
  ensureBuiltinRoles(db);
  const box = new SecretBox(cfg.secretKey);
  sealLegacyTitles(db, box);
  // Services aus 1.x bekommen ihren Schlüssel für das Attribut „Portal: Services“ in Zammad
  for (const s of db.all<{ id: string; system_id: string; name: string }>('SELECT id, system_id, name FROM services WHERE zkey IS NULL')) {
    const base = optionKey(s.name).slice(0, 50);
    let k = base;
    for (let i = 2; db.get('SELECT 1 FROM services WHERE system_id = ? AND zkey = ?', s.system_id, k); i++) k = `${base}_${i}`;
    db.run('UPDATE services SET zkey = ? WHERE id = ?', k, s.id);
  }
  // App-Rollen aus Partner-Tenants nur noch mit Tenant im Namen (siehe appRoleName)
  if ((cfg.entra?.allowedTenants?.length ?? 0) > 1) qualifyForeignAppRoles(db, cfg.entra.tenantId);
  return {
    cfg,
    db,
    box,
    clamav: cfg.clamav.host ? new ClamAv(cfg.clamav.host, cfg.clamav.port) : null,
    uploadsDir: join(cfg.dataDir === ':memory:' ? '/tmp' : cfg.dataDir, 'uploads'),
  };
}
