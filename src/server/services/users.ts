// Benutzerverwaltung: lokale Konten (mit generiertem Passwort) und Entra-Benutzer.
import type { Db } from '../db/db.ts';
import { parseJson, uuid } from '../db/db.ts';
import { generatePassword, hashPassword } from '../crypto.ts';
import { loadPermissions, type AuthUser } from './rbac.ts';

export interface UserRow {
  id: string;
  kind: 'entra' | 'local';
  entra_oid: string | null;
  tenant_id: string | null;
  username: string | null;
  email: string | null;
  display_name: string;
  department: string | null;
  password_hash: string | null;
  totp_secret: string | null;
  totp_enabled: number;
  totp_last_step: number | null;
  must_change_password: number;
  failed_logins: number;
  locked_until: number | null;
  lock_count: number;
  disabled: number;
  groups_json: string;
  created_at: number;
  last_login_at: number | null;
}

export function getUser(db: Db, id: string): UserRow | undefined {
  return db.get<UserRow>('SELECT * FROM users WHERE id = ?', id);
}

export function toAuthUser(db: Db, u: UserRow): AuthUser {
  const groups = parseJson<string[]>(u.groups_json, []);
  return {
    id: u.id,
    kind: u.kind,
    username: u.username,
    email: u.email,
    displayName: u.display_name,
    department: u.department,
    groups,
    totpEnabled: u.totp_enabled === 1,
    perms: loadPermissions(db, u.id, groups),
  };
}

export const USERNAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{1,63}$/;

export interface CreatedUser { id: string; username: string; password: string }

/** Legt ein lokales Konto mit generiertem Passwort an. Das Passwort muss bei der ersten Anmeldung geändert werden. */
export async function createLocalUser(
  db: Db,
  input: { username: string; displayName?: string; email?: string; department?: string; roleName?: string },
): Promise<CreatedUser> {
  if (!USERNAME_RE.test(input.username)) throw new Error('Benutzername: 2–64 Zeichen, a–z, 0–9, . _ -');
  if (db.get('SELECT 1 FROM users WHERE username = ?', input.username)) throw new Error('Benutzername ist schon vergeben');
  if (input.email?.trim() && emailInUse(db, input.email)) throw new Error('Diese E-Mail-Adresse gehört schon einem anderen Konto');
  const password = generatePassword(20);
  const hash = await hashPassword(password);
  const id = uuid();
  db.tx(() => {
    db.run(
      `INSERT INTO users (id, kind, username, email, display_name, department, password_hash, must_change_password, created_at)
       VALUES (?, 'local', ?, ?, ?, ?, ?, 1, ?)`,
      id, input.username, input.email?.trim() || null, input.displayName?.trim() || input.username,
      input.department?.trim() || null, hash, Date.now(),
    );
    if (input.roleName) {
      const role = db.get<{ id: string }>('SELECT id FROM roles WHERE name = ?', input.roleName);
      if (!role) throw new Error(`Rolle „${input.roleName}“ gibt es nicht`);
      db.run("INSERT INTO role_assignments (id, role_id, subject_type, subject_value, system_id, created_at) VALUES (?, ?, 'user', ?, NULL, ?)", uuid(), role.id, id, Date.now());
    }
  });
  return { id, username: input.username, password };
}

/** E-Mail-Adressen sind eindeutig – sonst könnte ein lokales Konto fremde Tickets in Zammad sehen. */
export function emailInUse(db: Db, email: string, exceptUserId?: string): boolean {
  return Boolean(db.get('SELECT 1 FROM users WHERE lower(email) = lower(?) AND id <> ?', email.trim(), exceptUserId ?? ''));
}

/** Setzt ein neues, generiertes Passwort und erzwingt die Änderung bei der nächsten Anmeldung. */
export async function resetLocalPassword(db: Db, userId: string, resetTotp = false): Promise<string> {
  const user = getUser(db, userId);
  if (!user || user.kind !== 'local') throw new Error('Kein lokales Konto');
  const password = generatePassword(20);
  const hash = await hashPassword(password);
  db.tx(() => {
    db.run('UPDATE users SET password_hash = ?, must_change_password = 1, failed_logins = 0, lock_count = 0, locked_until = NULL WHERE id = ?', hash, userId);
    if (resetTotp) db.run('UPDATE users SET totp_secret = NULL, totp_enabled = 0, totp_last_step = NULL WHERE id = ?', userId);
    db.run('DELETE FROM sessions WHERE user_id = ?', userId);
  });
  return password;
}

export interface EntraClaims {
  oid: string;
  tid: string;
  name?: string;
  email?: string;
  preferred_username?: string;
  groups?: string[];
  roles?: string[];
}

/**
 * Mail-Adresse eines Microsoft-Kontos nur übernehmen, wenn ihre Domain zum Tenant gehört. Über die Adresse
 * findet das Portal den Zammad-Kunden (alle Tickets) und Freigaben – das Graph-Attribut „mail“ kann der
 * Administrator eines Tenants aber beliebig setzen, auch auf Adressen eines anderen Tenants.
 *   allowed: erlaubte Domains (Konfiguration oder verifizierte Domains aus Graph), null = unbekannt
 *   singleTenant: nur ein Tenant erlaubt – dann ist dessen Administrator ohnehin vertrauenswürdig
 */
export function vetEntraEmail(email: string | null, allowed: string[] | null, singleTenant: boolean): { email: string | null; reason?: string } {
  if (!email) return { email: null };
  const domain = email.slice(email.lastIndexOf('@') + 1).toLowerCase();
  if (allowed === null) return singleTenant ? { email } : { email: null, reason: 'domains_unbekannt' };
  return allowed.includes(domain) ? { email } : { email: null, reason: 'fremde_domain' };
}

/** Legt einen Entra-Benutzer beim ersten Login an oder aktualisiert ihn. vet prüft die Mail-Adresse (siehe vetEntraEmail). */
export function upsertEntraUser(db: Db, c: EntraClaims, profile: { department?: string | null; mail?: string | null } = {}, vet: (email: string | null) => string | null = (e) => e): UserRow {
  const email = vet((profile.mail || c.email || c.preferred_username || '').toLowerCase() || null);
  const groups = [...(c.groups ?? []), ...(c.roles ?? []).map((r) => `approle:${r}`)];
  const existing = db.get<UserRow>('SELECT * FROM users WHERE entra_oid = ?', c.oid);
  const t = Date.now();
  if (existing) {
    db.run(
      'UPDATE users SET tenant_id = ?, email = ?, display_name = ?, department = COALESCE(?, department), groups_json = ?, last_login_at = ? WHERE id = ?',
      c.tid, email, c.name || email || existing.display_name, profile.department ?? null, JSON.stringify(groups), t, existing.id,
    );
    return getUser(db, existing.id)!;
  }
  const id = uuid();
  db.run(
    `INSERT INTO users (id, kind, entra_oid, tenant_id, email, display_name, department, groups_json, created_at, last_login_at)
     VALUES (?, 'entra', ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, c.oid, c.tid, email, c.name || email || 'Unbekannt', profile.department ?? null, JSON.stringify(groups), t, t,
  );
  return getUser(db, id)!;
}

export function publicUser(u: UserRow) {
  return {
    id: u.id,
    kind: u.kind,
    username: u.username,
    email: u.email,
    displayName: u.display_name,
    department: u.department,
    totpEnabled: u.totp_enabled === 1,
    mustChangePassword: u.must_change_password === 1,
    locked: Boolean(u.locked_until && u.locked_until > Date.now()),
    disabled: u.disabled === 1,
    createdAt: u.created_at,
    lastLoginAt: u.last_login_at,
  };
}
