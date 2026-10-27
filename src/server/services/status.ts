// Betriebszustand für Überwachung und CLI (status, scanner:test).
import type { App } from '../app.ts';
import { verifyAuditChain } from './audit.ts';

/** EICAR-Testdatei – zur Laufzeit zusammengesetzt, damit Virenscanner das Repository nicht anmeckern. */
export function eicar(): Buffer {
  const parts = ['X5O!P%@AP[4\\PZX54(P^)7CC)7}$', 'EICAR-STANDARD-', 'ANTIVIRUS-TEST-FILE!$H+H*'];
  return Buffer.from(parts.join(''), 'latin1');
}

export interface ScannerCheck { status: 'ok' | 'missing' | 'down' | 'not_detecting'; message: string }

/** Prüft den Virenscanner: saubere Datei muss durchgehen, EICAR muss erkannt werden. */
export async function testScanner(app: App): Promise<ScannerCheck> {
  if (!app.clamav) return { status: 'missing', message: 'Kein Virenscanner konfiguriert (CLAMAV_HOST)' };
  try {
    const clean = await app.clamav.scan(Buffer.from('Service-Portal Scanner-Test\n'));
    if (!clean.clean) return { status: 'not_detecting', message: `Saubere Testdatei wurde abgelehnt (${clean.signature})` };
    const bad = await app.clamav.scan(eicar());
    if (bad.clean) return { status: 'not_detecting', message: 'EICAR-Testdatei wurde NICHT erkannt – Signaturen fehlen oder Scanner falsch eingerichtet' };
    return { status: 'ok', message: `Virenscanner arbeitet (EICAR erkannt als ${bad.signature})` };
  } catch (err) {
    return { status: 'down', message: `Virenscanner nicht erreichbar: ${(err as Error).message}` };
  }
}

export interface StatusReport {
  ok: boolean;
  problems: string[];
  warnings: string[];
  outbox: { queued: number; sending: number; failed: number; deliveredLast24h: number; oldestQueuedMinutes: number | null };
  scanner: ScannerCheck;
  audit: { ok: boolean; count: number; brokenAt: number | null };
  version: string;
}

export interface StatusLimits { maxQueueAgeMinutes: number; maxFailed: number }

export async function collectStatus(app: App, limits: StatusLimits = { maxQueueAgeMinutes: 30, maxFailed: 0 }): Promise<StatusReport> {
  const count = (status: string) => app.db.get<{ n: number }>('SELECT COUNT(*) n FROM requests WHERE status = ?', status)!.n;
  const oldest = app.db.get<{ t: number | null }>("SELECT MIN(created_at) t FROM requests WHERE status IN ('queued','sending')")!.t;
  const outbox = {
    queued: count('queued'),
    sending: count('sending'),
    failed: count('failed'),
    deliveredLast24h: app.db.get<{ n: number }>("SELECT COUNT(*) n FROM requests WHERE status = 'delivered' AND delivered_at > ?", Date.now() - 86400_000)!.n,
    oldestQueuedMinutes: oldest ? Math.floor((Date.now() - oldest) / 60_000) : null,
  };
  const problems: string[] = [];
  const warnings: string[] = [];
  if (outbox.oldestQueuedMinutes !== null && outbox.oldestQueuedMinutes > limits.maxQueueAgeMinutes) {
    problems.push(`Älteste Anfrage wartet seit ${outbox.oldestQueuedMinutes} Minuten auf Zustellung (Grenze ${limits.maxQueueAgeMinutes})`);
  }
  if (outbox.failed > limits.maxFailed) problems.push(`${outbox.failed} Anfrage(n) endgültig fehlgeschlagen – Verwaltung → Zustellung`);
  const scanner = await testScanner(app);
  if (scanner.status !== 'ok') (app.cfg.clamav.required ? problems : warnings).push(scanner.message);
  const chain = verifyAuditChain(app.db);
  if (!chain.ok) problems.push(`Audit-Log beschädigt ab Eintrag ${chain.brokenAt}`);
  return { ok: problems.length === 0, problems, warnings, outbox, scanner, audit: chain, version: app.cfg.version };
}
