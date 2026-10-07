'use strict';

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function isValidEmail(email) {
  return email.length <= 120 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function cleanName(name) {
  return String(name || '').replace(/\s+/g, ' ').trim().slice(0, 60);
}

// "Città D'Amico" -> "citta d amico": niente accenti, maiuscole o punteggiatura.
function fold(text) {
  return String(text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// Al rientro il cognome digitato deve coincidere con la parte finale del nome
// salvato: "Bianchi" va bene per "Anna Maria Bianchi", "Anna" no.
function surnameMatches(storedName, lastName) {
  const last = fold(lastName);
  return last.length > 0 && (' ' + fold(storedName)).endsWith(' ' + last);
}

module.exports = { normalizeEmail, isValidEmail, cleanName, surnameMatches };
