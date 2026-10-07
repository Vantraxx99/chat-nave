'use strict';
const crypto = require('node:crypto');

// Niente caratteri ambigui (0/O, 1/I/L) per codici facili da digitare dal telefono.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function generateCode(length = 6) {
  let out = '';
  const bytes = crypto.randomBytes(length);
  for (let i = 0; i < length; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

function normalizeCode(code) {
  return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

module.exports = { generateCode, normalizeCode };
