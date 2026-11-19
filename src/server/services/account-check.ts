// Deaktivierte Microsoft-Konten früher aussperren (optional, ENTRA_ACCOUNT_CHECK_MINUTES).
// Ohne diese Prüfung bleibt eine Portal-Sitzung bis zu SESSION_MAX_HOURS gültig, auch wenn das Konto in Entra
// inzwischen deaktiviert oder gelöscht ist. Mit ihr fragt der Worker regelmäßig für alle Konten mit offener
// Sitzung bei Graph nach und beendet die Sitzungen deaktivierter Konten. Das Portal-Konto selbst bleibt
// unverändert – eine neue Anmeldung verhindert Microsoft ohnehin.
import type { App } from '../app.ts';
import type { EntraClient } from '../auth/oidc.ts';
import { audit } from './audit.ts';
import { log } from '../log.ts';

/** Höchstens so viele Konten je Durchlauf (Graph-Drosselung) */
const MAX_PER_RUN = 300;

export async function checkEntraAccounts(app: App, entra: Pick<EntraClient, 'accountEnabled'>): Promise<{ checked: number; ended: number }> {
  const rows = app.db.all<{ id: string; entra_oid: string; tenant_id: string; display_name: string }>(
    `SELECT DISTINCT u.id, u.entra_oid, u.tenant_id, u.display_name FROM users u JOIN sessions s ON s.user_id = u.id
     WHERE u.kind = 'entra' AND u.entra_oid IS NOT NULL AND u.tenant_id IS NOT NULL AND s.expires_at > ? LIMIT ?`,
    Date.now(), MAX_PER_RUN,
  );
  let ended = 0;
  for (const u of rows) {
    const enabled = await entra.accountEnabled(u.tenant_id, u.entra_oid);
    if (enabled !== false) continue; // aktiv oder unbekannt: nichts tun
    const r = app.db.run('DELETE FROM sessions WHERE user_id = ?', u.id);
    if (r.changes) {
      ended++;
      log.warn('Sitzungen eines in Entra deaktivierten Kontos beendet', { alert: true, event: 'entra_account_disabled', user: u.id });
      audit(app.db, { name: 'Kontoprüfung (Entra)' }, { action: 'user.sessions_ended', targetType: 'user', targetId: u.id, details: { grund: 'in Entra deaktiviert oder gelöscht', sitzungen: r.changes } });
    }
  }
  return { checked: rows.length, ended };
}
