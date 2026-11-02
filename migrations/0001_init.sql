-- All timestamps are Unix epoch milliseconds.

CREATE TABLE lines (
	id TEXT PRIMARY KEY, -- base64url SHA-256 of "<areaCode>/<number>"; doesn't reveal the number in URLs
	area_code TEXT NOT NULL,
	number TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	last_viewed_at INTEGER NOT NULL,
	last_checked_at INTEGER,
	check_count INTEGER NOT NULL DEFAULT 0,
	error_count INTEGER NOT NULL DEFAULT 0,
	last_error TEXT
);

CREATE UNIQUE INDEX lines_number ON lines (area_code, number);

-- One row per outage episode. Telekom gives no IDs; an episode is keyed by the result page ID and text, so a changed
-- message (e.g. a new estimated repair time) ends one episode and starts the next.
CREATE TABLE faults (
	id INTEGER PRIMARY KEY,
	line_id TEXT NOT NULL REFERENCES lines (id) ON DELETE CASCADE,
	fault_key TEXT NOT NULL,
	page_id TEXT NOT NULL,
	text TEXT NOT NULL,
	first_seen INTEGER NOT NULL,
	last_seen INTEGER NOT NULL,
	missing_since INTEGER, -- absent in the latest check but not yet considered resolved
	resolved_at INTEGER
);

CREATE UNIQUE INDEX faults_active ON faults (line_id, fault_key) WHERE resolved_at IS NULL;
CREATE INDEX faults_line ON faults (line_id, first_seen);

CREATE TABLE subscriptions (
	id INTEGER PRIMARY KEY,
	line_id TEXT NOT NULL REFERENCES lines (id) ON DELETE CASCADE,
	kind TEXT NOT NULL CHECK (kind IN ('push', 'email')),
	target TEXT NOT NULL, -- push endpoint or email address
	p256dh TEXT,
	auth TEXT,
	token TEXT NOT NULL UNIQUE, -- confirm/unsubscribe capability
	confirmed_at INTEGER,
	created_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX subscriptions_target ON subscriptions (line_id, kind, target);
CREATE INDEX subscriptions_confirmed ON subscriptions (line_id) WHERE confirmed_at IS NOT NULL;
