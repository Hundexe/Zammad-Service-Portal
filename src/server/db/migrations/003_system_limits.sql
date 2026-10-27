-- Pro Ticketsystem: Zammad-Gruppen, in die das Portal Tickets anlegen darf (leer = keine Einschränkung),
-- und ob Namen der Mitarbeitenden im Ticketverlauf ausgeblendet werden.
ALTER TABLE ticket_systems ADD COLUMN allowed_groups TEXT NOT NULL DEFAULT '[]';
ALTER TABLE ticket_systems ADD COLUMN hide_agent_names INTEGER NOT NULL DEFAULT 0;
