// Gemeinsamer Anwendungskontext für Server, Worker und CLI.
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';
import { useLinearRegex } from '../shared/form.ts';
import type { Config } from './config.ts';
import { Db } from './db/db.ts';
import { SecretBox } from './crypto.ts';
import { ensureBuiltinRoles } from './services/rbac.ts';
import { sealLegacyTitles } from './services/request-title.ts';
import { ClamAv } from './services/clamav.ts';

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
  return {
    cfg,
    db,
    box,
    clamav: cfg.clamav.host ? new ClamAv(cfg.clamav.host, cfg.clamav.port) : null,
    uploadsDir: join(cfg.dataDir === ':memory:' ? '/tmp' : cfg.dataDir, 'uploads'),
  };
}
