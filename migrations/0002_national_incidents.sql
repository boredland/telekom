-- Nationwide service disruptions from https://www.telekom.com/de/newsroom/aktuelles/stoerungsuebersicht.
-- One row per episode of a service not being reported as fine; the latest status text is kept while it lasts.
CREATE TABLE national_incidents (
	id INTEGER PRIMARY KEY,
	service TEXT NOT NULL, -- as published, e.g. "MagentaZuhause"
	symbol TEXT NOT NULL, -- latest status symbol from the overview table
	description TEXT NOT NULL, -- latest status text
	first_seen INTEGER NOT NULL,
	last_seen INTEGER NOT NULL,
	resolved_at INTEGER
);

CREATE UNIQUE INDEX national_incidents_active ON national_incidents (service) WHERE resolved_at IS NULL;
CREATE INDEX national_incidents_started ON national_incidents (first_seen);
