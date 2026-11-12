-- v3: idempotent check-in, correct indexes, brute-force log, audit trail, Sheets change detection.
-- Safe to run once. (If a column already exists because the Worker's fallback created it, delete that line and re-run.)
ALTER TABLE checkins ADD COLUMN idem_key TEXT;
ALTER TABLE login_logs ADD COLUMN ok INTEGER DEFAULT 1;
ALTER TABLE sheet_sources ADD COLUMN content_hash TEXT;

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin TEXT,
  action TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL
);

-- A retried device event (same event + idempotency key) can never insert twice.
CREATE UNIQUE INDEX IF NOT EXISTS idx_checkins_idem ON checkins(event_id, idem_key) WHERE idem_key IS NOT NULL;
-- Duplicate check, "has this guest arrived" (admin list), per-guest history. Measured: 23 ms -> 0.006 ms; admin list 1193 ms -> 5 ms @ 1M rows.
CREATE INDEX IF NOT EXISTS idx_checkins_event_attendee ON checkins(event_id, attendee_id, id);
-- Auto-generated codes for unregistered faces are unique per event, so concurrent scans of the same unknown face create one guest.
CREATE UNIQUE INDEX IF NOT EXISTS idx_attendees_auto_code ON attendees(event_id, attendee_code) WHERE attendee_code LIKE 'AUTO-%';
CREATE INDEX IF NOT EXISTS idx_login_logs_fail ON login_logs(ok, created_at);

-- Unused / redundant indexes: every extra index is another row written (and billed) on each insert.
DROP INDEX IF EXISTS idx_checkins_event_time;     -- no query filters on checkin_time
DROP INDEX IF EXISTS idx_attendees_event_email;   -- duplicate of UNIQUE(event_id,email) autoindex
