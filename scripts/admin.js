#!/usr/bin/env node
'use strict';
// Piccoli comandi di gestione da riga di comando.
//
//   node scripts/admin.js add "Mario Rossi" mario@email.it [--admin]   crea un utente
//   node scripts/admin.js promote mario@email.it                       rende organizzatore
//   node scripts/admin.js unban mario@email.it                         riattiva un utente sospeso
//   node scripts/admin.js find rossi                                   cerca utenti per nome o email
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
  case 'stats': {
    console.log(db.prepare(`SELECT (SELECT COUNT(*) FROM users) AS utenti, (SELECT COUNT(*) FROM messages) AS messaggi, (SELECT COUNT(*) FROM conversations) AS chat`).get());
    break;
  }
  default:
    usage();
}

function usage() {
  console.log(require('node:fs').readFileSync(__filename, 'utf8').split('\n').slice(2, 10).join('\n').replace(/^\/\/ ?/gm, ''));
  process.exit(1);
}
