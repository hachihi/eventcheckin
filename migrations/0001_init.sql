CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  event_date TEXT,
  venue TEXT,
  logo_url TEXT,
  banner_url TEXT,
  primary_color TEXT DEFAULT '#b89454',
  welcome_title TEXT DEFAULT 'Chào mừng Quý khách',
  welcome_message TEXT DEFAULT 'Cảm ơn bạn đã tham dự sự kiện',
  allow_walkin INTEGER DEFAULT 1,
  allow_repeat INTEGER DEFAULT 0,
  active INTEGER DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS attendees (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL,
  full_name TEXT NOT NULL,
  attendee_code TEXT,
  email TEXT,
  phone TEXT,
  company TEXT,
  position TEXT,
  photo_key TEXT,
  photo_url TEXT,
  registration_source TEXT DEFAULT 'manual',
  created_at TEXT NOT NULL,
  UNIQUE(event_id,email)
);
CREATE TABLE IF NOT EXISTS checkins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL,
  attendee_id INTEGER,
  full_name TEXT NOT NULL,
  email TEXT,
  company TEXT,
  checkin_time TEXT NOT NULL,
  machine TEXT,
  gmail TEXT,
  source TEXT NOT NULL,
  result TEXT NOT NULL DEFAULT 'success',
  photo_key TEXT,
  photo_url TEXT,
  raw_json TEXT
);
CREATE TABLE IF NOT EXISTS sync_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  checkin_id INTEGER NOT NULL UNIQUE,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER DEFAULT 0,
  next_try INTEGER DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS login_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT,
  ip TEXT,
  created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_attendees_event_email ON attendees(event_id,email);
CREATE INDEX IF NOT EXISTS idx_attendees_event_name ON attendees(event_id,full_name);
CREATE INDEX IF NOT EXISTS idx_attendees_event_code ON attendees(event_id,attendee_code);
CREATE INDEX IF NOT EXISTS idx_checkins_event_id ON checkins(event_id,id);
CREATE INDEX IF NOT EXISTS idx_checkins_event_time ON checkins(event_id,checkin_time);
CREATE INDEX IF NOT EXISTS idx_sync_outbox_pending ON sync_outbox(status,next_try);
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
