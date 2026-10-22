// Gemeinsamer Anwendungskontext für Server, Worker und CLI.
import { join } from 'node:path';
import type { Config } from './config.ts';
import { Db } from './db/db.ts';
import { SecretBox } from './crypto.ts';
import { ensureBuiltinRoles } from './services/rbac.ts';
import { ClamAv } from './services/clamav.ts';

export interface App {
  cfg: Config;
  db: Db;
  box: SecretBox;
  clamav: ClamAv | null;
  uploadsDir: string;
}

export function createApp(cfg: Config): App {
  const db = new Db(cfg.dataDir === ':memory:' ? ':memory:' : join(cfg.dataDir, 'portal.sqlite'));
  db.migrate();
  ensureBuiltinRoles(db);
  return {
    cfg,
    db,
    box: new SecretBox(cfg.secretKey),
    clamav: cfg.clamav.host ? new ClamAv(cfg.clamav.host, cfg.clamav.port) : null,
    uploadsDir: join(cfg.dataDir === ':memory:' ? '/tmp' : cfg.dataDir, 'uploads'),
  };
}
