// Rollenbasierte Rechte. Eine Zuordnung verbindet eine Rolle mit einem Benutzer,
// einer Entra-Gruppe oder "allen" – entweder global oder für ein Ticketsystem.
import type { Db } from '../db/db.ts';
import { parseJson, uuid } from '../db/db.ts';
import { GLOBAL_PERMISSIONS, ADMIN_PERMISSIONS, PERMISSION_KEYS } from '../../shared/permissions.ts';

export interface Permissions {
  global: Set<string>;
  bySystem: Map<string, Set<string>>;
}

export interface AuthUser {
  id: string;
  kind: 'entra' | 'local';
  username: string | null;
  email: string | null;
  displayName: string;
  department: string | null;
  groups: string[];
  totpEnabled: boolean;
  perms: Permissions;
}

export function loadPermissions(db: Db, userId: string, groups: string[]): Permissions {
  const rows = db.all<{ permissions: string; system_id: string | null; subject_type: string; subject_value: string }>(
    `SELECT r.permissions, a.system_id, a.subject_type, a.subject_value
       FROM role_assignments a JOIN roles r ON r.id = a.role_id`,
  );
  const groupSet = new Set(groups.map((g) => g.toLowerCase()));
  const perms: Permissions = { global: new Set(), bySystem: new Map() };
  for (const r of rows) {
    const applies =
      r.subject_type === 'all' ||
      (r.subject_type === 'user' && r.subject_value === userId) ||
      (r.subject_type === 'group' && groupSet.has(r.subject_value.toLowerCase()));
    if (!applies) continue;
    const list = parseJson<string[]>(r.permissions, []).filter((p) => PERMISSION_KEYS.includes(p) || p === '*');
    const expanded = list.includes('*') ? PERMISSION_KEYS : list;
    if (r.system_id === null) {
      expanded.forEach((p) => perms.global.add(p));
    } else {
      const set = perms.bySystem.get(r.system_id) ?? new Set<string>();
      // Globale Rechte (z. B. Rollenverwaltung) wirken nie über eine Zuordnung an ein einzelnes System.
      expanded.filter((p) => !GLOBAL_PERMISSIONS.includes(p)).forEach((p) => set.add(p));
      perms.bySystem.set(r.system_id, set);
    }
  }
  return perms;
}

export function can(user: AuthUser | undefined, perm: string, systemId?: string | null): boolean {
  if (!user) return false;
  if (user.perms.global.has(perm)) return true;
  if (GLOBAL_PERMISSIONS.includes(perm)) return false;
  if (systemId) return user.perms.bySystem.get(systemId)?.has(perm) ?? false;
  return false;
}

/** Hat das Recht für irgendein System (für Menüs und Listen). */
export function canAnywhere(user: AuthUser | undefined, perm: string): boolean {
  if (!user) return false;
  if (user.perms.global.has(perm)) return true;
  for (const set of user.perms.bySystem.values()) if (set.has(perm)) return true;
  return false;
}

/** Systeme, für die der Benutzer ein Recht hat. null = alle. */
export function systemsWith(user: AuthUser, perm: string): string[] | null {
  if (user.perms.global.has(perm)) return null;
  return [...user.perms.bySystem.entries()].filter(([, s]) => s.has(perm)).map(([id]) => id);
}

export function isAdmin(user: AuthUser | undefined): boolean {
  return ADMIN_PERMISSIONS.some((p) => canAnywhere(user, p));
}

export function permissionsForClient(user: AuthUser): { global: string[]; bySystem: Record<string, string[]> } {
  return {
    global: [...user.perms.global],
    bySystem: Object.fromEntries([...user.perms.bySystem.entries()].map(([k, v]) => [k, [...v]])),
  };
}

export const BUILTIN_ROLES: { name: string; description: string; permissions: string[] }[] = [
  { name: 'Super-Admin', description: 'Alle Rechte für alle Ticketsysteme', permissions: ['*'] },
  { name: 'Ziel-Admin', description: 'Verwaltet ein Ticketsystem vollständig', permissions: ['system.manage', 'form.edit', 'form.publish', 'form.approve', 'template.edit', 'overview.edit', 'branding.edit', 'attribute.release', 'status.manage', 'problem.manage', 'audit.read'] },
  { name: 'Service-Desk', description: 'Pflegt Services, Störungen, Wartungen und Probleme', permissions: ['status.manage', 'problem.manage'] },
  { name: 'Formular-Editor', description: 'Entwirft Formulare und Vorlagen, veröffentlicht nicht selbst', permissions: ['form.edit', 'template.edit'] },
  { name: 'Branding-Editor', description: 'Farben, Logos und Texte', permissions: ['branding.edit'] },
  { name: 'Objekt-Freigabe', description: 'Gibt Zammad-Objekte (Ticket-Attribute) und ihre Werte für das Portal frei', permissions: ['attribute.release'] },
  { name: 'Auditor', description: 'Liest Audit-Log und Update-Status, ändert nichts', permissions: ['audit.read', 'update.read'] },
  { name: 'Benutzer', description: 'Anfragen stellen und eigene Tickets sehen', permissions: ['portal.use'] },
];

/** Legt die eingebauten Rollen an und gibt allen angemeldeten Benutzern die Rolle "Benutzer". */
export function ensureBuiltinRoles(db: Db): void {
  for (const r of BUILTIN_ROLES) {
    const existing = db.get<{ id: string }>('SELECT id FROM roles WHERE name = ?', r.name);
    if (existing) {
      db.run('UPDATE roles SET permissions = ?, description = ?, builtin = 1 WHERE id = ?', JSON.stringify(r.permissions), r.description, existing.id);
    } else {
      db.run('INSERT INTO roles (id, name, description, permissions, builtin) VALUES (?, ?, ?, ?, 1)', uuid(), r.name, r.description, JSON.stringify(r.permissions));
    }
  }
  const userRole = db.get<{ id: string }>("SELECT id FROM roles WHERE name = 'Benutzer'")!;
  const seeded = db.get("SELECT value FROM settings WHERE key = 'seed.all_users_role'");
  if (!seeded) {
    db.run("INSERT OR IGNORE INTO role_assignments (id, role_id, subject_type, subject_value, system_id, created_at) VALUES (?, ?, 'all', '', NULL, ?)", uuid(), userRole.id, Date.now());
    db.run("INSERT INTO settings (key, value) VALUES ('seed.all_users_role', '1')");
  }
}
