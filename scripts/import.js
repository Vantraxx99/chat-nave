#!/usr/bin/env node
'use strict';
// Importa la lista dei partecipanti da un CSV.
//
//   node scripts/import.js partecipanti.csv
//
// Colonne obbligatorie: "email" e "nome" (oppure "nome" + "cognome").
// Colonna facoltativa: "admin" (1/si/true = organizzatore).
// Separatore ";" o "," rilevato automaticamente. Lo script si può rilanciare:
// chi ha già quell'email viene aggiornato (segnato come in lista, admin se indicato).
//
// I partecipanti entrano poi sul sito con nome, cognome ed email.
// Con SOLO_ISCRITTI=1 solo le email importate possono entrare.

const fs = require('node:fs');
const { db } = require('../src/db');
const { normalizeEmail, isValidEmail, cleanName } = require('../src/identity');

const [input] = process.argv.slice(2);
if (!input) {
  console.error('Uso: node scripts/import.js partecipanti.csv');
  process.exit(1);
}

function parseCsv(text, sep) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === sep) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((f) => f.trim()));
}

const text = fs.readFileSync(input, 'utf8').replace(/^﻿/, '');
const firstLine = text.split(/\r?\n/, 1)[0];
const sep = (firstLine.match(/;/g) || []).length > (firstLine.match(/,/g) || []).length ? ';' : ',';
const [header, ...rows] = parseCsv(text, sep);
const cols = header.map((h) => h.trim().toLowerCase());
const col = (...names) => cols.findIndex((c) => names.includes(c));
const iNome = col('nome', 'name', 'first name', 'nome completo', 'full name');
const iCognome = col('cognome', 'surname', 'last name');
const iEmail = col('email', 'e-mail', 'mail');
const iAdmin = col('admin', 'organizzatore', 'staff');
if (iNome < 0 || iEmail < 0) {
  console.error('Il CSV deve avere le colonne "nome" ed "email". Colonne trovate: ' + header.join(', '));
  process.exit(1);
}

const find = db.prepare(`SELECT id FROM users WHERE email = ?`);
const insert = db.prepare(`INSERT INTO users (name, email, imported, is_admin, created_at) VALUES (?, ?, 1, ?, ?)`);
const update = db.prepare(`UPDATE users SET imported = 1, is_admin = MAX(is_admin, ?) WHERE id = ?`);

let created = 0, updated = 0;
const invalid = [];
db.exec('BEGIN');
rows.forEach((r, i) => {
  const name = cleanName([r[iNome], iCognome >= 0 ? r[iCognome] : ''].map((s) => (s || '').trim()).join(' '));
  const email = normalizeEmail(r[iEmail]);
  if (!name || !isValidEmail(email)) { invalid.push(i + 2); return; }
  const admin = iAdmin >= 0 && /^(1|si|sì|yes|true|x)$/i.test((r[iAdmin] || '').trim()) ? 1 : 0;
  const prev = find.get(email);
  if (prev) { update.run(admin, prev.id); updated++; }
  else { insert.run(name, email, admin, Date.now()); created++; }
});
db.exec('COMMIT');

console.log(`Importati ${created} nuovi partecipanti, ${updated} già presenti.`);
if (invalid.length) console.log(`Righe saltate (nome o email mancanti/non validi): ${invalid.join(', ')}`);
