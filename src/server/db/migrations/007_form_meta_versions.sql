-- Vier-Augen-Prinzip: Name, Beschreibung, sichtbare Gruppen und Aktiv-Status eines Formulars gehen bei
-- Systemen mit Freigabepflicht über die nächste Version (JSON, NULL = keine Änderung) und gelten erst beim Veröffentlichen.
ALTER TABLE form_versions ADD COLUMN meta TEXT;
