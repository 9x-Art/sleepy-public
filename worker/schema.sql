-- 设定仓库 D1 schema（P0）
CREATE TABLE IF NOT EXISTS gates (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS authors (
  id TEXT PRIMARY KEY,
  token TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_authors_token ON authors(token);
CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  gate TEXT NOT NULL,
  type TEXT NOT NULL,          -- island | char | worldbook | preset | book | theme
  title TEXT NOT NULL,
  author TEXT NOT NULL,
  lock TEXT NOT NULL DEFAULT 'open',   -- open | blind
  version INTEGER NOT NULL DEFAULT 1,
  size INTEGER NOT NULL,
  downloads INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  body_key TEXT NOT NULL,
  author_id TEXT NOT NULL,
  status INTEGER NOT NULL DEFAULT 1    -- 1 架上 0 下架
);
CREATE INDEX IF NOT EXISTS idx_items_gate ON items(gate, status);
