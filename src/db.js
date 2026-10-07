'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'chat.db'));

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id         INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    email      TEXT NOT NULL UNIQUE,  -- sempre minuscola
    imported   INTEGER NOT NULL DEFAULT 0,  -- 1 = presente nella lista partecipanti
    is_admin   INTEGER NOT NULL DEFAULT 0,
    banned     INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL
  );

  -- type: 'public' (tutti), 'announce' (tutti leggono, solo admin scrivono),
  --       'group' (solo membri), 'dm' (due membri)
  CREATE TABLE IF NOT EXISTS conversations (
    id         INTEGER PRIMARY KEY,
    type       TEXT NOT NULL,
    name       TEXT,
    dm_key     TEXT UNIQUE,
    created_by INTEGER REFERENCES users(id),
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS members (
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (conversation_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS members_user ON members(user_id);

  CREATE TABLE IF NOT EXISTS messages (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    user_id         INTEGER NOT NULL REFERENCES users(id),
    text            TEXT NOT NULL,
    deleted         INTEGER NOT NULL DEFAULT 0,
    created_at      INTEGER NOT NULL,
    seq             INTEGER NOT NULL DEFAULT 0  -- cambia a ogni invio/cancellazione, usato dal polling
  );
  CREATE INDEX IF NOT EXISTS messages_conv ON messages(conversation_id, id);
  CREATE INDEX IF NOT EXISTS messages_seq ON messages(seq);

  CREATE TABLE IF NOT EXISTS reads (
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    last_read_id    INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, conversation_id)
  );
`);

// Canali di default, creati una sola volta.
function ensureDefaultChannels() {
  const count = db.prepare(`SELECT COUNT(*) AS n FROM conversations WHERE type IN ('public','announce')`).get().n;
  if (count > 0) return;
  const now = Date.now();
  const ins = db.prepare(`INSERT INTO conversations (type, name, created_at) VALUES (?, ?, ?)`);
  ins.run('announce', '📢 Annunci', now);
  ins.run('public', '🚢 Tutti a bordo', now);
}
ensureDefaultChannels();

module.exports = { db, DATA_DIR };
