-- Service-Status, Störungen, Wartungen und Probleme (Funktionen, einzeln schaltbar).
-- Zammad bleibt das führende System für Tickets: Verknüpfungen zu Tickets stehen dort als Tag
-- (inc-0001, prb-0001); hier liegt nur, was das Portal anzeigt und wer sich als betroffen gemeldet hat.

CREATE TABLE services (
  id TEXT PRIMARY KEY,
  system_id TEXT NOT NULL REFERENCES ticket_systems(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  -- von Hand gesetzter Zustand (NULL = nur aus Störungen und Wartungen)
  manual_status TEXT CHECK (manual_status IN ('maintenance', 'degraded', 'partial_outage', 'major_outage')),
  manual_note TEXT NOT NULL DEFAULT '',
  sort INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX services_system ON services(system_id, sort);

CREATE TABLE problems (
  id TEXT PRIMARY KEY,
  number INTEGER NOT NULL UNIQUE,
  system_id TEXT NOT NULL REFERENCES ticket_systems(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('open', 'analysis', 'known_error', 'resolved', 'closed')),
  service_id TEXT REFERENCES services(id) ON DELETE SET NULL,
  description TEXT NOT NULL DEFAULT '',
  root_cause TEXT NOT NULL DEFAULT '',
  workaround TEXT NOT NULL DEFAULT '',
  -- als bekannter Fehler mit Workaround im Portal zeigen
  public INTEGER NOT NULL DEFAULT 0,
  owner TEXT NOT NULL DEFAULT '',
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX problems_system ON problems(system_id, state);

CREATE TABLE problem_tickets (
  problem_id TEXT NOT NULL REFERENCES problems(id) ON DELETE CASCADE,
  ticket_id INTEGER NOT NULL,
  ticket_number TEXT NOT NULL,
  added_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (problem_id, ticket_id)
);

CREATE TABLE incidents (
  id TEXT PRIMARY KEY,
  number INTEGER NOT NULL UNIQUE,
  system_id TEXT NOT NULL REFERENCES ticket_systems(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  impact TEXT NOT NULL CHECK (impact IN ('degraded', 'partial_outage', 'major_outage')),
  -- große Störung: Banner auf allen Seiten des Portals
  major INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL CHECK (state IN ('investigating', 'identified', 'monitoring', 'resolved')),
  locations TEXT NOT NULL DEFAULT '[]',
  started_at INTEGER NOT NULL,
  resolved_at INTEGER,
  -- führendes Ticket in Zammad (optional)
  zammad_ticket_id INTEGER,
  zammad_ticket_number TEXT,
  problem_id TEXT REFERENCES problems(id) ON DELETE SET NULL,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX incidents_system ON incidents(system_id, state);

CREATE TABLE incident_services (
  incident_id TEXT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  PRIMARY KEY (incident_id, service_id)
);

CREATE TABLE incident_updates (
  id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  state TEXT NOT NULL,
  body TEXT NOT NULL,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX incident_updates_incident ON incident_updates(incident_id, created_at);

CREATE TABLE incident_affected (
  incident_id TEXT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (incident_id, user_id)
);

CREATE TABLE maintenances (
  id TEXT PRIMARY KEY,
  system_id TEXT NOT NULL REFERENCES ticket_systems(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL,
  locations TEXT NOT NULL DEFAULT '[]',
  cancelled INTEGER NOT NULL DEFAULT 0,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (ends_at > starts_at)
);
CREATE INDEX maintenances_system ON maintenances(system_id, ends_at);

CREATE TABLE maintenance_services (
  maintenance_id TEXT NOT NULL REFERENCES maintenances(id) ON DELETE CASCADE,
  service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  PRIMARY KEY (maintenance_id, service_id)
);
