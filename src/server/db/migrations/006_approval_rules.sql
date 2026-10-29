-- Freigabe durch Vorgesetzte: erlaubte Entra-Gruppen für die freigebende Person (JSON-Liste, NULL = alle)
-- und Zahl der Wechsel der freigebenden Person (begrenzt, die Frist läuft ab Erstellung).
ALTER TABLE approvals ADD COLUMN approver_groups TEXT;
ALTER TABLE approvals ADD COLUMN reassign_count INTEGER NOT NULL DEFAULT 0;
