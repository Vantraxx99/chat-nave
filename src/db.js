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

  -- Email abilitate a mano dagli organizzatori (oltre all'elenco partecipanti).
  CREATE TABLE IF NOT EXISTS allowed_emails (
    email      TEXT PRIMARY KEY,
    added_by   INTEGER REFERENCES users(id),
    created_at INTEGER NOT NULL
  );

  -- Iscrizioni alle notifiche push (una per dispositivo).
  CREATE TABLE IF NOT EXISTS push_subscriptions (
    endpoint   TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    p256dh     TEXT NOT NULL,
    auth       TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS push_user ON push_subscriptions(user_id);

  -- Pagina "Useful info" scritta dagli organizzatori.
  CREATE TABLE IF NOT EXISTS info (
    id         TEXT PRIMARY KEY,
    content    TEXT NOT NULL,
    updated_by INTEGER REFERENCES users(id),
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS reads (
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    last_read_id    INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, conversation_id)
  );
`);

// Risposte ai messaggi: colonna aggiunta anche ai database già esistenti.
if (!db.prepare(`PRAGMA table_info(messages)`).all().some((c) => c.name === 'reply_to')) {
  db.exec(`ALTER TABLE messages ADD COLUMN reply_to INTEGER`);
}

// Reazioni ai messaggi (una per persona, come su WhatsApp). In messages.reactions teniamo
// anche il conteggio già pronto ({"❤️":3}), così il polling manda pochi byte.
db.exec(`
  CREATE TABLE IF NOT EXISTS reactions (
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    emoji      TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (message_id, user_id)
  );
`);
if (!db.prepare(`PRAGMA table_info(messages)`).all().some((c) => c.name === 'reactions')) {
  db.exec(`ALTER TABLE messages ADD COLUMN reactions TEXT`);
}
// Profilo facoltativo (Instagram, città, due righe su di sé…), visibile agli altri partecipanti.
if (!db.prepare(`PRAGMA table_info(users)`).all().some((c) => c.name === 'profile')) {
  db.exec(`ALTER TABLE users ADD COLUMN profile TEXT`);
}

// Password scelta al primo accesso (hash scrypt): senza, chiunque conosca email e cognome
// di qualcuno potrebbe entrare al suo posto.
if (!db.prepare(`PRAGMA table_info(users)`).all().some((c) => c.name === 'password_hash')) {
  db.exec(`ALTER TABLE users ADD COLUMN password_hash TEXT`);
}

// Codici di verifica (OTP) mandati per email alla registrazione, oppure dati a voce da un
// organizzatore dopo un reset della password. Salviamo solo l'hash del codice.
db.exec(`
  CREATE TABLE IF NOT EXISTS codes (
    email      TEXT NOT NULL,
    kind       TEXT NOT NULL,           -- 'email' | 'staff': restano validi entrambi
    code_hash  TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    attempts   INTEGER NOT NULL DEFAULT 0,
    sent_at    INTEGER NOT NULL,
    sends      INTEGER NOT NULL DEFAULT 1, -- invii nell'ultima ora
    PRIMARY KEY (email, kind)
  );
`);

// "Elimina chat" per una persona sola: nasconde i messaggi fino a cleared_id (la chat torna
// nella lista quando arriva un messaggio nuovo). Gli altri continuano a vedere tutto.
db.exec(`
  CREATE TABLE IF NOT EXISTS cleared (
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    cleared_id      INTEGER NOT NULL,
    PRIMARY KEY (user_id, conversation_id)
  );
`);

// Unico canale di default: gli Annunci degli organizzatori. Per il resto i
// partecipanti si creano i loro gruppi.
function ensureDefaultChannels() {
  // Il vecchio canale generale "Tutti a bordo" (creato dal sistema) non esiste più.
  db.prepare(`DELETE FROM conversations WHERE type = 'public' AND name = '🚢 Tutti a bordo' AND created_by IS NULL`).run();
  // L'app è in inglese: il canale si chiama "Announcements".
  db.prepare(`UPDATE conversations SET name = '📢 Announcements' WHERE type = 'announce' AND created_by IS NULL AND name = '📢 Annunci'`).run();
  const count = db.prepare(`SELECT COUNT(*) AS n FROM conversations WHERE type = 'announce' AND created_by IS NULL`).get().n;
  if (count > 0) return;
  db.prepare(`INSERT INTO conversations (type, name, created_at) VALUES ('announce', '📢 Announcements', ?)`).run(Date.now());
}
ensureDefaultChannels();

module.exports = { db, DATA_DIR };
