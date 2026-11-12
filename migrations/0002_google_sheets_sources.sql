CREATE TABLE IF NOT EXISTS sheet_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL UNIQUE,
  spreadsheet_id TEXT NOT NULL,
  gid TEXT NOT NULL DEFAULT '0',
  sheet_url TEXT NOT NULL,
  last_sync_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL
);
