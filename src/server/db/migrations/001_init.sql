-- Grundschema des Service-Portals (SQLite).
-- Zeiten sind Millisekunden seit 1970 (UTC), IDs sind UUIDs.

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('entra', 'local')),
  entra_oid TEXT UNIQUE,
  tenant_id TEXT,
  username TEXT UNIQUE COLLATE NOCASE,
  email TEXT COLLATE NOCASE,
  display_name TEXT NOT NULL,
  department TEXT,
  password_hash TEXT,
  totp_secret TEXT,
  totp_enabled INTEGER NOT NULL DEFAULT 0,
  totp_last_step INTEGER,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER,
  disabled INTEGER NOT NULL DEFAULT 0,
  groups_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  last_login_at INTEGER,
  CHECK (kind = 'entra' OR username IS NOT NULL)
);
CREATE INDEX users_email ON users(email);

CREATE TABLE sessions (
  id_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'mfa_pending', 'password_change', 'totp_setup')),
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  auth_time INTEGER NOT NULL,
  mfa INTEGER NOT NULL DEFAULT 0,
  ip TEXT,
  user_agent TEXT
);
CREATE INDEX sessions_user ON sessions(user_id);

CREATE TABLE ticket_systems (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'zammad' CHECK (type IN ('zammad')),
  base_url TEXT NOT NULL,
  api_token TEXT,
  default_group TEXT,
  creation_mode TEXT NOT NULL DEFAULT 'on_behalf_of' CHECK (creation_mode IN ('on_behalf_of', 'customer_field')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'maintenance', 'inactive')),
  visible_groups TEXT NOT NULL DEFAULT '[]',
  require_approval INTEGER NOT NULL DEFAULT 0,
  show_org_tickets INTEGER NOT NULL DEFAULT 0,
  allow_replies INTEGER NOT NULL DEFAULT 1,
  closed_states TEXT NOT NULL DEFAULT '["closed","merged","removed"]',
  portal_tag TEXT NOT NULL DEFAULT 'service-portal',
  -- Freigegebene Zammad-Ticket-Attribute: [{name, allowedValues|null}]
  released_attributes TEXT NOT NULL DEFAULT '[]',
  sort INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE branding_versions (
  id TEXT PRIMARY KEY,
  system_id TEXT NOT NULL REFERENCES ticket_systems(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  data TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'pending', 'published', 'archived')),
  created_by TEXT,
  created_at INTEGER NOT NULL,
  submitted_by TEXT,
  approved_by TEXT,
  published_at INTEGER,
  UNIQUE (system_id, version)
);

CREATE TABLE forms (
  id TEXT PRIMARY KEY,
  system_id TEXT NOT NULL REFERENCES ticket_systems(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '',
  visible_groups TEXT NOT NULL DEFAULT '[]',
  sort INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (system_id, slug)
);

CREATE TABLE form_versions (
  id TEXT PRIMARY KEY,
  form_id TEXT NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  definition TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'pending', 'published', 'archived')),
  note TEXT NOT NULL DEFAULT '',
  created_by TEXT,
  created_at INTEGER NOT NULL,
  submitted_by TEXT,
  approved_by TEXT,
  published_at INTEGER,
  UNIQUE (form_id, version)
);

CREATE TABLE templates (
  id TEXT PRIMARY KEY,
  system_id TEXT NOT NULL REFERENCES ticket_systems(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('title', 'body', 'success')),
  name TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT
);

CREATE TABLE overviews (
  id TEXT PRIMARY KEY,
  system_id TEXT NOT NULL REFERENCES ticket_systems(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  state_filter TEXT NOT NULL DEFAULT 'open' CHECK (state_filter IN ('open', 'closed', 'all')),
  columns TEXT NOT NULL DEFAULT '["number","title","state","updated_at"]',
  sort_by TEXT NOT NULL DEFAULT 'updated_at',
  sort_dir TEXT NOT NULL DEFAULT 'desc' CHECK (sort_dir IN ('asc', 'desc')),
  sort INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Zwischenspeicher der Zammad-Stammdaten (Gruppen, Status, Prioritäten, Ticket-Attribute)
CREATE TABLE system_metadata (
  system_id TEXT PRIMARY KEY REFERENCES ticket_systems(id) ON DELETE CASCADE,
  data TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
);

CREATE TABLE roles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  permissions TEXT NOT NULL DEFAULT '[]',
  builtin INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE role_assignments (
  id TEXT PRIMARY KEY,
  role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('user', 'group', 'all')),
  subject_value TEXT NOT NULL DEFAULT '',
  system_id TEXT REFERENCES ticket_systems(id) ON DELETE CASCADE,
  created_by TEXT,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX role_assignments_unique ON role_assignments(role_id, subject_type, subject_value, IFNULL(system_id, ''));

CREATE TABLE requests (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  system_id TEXT NOT NULL REFERENCES ticket_systems(id),
  form_id TEXT NOT NULL,
  form_version_id TEXT NOT NULL,
  title TEXT NOT NULL,
  payload TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued', 'sending', 'delivered', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  last_error TEXT,
  ticket_id INTEGER,
  ticket_number TEXT,
  created_at INTEGER NOT NULL,
  delivered_at INTEGER,
  purge_after INTEGER
);
CREATE INDEX requests_user ON requests(user_id, created_at);
CREATE INDEX requests_queue ON requests(status, next_attempt_at);

CREATE TABLE request_files (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  field_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  stored INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE zammad_customers (
  system_id TEXT NOT NULL REFERENCES ticket_systems(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  customer_id INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (system_id, user_id)
);

CREATE TABLE assets (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('logo', 'favicon')),
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  data BLOB NOT NULL,
  created_by TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Audit-Log: nur anhängen. Jede Zeile enthält den Hash der vorherigen Zeile,
-- so fällt eine nachträgliche Änderung direkt in der Datenbankdatei auf.
CREATE TABLE audit_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  actor_id TEXT,
  actor_name TEXT,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  system_id TEXT,
  details TEXT,
  ip TEXT,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);
CREATE INDEX audit_log_at ON audit_log(at);
CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log ist nur anhängbar'); END;
CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log ist nur anhängbar'); END;

CREATE TABLE update_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  current_version TEXT,
  latest_version TEXT,
  channel TEXT NOT NULL DEFAULT 'stable',
  available TEXT NOT NULL DEFAULT '[]',
  changelog TEXT NOT NULL DEFAULT '',
  checked_at INTEGER,
  last_error TEXT,
  updater_seen_at INTEGER
);
INSERT INTO update_state (id) VALUES (1);

CREATE TABLE update_jobs (
  id TEXT PRIMARY KEY,
  requested_by TEXT,
  requested_by_name TEXT,
  target_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('requested', 'running', 'succeeded', 'failed', 'rolled_back')),
  log TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER
);
