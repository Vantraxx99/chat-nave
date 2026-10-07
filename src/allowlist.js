'use strict';
// Elenco di chi può registrarsi. Nel repository ci sono solo le IMPRONTE (SHA-256
// con un prefisso fisso) delle email dei partecipanti, mai le email in chiaro:
// basta per riconoscere chi si registra senza rendere leggibile l'elenco.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const SALT = 'grw26-chat:';
const FILE = process.env.PARTICIPANTS_FILE || path.join(__dirname, '..', 'partecipanti.sha256');

function hashEmail(email) {
  return crypto.createHash('sha256').update(SALT + email).digest('hex');
}

function loadHashes() {
  let text = '';
  try { text = fs.readFileSync(FILE, 'utf8'); } catch {}
  return new Set(text.split('\n').map((l) => l.trim()).filter((l) => /^[0-9a-f]{64}$/.test(l)));
}

module.exports = { hashEmail, loadHashes, FILE };
