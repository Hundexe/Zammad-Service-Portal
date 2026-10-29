-- Benachrichtigung bei Antworten aus Zammad: je Ticketsystem, bis wohin schon geschaut wurde.
-- started_at: ab hier wird benachrichtigt (ältere Antworten nie – kein Schwall nach der Einführung).
CREATE TABLE ticket_watch (
  system_id TEXT PRIMARY KEY REFERENCES ticket_systems(id) ON DELETE CASCADE,
  since TEXT NOT NULL,
  last_article_id INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL
);
