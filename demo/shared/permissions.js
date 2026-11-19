// Einzelrechte des Portals. Rollen sind Bündel dieser Rechte.
// "global" = Recht gilt nur ohne Einschränkung auf ein Ticketsystem.

                                                                                                

export const PERMISSIONS                   = [
  { key: 'portal.use', label: 'Anfragen stellen und eigene Tickets sehen', admin: false },
  { key: 'system.manage', label: 'Ticketsystem verbinden und konfigurieren', admin: true },
  { key: 'form.edit', label: 'Formulare und Felder entwerfen', admin: true },
  { key: 'form.publish', label: 'Formulare veröffentlichen', admin: true },
  { key: 'form.approve', label: 'Veröffentlichungen freigeben (Vier-Augen)', admin: true },
  { key: 'template.edit', label: 'Vorlagen bearbeiten', admin: true },
  { key: 'overview.edit', label: 'Übersichten bearbeiten', admin: true },
  { key: 'branding.edit', label: 'Farben, Logos und Texte bearbeiten', admin: true },
  { key: 'attribute.release', label: 'Zammad-Objekte (Ticket-Attribute) für das Portal freigeben', admin: true },
  { key: 'status.manage', label: 'Services, Störungen und Wartungen verwalten', admin: true },
  { key: 'problem.manage', label: 'Probleme verwalten (Ursache, Workaround, verknüpfte Tickets)', admin: true },
  { key: 'audit.read', label: 'Audit-Log lesen', admin: true },
  { key: 'role.manage', label: 'Rollen und Zuordnungen verwalten', global: true, admin: true },
  { key: 'user.manage', label: 'Lokale Benutzer verwalten', global: true, admin: true },
  { key: 'update.read', label: 'Update-Status sehen', global: true, admin: true },
  { key: 'update.install', label: 'Updates installieren', global: true, admin: true },
  { key: 'settings.manage', label: 'Globale Einstellungen ändern', global: true, admin: true },
];

export const PERMISSION_KEYS = PERMISSIONS.map((p) => p.key);
export const ADMIN_PERMISSIONS = PERMISSIONS.filter((p) => p.admin).map((p) => p.key);
export const GLOBAL_PERMISSIONS = PERMISSIONS.filter((p) => p.global).map((p) => p.key);

/** Rechte, für die eine frische Anmeldung (Step-up) nötig ist. */
export const STEPUP_PERMISSIONS = ['update.install', 'role.manage', 'user.manage', 'system.manage'];
