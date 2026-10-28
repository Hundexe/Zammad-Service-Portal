-- foreign_keys=off
-- Freigabe durch Vorgesetzte: Anfragen warten vor der Zustellung auf eine Entscheidung.
-- Neue Status für requests (SQLite kann CHECK-Regeln nur durch Neuaufbau der Tabelle ändern).
CREATE TABLE requests_new (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  system_id TEXT NOT NULL REFERENCES ticket_systems(id),
  form_id TEXT NOT NULL,
  form_version_id TEXT NOT NULL,
  title TEXT NOT NULL,
  payload TEXT,
  status TEXT NOT NULL CHECK (status IN ('awaiting_approval', 'queued', 'sending', 'delivered', 'failed', 'rejected', 'withdrawn', 'expired')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  last_error TEXT,
  ticket_id INTEGER,
  ticket_number TEXT,
  created_at INTEGER NOT NULL,
  delivered_at INTEGER,
  purge_after INTEGER,
  -- Zeitpunkt, ab dem die Anfrage zur Zustellung bereitsteht (nach einer Freigabe später als created_at)
  queued_at INTEGER
);
INSERT INTO requests_new (id, user_id, system_id, form_id, form_version_id, title, payload, status, attempts, next_attempt_at, last_error,
                          ticket_id, ticket_number, created_at, delivered_at, purge_after, queued_at)
  SELECT id, user_id, system_id, form_id, form_version_id, title, payload, status, attempts, next_attempt_at, last_error,
         ticket_id, ticket_number, created_at, delivered_at, purge_after, created_at
    FROM requests;
DROP TABLE requests;
ALTER TABLE requests_new RENAME TO requests;
CREATE INDEX requests_user ON requests(user_id, created_at);
CREATE INDEX requests_queue ON requests(status, next_attempt_at);

CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE REFERENCES requests(id) ON DELETE CASCADE,
  approver_email TEXT NOT NULL COLLATE NOCASE,
  approver_name TEXT,
  -- Nur Personen, die sich schon einmal angemeldet haben (Einstellung des Formularfelds)
  known_only INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn', 'expired')),
  -- Verschlüsselt: Inhalt der Anfrage für die freigebende Person; wird nach der Entscheidung gelöscht
  summary TEXT,
  -- Verschlüsselt: Begründung bzw. Hinweis der freigebenden Person
  comment TEXT,
  decided_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  decided_by_name TEXT,
  decided_at INTEGER,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  reminded_at INTEGER
);
CREATE INDEX approvals_approver ON approvals(approver_email, status);
CREATE INDEX approvals_due ON approvals(status, expires_at);

-- Benachrichtigungen im Portal. Ziel ist ein Konto (user_id) oder eine E-Mail-Adresse
-- (freigebende Person, die vielleicht noch nie angemeldet war).
CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  email TEXT COLLATE NOCASE,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  link TEXT,
  created_at INTEGER NOT NULL,
  read_at INTEGER,
  CHECK (user_id IS NOT NULL OR email IS NOT NULL)
);
CREATE INDEX notifications_user ON notifications(user_id, created_at);
CREATE INDEX notifications_email ON notifications(email, created_at);
