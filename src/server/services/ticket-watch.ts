// Benachrichtigung im Portal (Glocke), wenn in Zammad ein Bearbeiter auf ein Ticket antwortet.
//
// Der Worker fragt regelmäßig je Ticketsystem die seit dem letzten Mal geänderten Tickets ab (eine Abfrage),
// und nur für Tickets von Personen, die das Portal kennt, die Nachrichten. Benachrichtigt wird für
// öffentliche Antworten von Bearbeitern – nie für interne Notizen und nie rückwirkend vor dem Start.
import type { App } from '../app.ts';
import { log } from '../log.ts';
import { notify } from './notifications.ts';
import { connectorFor } from './systems.ts';
import { formatHtmlArticle, formatTextArticle } from './article-format.ts';
import type { SystemRow } from './systems.ts';

/** Überlappung, damit Änderungen kurz vor dem letzten Abruf (Uhren, Verzögerung) nicht verloren gehen */
const OVERLAP_MS = 2 * 60_000;
const MAX_TICKETS_PER_RUN = 100;

function snippet(contentType: string, body: string): string {
  const f = contentType.includes('html') ? formatHtmlArticle(body) : formatTextArticle(body);
  const text = f.blocks.filter((b) => b.t === 'text').map((b) => (b as { text: string }).text).join(' ').replace(/\s+/g, ' ').trim();
  return text.length > 200 ? `${text.slice(0, 197)} …` : text;
}

export async function watchSystem(app: App, sys: SystemRow, now = Date.now()): Promise<number> {
  let state = app.db.get<{ since: string; last_article_id: number; started_at: number }>('SELECT since, last_article_id, started_at FROM ticket_watch WHERE system_id = ?', sys.id);
  if (!state) {
    // Erster Lauf: ab jetzt beobachten
    app.db.run('INSERT INTO ticket_watch (system_id, since, last_article_id, started_at) VALUES (?, ?, 0, ?)', sys.id, new Date(now).toISOString(), now);
    return 0;
  }
  const conn = connectorFor(app, sys);
  const nextSince = new Date(now - OVERLAP_MS).toISOString();
  const changed = (await conn.ticketsUpdatedSince(state.since)).slice(0, MAX_TICKETS_PER_RUN);
  let maxArticle = state.last_article_id;
  let sent = 0;
  for (const t of changed) {
    const users = app.db.all<{ user_id: string }>(
      "SELECT z.user_id FROM zammad_customers z JOIN users u ON u.id = z.user_id WHERE z.system_id = ? AND z.customer_id = ? AND u.disabled = 0",
      sys.id, t.customerId,
    );
    if (!users.length) continue;
    const replies = (await conn.agentReplies(t.id)).filter((a) => a.id > state!.last_article_id && Date.parse(a.createdAt) >= state!.started_at);
    if (!replies.length) continue;
    for (const a of replies) maxArticle = Math.max(maxArticle, a.id);
    const latest = replies.reduce((x, y) => (y.id > x.id ? y : x));
    const more = replies.length > 1 ? ` (${replies.length} neue Nachrichten)` : '';
    for (const u of users) {
      notify(app, {
        to: { userId: u.user_id },
        kind: 'ticket.reply',
        title: `Neue Antwort: ${t.title}${more}`,
        body: snippet(latest.contentType, latest.body) || undefined,
        link: `/s/${sys.id}/tickets/${t.id}`,
      });
      sent++;
    }
  }
  app.db.run('UPDATE ticket_watch SET since = ?, last_article_id = ? WHERE system_id = ?', nextSince, maxArticle, sys.id);
  return sent;
}

/** Alle aktiven Ticketsysteme; Fehler eines Systems stören die anderen nicht. */
export async function watchTickets(app: App): Promise<number> {
  let sent = 0;
  for (const sys of app.db.all<SystemRow>("SELECT * FROM ticket_systems WHERE status = 'active'")) {
    try {
      sent += await watchSystem(app, sys);
    } catch (err) {
      log.warn('Neue Antworten nicht abrufbar', { system: sys.slug, error: (err as Error).message });
    }
  }
  return sent;
}
