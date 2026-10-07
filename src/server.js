'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { db } = require('./db');
const { normalizeEmail, isValidEmail, cleanName, surnameMatches } = require('./identity');

const PORT = Number(process.env.PORT) || 3000;
const normalizeCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
// Codice evento facoltativo, richiesto solo a chi si registra per la prima volta.
const JOIN_CODE = process.env.JOIN_CODE ? normalizeCode(process.env.JOIN_CODE) : null;
// Con SOLO_ISCRITTI=1 possono entrare solo le email importate dalla lista partecipanti.
const LIST_ONLY = process.env.SOLO_ISCRITTI === '1';
// Email degli organizzatori: diventano admin quando entrano.
// Arrivano dal file organizzatori.txt (una per riga) e dalla variabile ADMIN_EMAILS (separate da virgola).
function loadAdminEmails() {
  let fromFile = '';
  try { fromFile = fs.readFileSync(path.join(__dirname, '..', 'organizzatori.txt'), 'utf8'); } catch {}
  const lines = fromFile.split('\n').filter((l) => !l.trim().startsWith('#'));
  return new Set([...lines, ...String(process.env.ADMIN_EMAILS || '').split(',')].map(normalizeEmail).filter(Boolean));
}
const ADMIN_EMAILS = loadAdminEmails();
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
  insertUser: db.prepare(`INSERT INTO users (name, email, created_at) VALUES (?, ?, ?)`),
  sessionUser: db.prepare(`SELECT u.id, u.name, u.is_admin, u.banned FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`),
  insertSession: db.prepare(`INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)`),
  deleteSession: db.prepare(`DELETE FROM sessions WHERE token = ?`),
  deleteUserSessions: db.prepare(`DELETE FROM sessions WHERE user_id = ?`),
  setBanned: db.prepare(`UPDATE users SET banned = ? WHERE id = ?`),
  makeAdmin: db.prepare(`UPDATE users SET is_admin = 1 WHERE id = ?`),
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
    SELECT c.id, c.type, c.name, c.dm_key,
      (SELECT MAX(id) FROM messages WHERE conversation_id = c.id) AS last_id,
      COALESCE((SELECT last_read_id FROM reads WHERE user_id = ? AND conversation_id = c.id), 0) AS last_read_id
    FROM conversations c
    WHERE c.type IN ('public','announce')
       OR c.id IN (SELECT conversation_id FROM members WHERE user_id = ?)`),
  unread: db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND id > ? AND user_id != ? AND deleted = 0`),
  msgById: db.prepare(`
    SELECT m.id, m.conversation_id, m.user_id, u.name AS user_name, m.text, m.deleted, m.created_at, m.seq
    FROM messages m JOIN users u ON u.id = m.user_id WHERE m.id = ?`),
  history: db.prepare(`
    SELECT m.id, m.conversation_id, m.user_id, u.name AS user_name, m.text, m.deleted, m.created_at, m.seq
    FROM messages m JOIN users u ON u.id = m.user_id
    WHERE m.conversation_id = ? AND m.id < ? ORDER BY m.id DESC LIMIT ?`),
  insertMsg: db.prepare(`INSERT INTO messages (conversation_id, user_id, text, created_at, seq) VALUES (?, ?, ?, ?, ?)`),
  deleteMsg: db.prepare(`UPDATE messages SET deleted = 1, text = '', seq = ? WHERE id = ?`),
  upsertRead: db.prepare(`
    INSERT INTO reads (user_id, conversation_id, last_read_id) VALUES (?, ?, ?)
    ON CONFLICT(user_id, conversation_id) DO UPDATE SET last_read_id = MAX(last_read_id, excluded.last_read_id)`),
  since: db.prepare(`
    SELECT m.id, m.conversation_id, m.user_id, u.name AS user_name, m.text, m.deleted, m.created_at, m.seq
    FROM messages m
    JOIN users u ON u.id = m.user_id
    JOIN conversations c ON c.id = m.conversation_id
    WHERE m.seq > ?
      AND (c.type IN ('public','announce')
           OR EXISTS (SELECT 1 FROM members WHERE conversation_id = c.id AND user_id = ?))
    ORDER BY m.seq LIMIT 300`),
  stats: db.prepare(`SELECT (SELECT COUNT(*) FROM users) AS users, (SELECT COUNT(*) FROM messages) AS messages, (SELECT COUNT(*) FROM conversations) AS conversations`),
};

function publicMsg(m) {
  return {
    id: m.id, conversationId: m.conversation_id, userId: m.user_id, userName: m.user_name,
    text: m.deleted ? '' : m.text, deleted: !!m.deleted, createdAt: m.created_at, seq: m.seq,
  };
}

function canSee(conv, userId) {
  if (!conv) return false;
  if (conv.type === 'public' || conv.type === 'announce') return true;
  return !!q.isMember.get(conv.id, userId);
}

function convTitle(conv, userId) {
  if (conv.type !== 'dm') return conv.name;
  const other = q.members.all(conv.id).find((u) => u.id !== userId);
  return other ? other.name : 'Chat';
}

function conversationSummary(row, userId) {
  const last = row.last_id ? q.msgById.get(row.last_id) : null;
  const summary = {
    id: row.id,
    type: row.type,
    title: convTitle(row, userId),
    lastMessage: last ? publicMsg(last) : null,
    unread: q.unread.get(row.id, row.last_read_id, userId).n,
  };
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

function notify(conv) {
  if (conv.type === 'public' || conv.type === 'announce') pendingAll = true;
  else for (const r of q.memberIds.all(conv.id)) pendingUsers.add(r.user_id);
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
  for (const w of waiters) {
    if (!all && !users.has(w.userId)) continue;
    const rows = q.since.all(w.since, w.userId);
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
const MAX_FAILS = 150;
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of loginFailures) if (now - v.start > FAIL_WINDOW) loginFailures.delete(k);
}, FAIL_WINDOW).unref();
function checkLoginAllowed(req) {
  const f = loginFailures.get(clientIp(req));
  if (f && Date.now() - f.start <= FAIL_WINDOW && f.n >= MAX_FAILS) throw new HttpError(429, 'Troppi tentativi, riprova tra qualche minuto');
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

function readJson(req) {
  return new Promise((resolve, reject) => {
    const ct = String(req.headers['content-type'] || '');
    // Richiedere JSON blocca i form cross-site (protezione CSRF insieme a SameSite).
    if (!ct.startsWith('application/json')) return reject(new HttpError(415, 'Content-Type non valido'));
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new HttpError(413, 'Richiesta troppo grande')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject(new HttpError(400, 'JSON non valido')); }
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

function auth(req) {
  const token = parseCookies(req)[COOKIE];
  const user = token && q.sessionUser.get(token);
  if (!user) throw new HttpError(401, 'Non autenticato');
  if (user.banned) throw new HttpError(403, 'Account sospeso');
  return user;
}

function requireAdmin(user) {
  if (!user.is_admin) throw new HttpError(403, 'Solo gli organizzatori');
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
  if (!canSee(conv, user.id)) throw new HttpError(404, 'Chat non trovata');
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

function postMessage(conv, userId, text) {
  const s = nextSeq();
  const { lastInsertRowid } = q.insertMsg.run(conv.id, userId, text, Date.now(), s);
  q.upsertRead.run(userId, conv.id, lastInsertRowid);
  notify(conv);
  return q.msgById.get(lastInsertRowid);
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
route('POST', '/api/register', async (req) => {
  checkLoginAllowed(req);
  const body = await readJson(req);
  const firstName = cleanName(body.firstName);
  const lastName = cleanName(body.lastName);
  const email = normalizeEmail(body.email);
  if (!firstName || !lastName) throw new HttpError(400, 'Inserisci nome e cognome');
  if (!isValidEmail(email)) throw new HttpError(400, 'Email non valida');

  let user = q.userByEmail.get(email);
  if (user) {
    if (!surnameMatches(user.name, lastName)) {
      throw loginFailed(req, 401, 'Questa email è registrata con un altro cognome');
    }
  } else {
    if (LIST_ONLY) throw loginFailed(req, 403, "Email non presente nella lista dei partecipanti: usa quella con cui ti sei iscritto all'evento");
    if (JOIN_CODE && normalizeCode(body.joinCode) !== JOIN_CODE) throw loginFailed(req, 401, 'Codice evento non valido');
    const name = cleanName(`${firstName} ${lastName}`);
    const { lastInsertRowid } = q.insertUser.run(name, email, Date.now());
    user = q.userById.get(lastInsertRowid);
  }
  if (user.banned) throw new HttpError(403, 'Account sospeso');
  if (ADMIN_EMAILS.has(email) && !user.is_admin) q.makeAdmin.run(user.id);
  return { status: 200, body: { ok: true }, headers: { 'Set-Cookie': startSession(user.id) } };
});

route('POST', '/api/logout', async (req) => {
  const token = parseCookies(req)[COOKIE];
  if (token) q.deleteSession.run(token);
  return { status: 200, body: { ok: true }, headers: { 'Set-Cookie': sessionCookie('', 0) } };
});

route('GET', '/api/me', async (req) => {
  const user = auth(req);
  const conversations = q.visibleConvs.all(user.id, user.id).map((r) => conversationSummary(r, user.id));
  return {
    user: { id: user.id, name: user.name, isAdmin: !!user.is_admin },
    cursor: seq,
    conversations,
  };
});

route('GET', '/api/users', async (req, res, params, url) => {
  const user = auth(req);
  const term = String(url.searchParams.get('q') || '').trim().slice(0, 50);
  const like = '%' + term.replace(/[\\%_]/g, (c) => '\\' + c) + '%';
  return { users: q.searchUsers.all(user.id, like) };
});

route('GET', '/api/conversations/:id', async (req, res, { id }) => {
  const user = auth(req);
  const conv = getConvOr404(id, user);
  const row = q.visibleConvs.all(user.id, user.id).find((r) => r.id === conv.id);
  const summary = conversationSummary(row, user.id);
  if (conv.type === 'group') summary.members = q.members.all(conv.id);
  return summary;
});

route('GET', '/api/conversations/:id/messages', async (req, res, { id }, url) => {
  const user = auth(req);
  const conv = getConvOr404(id, user);
  const before = Number(url.searchParams.get('before')) || Number.MAX_SAFE_INTEGER;
  const rows = q.history.all(conv.id, before, 50).reverse();
  return { messages: rows.map(publicMsg), hasMore: rows.length === 50 };
});

route('POST', '/api/conversations/:id/messages', async (req, res, { id }) => {
  const user = auth(req);
  const conv = getConvOr404(id, user);
  if (conv.type === 'announce' && !user.is_admin) throw new HttpError(403, 'Solo gli organizzatori possono scrivere qui');
  if (!msgLimit(user.id)) throw new HttpError(429, 'Stai scrivendo troppo velocemente');
  const body = await readJson(req);
  const text = String(body.text || '').replace(/\r\n/g, '\n').trim();
  if (!text) throw new HttpError(400, 'Messaggio vuoto');
  if (text.length > MAX_TEXT) throw new HttpError(400, `Massimo ${MAX_TEXT} caratteri`);
  return { message: publicMsg(postMessage(conv, user.id, text)) };
});

route('POST', '/api/conversations/:id/read', async (req, res, { id }) => {
  const user = auth(req);
  const conv = getConvOr404(id, user);
  const body = await readJson(req);
  const lastId = Number(body.messageId) || 0;
  if (lastId > 0) q.upsertRead.run(user.id, conv.id, lastId);
  return { ok: true };
});

route('POST', '/api/dm', async (req) => {
  const user = auth(req);
  const body = await readJson(req);
  const other = q.userById.get(Number(body.userId));
  if (!other || other.banned || other.id === user.id) throw new HttpError(404, 'Utente non trovato');
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

route('POST', '/api/groups', async (req) => {
  const user = auth(req);
  if (!createLimit(user.id)) throw new HttpError(429, 'Troppi gruppi creati, riprova tra poco');
  const body = await readJson(req);
  const name = cleanName(body.name);
  if (name.length < 2) throw new HttpError(400, 'Dai un nome al gruppo');
  const ids = Array.isArray(body.memberIds) ? body.memberIds.map(Number).filter(Boolean).slice(0, 256) : [];
  const conv = createGroupLike('group', name, user.id, ids);
  postMessage(conv, user.id, `👋 ${user.name} ha creato il gruppo "${name}"`);
  return { id: conv.id };
});

route('POST', '/api/conversations/:id/members', async (req, res, { id }) => {
  const user = auth(req);
  const conv = getConvOr404(id, user);
  if (conv.type !== 'group') throw new HttpError(400, 'Si possono aggiungere persone solo ai gruppi');
  const body = await readJson(req);
  const ids = Array.isArray(body.userIds) ? body.userIds.map(Number).filter(Boolean).slice(0, 256) : [];
  const added = [];
  for (const uid of ids) {
    const u = q.userById.get(uid);
    if (u && !u.banned && !q.isMember.get(conv.id, uid)) { q.addMember.run(conv.id, uid); added.push(u.name); }
  }
  if (added.length) postMessage(conv, user.id, `➕ ${user.name} ha aggiunto ${added.join(', ')}`);
  return { ok: true };
});

route('POST', '/api/conversations/:id/leave', async (req, res, { id }) => {
  const user = auth(req);
  const conv = getConvOr404(id, user);
  if (conv.type !== 'group') throw new HttpError(400, 'Puoi uscire solo dai gruppi');
  postMessage(conv, user.id, `🚪 ${user.name} ha lasciato il gruppo`);
  q.removeMember.run(conv.id, user.id);
  return { ok: true };
});

route('DELETE', '/api/messages/:id', async (req, res, { id }) => {
  const user = auth(req);
  const msg = q.msgById.get(Number(id));
  if (!msg) throw new HttpError(404, 'Messaggio non trovato');
  const conv = getConvOr404(msg.conversation_id, user);
  if (msg.user_id !== user.id && !user.is_admin) throw new HttpError(403, 'Non puoi eliminare questo messaggio');
  q.deleteMsg.run(nextSeq(), msg.id);
  notify(conv);
  return { ok: true };
});

route('GET', '/api/poll', async (req, res, params, url) => {
  const user = auth(req);
  const since = Math.max(0, Number(url.searchParams.get('since')) || 0);
  const rows = q.since.all(since, user.id);
  const reply = (list) => ({
    messages: list.map(publicMsg),
    cursor: list.length ? list[list.length - 1].seq : Math.max(since, seq),
  });
  if (rows.length) return reply(rows);
  return new Promise((resolve) => {
    const w = {
      userId: user.id,
      since,
      respond(list) {
        if (!waiters.delete(w)) return;
        clearTimeout(w.timer);
        resolve(reply(list));
      },
    };
    w.timer = setTimeout(() => w.respond([]), POLL_TIMEOUT_MS);
    res.on('close', () => { if (waiters.delete(w)) clearTimeout(w.timer); });
    waiters.add(w);
  });
});

// --- Organizzatori -----------------------------------------------------------
route('POST', '/api/admin/channels', async (req) => {
  const user = auth(req);
  requireAdmin(user);
  const body = await readJson(req);
  const name = cleanName(body.name);
  if (name.length < 2) throw new HttpError(400, 'Nome canale troppo corto');
  const type = body.announce ? 'announce' : 'public';
  const conv = createGroupLike(type, name, user.id, []);
  postMessage(conv, user.id, `Nuovo canale: ${name}`);
  return { id: conv.id };
});

route('POST', '/api/admin/ban', async (req) => {
  const user = auth(req);
  requireAdmin(user);
  const body = await readJson(req);
  const target = q.userById.get(Number(body.userId));
  if (!target) throw new HttpError(404, 'Utente non trovato');
  if (target.is_admin) throw new HttpError(400, 'Non puoi sospendere un organizzatore');
  const banned = body.banned === false ? 0 : 1;
  q.setBanned.run(banned, target.id);
  if (banned) q.deleteUserSessions.run(target.id);
  return { ok: true };
});

route('GET', '/api/admin/stats', async (req) => {
  const user = auth(req);
  requireAdmin(user);
  return { ...q.stats.get(), online: new Set([...waiters].map((w) => w.userId)).size };
});

route('GET', '/healthz', async () => ({ ok: true }));

// ---------------------------------------------------------------------------
// File statici (tutto servito dallo stesso dominio: nessuna risorsa esterna)
// ---------------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/manifest+json',
  '.png': 'image/png', '.ico': 'image/x-icon',
};
const staticCache = new Map();
function loadStatic(rel) {
  if (staticCache.has(rel)) return staticCache.get(rel);
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return null;
  let raw;
  try { raw = fs.readFileSync(file); } catch { return null; }
  const entry = {
    raw,
    gz: zlib.gzipSync(raw, { level: 9 }),
    type: MIME[path.extname(file)] || 'application/octet-stream',
    etag: '"' + crypto.createHash('sha1').update(raw).digest('base64url').slice(0, 16) + '"',
  };
  if (process.env.NODE_ENV === 'production') staticCache.set(rel, entry);
  return entry;
}

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || !path.extname(rel)) rel = '/index.html';
  const entry = loadStatic(rel.replace(/^\/+/, ''));
  if (!entry) return send(req, res, 404, { error: 'Non trovato' });
  const headers = { 'Content-Type': entry.type, ETag: entry.etag, 'Cache-Control': 'no-cache', Vary: 'Accept-Encoding' };
  if (req.headers['if-none-match'] === entry.etag) { res.writeHead(304, headers); return res.end(); }
  const gzip = /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''));
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
  const url = new URL(req.url, 'http://localhost');
  try {
    if (!url.pathname.startsWith('/api/') && url.pathname !== '/healthz') {
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Metodo non consentito');
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
    throw new HttpError(404, 'Non trovato');
  } catch (err) {
    if (!(err instanceof HttpError)) console.error(err);
    if (res.headersSent || res.destroyed) return;
    send(req, res, err.status || 500, { error: err instanceof HttpError ? err.message : 'Errore del server' });
  }
});

server.keepAliveTimeout = POLL_TIMEOUT_MS + 10_000;
server.headersTimeout = POLL_TIMEOUT_MS + 15_000;
server.requestTimeout = 0;

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Chat nave in ascolto su http://localhost:${PORT}`);
    if (LIST_ONLY) console.log('Accesso riservato alle email della lista partecipanti');
    if (JOIN_CODE) console.log('Codice evento richiesto ai nuovi iscritti');
  });
}

module.exports = { server };
