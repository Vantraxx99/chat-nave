#!/usr/bin/env node
'use strict';
// Importa i partecipanti da un CSV e genera un codice personale per ciascuno.
//
//   node scripts/import.js partecipanti.csv [codici.csv]
//
// Il CSV deve avere una colonna "nome" (oppure "nome" + "cognome").
// Colonne opzionali: "email" (copiata nell'output), "admin" (1/si/true = organizzatore).
// Separatore ";" o "," rilevato automaticamente. Le persone già importate
// (stesso nome + email) vengono saltate, quindi lo script si può rilanciare.

const fs = require('node:fs');
const { db } = require('../src/db');
const { generateCode } = require('../src/codes');

const [input, output = 'codici.csv'] = process.argv.slice(2);
if (!input) {
  console.error('Uso: node scripts/import.js partecipanti.csv [codici.csv]');
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
if (iNome < 0) {
  console.error('Il CSV deve avere una colonna "nome". Colonne trovate: ' + header.join(', '));
  process.exit(1);
}

const exists = db.prepare(`SELECT code FROM users WHERE name = ? AND COALESCE(email, '') = ?`);
const codeTaken = db.prepare(`SELECT 1 FROM users WHERE code = ?`);
const insert = db.prepare(`INSERT INTO users (name, email, code, is_admin, created_at) VALUES (?, ?, ?, ?, ?)`);

const out = [['nome', 'email', 'codice', 'admin']];
let created = 0, skipped = 0;
db.exec('BEGIN');
for (const r of rows) {
  const name = [r[iNome], iCognome >= 0 ? r[iCognome] : ''].map((s) => (s || '').trim()).filter(Boolean).join(' ').replace(/\s+/g, ' ').slice(0, 60);
  if (!name) continue;
  const email = iEmail >= 0 ? (r[iEmail] || '').trim().toLowerCase() : '';
  const admin = iAdmin >= 0 && /^(1|si|sì|yes|true|x)$/i.test((r[iAdmin] || '').trim()) ? 1 : 0;
  const prev = exists.get(name, email);
  let code;
  if (prev) { code = prev.code; skipped++; }
  else {
    do { code = generateCode(); } while (codeTaken.get(code));
    insert.run(name, email || null, code, admin, Date.now());
    created++;
  }
  out.push([name, email, code, admin ? 'si' : '']);
}
db.exec('COMMIT');

const csvField = (f) => (/[";,\n]/.test(f) ? '"' + f.replace(/"/g, '""') + '"' : f);
fs.writeFileSync(output, '﻿' + out.map((r) => r.map(csvField).join(';')).join('\n') + '\n');
console.log(`Creati ${created} partecipanti, ${skipped} già presenti. Codici scritti in ${output}`);
