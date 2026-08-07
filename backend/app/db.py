"""aiosqlite connection helper + schema initialization."""

import aiosqlite

SCHEMA = """
CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY,
  content_hash TEXT UNIQUE NOT NULL,
  title TEXT, source_url TEXT, page_count INTEGER,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS highlights (
  id INTEGER PRIMARY KEY,
  document_id INTEGER NOT NULL REFERENCES documents(id),
  type TEXT NOT NULL CHECK(type IN ('text','region')),
  page_number INTEGER NOT NULL,
  quoted_text TEXT, prefix_context TEXT, suffix_context TEXT,
  rects_json TEXT,
  anchor_status TEXT CHECK(anchor_status IN ('pending','resolved','stale')),
  difficulty INTEGER,
  bbox_json TEXT,
  crop_image_path TEXT,
  reason TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  highlight_id INTEGER NOT NULL REFERENCES highlights(id),
  role TEXT NOT NULL CHECK(role IN ('user','assistant')),
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  provider TEXT, api_key_enc TEXT, base_url TEXT, model TEXT, vision_model TEXT,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_highlights_document ON highlights(document_id);
CREATE INDEX IF NOT EXISTS idx_messages_highlight ON messages(highlight_id, created_at);
"""


async def init_db(db: aiosqlite.Connection) -> None:
    await db.executescript(SCHEMA)
    await db.commit()


async def connect(db_path: str) -> aiosqlite.Connection:
    db = await aiosqlite.connect(db_path)
    db.row_factory = aiosqlite.Row
    await db.execute("PRAGMA foreign_keys = ON")
    await init_db(db)
    return db
