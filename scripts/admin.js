#!/usr/bin/env node
'use strict';
// Piccoli comandi di gestione da riga di comando.
//
//   node scripts/admin.js add "Mario Rossi" mario@email.it [--admin]   crea un utente
//   node scripts/admin.js promote mario@email.it                       rende organizzatore
//   node scripts/admin.js unban mario@email.it                         riattiva un utente sospeso
//   node scripts/admin.js find rossi                                   cerca utenti per nome o email
//   node scripts/admin.js delete mario@email.it [--yes]                elimina account, messaggi e chat private
//   node scripts/admin.js stats

const { db } = require('../src/db');
const { normalizeEmail, isValidEmail, cleanName } = require('../src/identity');

const [cmd, ...args] = process.argv.slice(2);

switch (cmd) {
  case 'add': {
    const [name, rawEmail, flag] = args;
    const email = normalizeEmail(rawEmail);
    if (!cleanName(name) || !isValidEmail(email)) usage();
    const admin = flag === '--admin' ? 1 : 0;
    db.prepare(`INSERT INTO users (name, email, imported, is_admin, created_at) VALUES (?, ?, 1, ?, ?)
                ON CONFLICT(email) DO UPDATE SET imported = 1, is_admin = MAX(is_admin, excluded.is_admin)`)
      .run(cleanName(name), email, admin, Date.now());
    console.log(`${cleanName(name)} <${email}> aggiunto${admin ? ' come organizzatore' : ''}.`);
    break;
  }
  case 'promote':
  case 'unban': {
    const sql = cmd === 'promote' ? `UPDATE users SET is_admin = 1 WHERE email = ?` : `UPDATE users SET banned = 0 WHERE email = ?`;
    const r = db.prepare(sql).run(normalizeEmail(args[0]));
    console.log(r.changes ? 'Fatto.' : 'Email non trovata.');
    break;
  }
  case 'find': {
    const term = `%${args[0] || ''}%`;
    const rows = db.prepare(`SELECT id, name, email, is_admin, banned FROM users WHERE name LIKE ? OR email LIKE ? ORDER BY name LIMIT 50`).all(term, term);
    for (const u of rows) console.log(`#${u.id}\t${u.name}\t${u.email}${u.is_admin ? '\t[admin]' : ''}${u.banned ? '\t[sospeso]' : ''}`);
    break;
  }
  case 'delete': {
    const email = normalizeEmail(args[0]);
    const u = db.prepare(`SELECT id, name, email, is_admin FROM users WHERE email = ?`).get(email);
    if (!u) { console.log('Email non trovata.'); break; }
    const n = (sql) => db.prepare(sql).get(u.id).n;
    const msgs = n(`SELECT COUNT(*) AS n FROM messages WHERE user_id = ?`);
    const dms = n(`SELECT COUNT(*) AS n FROM conversations c JOIN members m ON m.conversation_id = c.id WHERE c.type = 'dm' AND m.user_id = ?`);
    console.log(`#${u.id} ${u.name} <${u.email}>${u.is_admin ? ' [admin]' : ''}: ${msgs} messaggi, ${dms} chat private.`);
    if (args[1] !== '--yes') { console.log(`Per eliminarlo davvero: npm run admin -- delete ${u.email} --yes`); break; }
    db.exec('BEGIN');
    try {
      const id = u.id;
      // Chat private e richieste allo staff di questa persona: spariscono con i loro messaggi.
      db.prepare(`DELETE FROM conversations WHERE (type = 'dm' AND id IN (SELECT conversation_id FROM members WHERE user_id = ?)) OR (type = 'staff' AND created_by = ?)`).run(id, id);
      // Le sue reazioni sui messaggi degli altri: si tolgono e si ricontano.
      const touched = db.prepare(`SELECT message_id FROM reactions WHERE user_id = ?`).all(id).map((r) => r.message_id);
      db.prepare(`DELETE FROM reactions WHERE user_id = ?`).run(id);
      const counts = db.prepare(`SELECT emoji, COUNT(*) AS n FROM reactions WHERE message_id = ? GROUP BY emoji ORDER BY MIN(created_at)`);
      const save = db.prepare(`UPDATE messages SET reactions = ? WHERE id = ?`);
      for (const mid of touched) {
        const c = {};
        for (const r of counts.all(mid)) c[r.emoji] = r.n;
        save.run(Object.keys(c).length ? JSON.stringify(c) : null, mid);
      }
      db.prepare(`DELETE FROM messages WHERE user_id = ?`).run(id);
      db.prepare(`UPDATE conversations SET created_by = NULL WHERE created_by = ?`).run(id);
      db.prepare(`UPDATE conversations SET resolved_by = NULL WHERE resolved_by = ?`).run(id);
      db.prepare(`UPDATE allowed_emails SET added_by = NULL WHERE added_by = ?`).run(id);
      db.prepare(`UPDATE info SET updated_by = NULL WHERE updated_by = ?`).run(id);
      db.prepare(`DELETE FROM codes WHERE email = ?`).run(u.email);
      db.prepare(`DELETE FROM users WHERE id = ?`).run(id); // sessioni, gruppi, notifiche, letture: a cascata
      db.exec('COMMIT');
    } catch (err) { db.exec('ROLLBACK'); throw err; }
    console.log('Eliminato. Chi ha la chat aperta smette di vedere i suoi messaggi al prossimo aggiornamento della pagina.');
    break;
  }
  case 'stats': {
    console.log(db.prepare(`SELECT (SELECT COUNT(*) FROM users) AS utenti, (SELECT COUNT(*) FROM messages) AS messaggi, (SELECT COUNT(*) FROM conversations) AS chat`).get());
    break;
  }
  default:
    usage();
}

function usage() {
  console.log(require('node:fs').readFileSync(__filename, 'utf8').split('\n').slice(2, 11).join('\n').replace(/^\/\/ ?/gm, ''));
  process.exit(1);
}
