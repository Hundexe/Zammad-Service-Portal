// „Nur benachrichtigen“ (UPDATE_NOTIFY=true): Ohne Update-Dienst prüft der Worker selbst – ohne besondere Rechte –
// ob es eine neuere Version gibt, und zeigt sie in der Verwaltung an. Installiert wird manuell (docs/UPDATES.md).
// Die Antwort steuert nur eine Anzeige: Die Liste installierbarer Versionen („available“) pflegt allein der
// Update-Dienst nach Prüfung der Signatur – darüber lässt sich also nichts installieren.
import type { App } from '../app.ts';
import { log } from '../log.ts';

const VERSION = /^v?(\d{1,4})\.(\d{1,4})\.(\d{1,4})$/;

export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split('.').map(Number);
  const pb = b.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

/** Neuere Versionen aus einer Tag-Liste (GitHub-API: [{ name: "v1.14.0" }, …]), absteigend */
export function newerVersions(tags: unknown, current: string): string[] {
  if (!Array.isArray(tags)) return [];
  const out = new Set<string>();
  for (const t of tags.slice(0, 500)) {
    const name = typeof t === 'string' ? t : typeof (t as { name?: unknown })?.name === 'string' ? (t as { name: string }).name : '';
    if (VERSION.test(name)) {
      const v = name.replace(/^v/, '');
      if (compareVersions(v, current) > 0) out.add(v);
    }
  }
  return [...out].sort((a, b) => compareVersions(b, a)).slice(0, 20);
}

/** Läuft der Update-Dienst? Dann prüft er selbst (mit Signatur) – „nur benachrichtigen“ hält sich heraus. */
function updaterOnline(app: App): boolean {
  const s = app.db.get<{ updater_seen_at: number | null }>('SELECT updater_seen_at FROM update_state WHERE id = 1');
  return Date.now() - Number(s?.updater_seen_at ?? 0) < 5 * 60_000;
}

export async function checkForUpdates(app: App, fetchImpl: typeof fetch = fetch): Promise<string[] | null> {
  const n = app.cfg.updateNotify;
  if (!n?.enabled || updaterOnline(app)) return null;
  try {
    const r = await fetchImpl(n.url, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'self-service-portal' }, signal: AbortSignal.timeout(15000), redirect: 'error' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const text = await r.text();
    if (text.length > 2_000_000) throw new Error('Antwort zu groß');
    const newer = newerVersions(JSON.parse(text), app.cfg.version);
    app.db.run("UPDATE update_state SET latest_version = ?, checked_at = ?, last_error = NULL, channel = 'notify' WHERE id = 1", newer[0] ?? app.cfg.version, Date.now());
    app.db.run("INSERT INTO settings (key, value) VALUES ('update.notify_versions', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", JSON.stringify(newer));
    if (newer.length) log.info('Neue Version verfügbar (nur Benachrichtigung)', { version: newer[0] });
    return newer;
  } catch (err) {
    const msg = `Prüfung auf neue Versionen fehlgeschlagen: ${(err as Error).message}`.slice(0, 300);
    app.db.run("UPDATE update_state SET checked_at = ?, last_error = ?, channel = 'notify' WHERE id = 1", Date.now(), msg);
    log.warn(msg);
    return null;
  }
}
