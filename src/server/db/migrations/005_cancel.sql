-- foreign_keys=off
-- Anfragen lassen sich in der Verwaltung abbrechen (Status "cancelled"), auch während sie auf eine Freigabe warten.
CREATE TABLE requests_new (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  system_id TEXT NOT NULL REFERENCES ticket_systems(id),
  form_id TEXT NOT NULL,
  form_version_id TEXT NOT NULL,
  title TEXT NOT NULL,
  payload TEXT,
  status TEXT NOT NULL CHECK (status IN ('awaiting_approval', 'queued', 'sending', 'delivered', 'failed', 'rejected', 'withdrawn', 'expired', 'cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  last_error TEXT,
  ticket_id INTEGER,
  ticket_number TEXT,
  created_at INTEGER NOT NULL,
  delivered_at INTEGER,
  purge_after INTEGER,
  queued_at INTEGER
);
INSERT INTO requests_new SELECT id, user_id, system_id, form_id, form_version_id, title, payload, status, attempts, next_attempt_at, last_error,
                                ticket_id, ticket_number, created_at, delivered_at, purge_after, queued_at FROM requests;
DROP TABLE requests;
ALTER TABLE requests_new RENAME TO requests;
CREATE INDEX requests_user ON requests(user_id, created_at);
CREATE INDEX requests_queue ON requests(status, next_attempt_at);

CREATE TABLE approvals_new (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE REFERENCES requests(id) ON DELETE CASCADE,
  approver_email TEXT NOT NULL COLLATE NOCASE,
  approver_name TEXT,
  known_only INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn', 'expired', 'cancelled')),
  summary TEXT,
  comment TEXT,
  decided_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  decided_by_name TEXT,
  decided_at INTEGER,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  reminded_at INTEGER
);
INSERT INTO approvals_new SELECT id, request_id, approver_email, approver_name, known_only, status, summary, comment, decided_by, decided_by_name,
                                 decided_at, created_at, expires_at, reminded_at FROM approvals;
DROP TABLE approvals;
ALTER TABLE approvals_new RENAME TO approvals;
CREATE INDEX approvals_approver ON approvals(approver_email, status);
CREATE INDEX approvals_due ON approvals(status, expires_at);
