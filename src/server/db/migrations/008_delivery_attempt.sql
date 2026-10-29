-- Zustellung: Zeitpunkt des ersten Versuchs, ein Ticket anzulegen. Danach wird vor jedem weiteren Versuch
-- (auch nach „Erneut senden“) in Zammad nach dem schon angelegten Ticket gesucht – keine Doppel-Tickets.
ALTER TABLE requests ADD COLUMN create_attempted_at INTEGER;
