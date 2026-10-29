// Titel einer Anfrage: aus Benutzereingaben gebildet (z. B. „Störung: <Betreff>“) und deshalb verschlüsselt
// gespeichert wie der übrige Inhalt. Nach der Aufbewahrungsfrist steht dort nur noch PURGED_TITLE (Klartext).
import type { Db } from '../db/db.ts';
import type { SecretBox } from '../crypto.ts';

export const PURGED_TITLE = 'Inhalt nach Ablauf der Aufbewahrungsfrist gelöscht';
const PURPOSE = 'request-title';

export function sealTitle(box: SecretBox, title: string): string {
  return box.encrypt(PURPOSE, title);
}

/** Entschlüsselt; ältere (Klartext-)Einträge und der Platzhalter nach der Löschung bleiben, wie sie sind. */
export function openTitle(box: SecretBox, v: string): string {
  if (!v || !v.startsWith('v1.')) return v;
  try { return box.decrypt(PURPOSE, v); } catch { return ''; }
}

/** Einmalig beim Start: Titel aus Versionen vor 1.10.2 nachträglich verschlüsseln. */
export function sealLegacyTitles(db: Db, box: SecretBox): number {
  const rows = db.all<{ id: string; title: string }>("SELECT id, title FROM requests WHERE title NOT LIKE 'v1.%' AND title <> ?", PURGED_TITLE);
  for (const r of rows) db.run('UPDATE requests SET title = ? WHERE id = ?', sealTitle(box, r.title), r.id);
  // Freigewordene Seiten der Datenbankdatei enthalten sonst noch den alten Klartext
  if (rows.length) db.raw.exec('VACUUM');
  return rows.length;
}
