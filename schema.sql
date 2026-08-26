CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  cookie TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON sessions(updated_at);
