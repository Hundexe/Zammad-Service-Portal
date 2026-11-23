-- 2.0: Zammad ist die einzige Datenquelle für Freigaben, Störungen, Wartungen und Probleme.
-- Das Portal merkt sich nur noch, wie es Zammad abbildet (je Ticketsystem einstellbar), die Schlüssel der
-- Services in Zammad und welche Aufräumarbeiten in Zammad schon erledigt sind.
-- Die Tabellen aus 1.x (approvals, incidents, maintenances, problems …) bleiben für die Übernahme nach Zammad
-- stehen (CLI „zammad:migrate“) und werden nicht mehr beschrieben.
ALTER TABLE ticket_systems ADD COLUMN zammad_mapping TEXT NOT NULL DEFAULT '{}';
ALTER TABLE services ADD COLUMN zkey TEXT;
CREATE UNIQUE INDEX services_zkey ON services(system_id, zkey);

CREATE TABLE zammad_done (
  system_id TEXT NOT NULL REFERENCES ticket_systems(id) ON DELETE CASCADE,
  ticket_id INTEGER NOT NULL,
  -- z. B. „children_closed“ (Tickets der Betroffenen geschlossen), „maintenance_closed“, „approval_reminded“
  kind TEXT NOT NULL,
  done_at INTEGER NOT NULL,
  PRIMARY KEY (system_id, ticket_id, kind)
);

-- Übernahme der Daten aus 1.x nach Zammad (CLI „zammad:migrate“): was schon übernommen ist
CREATE TABLE legacy_migrated (
  kind TEXT NOT NULL CHECK (kind IN ('incident', 'maintenance', 'problem')),
  legacy_id TEXT NOT NULL,
  system_id TEXT NOT NULL,
  ticket_id INTEGER NOT NULL,
  migrated_at INTEGER NOT NULL,
  PRIMARY KEY (kind, legacy_id)
);
