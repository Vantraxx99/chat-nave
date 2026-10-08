'use strict';
// Notifiche push (Web Push): arrivano anche ad app chiusa, passando dai server
// di notifica di Apple e Google. A bordo funzionano solo se la nave sblocca anche
// quei servizi; altrimenti non arrivano, ma il resto della chat funziona lo stesso.
const fs = require('node:fs');
const path = require('node:path');
const webpush = require('web-push');
const { db, DATA_DIR } = require('./db');

// Chiavi VAPID: dalle variabili d'ambiente oppure generate una volta e salvate.
function loadKeys() {
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    return { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
  }
  const file = path.join(DATA_DIR, 'vapid.json');
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  const keys = webpush.generateVAPIDKeys();
  fs.writeFileSync(file, JSON.stringify(keys));
  return keys;
}
const keys = loadKeys();
webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:roca.filippo1999@gmail.com', keys.publicKey, keys.privateKey);

const q = {
  upsert: db.prepare(`
    INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`),
  remove: db.prepare(`DELETE FROM push_subscriptions WHERE endpoint = ?`),
  removeForUser: db.prepare(`DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?`),
  forUser: db.prepare(`SELECT endpoint, p256dh, auth, user_id FROM push_subscriptions WHERE user_id = ?`),
  all: db.prepare(`SELECT endpoint, p256dh, auth, user_id FROM push_subscriptions`),
};

function subscribe(userId, sub) {
  const endpoint = String(sub && sub.endpoint || '');
  const p256dh = String(sub && sub.keys && sub.keys.p256dh || '');
  const auth = String(sub && sub.keys && sub.keys.auth || '');
  if (!/^https:\/\//.test(endpoint) || endpoint.length > 1000 || !p256dh || !auth || p256dh.length > 200 || auth.length > 100) return false;
  q.upsert.run(endpoint, userId, p256dh, auth, Date.now());
  return true;
}

function unsubscribe(userId, endpoint) {
  q.removeForUser.run(String(endpoint || ''), userId);
}

// Invio con poche richieste in parallelo: un annuncio può andare a 1500 persone.
let sender = (sub, payload) => webpush.sendNotification(sub, payload, { TTL: 6 * 3600, urgency: 'high' });
const queue = [];
let active = 0;
const MAX_PARALLEL = 20;

const hostOf = (u) => { try { return new URL(u).host; } catch { return '?'; } };

function pump() {
  while (active < MAX_PARALLEL && queue.length) {
    const { row, payload } = queue.shift();
    active++;
    Promise.resolve()
      .then(() => sender({ endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } }, payload))
      .catch((err) => {
        // 404/410: l'iscrizione non esiste più (app disinstallata, permesso revocato).
        if (err && (err.statusCode === 404 || err.statusCode === 410)) q.remove.run(row.endpoint);
        // Nei log di Render: utile per capire perché a qualcuno non arrivano le notifiche.
        else console.error(`push non inviata (utente ${row.user_id}, ${hostOf(row.endpoint)}): ${err && (err.statusCode || err.code) || ''} ${err && err.body ? String(err.body).slice(0, 120) : (err && err.message) || err}`);
      })
      .finally(() => { active--; pump(); });
  }
}

/**
 * Notifica le persone indicate, saltando quelle in `exclude` (chi ha scritto e
 * chi ha l'app aperta e visibile). userIds = null significa "tutti".
 */
function notify(userIds, message, exclude = new Set()) {
  const payload = JSON.stringify(message);
  const rows = (userIds === null ? q.all.all() : userIds.flatMap((id) => q.forUser.all(id)))
    .filter((r) => !exclude.has(r.user_id));
  for (const row of rows) queue.push({ row, payload });
  pump();
  return rows.length;
}

function setSender(fn) { sender = fn; }

module.exports = { publicKey: keys.publicKey, subscribe, unsubscribe, notify, setSender };
