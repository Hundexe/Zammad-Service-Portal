// Benachrichtigungen. Jede Nachricht landet im Posteingang des Portals (Glocke oben rechts).
// Weitere Kanäle (z. B. später E-Mail) lassen sich über registerChannel() anhängen, ohne die
// Stellen zu ändern, die benachrichtigen. Das Portal selbst verschickt derzeit keine E-Mails.
import type { App } from '../app.ts';
import { uuid } from '../db/db.ts';
import { log } from '../log.ts';
import type { AuthUser } from './rbac.ts';
import { localEmailTaken } from './requests.ts';

export type NotificationKind =
  | 'approval.requested' | 'approval.reminder' | 'approval.approved' | 'approval.rejected'
  | 'approval.expired' | 'approval.withdrawn' | 'approval.reassigned';

export interface NotificationInput {
  /** Empfänger: Konto oder E-Mail-Adresse (für Personen, die vielleicht noch nie angemeldet waren) */
  to: { userId: string } | { email: string };
  kind: NotificationKind;
  title: string;
  body?: string;
  /** Pfad im Portal, z. B. /freigaben/<id> */
  link?: string;
}

export interface StoredNotification extends NotificationInput { id: string; createdAt: number }

/** Zusätzlicher Zustellweg. Fehler eines Kanals stören weder andere Kanäle noch den Ablauf. */
export interface NotificationChannel {
  name: string;
  deliver(app: App, n: StoredNotification): void | Promise<void>;
}

const channels: NotificationChannel[] = [];

export function registerChannel(c: NotificationChannel): () => void {
  channels.push(c);
  return () => { const i = channels.indexOf(c); if (i >= 0) channels.splice(i, 1); };
}

export function notify(app: App, n: NotificationInput): string {
  const id = uuid();
  const createdAt = Date.now();
  const userId = 'userId' in n.to ? n.to.userId : null;
  const email = 'email' in n.to ? n.to.email.toLowerCase() : null;
  app.db.run(
    'INSERT INTO notifications (id, user_id, email, kind, title, body, link, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    id, userId, email, n.kind, n.title.slice(0, 300), n.body?.slice(0, 1000) ?? null, n.link ?? null, createdAt,
  );
  for (const c of channels) {
    try {
      void Promise.resolve(c.deliver(app, { ...n, id, createdAt })).catch((err) => log.warn('Benachrichtigung nicht zugestellt', { channel: c.name, error: (err as Error).message }));
    } catch (err) {
      log.warn('Benachrichtigung nicht zugestellt', { channel: c.name, error: (err as Error).message });
    }
  }
  return id;
}

/**
 * Bedingung für "meine" Benachrichtigungen. Nachrichten an eine E-Mail-Adresse sieht nur, wem die Adresse
 * wirklich gehört: ein lokales Konto mit der Adresse eines Microsoft-Kontos bekommt sie nicht.
 */
function mine(app: App, user: AuthUser): { where: string; params: string[] } {
  const byMail = user.email && !localEmailTaken(app, user.id, user.email);
  return byMail
    ? { where: '(user_id = ? OR (user_id IS NULL AND email = ?))', params: [user.id, user.email!.toLowerCase()] }
    : { where: 'user_id = ?', params: [user.id] };
}

export function listNotifications(app: App, user: AuthUser, limit = 50) {
  const m = mine(app, user);
  return app.db.all<{ id: string; kind: string; title: string; body: string | null; link: string | null; created_at: number; read_at: number | null }>(
    `SELECT id, kind, title, body, link, created_at, read_at FROM notifications WHERE ${m.where} ORDER BY created_at DESC LIMIT ?`,
    ...m.params, limit,
  ).map((n) => ({ id: n.id, kind: n.kind, title: n.title, body: n.body, link: n.link, createdAt: n.created_at, read: n.read_at !== null }));
}

export function unreadCount(app: App, user: AuthUser): number {
  const m = mine(app, user);
  return app.db.get<{ n: number }>(`SELECT COUNT(*) n FROM notifications WHERE ${m.where} AND read_at IS NULL`, ...m.params)!.n;
}

/** Markiert Benachrichtigungen als gelesen (ohne ids: alle). Fremde ids werden still übergangen. */
export function markRead(app: App, user: AuthUser, ids?: string[]): number {
  const m = mine(app, user);
  const t = Date.now();
  if (!ids) return app.db.run(`UPDATE notifications SET read_at = ? WHERE ${m.where} AND read_at IS NULL`, t, ...m.params).changes;
  let n = 0;
  for (const id of ids.slice(0, 200)) n += app.db.run(`UPDATE notifications SET read_at = ? WHERE id = ? AND ${m.where} AND read_at IS NULL`, t, id, ...m.params).changes;
  return n;
}

/** Benachrichtigungen zu einem Vorgang als gelesen markieren, z. B. wenn die Freigabe geöffnet wurde. */
export function markReadByLink(app: App, user: AuthUser, link: string): void {
  const m = mine(app, user);
  app.db.run(`UPDATE notifications SET read_at = ? WHERE link = ? AND ${m.where} AND read_at IS NULL`, Date.now(), link, ...m.params);
}

/** Alte Benachrichtigungen entfernen (90 Tage). */
export function purgeNotifications(app: App, days = 90): number {
  return app.db.run('DELETE FROM notifications WHERE created_at < ?', Date.now() - days * 86400_000).changes;
}
