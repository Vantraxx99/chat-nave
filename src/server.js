'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const os = require('node:os');
const { monitorEventLoopDelay } = require('node:perf_hooks');
const { db, DATA_DIR } = require('./db');
const { normalizeEmail, isValidEmail, cleanName, surnameMatches } = require('./identity');
const { hashEmail, loadHashes } = require('./allowlist');
const push = require('./push');
const mail = require('./mail');

const PORT = Number(process.env.PORT) || 3000;
const normalizeCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
// Codice evento facoltativo, richiesto solo a chi si registra per la prima volta.
const JOIN_CODE = process.env.JOIN_CODE ? normalizeCode(process.env.JOIN_CODE) : null;
// Chi può registrarsi: se esiste l'elenco partecipanti (partecipanti.sha256) o
// SOLO_ISCRITTI=1, solo le email in elenco, quelle importate, quelle abilitate dagli
// organizzatori e gli organizzatori stessi. SOLO_ISCRITTI=0 apre a tutti.
const PARTICIPANT_HASHES = loadHashes();
const LIST_ONLY = process.env.SOLO_ISCRITTI === '1' || (process.env.SOLO_ISCRITTI !== '0' && PARTICIPANT_HASHES.size > 0);
// Email degli organizzatori: diventano admin quando entrano.
// Arrivano dal file organizzatori.txt (una per riga) e dalla variabile ADMIN_EMAILS (separate da virgola).
function loadAdminEmails() {
  let fromFile = '';
  try { fromFile = fs.readFileSync(path.join(__dirname, '..', 'organizzatori.txt'), 'utf8'); } catch {}
  const lines = fromFile.split('\n').filter((l) => !l.trim().startsWith('#'));
  return new Set([...lines, ...String(process.env.ADMIN_EMAILS || '').split(',')].map(normalizeEmail).filter(Boolean));
}
const ADMIN_EMAILS = loadAdminEmails();
// Iscrizioni chiuse (finché un organizzatore non le apre dal menu): possono creare un account
// solo gli organizzatori, le email di accesso-anticipato.txt e quelle abilitate a mano dagli
// organizzatori. Chi ha già un account entra sempre.
function loadEarlyEmails() {
  let txt = '';
  try { txt = fs.readFileSync(path.join(__dirname, '..', 'accesso-anticipato.txt'), 'utf8'); } catch {}
  return new Set(txt.split('\n').filter((l) => !l.trim().startsWith('#')).map(normalizeEmail).filter(Boolean));
}
const EARLY_EMAILS = loadEarlyEmails();
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const POLL_TIMEOUT_MS = 25_000; // sotto i 30s tipici dei proxy
const MAX_TEXT = 1000;
const MAX_BODY = 16 * 1024;
const COOKIE = 'nave_session';
const SECURE_COOKIE = process.env.SECURE_COOKIE !== '0';

// ---------------------------------------------------------------------------
// Sequenza globale: ogni messaggio nuovo o cancellato prende un seq crescente.
// I client fanno long-polling chiedendo "tutto ciò che ha seq > X".
// ---------------------------------------------------------------------------
let seq = db.prepare(`SELECT COALESCE(MAX(seq), 0) AS s FROM messages`).get().s;

const q = {
  userByEmail: db.prepare(`SELECT * FROM users WHERE email = ?`),
  userById: db.prepare(`SELECT id, name, is_admin, banned FROM users WHERE id = ?`),
  userProfile: db.prepare(`SELECT id, name, is_admin, profile FROM users WHERE id = ?`),
  userEmail: db.prepare(`SELECT email FROM users WHERE id = ?`),
  passwordHash: db.prepare(`SELECT password_hash FROM users WHERE id = ?`),
  getCode: db.prepare(`SELECT * FROM codes WHERE email = ? AND kind = ?`),
  codesFor: db.prepare(`SELECT * FROM codes WHERE email = ?`),
  saveCode: db.prepare(`
    INSERT INTO codes (email, kind, code_hash, expires_at, attempts, sent_at, sends) VALUES (?, ?, ?, ?, 0, ?, ?)
    ON CONFLICT(email, kind) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at,
      attempts = 0, sent_at = excluded.sent_at, sends = excluded.sends`),
  codeAttempt: db.prepare(`UPDATE codes SET attempts = attempts + 1 WHERE email = ? AND kind = ?`),
  deleteCodes: db.prepare(`DELETE FROM codes WHERE email = ?`),
  deleteCode: db.prepare(`DELETE FROM codes WHERE email = ? AND kind = ?`),
  insertUser: db.prepare(`INSERT INTO users (name, email, created_at) VALUES (?, ?, ?)`),
  sessionUser: db.prepare(`SELECT u.id, u.name, u.email, u.is_admin, u.banned, u.password_hash IS NOT NULL AS has_password FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`),
  setPassword: db.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`),
  deleteOtherSessions: db.prepare(`DELETE FROM sessions WHERE user_id = ? AND token != ?`),
  insertSession: db.prepare(`INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)`),
  deleteSession: db.prepare(`DELETE FROM sessions WHERE token = ?`),
  deleteUserSessions: db.prepare(`DELETE FROM sessions WHERE user_id = ?`),
  setBanned: db.prepare(`UPDATE users SET banned = ? WHERE id = ?`),
  makeAdmin: db.prepare(`UPDATE users SET is_admin = 1 WHERE id = ?`),
  isAllowed: db.prepare(`SELECT 1 FROM allowed_emails WHERE email = ?`),
  allowEmail: db.prepare(`INSERT OR IGNORE INTO allowed_emails (email, added_by, created_at) VALUES (?, ?, ?)`),
  searchUsers: db.prepare(`SELECT id, name FROM users WHERE banned = 0 AND id != ? AND name LIKE ? ESCAPE '\\' ORDER BY name LIMIT 30`),
  conv: db.prepare(`SELECT * FROM conversations WHERE id = ?`),
  isMember: db.prepare(`SELECT 1 FROM members WHERE conversation_id = ? AND user_id = ?`),
  members: db.prepare(`SELECT u.id, u.name FROM members m JOIN users u ON u.id = m.user_id WHERE m.conversation_id = ? ORDER BY u.name`),
  memberIds: db.prepare(`SELECT user_id FROM members WHERE conversation_id = ?`),
  addMember: db.prepare(`INSERT OR IGNORE INTO members (conversation_id, user_id) VALUES (?, ?)`),
  removeMember: db.prepare(`DELETE FROM members WHERE conversation_id = ? AND user_id = ?`),
  dmByKey: db.prepare(`SELECT * FROM conversations WHERE dm_key = ?`),
  insertConv: db.prepare(`INSERT INTO conversations (type, name, dm_key, created_by, created_at) VALUES (?, ?, ?, ?, ?)`),
  visibleConvs: db.prepare(`
    SELECT c.id, c.type, c.name, c.dm_key, c.resolved_id, (SELECT name FROM users WHERE id = c.resolved_by) AS resolved_by_name,
      (SELECT MAX(id) FROM messages WHERE conversation_id = c.id AND NOT (c.type = 'announce' AND deleted = 1)) AS last_id,
      COALESCE((SELECT last_read_id FROM reads WHERE user_id = ? AND conversation_id = c.id), 0) AS last_read_id,
      COALESCE((SELECT cleared_id FROM cleared WHERE user_id = ? AND conversation_id = c.id), 0) AS cleared_id
    FROM conversations c
    WHERE c.type IN ('public','announce')
       OR c.id IN (SELECT conversation_id FROM members WHERE user_id = ?)
       OR (c.type = 'staff' AND ? = 1)`),
  adminIds: db.prepare(`SELECT id FROM users WHERE is_admin = 1 AND banned = 0`),
  pushCount: db.prepare(`SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?`),
  getSetting: db.prepare(`SELECT content FROM info WHERE id = ?`),
  setSetting: db.prepare(`INSERT INTO info (id, content, updated_by, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET content = excluded.content, updated_by = excluded.updated_by, updated_at = excluded.updated_at`),
  getInfo: db.prepare(`SELECT i.content, i.updated_at, u.name AS updated_by FROM info i LEFT JOIN users u ON u.id = i.updated_by WHERE i.id = 'main'`),
  setInfo: db.prepare(`
    INSERT INTO info (id, content, updated_by, updated_at) VALUES ('main', ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET content = excluded.content, updated_by = excluded.updated_by, updated_at = excluded.updated_at`),
  unread: db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND id > ? AND user_id != ? AND deleted = 0`),
  msgById: db.prepare(`
    SELECT m.id, m.conversation_id, m.user_id, u.name AS user_name, m.text, m.deleted, m.created_at, m.seq, m.reactions,
      m.reply_to, r.user_id AS r_user_id, ru.name AS r_user_name, r.text AS r_text, r.deleted AS r_deleted
    FROM messages m JOIN users u ON u.id = m.user_id
    LEFT JOIN messages r ON r.id = m.reply_to LEFT JOIN users ru ON ru.id = r.user_id WHERE m.id = ?`),
  history: db.prepare(`
    SELECT m.id, m.conversation_id, m.user_id, u.name AS user_name, m.text, m.deleted, m.created_at, m.seq, m.reactions,
      m.reply_to, r.user_id AS r_user_id, ru.name AS r_user_name, r.text AS r_text, r.deleted AS r_deleted
    FROM messages m JOIN users u ON u.id = m.user_id
    LEFT JOIN messages r ON r.id = m.reply_to LEFT JOIN users ru ON ru.id = r.user_id
    WHERE m.conversation_id = ? AND m.id > ? AND m.id < ? ORDER BY m.id DESC LIMIT ?`),
  clearedId: db.prepare(`SELECT cleared_id FROM cleared WHERE user_id = ? AND conversation_id = ?`),
  setCleared: db.prepare(`
    INSERT INTO cleared (user_id, conversation_id, cleared_id) VALUES (?, ?, ?)
    ON CONFLICT(user_id, conversation_id) DO UPDATE SET cleared_id = excluded.cleared_id`),
  lastMsgId: db.prepare(`SELECT COALESCE(MAX(id), 0) AS id FROM messages WHERE conversation_id = ?`),
  insertMsg: db.prepare(`INSERT INTO messages (conversation_id, user_id, text, created_at, seq, reply_to) VALUES (?, ?, ?, ?, ?, ?)`),
  deleteMsg: db.prepare(`UPDATE messages SET deleted = 1, text = '', reactions = NULL, seq = ? WHERE id = ?`),
  setReaction: db.prepare(`
    INSERT INTO reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(message_id, user_id) DO UPDATE SET emoji = excluded.emoji, created_at = excluded.created_at`),
  removeReaction: db.prepare(`DELETE FROM reactions WHERE message_id = ? AND user_id = ?`),
  reactionCounts: db.prepare(`SELECT emoji, COUNT(*) AS n FROM reactions WHERE message_id = ? GROUP BY emoji ORDER BY MIN(created_at)`),
  saveReactions: db.prepare(`UPDATE messages SET reactions = ?, seq = ? WHERE id = ?`),
  reactionUsers: db.prepare(`
    SELECT r.emoji, u.id, u.name FROM reactions r JOIN users u ON u.id = r.user_id
    WHERE r.message_id = ? ORDER BY r.created_at DESC LIMIT 500`),
  myReactions: db.prepare(`SELECT message_id, emoji FROM reactions WHERE user_id = ? AND message_id BETWEEN ? AND ?`),
  myReaction: db.prepare(`SELECT emoji FROM reactions WHERE user_id = ? AND message_id = ?`),
  setProfile: db.prepare(`UPDATE users SET profile = ? WHERE id = ?`),
  upsertRead: db.prepare(`
    INSERT INTO reads (user_id, conversation_id, last_read_id) VALUES (?, ?, ?)
    ON CONFLICT(user_id, conversation_id) DO UPDATE SET last_read_id = MAX(last_read_id, excluded.last_read_id)`),
  markDelivered: db.prepare(`
    INSERT INTO reads (user_id, conversation_id, last_read_id, delivered_id) VALUES (?, ?, 0, ?)
    ON CONFLICT(user_id, conversation_id) DO UPDATE SET delivered_id = MAX(delivered_id, excluded.delivered_id)
    WHERE excluded.delivered_id > reads.delivered_id`),
  readStates: db.prepare(`SELECT user_id, last_read_id, delivered_id FROM reads WHERE conversation_id = ?`),
  convById: db.prepare(`SELECT * FROM conversations WHERE id = ?`),
  setResolved: db.prepare(`UPDATE conversations SET resolved_id = ?, resolved_by = ? WHERE id = ?`),
  since: db.prepare(`
    SELECT m.id, m.conversation_id, m.user_id, u.name AS user_name, m.text, m.deleted, m.created_at, m.seq, m.reactions,
      m.reply_to, r.user_id AS r_user_id, ru.name AS r_user_name, r.text AS r_text, r.deleted AS r_deleted
    FROM messages m JOIN users u ON u.id = m.user_id
    LEFT JOIN messages r ON r.id = m.reply_to LEFT JOIN users ru ON ru.id = r.user_id
    JOIN conversations c ON c.id = m.conversation_id
    WHERE m.seq > ?
      AND (c.type IN ('public','announce')
           OR EXISTS (SELECT 1 FROM members WHERE conversation_id = c.id AND user_id = ?)
           OR (c.type = 'staff' AND ? = 1))
      AND m.id > COALESCE((SELECT cleared_id FROM cleared WHERE user_id = ? AND conversation_id = c.id), 0)
    ORDER BY m.seq LIMIT 300`),
  sincePublic: db.prepare(`
    SELECT m.id, m.conversation_id, m.user_id, u.name AS user_name, m.text, m.deleted, m.created_at, m.seq, m.reactions,
      m.reply_to, r.user_id AS r_user_id, ru.name AS r_user_name, r.text AS r_text, r.deleted AS r_deleted
    FROM messages m JOIN users u ON u.id = m.user_id
    LEFT JOIN messages r ON r.id = m.reply_to LEFT JOIN users ru ON ru.id = r.user_id
    JOIN conversations c ON c.id = m.conversation_id
    WHERE m.seq > ? AND c.type IN ('public','announce')
    ORDER BY m.seq LIMIT 300`),
  touchUser: db.prepare(`UPDATE users SET last_seen = ? WHERE id = ?`),
  stats: db.prepare(`SELECT (SELECT COUNT(*) FROM users) AS users, (SELECT COUNT(*) FROM messages) AS messages, (SELECT COUNT(*) FROM conversations) AS conversations`),
};

// Chi è già registrato e viene aggiunto agli organizzatori diventa admin subito (senza dover rientrare).
for (const email of ADMIN_EMAILS) {
  const u = q.userByEmail.get(email);
  if (u && !u.is_admin) q.makeAdmin.run(u.id);
}

function publicMsg(m) {
  return {
    id: m.id, conversationId: m.conversation_id, userId: m.user_id, userName: m.user_name,
    text: m.deleted ? '' : m.text, deleted: !!m.deleted, createdAt: m.created_at, seq: m.seq,
    reactions: m.reactions && !m.deleted ? JSON.parse(m.reactions) : null,
    replyTo: m.reply_to ? {
      id: m.reply_to, userId: m.r_user_id, userName: m.r_user_name || '',
      text: m.r_deleted ? '' : String(m.r_text || '').slice(0, 160), deleted: !!m.r_deleted,
    } : null,
  };
}

// Chat "Contact staff": una per partecipante; la vedono lui e tutti gli organizzatori.
function canSee(conv, user) {
  if (!conv) return false;
  if (conv.type === 'public' || conv.type === 'announce') return true;
  if (conv.type === 'staff' && user.is_admin) return true;
  return !!q.isMember.get(conv.id, user.id);
}

function convTitle(conv, user) {
  if (conv.type === 'staff') {
    const owner = q.members.all(conv.id)[0];
    return user.is_admin && owner && owner.id !== user.id ? `🛟 ${owner.name}` : '🛟 Staff support';
  }
  if (conv.type !== 'dm') return conv.name;
  const other = q.members.all(conv.id).find((u) => u.id !== user.id);
  return other ? other.name : 'Chat';
}

function conversationSummary(row, user) {
  const userId = user.id;
  // Chat eliminata da questa persona: conta solo ciò che è arrivato dopo.
  const last = row.last_id && row.last_id > row.cleared_id ? q.msgById.get(row.last_id) : null;
  const summary = {
    id: row.id,
    type: row.type,
    title: convTitle(row, user),
    lastMessage: last ? publicMsg(last) : null,
    unread: q.unread.get(row.id, Math.max(row.last_read_id, row.cleared_id), userId).n,
    clearedId: row.cleared_id || 0,
    receipt: receiptFor(row, userId),
  };
  if (row.type === 'staff' && user.is_admin) {
    const owner = q.members.all(row.id)[0];
    summary.ownerId = owner ? owner.id : null;
    summary.resolvedId = row.resolved_id || 0;
    summary.resolvedBy = row.resolved_by_name || null;
  }
  if (row.type === 'dm') {
    const other = q.members.all(row.id).find((u) => u.id !== userId);
    summary.otherUserId = other ? other.id : null;
  }
  return summary;
}

// ---------------------------------------------------------------------------
// Long-polling
// ---------------------------------------------------------------------------
const waiters = new Set(); // { userId, since, respond, timer }
let pendingAll = false;
const pendingUsers = new Set();
let flushScheduled = false;

// Chi riceve i messaggi di una chat non pubblica (le chat con lo staff vanno anche a tutti gli organizzatori).
function recipientsOf(conv) {
  const ids = new Set(q.memberIds.all(conv.id).map((r) => r.user_id));
  if (conv.type === 'staff') for (const r of q.adminIds.all()) ids.add(r.id);
  return [...ids];
}

// --- Spunte (inviato ✓ · consegnato ✓✓ · letto ✓✓ blu) ---------------------------
// Per chi guarda la chat: fin dove gli ALTRI hanno ricevuto (delivered) e letto (read).
// Chat private e gruppi: contano tutti gli altri (nei gruppi blu = letto da tutti).
// Chat con lo staff: per il partecipante basta un organizzatore qualsiasi.
const RECEIPT_MAX_MEMBERS = 256;
function receiptFor(conv, viewerId) {
  if (!conv || !['dm', 'group', 'staff'].includes(conv.type)) return null;
  const members = q.memberIds.all(conv.id).map((r) => r.user_id);
  if (members.length > RECEIPT_MAX_MEMBERS) return null;
  let others, any = false;
  if (conv.type === 'staff') {
    if (members.includes(viewerId)) { others = q.adminIds.all().map((r) => r.id).filter((id) => id !== viewerId); any = true; }
    else others = members;
  } else others = members.filter((id) => id !== viewerId);
  if (!others.length) return null;
  const st = new Map(q.readStates.all(conv.id).map((r) => [r.user_id, r]));
  const vals = others.map((id) => { const r = st.get(id) || { last_read_id: 0, delivered_id: 0 }; return [r.last_read_id, Math.max(r.delivered_id, r.last_read_id)]; });
  const pick = any ? Math.max : Math.min;
  return { conversationId: conv.id, read: pick(...vals.map((v) => v[0])), delivered: pick(...vals.map((v) => v[1])) };
}
// Chi deve ricevere spunte aggiornate (consegnate al prossimo polling, o subito se in attesa).
const pendingReceipts = new Map(); // userId -> Set(convId)
let receiptTimer = null;
function receiptsChanged(conv, actorId) {
  if (!['dm', 'group', 'staff'].includes(conv.type)) return;
  for (const id of recipientsOf(conv)) {
    if (id === actorId) continue;
    if (!pendingReceipts.has(id)) pendingReceipts.set(id, new Set());
    pendingReceipts.get(id).add(conv.id);
  }
  if (!receiptTimer) receiptTimer = setTimeout(() => {
    receiptTimer = null;
    for (const w of [...waiters]) if (pendingReceipts.has(w.userId)) w.respond([]);
  }, 250);
}
// Chat cambiate per qualcuno (es. richiesta segnata come risolta): riceve il riepilogo aggiornato.
const pendingConvs = new Map(); // userId -> Set(convId)
function convChanged(conv, userIds) {
  for (const id of userIds) {
    if (!pendingConvs.has(id)) pendingConvs.set(id, new Set());
    pendingConvs.get(id).add(conv.id);
  }
  for (const w of [...waiters]) if (pendingConvs.has(w.userId)) w.respond([]);
}
function drainConvs(user) {
  const set = pendingConvs.get(user.id);
  if (!set) return [];
  pendingConvs.delete(user.id);
  return q.visibleConvs.all(user.id, user.id, user.id, user.is_admin).filter((r) => set.has(r.id)).map((r) => conversationSummary(r, user));
}
function drainReceipts(userId) {
  const set = pendingReceipts.get(userId);
  if (!set) return [];
  pendingReceipts.delete(userId);
  return [...set].map((id) => receiptFor(q.convById.get(id), userId)).filter(Boolean);
}
// Quello che è arrivato sul telefono di userId: aggiorna "consegnato" e avvisa i mittenti.
function noteDelivered(userId, rows) {
  const best = new Map();
  for (const m of rows) if (m.user_id !== userId && !m.deleted) best.set(m.conversation_id, Math.max(best.get(m.conversation_id) || 0, m.id));
  for (const [convId, id] of best) {
    const conv = q.convById.get(convId);
    if (!conv || !['dm', 'group', 'staff'].includes(conv.type)) continue;
    if (q.markDelivered.run(userId, convId, id).changes) receiptsChanged(conv, userId);
  }
}

function notify(conv) {
  if (conv.type === 'public' || conv.type === 'announce') pendingAll = true;
  else for (const id of recipientsOf(conv)) pendingUsers.add(id);
  if (!flushScheduled) {
    flushScheduled = true;
    // Breve attesa per accorpare più messaggi in un'unica risposta.
    setTimeout(flush, 40);
  }
}

function flush() {
  flushScheduled = false;
  const all = pendingAll;
  const users = new Set(pendingUsers);
  pendingAll = false;
  pendingUsers.clear();
  // Chi non ha novità private riceve solo i messaggi pubblici: la query si fa una
  // volta per ogni cursore (di solito quasi tutti sono allo stesso punto) e non
  // una volta per persona. Con 3000 persone collegate fa una grande differenza.
  const publicByCursor = new Map();
  for (const w of [...waiters]) {
    let rows;
    if (users.has(w.userId)) rows = q.since.all(w.since, w.userId, w.isAdmin, w.userId);
    else if (all) {
      let shared = publicByCursor.get(w.since);
      if (!shared) { shared = { rows: q.sincePublic.all(w.since) }; publicByCursor.set(w.since, shared); }
      if (shared.rows.length) w.respond(shared.rows, shared);
      continue;
    } else continue;
    if (rows.length) w.respond(rows);
  }
}

function nextSeq() { return ++seq; }

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------
function limiter(max, windowMs) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (now - v.start > windowMs) hits.delete(k);
  }, windowMs).unref();
  return (key) => {
    const now = Date.now();
    let h = hits.get(key);
    if (!h || now - h.start > windowMs) { h = { start: now, n: 0 }; hits.set(key, h); }
    h.n++;
    return h.n <= max;
  };
}
const msgLimit = limiter(8, 10_000);
const createLimit = limiter(10, 60_000);

// Sulla nave tutti escono probabilmente dallo stesso IP: contiamo solo i
// tentativi di accesso SBAGLIATI, così 2000 login corretti non si bloccano.
const loginFailures = new Map();
const FAIL_WINDOW = 10 * 60_000;
const MAX_FAILS = 600; // con le password i tentativi sbagliati (refusi) sono più frequenti
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of loginFailures) if (now - v.start > FAIL_WINDOW) loginFailures.delete(k);
}, FAIL_WINDOW).unref();
function checkLoginAllowed(req) {
  const f = loginFailures.get(clientIp(req));
  if (f && Date.now() - f.start <= FAIL_WINDOW && f.n >= MAX_FAILS) throw new HttpError(429, 'Too many attempts, please try again in a few minutes');
}
function loginFailed(req, status, message) {
  const ip = clientIp(req);
  let f = loginFailures.get(ip);
  if (!f || Date.now() - f.start > FAIL_WINDOW) { f = { start: Date.now(), n: 0 }; loginFailures.set(ip, f); }
  f.n++;
  return new HttpError(status, message);
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function send(req, res, status, body, headers = {}) {
  let data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  if (!headers['Content-Type']) headers['Content-Type'] = 'application/json; charset=utf-8';
  if (!headers['Cache-Control']) headers['Cache-Control'] = 'no-store';
  const accepts = String(req.headers['accept-encoding'] || '');
  if (data.length > 512 && /\bgzip\b/.test(accepts)) {
    data = zlib.gzipSync(data);
    headers['Content-Encoding'] = 'gzip';
    headers['Vary'] = 'Accept-Encoding';
  }
  headers['Content-Length'] = Buffer.byteLength(data);
  res.writeHead(status, headers);
  res.end(data);
}

// Invia un JSON già serializzato, comprimendolo una volta sola per tutti.
function sendEncoded(req, res, shared) {
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
  let data = shared.json;
  if (data.length > 512 && /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''))) {
    if (!shared.gz) shared.gz = zlib.gzipSync(data);
    data = shared.gz;
    headers['Content-Encoding'] = 'gzip';
    headers['Vary'] = 'Accept-Encoding';
  }
  headers['Content-Length'] = data.length;
  res.writeHead(200, headers);
  res.end(data);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const ct = String(req.headers['content-type'] || '');
    // Richiedere JSON blocca i form cross-site (protezione CSRF insieme a SameSite).
    if (!ct.startsWith('application/json')) return reject(new HttpError(415, 'Invalid Content-Type'));
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new HttpError(413, 'Request too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject(new HttpError(400, 'Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function sessionCookie(token, maxAge) {
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${SECURE_COOKIE ? '; Secure' : ''}`;
}

// Ultima attività di ogni persona: in memoria al minuto, sul database ogni 5 minuti
// (così migliaia di persone collegate non fanno migliaia di scritture).
const lastSeen = new Map();
function touch(userId) {
  const now = Date.now();
  const prev = lastSeen.get(userId) || 0;
  if (now - prev < 60_000) return;
  lastSeen.set(userId, now);
  if (now - prev > 300_000) q.touchUser.run(now, userId);
}

function auth(req) {
  const token = parseCookies(req)[COOKIE];
  const user = token && q.sessionUser.get(token);
  if (!user) throw new HttpError(401, 'Not signed in');
  if (user.banned) throw new HttpError(403, 'Account suspended');
  touch(user.id);
  return user;
}

function requireAdmin(user) {
  if (!user.is_admin) throw new HttpError(403, 'Organisers only');
}

function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;
}

function startSession(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  q.insertSession.run(token, userId, Date.now());
  return sessionCookie(token, 60 * 60 * 24 * 30);
}

function getConvOr404(id, user) {
  const conv = q.conv.get(Number(id));
  if (!canSee(conv, user)) throw new HttpError(404, 'Chat not found');
  return conv;
}

function createGroupLike(type, name, creatorId, memberIds) {
  db.exec('BEGIN');
  try {
    const { lastInsertRowid } = q.insertConv.run(type, name, null, creatorId, Date.now());
    if (type === 'group') {
      q.addMember.run(lastInsertRowid, creatorId);
      for (const id of memberIds) if (q.userById.get(id)) q.addMember.run(lastInsertRowid, id);
    }
    db.exec('COMMIT');
    return q.conv.get(lastInsertRowid);
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

function postMessage(conv, userId, text, replyTo = null) {
  const s = nextSeq();
  const { lastInsertRowid } = q.insertMsg.run(conv.id, userId, text, Date.now(), s, replyTo);
  q.upsertRead.run(userId, conv.id, lastInsertRowid);
  notify(conv);
  const msg = q.msgById.get(lastInsertRowid);
  sendPush(conv, msg);
  return msg;
}

// Notifica push a chi deve ricevere il messaggio e non ha l'app aperta davanti.
// Niente push per i canali pubblici aperti dagli organizzatori (sarebbero troppe);
// sì per Annunci, gruppi e chat private.
function sendPush(conv, msg) {
  if (conv.type === 'public') return;
  const exclude = new Set([msg.user_id]);
  for (const w of waiters) if (w.visible) exclude.add(w.userId);
  const first = msg.user_name.split(' ')[0];
  const text = msg.text.length > 140 ? msg.text.slice(0, 137) + '…' : msg.text;
  const message = {
    // Chat con lo staff: agli organizzatori arriva il nome del partecipante, al partecipante "Staff support".
    title: conv.type === 'dm' ? msg.user_name
      : conv.type === 'staff' ? (msg.user_id === conv.created_by ? `🛟 ${msg.user_name}` : '🛟 Staff support')
      : conv.name,
    body: conv.type === 'dm' || conv.type === 'announce' ? text : `${first}: ${text}`,
    convId: conv.id,
    msgId: msg.id, // il telefono conferma l'arrivo (seconda spunta) anche ad app chiusa
    tag: 'conv-' + conv.id,
  };
  const recipients = conv.type === 'announce' ? null : recipientsOf(conv);
  try { push.notify(recipients, message, exclude); } catch (err) { console.error('push', err); }
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
const routes = [];
function route(method, pattern, handler) {
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$');
  routes.push({ method, re, handler });
}

route('GET', '/api/config', async () => ({ joinCodeRequired: !!JOIN_CODE }));

// Accesso e registrazione insieme: nome, cognome ed email.
// - email nuova      -> crea l'utente (se la registrazione è aperta)
// - email già nota   -> rientra, purché il cognome corrisponda
// --- Password ---------------------------------------------------------------------
// scrypt (async, non blocca il server mentre 2000 persone entrano insieme).
const PW_MIN = 6;
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  return new Promise((resolve, reject) => crypto.scrypt(password, salt, 32, (err, key) => (err ? reject(err) : resolve(`s1$${salt.toString('base64')}$${key.toString('base64')}`))));
}
function verifyPassword(password, stored) {
  const [v, salt, hash] = String(stored || '').split('$');
  if (v !== 's1' || !salt || !hash) return Promise.resolve(false);
  const expected = Buffer.from(hash, 'base64');
  return new Promise((resolve) => crypto.scrypt(password, Buffer.from(salt, 'base64'), expected.length, (err, key) => resolve(!err && crypto.timingSafeEqual(key, expected))));
}
function checkNewPassword(pw) {
  const password = String(pw || '');
  if (password.length < PW_MIN) throw new HttpError(400, `Choose a password of at least ${PW_MIN} characters`);
  if (password.length > 200) throw new HttpError(400, 'Password too long');
  return password;
}
// Tentativi sbagliati per account: dopo 10 in 15 minuti quell'account si blocca per un po'
// (sulla nave tutti hanno lo stesso IP, quindi il limite per IP da solo non basta).
const pwFailures = new Map();
const PW_FAIL_WINDOW = 15 * 60_000;
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of pwFailures) if (now - v.start > PW_FAIL_WINDOW) pwFailures.delete(k);
}, PW_FAIL_WINDOW).unref();
function checkPwAttempts(email) {
  const f = pwFailures.get(email);
  if (f && Date.now() - f.start <= PW_FAIL_WINDOW && f.n >= 10) throw new HttpError(429, 'Too many wrong passwords. Try again in 15 minutes, or ask an organiser to reset it.');
}
function pwFailed(email) {
  let f = pwFailures.get(email);
  if (!f || Date.now() - f.start > PW_FAIL_WINDOW) { f = { start: Date.now(), n: 0 }; pwFailures.set(email, f); }
  f.n++;
}

// --- Codici di verifica ---------------------------------------------------------
const CODE_TTL = 15 * 60_000;           // codice via email
const STAFF_CODE_TTL = 48 * 3600_000;   // codice dato a voce da un organizzatore
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
const newCode = () => String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');

function storeCode(email, kind, ttl, sends = 1) {
  const code = newCode();
  q.saveCode.run(email, kind, sha(`${email}:${code}`), Date.now() + ttl, Date.now(), sends);
  return code;
}
// true se il codice (quello dell'email o quello dello staff) è giusto: li consuma tutti.
// Max 5 tentativi per codice.
function useCode(email, code) {
  const given = String(code || '').replace(/\D/g, '');
  if (given.length !== 6) return false;
  const hash = Buffer.from(sha(`${email}:${given}`));
  for (const row of q.codesFor.all(email)) {
    if (row.expires_at < Date.now() || row.attempts >= 5) continue;
    if (crypto.timingSafeEqual(hash, Buffer.from(row.code_hash))) { q.deleteCodes.run(email); return true; }
    q.codeAttempt.run(email, row.kind);
  }
  return false;
}

// Manda il codice per email (registrazione o nuova password). Al massimo uno al minuto e
// cinque all'ora per indirizzo.
route('POST', '/api/login/send-code', async (req) => {
  checkLoginAllowed(req);
  if (!mail.enabled) throw new HttpError(400, 'Email codes are not active');
  const body = await readJson(req);
  const email = normalizeEmail(body.email);
  if (!isValidEmail(email)) throw new HttpError(400, 'Invalid email');
  const user = q.userByEmail.get(email);
  if (user && user.password_hash) throw new HttpError(400, 'This account already has a password: sign in with it');
  if (!user && LIST_ONLY && !isAllowedEmail(email)) throw loginFailed(req, 403, 'This email is not on the Global Reunion participant list');
  if (!user && !canSignUpNow(email)) throw new HttpError(403, CLOSED_MSG);
  const prev = q.getCode.get(email, 'email');
  const now = Date.now();
  if (prev && now - prev.sent_at < 60_000) throw new HttpError(429, 'We just sent you a code: wait a minute before asking for a new one');
  const sends = prev && now - prev.sent_at < 3600_000 ? prev.sends + 1 : 1;
  if (sends > 5) throw new HttpError(429, 'Too many codes requested: try again in an hour');
  const code = storeCode(email, 'email', CODE_TTL, sends);
  // Email personalizzata: il nome dal profilo, o quello appena scritto nella registrazione.
  const name = user ? user.name.split(' ')[0] : cleanName(body.firstName).split(' ')[0].slice(0, 30);
  try { await mail.sendCode(email, code, { name, purpose: user ? 'reset' : 'signup' }); } catch (err) {
    console.error('Invio email fallito:', err.message);
    q.deleteCode.run(email, 'email');
    throw new HttpError(502, 'We couldn\'t send the email right now, please try again in a moment');
  }
  return { ok: true };
});

// Primo passo dell'accesso: con questa email cosa serve?
//  password → account con password · setup → account vecchio senza password (cognome + nuova password)
//  new → prima volta (nome, cognome, password) · not-allowed → non è nell'elenco partecipanti
route('POST', '/api/login/check', async (req) => {
  checkLoginAllowed(req);
  const body = await readJson(req);
  const email = normalizeEmail(body.email);
  if (!isValidEmail(email)) throw new HttpError(400, 'Invalid email');
  const user = q.userByEmail.get(email);
  if (user && user.password_hash) return { step: 'password' };
  if (!user && LIST_ONLY && !isAllowedEmail(email)) return { step: 'not-allowed' };
  if (!user && !canSignUpNow(email)) return { step: 'closed' };
  // codeRequired: prima di creare l'account (o la nuova password) arriva un codice per email.
  return { step: user ? 'setup' : 'new', codeRequired: mail.enabled };
});

// Accesso e registrazione insieme.
// - email nuova                 -> nome, cognome e password: crea l'utente
// - email con password          -> basta la password
// - email senza password (vecchi account) -> cognome giusto + nuova password
route('POST', '/api/register', async (req) => {
  checkLoginAllowed(req);
  const body = await readJson(req);
  const email = normalizeEmail(body.email);
  if (!isValidEmail(email)) throw new HttpError(400, 'Invalid email');
  const password = String(body.password || '');

  let user = q.userByEmail.get(email);
  if (user && user.password_hash) {
    checkPwAttempts(email);
    if (!password || !await verifyPassword(password, user.password_hash)) {
      pwFailed(email);
      throw loginFailed(req, 401, 'Wrong password');
    }
  } else if (user) {
    // Nuova password: serve il codice (email, oppure quello dato da un organizzatore). Senza
    // invio email attivo basta anche il cognome giusto.
    const newPassword = checkNewPassword(password);
    if (body.code) {
      if (!useCode(email, body.code)) throw loginFailed(req, 401, 'Wrong or expired code');
    } else if (mail.enabled) {
      throw new HttpError(400, 'Enter the code we sent to your email');
    } else {
      const lastName = cleanName(body.lastName);
      if (!lastName) throw new HttpError(400, 'Please enter your last name');
      if (!surnameMatches(user.name, lastName)) throw loginFailed(req, 401, 'This email is registered with a different last name');
    }
    q.setPassword.run(await hashPassword(newPassword), user.id);
  } else {
    const firstName = cleanName(body.firstName);
    const lastName = cleanName(body.lastName);
    if (!firstName || !lastName) throw new HttpError(400, 'Please enter your first and last name');
    if (LIST_ONLY && !isAllowedEmail(email)) {
      throw loginFailed(req, 403, 'This email is not on the Global Reunion participant list. Use the one you booked the trip with, or ask an organiser to allow it.');
    }
    if (!canSignUpNow(email)) throw new HttpError(403, CLOSED_MSG);
    if (JOIN_CODE && normalizeCode(body.joinCode) !== JOIN_CODE) throw loginFailed(req, 401, 'Invalid event code');
    const newPassword = checkNewPassword(password);
    // L'account nasce solo con il codice arrivato a quella email: così è davvero di chi la usa.
    if (mail.enabled) {
      if (!body.code) throw new HttpError(400, 'Enter the code we sent to your email');
      if (!useCode(email, body.code)) throw loginFailed(req, 401, 'Wrong or expired code');
    }
    const hash = await hashPassword(newPassword);
    // Due richieste insieme per la stessa email: vince la prima.
    if (q.userByEmail.get(email)) throw new HttpError(409, 'This email has just been registered: sign in with its password');
    const name = cleanName(`${firstName} ${lastName}`);
    const { lastInsertRowid } = q.insertUser.run(name, email, Date.now());
    q.setPassword.run(hash, lastInsertRowid);
    user = q.userById.get(lastInsertRowid);
  }
  if (user.banned) throw new HttpError(403, 'Account suspended');
  pwFailures.delete(email);
  if (ADMIN_EMAILS.has(email) && !user.is_admin) q.makeAdmin.run(user.id);
  return { status: 200, body: { ok: true }, headers: { 'Set-Cookie': startSession(user.id) } };
});

// Scegliere o cambiare la password da dentro l'app (chi era già entrato prima delle password
// la sceglie qui; per cambiarla serve quella attuale). Gli altri dispositivi vengono disconnessi.
route('PUT', '/api/me/password', async (req) => {
  const user = auth(req);
  const body = await readJson(req);
  const password = checkNewPassword(body.password);
  if (user.has_password) {
    if (!await verifyPassword(String(body.current || ''), q.passwordHash.get(user.id).password_hash)) throw new HttpError(401, 'Your current password is wrong');
  }
  q.setPassword.run(await hashPassword(password), user.id);
  q.deleteOtherSessions.run(user.id, parseCookies(req)[COOKIE]);
  return { ok: true };
});

// Finché nessun organizzatore le apre: chiuse sul sito vero, aperte in locale e nei test.
const switchOpen = (key) => {
  const row = q.getSetting.get(key);
  return row ? row.content === 'open' : process.env.NODE_ENV !== 'production';
};
const signupsOpen = () => switchOpen('signups');
// Chat con lo staff: chiusa per i partecipanti finché gli organizzatori non la aprono (a bordo).
const supportOpen = () => switchOpen('support');
const SUPPORT_CLOSED_MSG = 'Staff support opens once we are on board. See you on the ship! 🚢';

// Sblocco della chat: prima di questa data i partecipanti si registrano e vedono un conto alla
// rovescia, ma non possono scrivere. Gli organizzatori non hanno limiti (per provare e preparare).
// UNLOCK_AT: data ISO, oppure 0 per nessun blocco. Sul sito vero: 20 ottobre 2026, 16:00 ora italiana.
const UNLOCK_AT = (() => {
  const v = process.env.UNLOCK_AT;
  if (v !== undefined && v !== '') return v === '0' ? 0 : Date.parse(v) || 0;
  return process.env.NODE_ENV === 'production' ? Date.parse('2026-10-20T16:00:00+02:00') : 0;
})();
const isLocked = (user) => !user.is_admin && Date.now() < UNLOCK_AT;
const LOCKED_MSG = 'The chat unlocks on 20 October 🚢';
function checkUnlocked(user) { if (isLocked(user)) throw new HttpError(403, LOCKED_MSG); }
function canSignUpNow(email) {
  return signupsOpen() || ADMIN_EMAILS.has(email) || EARLY_EMAILS.has(email) || !!q.isAllowed.get(email);
}
const CLOSED_MSG = 'Sign-ups are not open yet: the organisers will send you the link when the chat opens. See you soon! 🚢';

function isAllowedEmail(email) {
  return ADMIN_EMAILS.has(email) || PARTICIPANT_HASHES.has(hashEmail(email)) || !!q.isAllowed.get(email);
}

route('POST', '/api/logout', async (req) => {
  const token = parseCookies(req)[COOKIE];
  if (token) q.deleteSession.run(token);
  return { status: 200, body: { ok: true }, headers: { 'Set-Cookie': sessionCookie('', 0) } };
});

route('GET', '/api/me', async (req) => {
  const user = auth(req);
  const rows = q.visibleConvs.all(user.id, user.id, user.id, user.is_admin);
  // Le ultime righe della lista sono arrivate sul telefono: spunte "consegnato" per i mittenti.
  noteDelivered(user.id, rows.filter((r) => r.last_id && r.last_id > r.cleared_id).map((r) => q.msgById.get(r.last_id)).filter(Boolean));
  const conversations = rows.map((r) => conversationSummary(r, user));
  return {
    user: { id: user.id, name: user.name, isAdmin: !!user.is_admin, profile: readProfile(q.userProfile.get(user.id)), hasPassword: !!user.has_password },
    cursor: seq,
    conversations,
    supportOpen: supportOpen(),
    canSeeStats: canSeeStats(user),
    unlockAt: isLocked(user) ? UNLOCK_AT : 0, // > 0: conto alla rovescia al posto della chat
    now: Date.now(),
  };
});

route('GET', '/api/users', async (req, res, params, url) => {
  const user = auth(req);
  const term = String(url.searchParams.get('q') || '').trim().slice(0, 50);
  const like = '%' + term.replace(/[\\%_]/g, (c) => '\\' + c) + '%';
  return { users: q.searchUsers.all(user.id, like) };
});

// --- Profili ------------------------------------------------------------------
// Tutti campi facoltativi; i social si salvano come nome utente, l'app costruisce i link.
const handle = (re) => (v) => {
  const h = String(v || '').trim().replace(/^https?:\/\/(www\.)?[^/]+\/(in\/)?/i, '').replace(/^@/, '').replace(/[/?#].*$/, '');
  if (!h) return '';
  if (!re.test(h)) throw new HttpError(400, 'invalid');
  return h;
};
const PROFILE_FIELDS = {
  instagram: { label: 'Instagram username', clean: handle(/^[A-Za-z0-9._]{1,30}$/) },
  tiktok: { label: 'TikTok username', clean: handle(/^[A-Za-z0-9._]{2,24}$/) },
  linkedin: { label: 'LinkedIn profile', clean: handle(/^[A-Za-z0-9\-_%]{3,100}$/) },
  whatsapp: {
    label: 'WhatsApp number',
    clean: (v) => {
      const raw = String(v || '').trim();
      if (!raw) return '';
      const n = (raw.startsWith('+') || raw.startsWith('00') ? '+' : '') + raw.replace(/^00/, '').replace(/\D/g, '');
      if (!/^\+?\d{6,16}$/.test(n)) throw new HttpError(400, 'invalid');
      return n;
    },
  },
  city: { label: 'City', clean: (v) => cleanText(v, 40) },
  bio: { label: 'About you', clean: (v) => cleanText(v, 160) },
};
function cleanText(v, max) {
  return String(v || '').replace(/\s+/g, ' ').trim().slice(0, max);
}
function readProfile(row) {
  if (!row || !row.profile) return {};
  try { return JSON.parse(row.profile); } catch { return {}; }
}

route('PUT', '/api/me/profile', async (req) => {
  const user = auth(req);
  const body = await readJson(req);
  const input = body.profile || {};
  const profile = {};
  for (const [key, f] of Object.entries(PROFILE_FIELDS)) {
    let value;
    try { value = f.clean(input[key]); } catch { throw new HttpError(400, `${f.label} doesn't look right`); }
    if (value) profile[key] = value;
  }
  q.setProfile.run(Object.keys(profile).length ? JSON.stringify(profile) : null, user.id);
  return { profile };
});

route('GET', '/api/users/:id', async (req, res, { id }) => {
  auth(req);
  const row = q.userProfile.get(Number(id));
  if (!row) throw new HttpError(404, 'User not found');
  return { id: row.id, name: row.name, isAdmin: !!row.is_admin, profile: readProfile(row) };
});

route('GET', '/api/conversations/:id', async (req, res, { id }) => {
  const user = auth(req);
  const conv = getConvOr404(id, user);
  const row = q.visibleConvs.all(user.id, user.id, user.id, user.is_admin).find((r) => r.id === conv.id);
  const summary = conversationSummary(row, user);
  if (conv.type === 'group') summary.members = q.members.all(conv.id);
  return summary;
});

route('GET', '/api/conversations/:id/messages', async (req, res, { id }, url) => {
  const user = auth(req);
  const conv = getConvOr404(id, user);
  const before = Number(url.searchParams.get('before')) || Number.MAX_SAFE_INTEGER;
  const cleared = (q.clearedId.get(user.id, conv.id) || { cleared_id: 0 }).cleared_id;
  const rows = q.history.all(conv.id, cleared, before, 50).reverse();
  const messages = rows.map(publicMsg);
  if (rows.length) {
    const mine = new Map(q.myReactions.all(user.id, rows[0].id, rows[rows.length - 1].id).map((r) => [r.message_id, r.emoji]));
    for (const m of messages) m.myReaction = mine.get(m.id) || null;
    noteDelivered(user.id, rows);
  }
  return { messages, hasMore: rows.length === 50, receipt: receiptFor(conv, user.id) };
});

route('POST', '/api/conversations/:id/messages', async (req, res, { id }) => {
  const user = auth(req);
  checkUnlocked(user);
  const conv = getConvOr404(id, user);
  if (conv.type === 'announce' && !user.is_admin) throw new HttpError(403, 'Only organisers can post here');
  if (conv.type === 'staff' && !user.is_admin && !supportOpen()) throw new HttpError(403, SUPPORT_CLOSED_MSG);
  if (!msgLimit(user.id)) throw new HttpError(429, 'You are sending messages too fast');
  const body = await readJson(req);
  const text = String(body.text || '').replace(/\r\n/g, '\n').trim();
  if (!text) throw new HttpError(400, 'Empty message');
  if (text.length > MAX_TEXT) throw new HttpError(400, `Maximum ${MAX_TEXT} characters`);
  // Risposta a un messaggio: deve essere della stessa chat.
  let replyTo = null;
  if (body.replyTo) {
    const original = q.msgById.get(Number(body.replyTo));
    if (!original || original.conversation_id !== conv.id) throw new HttpError(400, 'The message you are replying to is not in this chat');
    replyTo = original.id;
  }
  return { message: publicMsg(postMessage(conv, user.id, text, replyTo)) };
});

// "Contact staff": apre (o crea) la chat di assistenza di chi la chiede.
route('POST', '/api/staff', async (req) => {
  const user = auth(req);
  checkUnlocked(user);
  if (!user.is_admin && !supportOpen()) throw new HttpError(403, SUPPORT_CLOSED_MSG);
  const key = 'staff:' + user.id;
  let conv = q.dmByKey.get(key);
  if (!conv) {
    db.exec('BEGIN');
    try {
      const { lastInsertRowid } = q.insertConv.run('staff', null, key, user.id, Date.now());
      q.addMember.run(lastInsertRowid, user.id);
      db.exec('COMMIT');
      conv = q.conv.get(lastInsertRowid);
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }
  return { id: conv.id };
});

// "Useful info": pagina scritta dagli organizzatori. Il contenuto è un JSON con
// titolo, introduzione e sezioni (icona, titolo, righe "voce → valore"); le pagine
// salvate prima, in testo semplice, vengono convertite dall'app.
const DEFAULT_INFO = JSON.stringify({
  title: 'Welcome aboard! 🚢',
  intro: 'This platform was created so you can stay in touch with your travel companions, even in the middle of the sea 🌊 Chat with everyone: in groups, or one to one with anyone on board.',
  sections: [
    { icon: '🔔', title: 'Turn on notifications', items: [{ t: 'Menu ⋮ → Notifications → Turn on, so you never miss a message. On iPhone, first add the chat to your Home Screen and open it from there.', v: '' }] },
    { icon: '💬', title: 'Message anyone', items: [{ t: 'Tap “New chat” and pick a name to write to someone one to one.', v: '' }] },
    { icon: '👥', title: 'Create your groups', items: [{ t: 'With your friends or your roommates: “New chat” → “Create a group” (up to 20 people).', v: '' }] },
    { icon: '🛟', title: 'Staff support', items: [{ t: 'The chat to ask the Reunion team for any info. It opens on departure day.', v: '' }] },
    { icon: '📍', title: 'WeRoad desk', items: [{ t: 'For any information, you can find the Reunion team at the WeRoad desk.', v: '' }] },
    { icon: '📶', title: 'Stay on the ship’s Wi‑Fi', items: [{ t: 'To use the chat on board you need to stay connected to the ship’s Wi‑Fi.', v: '' }] },
    { icon: '🔑', title: 'Save your password', items: [{ t: 'Save your sign-in password on your phone: you will need it to sign in again.', v: '' }] },
  ],
});
// Pagina nuova scritta dal team (ottobre 2026): sostituisce una volta quella salvata,
// poi gli organizzatori possono modificarla come sempre.
const INFO_VERSION = '2';
if ((q.getSetting.get('info-version') || {}).content !== INFO_VERSION) {
  q.setInfo.run(DEFAULT_INFO, null, Date.now());
  q.setSetting.run('info-version', INFO_VERSION, null, Date.now());
}

route('GET', '/api/info', async (req) => {
  auth(req);
  const row = q.getInfo.get();
  return { content: row ? row.content : DEFAULT_INFO, updatedAt: row ? row.updated_at : null, updatedBy: row ? row.updated_by : null };
});

route('PUT', '/api/info', async (req) => {
  const user = auth(req);
  requireAdmin(user);
  const body = await readJson(req);
  const content = String(body.content || '').replace(/\r\n/g, '\n').trim();
  if (!content) throw new HttpError(400, 'The page cannot be empty');
  if (content.length > 20000) throw new HttpError(400, 'The page is too long');
  q.setInfo.run(content, user.id, Date.now());
  // Facoltativo: avvisa tutti con un messaggio negli Announcements.
  if (body.announce) {
    const ann = db.prepare(`SELECT * FROM conversations WHERE type = 'announce' AND created_by IS NULL ORDER BY id LIMIT 1`).get();
    if (ann) postMessage(ann, user.id, 'ℹ️ Useful info has been updated: tap the ⓘ icon at the top to read it.');
  }
  return { ok: true };
});

route('POST', '/api/conversations/:id/read', async (req, res, { id }) => {
  const user = auth(req);
  const conv = getConvOr404(id, user);
  const body = await readJson(req);
  const lastId = Number(body.messageId) || 0;
  if (lastId > 0) { q.upsertRead.run(user.id, conv.id, lastId); receiptsChanged(conv, user.id); }
  return { ok: true };
});

route('POST', '/api/dm', async (req) => {
  const user = auth(req);
  checkUnlocked(user);
  const body = await readJson(req);
  const other = q.userById.get(Number(body.userId));
  if (!other || other.banned || other.id === user.id) throw new HttpError(404, 'User not found');
  const key = [user.id, other.id].sort((a, b) => a - b).join(':');
  let conv = q.dmByKey.get(key);
  if (!conv) {
    db.exec('BEGIN');
    try {
      const { lastInsertRowid } = q.insertConv.run('dm', null, key, user.id, Date.now());
      q.addMember.run(lastInsertRowid, user.id);
      q.addMember.run(lastInsertRowid, other.id);
      db.exec('COMMIT');
      conv = q.conv.get(lastInsertRowid);
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }
  return { id: conv.id };
});

// Gruppi piccoli, come tra amici: al massimo 20 persone, chi lo crea compreso.
const GROUP_MAX = 20;
const groupFull = () => new HttpError(400, `Groups can have up to ${GROUP_MAX} people`);

route('POST', '/api/groups', async (req) => {
  const user = auth(req);
  checkUnlocked(user);
  if (!createLimit(user.id)) throw new HttpError(429, 'Too many groups created, please try again shortly');
  const body = await readJson(req);
  const name = cleanName(body.name);
  if (name.length < 2) throw new HttpError(400, 'Give the group a name');
  const ids = Array.isArray(body.memberIds) ? [...new Set(body.memberIds.map(Number).filter((x) => x && x !== user.id))] : [];
  if (ids.length + 1 > GROUP_MAX) throw groupFull();
  const conv = createGroupLike('group', name, user.id, ids);
  postMessage(conv, user.id, `👋 ${user.name} created the group "${name}"`);
  return { id: conv.id };
});

route('POST', '/api/conversations/:id/members', async (req, res, { id }) => {
  const user = auth(req);
  checkUnlocked(user);
  const conv = getConvOr404(id, user);
  if (conv.type !== 'group') throw new HttpError(400, 'People can only be added to groups');
  const body = await readJson(req);
  const ids = Array.isArray(body.userIds) ? [...new Set(body.userIds.map(Number).filter(Boolean))].filter((uid) => !q.isMember.get(conv.id, uid)) : [];
  const now = q.memberIds.all(conv.id).length;
  if (now + ids.length > GROUP_MAX) {
    throw new HttpError(400, now >= GROUP_MAX ? `This group is full: groups can have up to ${GROUP_MAX} people`
      : `Groups can have up to ${GROUP_MAX} people: you can add ${GROUP_MAX - now} more`);
  }
  const added = [];
  for (const uid of ids) {
    const u = q.userById.get(uid);
    if (u && !u.banned && !q.isMember.get(conv.id, uid)) { q.addMember.run(conv.id, uid); added.push(u.name); }
  }
  if (added.length) postMessage(conv, user.id, `➕ ${user.name} added ${added.join(', ')}`);
  return { ok: true };
});

// Organizzatori: richiesta allo staff risolta → archiviata per tutti gli organizzatori; torna
// attiva da sola se il partecipante riscrive. resolved:false la riapre.
route('POST', '/api/conversations/:id/resolve', async (req, res, { id }) => {
  const user = auth(req);
  requireAdmin(user);
  const conv = getConvOr404(id, user);
  if (conv.type !== 'staff') throw new HttpError(400, 'Only support chats can be resolved');
  const body = await readJson(req);
  const resolved = body.resolved !== false;
  q.setResolved.run(resolved ? q.lastMsgId.get(conv.id).id : 0, resolved ? user.id : null, conv.id);
  convChanged(conv, q.adminIds.all().map((r) => r.id).filter((x) => x !== user.id));
  const row = q.visibleConvs.all(user.id, user.id, user.id, user.is_admin).find((r) => r.id === conv.id);
  return conversationSummary(row, user);
});

// "Delete chat" come su WhatsApp: una chat privata sparisce dalla tua lista e si svuota solo
// per te (ricompare se arriva un messaggio nuovo); da un gruppo esci. Annunci e staff restano.
route('DELETE', '/api/conversations/:id', async (req, res, { id }) => {
  const user = auth(req);
  const conv = getConvOr404(id, user);
  if (conv.type === 'group') {
    postMessage(conv, user.id, `🚪 ${user.name} left the group`);
    q.removeMember.run(conv.id, user.id);
  } else if (conv.type === 'dm') {
    const last = q.lastMsgId.get(conv.id).id;
    q.setCleared.run(user.id, conv.id, last);
    q.upsertRead.run(user.id, conv.id, last);
  } else {
    throw new HttpError(400, 'This chat can\'t be deleted');
  }
  return { ok: true };
});

route('POST', '/api/conversations/:id/leave', async (req, res, { id }) => {
  const user = auth(req);
  const conv = getConvOr404(id, user);
  if (conv.type !== 'group') throw new HttpError(400, 'You can only leave groups');
  postMessage(conv, user.id, `🚪 ${user.name} left the group`);
  q.removeMember.run(conv.id, user.id);
  return { ok: true };
});

route('DELETE', '/api/messages/:id', async (req, res, { id }) => {
  const user = auth(req);
  const msg = q.msgById.get(Number(id));
  if (!msg) throw new HttpError(404, 'Message not found');
  const conv = getConvOr404(msg.conversation_id, user);
  if (msg.user_id !== user.id && !user.is_admin) throw new HttpError(403, 'You cannot delete this message');
  q.deleteMsg.run(nextSeq(), msg.id);
  notify(conv);
  return { ok: true };
});

// --- Reazioni -------------------------------------------------------------------
const REACTIONS = ['❤️', '😂', '👍', '🔥', '😮', '😢', '🎉'];
const reactLimit = limiter(20, 10_000);

route('POST', '/api/messages/:id/react', async (req, res, { id }) => {
  const user = auth(req);
  checkUnlocked(user);
  const msg = q.msgById.get(Number(id));
  if (!msg || msg.deleted) throw new HttpError(404, 'Message not found');
  const conv = getConvOr404(msg.conversation_id, user);
  if (!reactLimit(user.id)) throw new HttpError(429, 'Slow down a little');
  const body = await readJson(req);
  const emoji = body.emoji ? String(body.emoji) : '';
  if (emoji && !REACTIONS.includes(emoji)) throw new HttpError(400, 'Reaction not available');
  if (emoji) q.setReaction.run(msg.id, user.id, emoji, Date.now());
  else q.removeReaction.run(msg.id, user.id);
  const counts = {};
  for (const r of q.reactionCounts.all(msg.id)) counts[r.emoji] = r.n;
  // Il messaggio prende un seq nuovo: il polling lo rimanda a tutti con i conteggi aggiornati.
  q.saveReactions.run(Object.keys(counts).length ? JSON.stringify(counts) : null, nextSeq(), msg.id);
  notify(conv);
  return { message: { ...publicMsg(q.msgById.get(msg.id)), myReaction: emoji || null } };
});

route('GET', '/api/messages/:id/reactions', async (req, res, { id }) => {
  const user = auth(req);
  const msg = q.msgById.get(Number(id));
  if (!msg) throw new HttpError(404, 'Message not found');
  getConvOr404(msg.conversation_id, user);
  return { reactions: q.reactionUsers.all(msg.id).map((r) => ({ emoji: r.emoji, userId: r.id, name: r.name })) };
});

// L'app è appena andata in background (telefono bloccato, cambio app): la richiesta in attesa
// potrebbe restare "appesa" senza che il telefono la riceva. La chiudiamo, così il prossimo
// messaggio parte come notifica push e la spunta doppia arriva solo quando è vera.
route('POST', '/api/away', async (req) => {
  const user = auth(req);
  for (const w of [...waiters]) if (w.userId === user.id) w.respond([]);
  return { ok: true };
});

// La notifica push è arrivata sul telefono (la segnala il service worker): seconda spunta.
route('POST', '/api/delivered', async (req) => {
  const user = auth(req);
  const { messageId } = await readJson(req);
  const msg = q.msgById.get(Number(messageId));
  if (!msg) throw new HttpError(404, 'Message not found');
  getConvOr404(msg.conversation_id, user);
  noteDelivered(user.id, [msg]);
  return { ok: true };
});

route('GET', '/api/poll', async (req, res, params, url) => {
  const user = auth(req);
  const since = Math.max(0, Number(url.searchParams.get('since')) || 0);
  // Il telefono può chiedere un'attesa più corta: alcune reti (es. Wi-Fi di bordo)
  // chiudono le connessioni rimaste ferme troppo a lungo.
  const waitMs = Math.min(POLL_TIMEOUT_MS, Math.max(1_000, (Number(url.searchParams.get('t')) || 0) * 1000 || POLL_TIMEOUT_MS));
  const rows = q.since.all(since, user.id, user.is_admin, user.id);
  const reply = (list) => {
    noteDelivered(user.id, list);
    return {
      messages: list.map(publicMsg),
      cursor: list.length ? list[list.length - 1].seq : Math.max(since, seq),
      receipts: drainReceipts(user.id),
      conversations: drainConvs(user),
    };
  };
  if (rows.length || pendingReceipts.has(user.id) || pendingConvs.has(user.id)) return reply(rows);
  return new Promise((resolve) => {
    const w = {
      userId: user.id,
      since,
      visible: url.searchParams.get('v') === '1', // app aperta e in primo piano
      isAdmin: user.is_admin ? 1 : 0,
      respond(list, shared) {
        if (!waiters.delete(w)) return;
        clearTimeout(w.timer);
        if (!shared) return resolve(reply(list));
        // Risposta già serializzata e compressa, condivisa con chi era allo stesso punto.
        // (solo messaggi pubblici: niente spunte né aggiornamenti personali, che arrivano al giro dopo)
        if (!shared.json) shared.json = Buffer.from(JSON.stringify({ messages: list.map(publicMsg), cursor: list[list.length - 1].seq }));
        sendEncoded(req, res, shared);
        resolve();
      },
    };
    w.timer = setTimeout(() => w.respond([]), waitMs);
    res.on('close', () => { if (waiters.delete(w)) clearTimeout(w.timer); });
    waiters.add(w);
  });
});

// --- Notifiche push ------------------------------------------------------------
route('GET', '/api/push/key', async (req) => {
  auth(req);
  return { publicKey: push.publicKey };
});

route('POST', '/api/push/subscribe', async (req) => {
  const user = auth(req);
  const body = await readJson(req);
  if (!push.subscribe(user.id, body.subscription)) throw new HttpError(400, 'Invalid notification subscription');
  return { ok: true };
});

// Notifica di prova: { delay } in secondi (0–30) per avere il tempo di bloccare il telefono.
route('POST', '/api/push/test', async (req) => {
  const user = auth(req);
  const { delay } = await readJson(req);
  const wait = Math.min(30, Math.max(0, Number(delay) || 0)) * 1000;
  const message = { title: '🔔 Test notification', body: 'Notifications work on this phone 🎉', tag: 'test' };
  if (!wait) return { results: await push.test(user.id, message) };
  const devices = q.pushCount.get(user.id).n;
  setTimeout(() => push.test(user.id, message).then((r) => {
    for (const x of r) if (!x.ok) console.error(`push di prova fallita (utente ${user.id}, ${x.device}): ${x.status || ''} ${x.error}`);
  }), wait);
  return { devices };
});

route('POST', '/api/push/unsubscribe', async (req) => {
  const user = auth(req);
  const body = await readJson(req);
  push.unsubscribe(user.id, body.endpoint);
  return { ok: true };
});

// --- Organizzatori -----------------------------------------------------------
route('POST', '/api/admin/channels', async (req) => {
  const user = auth(req);
  requireAdmin(user);
  const body = await readJson(req);
  const name = cleanName(body.name);
  if (name.length < 2) throw new HttpError(400, 'Channel name too short');
  const type = body.announce ? 'announce' : 'public';
  const conv = createGroupLike(type, name, user.id, []);
  postMessage(conv, user.id, `New channel: ${name}`);
  return { id: conv.id };
});

route('POST', '/api/admin/ban', async (req) => {
  const user = auth(req);
  requireAdmin(user);
  const body = await readJson(req);
  const target = q.userById.get(Number(body.userId));
  if (!target) throw new HttpError(404, 'User not found');
  if (target.is_admin) throw new HttpError(400, 'You cannot suspend an organiser');
  const banned = body.banned === false ? 0 : 1;
  q.setBanned.run(banned, target.id);
  if (banned) q.deleteUserSessions.run(target.id);
  return { ok: true };
});

// Password dimenticata: un organizzatore la azzera e la persona viene disconnessa. Riceve un
// codice da dare alla persona, che al prossimo accesso lo inserisce e sceglie una nuova password.
route('POST', '/api/admin/reset-password', async (req) => {
  const user = auth(req);
  requireAdmin(user);
  const body = await readJson(req);
  const target = q.userById.get(Number(body.userId));
  if (!target) throw new HttpError(404, 'User not found');
  const email = q.userEmail.get(target.id).email;
  q.setPassword.run(null, target.id);
  q.deleteUserSessions.run(target.id);
  pwFailures.delete(email);
  // A bordo l'email potrebbe non arrivare: l'organizzatore dà questo codice a voce.
  return { ok: true, code: storeCode(email, 'staff', STAFF_CODE_TTL) };
});

// Abilita un'email che non è nell'elenco (es. iscritto con un indirizzo diverso).
route('POST', '/api/admin/allow', async (req) => {
  const user = auth(req);
  requireAdmin(user);
  const body = await readJson(req);
  const email = normalizeEmail(body.email);
  if (!isValidEmail(email)) throw new HttpError(400, 'Invalid email');
  const already = isAllowedEmail(email) || !!q.userByEmail.get(email);
  if (!already) q.allowEmail.run(email, user.id, Date.now());
  return { ok: true, already };
});

// Apre o chiude le iscrizioni per i nuovi partecipanti.
route('GET', '/api/admin/signups', async (req) => {
  requireAdmin(auth(req));
  return { open: signupsOpen() };
});
route('PUT', '/api/admin/signups', async (req) => {
  const user = auth(req);
  requireAdmin(user);
  const { open } = await readJson(req);
  q.setSetting.run('signups', open ? 'open' : 'closed', user.id, Date.now());
  return { open: signupsOpen() };
});
// Apre o chiude la chat con lo staff per i partecipanti.
route('GET', '/api/admin/support', async (req) => {
  requireAdmin(auth(req));
  return { open: supportOpen() };
});
route('PUT', '/api/admin/support', async (req) => {
  const user = auth(req);
  requireAdmin(user);
  const { open } = await readJson(req);
  q.setSetting.run('support', open ? 'open' : 'closed', user.id, Date.now());
  return { open: supportOpen() };
});

// Statistiche live: solo per chi è in STATS_EMAILS (di default Filippo). Calcolate al massimo
// una volta ogni 10 secondi e condivise: aprire la pagina da più telefoni non pesa sul server.
const STATS_EMAILS = new Set(String(process.env.STATS_EMAILS || 'roca.filippo1999@gmail.com').split(',').map(normalizeEmail).filter(Boolean));
const canSeeStats = (user) => !!user.is_admin && STATS_EMAILS.has(user.email);
const sq = {
  counts: db.prepare(`SELECT
      (SELECT COUNT(*) FROM users WHERE is_admin = 0) AS participants,
      (SELECT COUNT(*) FROM users WHERE is_admin = 1) AS admins,
      (SELECT COUNT(*) FROM users WHERE is_admin = 0 AND created_at > ?) AS today,
      (SELECT COUNT(*) FROM users WHERE is_admin = 0 AND created_at > ?) AS lastHour,
      (SELECT COUNT(*) FROM users WHERE last_seen > ?) AS active24h,
      (SELECT COUNT(*) FROM users WHERE last_seen > ?) AS active1h,
      (SELECT COUNT(DISTINCT user_id) FROM push_subscriptions) AS notifications,
      (SELECT COUNT(*) FROM users WHERE profile IS NOT NULL AND profile NOT IN ('', '{}')) AS profiles,
      (SELECT COUNT(*) FROM messages WHERE deleted = 0) AS messages,
      (SELECT COUNT(*) FROM messages WHERE deleted = 0 AND created_at > ?) AS messagesToday,
      (SELECT COUNT(*) FROM messages WHERE deleted = 0 AND created_at > ?) AS messagesHour,
      (SELECT COUNT(*) FROM conversations WHERE type = 'group') AS groups,
      (SELECT COUNT(*) FROM conversations WHERE type = 'dm') AS dms,
      (SELECT COUNT(*) FROM conversations WHERE type = 'staff') AS support`),
  signupTimes: db.prepare(`SELECT created_at FROM users WHERE is_admin = 0 AND created_at > ?`),
  recent: db.prepare(`SELECT name, created_at FROM users WHERE is_admin = 0 ORDER BY id DESC LIMIT 8`),
};
let statsCache = null;

// Salute del server in percentuale, con i limiti veri del container (Render Standard: 1 CPU,
// 2 GB di memoria; il disco è quello montato sulla cartella dei dati).
const readNum = (file) => { try { const v = fs.readFileSync(file, 'utf8').trim().split(/\s+/); return v; } catch { return null; } };
const CPU_LIMIT = (() => {
  const v2 = readNum('/sys/fs/cgroup/cpu.max'); // "quota periodo" oppure "max periodo"
  if (v2 && v2[0] !== 'max') return Number(v2[0]) / Number(v2[1]);
  const q1 = readNum('/sys/fs/cgroup/cpu/cpu.cfs_quota_us'), p1 = readNum('/sys/fs/cgroup/cpu/cpu.cfs_period_us');
  if (q1 && p1 && Number(q1[0]) > 0) return Number(q1[0]) / Number(p1[0]);
  // Senza limite leggibile: quello del piano (Standard = 1 CPU), non i core di tutta la macchina.
  return Number(process.env.CPU_LIMIT) || (process.env.NODE_ENV === 'production' ? 1 : os.availableParallelism());
})();
const MEM_LIMIT = (() => {
  const v = readNum('/sys/fs/cgroup/memory.max') || readNum('/sys/fs/cgroup/memory/memory.limit_in_bytes');
  const n = v && Number(v[0]);
  if (n && n < os.totalmem()) return n;
  if (process.env.MEM_LIMIT_MB) return Number(process.env.MEM_LIMIT_MB) * 1048576;
  return process.env.NODE_ENV === 'production' ? Math.min(2048 * 1048576, os.totalmem()) : os.totalmem(); // Standard = 2 GB
})();
const loopDelay = monitorEventLoopDelay({ resolution: 20 });
loopDelay.enable();
let cpuSample = { at: Date.now(), usage: process.cpuUsage() };
function health() {
  const now = Date.now();
  const usage = process.cpuUsage();
  const used = (usage.user - cpuSample.usage.user + usage.system - cpuSample.usage.system) / 1000; // ms
  const cpu = Math.min(100, Math.round((used / Math.max(1, now - cpuSample.at) / CPU_LIMIT) * 100));
  cpuSample = { at: now, usage };
  const rss = process.memoryUsage().rss;
  let disk = null;
  try {
    const st = fs.statfsSync(DATA_DIR);
    const total = st.blocks * st.bsize, free = st.bavail * st.bsize;
    let dbSize = 0;
    for (const f of ['chat.db', 'chat.db-wal']) { try { dbSize += fs.statSync(path.join(DATA_DIR, f)).size; } catch {} }
    disk = { pct: Math.round(((total - free) / total) * 100), usedMb: Math.round((total - free) / 1048576), totalMb: Math.round(total / 1048576), dbMb: Math.round(dbSize / 1048576 * 10) / 10 };
  } catch {}
  const lag = Math.round(loopDelay.mean / 1e6);
  loopDelay.reset();
  return {
    cpu, cpus: Math.round(CPU_LIMIT * 10) / 10,
    memory: { pct: Math.round((rss / MEM_LIMIT) * 100), usedMb: Math.round(rss / 1048576), totalMb: Math.round(MEM_LIMIT / 1048576) },
    disk, lagMs: lag,
  };
}
const romeDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit' });
function buildStats() {
  const now = Date.now();
  // Mezzanotte di oggi, ora italiana
  const todayKey = romeDay.format(now);
  let midnight = now - (now % 3600_000);
  while (romeDay.format(midnight - 1) === todayKey) midnight -= 3600_000;
  const c = sq.counts.get(midnight, now - 3600_000, now - 86400_000, now - 3600_000, midnight, now - 3600_000);
  // Iscrizioni degli ultimi 14 giorni, giorno per giorno
  const days = new Map();
  for (let i = 13; i >= 0; i--) days.set(romeDay.format(now - i * 86400_000), 0);
  for (const r of sq.signupTimes.all(now - 14 * 86400_000)) {
    const k = romeDay.format(r.created_at);
    if (days.has(k)) days.set(k, days.get(k) + 1);
  }
  const online = new Set(), foreground = new Set();
  for (const w of waiters) { online.add(w.userId); if (w.visible) foreground.add(w.userId); }
  let active10m = 0;
  for (const t of lastSeen.values()) if (now - t < 600_000) active10m++;
  return {
    at: now,
    users: { participants: c.participants, admins: c.admins, today: c.today, lastHour: c.lastHour, list: PARTICIPANT_HASHES.size, notifications: c.notifications, profiles: c.profiles },
    activity: { online: online.size, foreground: foreground.size, active10m, active1h: c.active1h, active24h: c.active24h },
    chat: { messages: c.messages, today: c.messagesToday, lastHour: c.messagesHour, groups: c.groups, dms: c.dms, support: c.support },
    signupsByDay: [...days].map(([day, n]) => ({ day, n })),
    recent: sq.recent.all().map((r) => ({ name: r.name, at: r.created_at })),
    state: { signupsOpen: signupsOpen(), supportOpen: supportOpen(), unlockAt: UNLOCK_AT > now ? UNLOCK_AT : 0 },
    server: { uptimeMin: Math.round(process.uptime() / 60), connections: waiters.size, ...health() },
  };
}
route('GET', '/api/admin/live-stats', async (req) => {
  const user = auth(req);
  if (!canSeeStats(user)) throw new HttpError(403, 'Not available');
  if (!statsCache || Date.now() - statsCache.at > 10_000) statsCache = buildStats();
  return statsCache;
});

route('GET', '/api/admin/stats', async (req) => {
  const user = auth(req);
  requireAdmin(user);
  return { ...q.stats.get(), online: new Set([...waiters].map((w) => w.userId)).size };
});

route('GET', '/healthz', async () => ({ ok: true }));

// All'ora dello sblocco una notifica a tutti (una volta sola, anche se il server si riavvia).
if (UNLOCK_AT) {
  const unlockCheck = setInterval(() => {
    if (Date.now() < UNLOCK_AT) return;
    clearInterval(unlockCheck);
    if ((q.getSetting.get('unlock-notified') || {}).content) return;
    q.setSetting.run('unlock-notified', '1', null, Date.now());
    try {
      push.notify(null, { title: '🎉 The chat is open!', body: 'Global Reunion is unlocked: say hi to your travel mates 👋', tag: 'unlock' });
    } catch (err) { console.error('push sblocco', err); }
  }, 30_000);
  unlockCheck.unref();
}

// ---------------------------------------------------------------------------
// File statici (tutto servito dallo stesso dominio: nessuna risorsa esterna)
// ---------------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/manifest+json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};
// Le immagini cambiano di rado: i telefoni le tengono in cache una settimana,
// così via satellite si scaricano una volta sola.
const LONG_CACHE = new Set(['.png', '.jpg', '.svg', '.woff2']);
const staticCache = new Map();
// Versione dell'interfaccia: cambia a ogni aggiornamento dei file in public/.
// Viene scritta nella pagina e mandata con ogni risposta: se il telefono ha
// ancora la versione vecchia aperta (iPhone non ricarica le app della Home),
// si accorge della differenza e si ricarica da solo.
const APP_VERSION = (() => {
  const h = crypto.createHash('sha1');
  for (const f of fs.readdirSync(PUBLIC_DIR).sort()) {
    try { h.update(f).update(fs.readFileSync(path.join(PUBLIC_DIR, f))); } catch {}
  }
  return h.digest('hex').slice(0, 12);
})();

function loadStatic(rel) {
  if (staticCache.has(rel)) return staticCache.get(rel);
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return null;
  let raw;
  try { raw = fs.readFileSync(file); } catch { return null; }
  if (rel === 'index.html') raw = Buffer.from(raw.toString('utf8').replaceAll('__APP_VERSION__', APP_VERSION));
  const entry = {
    raw,
    gz: zlib.gzipSync(raw, { level: 9 }),
    type: MIME[path.extname(file)] || 'application/octet-stream',
    cache: LONG_CACHE.has(path.extname(file)) ? 'public, max-age=604800' : 'no-cache',
    compress: !['.png', '.jpg', '.woff2'].includes(path.extname(file)),
    etag: '"' + crypto.createHash('sha1').update(raw).digest('base64url').slice(0, 16) + '"',
  };
  if (process.env.NODE_ENV === 'production') staticCache.set(rel, entry);
  return entry;
}

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || !path.extname(rel)) rel = '/index.html';
  const entry = loadStatic(rel.replace(/^\/+/, ''));
  if (!entry) return send(req, res, 404, { error: 'Not found' });
  const headers = { 'Content-Type': entry.type, ETag: entry.etag, 'Cache-Control': entry.cache, Vary: 'Accept-Encoding' };
  if (req.headers['if-none-match'] === entry.etag) { res.writeHead(304, headers); return res.end(); }
  const gzip = entry.compress && /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''));
  const body = gzip ? entry.gz : entry.raw;
  if (gzip) headers['Content-Encoding'] = 'gzip';
  headers['Content-Length'] = body.length;
  res.writeHead(200, headers);
  res.end(req.method === 'HEAD' ? undefined : body);
}

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
};

const server = http.createServer(async (req, res) => {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  res.setHeader('X-App-Version', APP_VERSION);
  const url = new URL(req.url, 'http://localhost');
  try {
    if (!url.pathname.startsWith('/api/') && url.pathname !== '/healthz') {
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
      return serveStatic(req, res, url.pathname);
    }
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.re.exec(url.pathname);
      if (!m) continue;
      const out = await r.handler(req, res, m.groups || {}, url);
      if (res.writableEnded || res.destroyed) return;
      if (out && out.status) return send(req, res, out.status, out.body, out.headers);
      return send(req, res, 200, out);
    }
    throw new HttpError(404, 'Not found');
  } catch (err) {
    if (!(err instanceof HttpError)) console.error(err);
    if (res.headersSent || res.destroyed) return;
    send(req, res, err.status || 500, { error: err instanceof HttpError ? err.message : 'Server error' });
  }
});

server.keepAliveTimeout = POLL_TIMEOUT_MS + 10_000;
server.headersTimeout = POLL_TIMEOUT_MS + 15_000;
server.requestTimeout = 0;

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Chat nave in ascolto su http://localhost:${PORT}`);
    if (LIST_ONLY) console.log(`Accesso riservato ai partecipanti (${PARTICIPANT_HASHES.size} email in elenco)`);
    if (JOIN_CODE) console.log('Codice evento richiesto ai nuovi iscritti');
  });
}

module.exports = { server };
