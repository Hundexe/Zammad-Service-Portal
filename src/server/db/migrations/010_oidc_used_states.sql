-- Microsoft-Anmeldung: verwendete Einmalwerte (state, gehasht) bis zu ihrem Ablauf sperren.
-- Ein abgefangenes Transaktions-Cookie samt state lässt sich so nicht ein zweites Mal einlösen.
CREATE TABLE oidc_used_states (
  state_hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
CREATE INDEX oidc_used_states_exp ON oidc_used_states (expires_at);
