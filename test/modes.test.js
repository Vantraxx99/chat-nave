'use strict';
// Registrazione riservata ai partecipanti (elenco di impronte delle email), in un
// processo separato perché la configurazione si legge all'avvio.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-nave-'));
process.env.SECURE_COOKIE = '0';
process.env.ADMIN_EMAILS = 'boss@x.it';
process.env.PARTICIPANTS_FILE = path.join(process.env.DATA_DIR, 'partecipanti.sha256');

const { hashEmail } = require('../src/allowlist');
fs.writeFileSync(process.env.PARTICIPANTS_FILE, `# commento\n${hashEmail('lista@x.it')}\n`);

const { db } = require('../src/db');
const { server } = require('../src/server');

test('solo i partecipanti in elenco possono registrarsi', async () => {
  db.prepare(`INSERT INTO users (name, email, imported, created_at) VALUES ('Anna Maria Bianchi', 'anna@x.it', 1, 0)`).run();
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (url, body, cookie) => fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) });
  const cookieOf = (r) => r.headers.get('set-cookie').split(';')[0];
  try {
    // Non in elenco
    assert.equal((await post('/api/register', { firstName: 'Ospite', lastName: 'Rossi', email: 'ospite@x.it' })).status, 403);
    // In elenco (maiuscole e spazi non contano)
    assert.equal((await post('/api/register', { firstName: 'Lia', lastName: 'Neri', email: ' Lista@X.it ' })).status, 200);
    // Importato da CSV: rientra, con il nome della lista
    const ok = await post('/api/register', { firstName: 'Anna', lastName: 'Bianchi', email: 'anna@x.it' });
    assert.equal(ok.status, 200);
    const me = await fetch(base + '/api/me', { headers: { Cookie: cookieOf(ok) } }).then((r) => r.json());
    assert.equal(me.user.name, 'Anna Maria Bianchi');
    // Un organizzatore entra sempre e può abilitare altre email
    const boss = await post('/api/register', { firstName: 'Capo', lastName: 'Staff', email: 'boss@x.it' });
    assert.equal(boss.status, 200);
    assert.equal((await post('/api/admin/allow', { email: 'ospite@x.it' }, cookieOf(ok))).status, 403); // Anna non è admin
    const allow = await post('/api/admin/allow', { email: 'Ospite@x.it' }, cookieOf(boss));
    assert.deepEqual(await allow.json(), { ok: true, already: false });
    assert.equal((await post('/api/register', { firstName: 'Ospite', lastName: 'Rossi', email: 'ospite@x.it' })).status, 200);
  } finally { server.closeAllConnections(); server.close(); }
});
