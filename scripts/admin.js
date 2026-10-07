#!/usr/bin/env node
'use strict';
// Piccoli comandi di gestione da riga di comando.
//
//   node scripts/admin.js add "Mario Rossi" [--admin]   crea un utente e stampa il codice
//   node scripts/admin.js promote CODICE                  rende organizzatore
//   node scripts/admin.js find "rossi"                    cerca utenti (mostra il codice)
//   node scripts/admin.js stats

const { db } = require('../src/db');
const { generateCode, normalizeCode } = require('../src/codes');

const [cmd, arg, flag] = process.argv.slice(2);

switch (cmd) {
  case 'add': {
    if (!arg) usage();
    let code;
    do { code = generateCode(); } while (db.prepare(`SELECT 1 FROM users WHERE code = ?`).get(code));
    db.prepare(`INSERT INTO users (name, code, is_admin, created_at) VALUES (?, ?, ?, ?)`)
      .run(arg.trim().slice(0, 60), code, flag === '--admin' ? 1 : 0, Date.now());
    console.log(`${arg} → codice ${code}${flag === '--admin' ? ' (organizzatore)' : ''}`);
    break;
  }
  case 'promote': {
    const r = db.prepare(`UPDATE users SET is_admin = 1 WHERE code = ?`).run(normalizeCode(arg));
    console.log(r.changes ? 'Fatto.' : 'Codice non trovato.');
    break;
  }
  case 'find': {
    const rows = db.prepare(`SELECT id, name, code, is_admin, banned FROM users WHERE name LIKE ? ORDER BY name LIMIT 50`).all(`%${arg || ''}%`);
    for (const u of rows) console.log(`#${u.id}\t${u.code}\t${u.name}${u.is_admin ? '\t[admin]' : ''}${u.banned ? '\t[sospeso]' : ''}`);
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
  console.log(require('node:fs').readFileSync(__filename, 'utf8').split('\n').slice(2, 9).join('\n').replace(/^\/\/ ?/gm, ''));
  process.exit(1);
}
