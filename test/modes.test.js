'use strict';
// Modalità SOLO_ISCRITTI + JOIN_CODE, in un processo separato (le variabili si leggono all'avvio).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-nave-'));
process.env.SECURE_COOKIE = '0';
process.env.SOLO_ISCRITTI = '1';

const { db } = require('../src/db');
const { server } = require('../src/server');

test('solo le email in lista possono entrare', async () => {
  db.prepare(`INSERT INTO users (name, email, imported, created_at) VALUES ('Anna Maria Bianchi', 'anna@x.it', 1, 0)`).run();
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body) => fetch(base + '/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    assert.equal((await post({ firstName: 'Ospite', lastName: 'Rossi', email: 'ospite@x.it' })).status, 403);
    const ok = await post({ firstName: 'Anna', lastName: 'Bianchi', email: 'anna@x.it' });
    assert.equal(ok.status, 200);
    const me = await fetch(base + '/api/me', { headers: { Cookie: ok.headers.get('set-cookie').split(';')[0] } }).then((r) => r.json());
    assert.equal(me.user.name, 'Anna Maria Bianchi'); // resta il nome della lista
  } finally { server.closeAllConnections(); server.close(); }
});
