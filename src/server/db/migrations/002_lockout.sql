-- Fortschreitende Kontosperre: jede weitere Sperre dauert doppelt so lang (bis 24 h).
ALTER TABLE users ADD COLUMN lock_count INTEGER NOT NULL DEFAULT 0;
