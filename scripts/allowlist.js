#!/usr/bin/env node
'use strict';
// Genera partecipanti.sha256 (le impronte delle email di chi può registrarsi)
// da uno o più file qualsiasi che contengono email: CSV, testo estratto da PDF…
//
//   node scripts/allowlist.js prenotazioni.csv checkin-team.csv checkin-staff.csv
//
// Le email in chiaro non vengono salvate da nessuna parte. Il file prodotto
// sostituisce quello esistente: passate sempre TUTTI gli elenchi insieme.

const fs = require('node:fs');
const { hashEmail, FILE } = require('../src/allowlist');

const files = process.argv.slice(2);
if (!files.length) {
  console.error('Uso: node scripts/allowlist.js elenco1.csv [elenco2.csv …]');
  process.exit(1);
}
// Il dominio finale è tutto minuscolo o tutto maiuscolo: così "x@weroad.comMario"
// (email attaccata al nome nella colonna dopo) diventa "x@weroad.com".
const rx = /[A-Za-z0-9._%+-]+@(?:[A-Za-z0-9-]+\.)+(?:[A-Z]{2,}|[a-z]{2,})/g;
const emails = new Set();
for (const f of files) {
  const found = (fs.readFileSync(f, 'utf8').match(rx) || []).map((e) => e.toLowerCase());
  found.forEach((e) => emails.add(e));
  console.log(`${f}: ${found.length} email`);
}
const hashes = [...emails].map(hashEmail).sort();
fs.writeFileSync(FILE, '# Impronte SHA-256 delle email dei partecipanti (Global Reunion 2026).\n'
  + '# Generate da scripts/allowlist.js: le email in chiaro NON sono nel repository.\n'
  + hashes.join('\n') + '\n');
console.log(`${hashes.length} partecipanti unici → ${FILE}`);
