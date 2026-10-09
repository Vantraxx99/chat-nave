'use strict';
// Iscrizioni chiuse: entrano solo organizzatori, accesso anticipato ed email abilitate.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-nave-'));
process.env.SECURE_COOKIE = '0';
process.env.PARTICIPANTS_FILE = path.join(process.env.DATA_DIR, 'nessun-elenco');
process.env.ADMIN_EMAILS = 'staff@x.it';
process.env.NODE_ENV = 'production';
process.env.UNLOCK_AT = '0';

const { server } = require('../src/server');

test('iscrizioni chiuse con eccezioni', async () => {
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (url, body, cookie) => fetch(base + url, { method: body === undefined ? 'GET' : url.includes('signups') ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) })
    .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null), cookie: (r.headers.get('set-cookie') || '').split(';')[0] }));
  const reg = (email) => post('/api/register', { firstName: 'A', lastName: 'B', email, password: 'secret1' });
  try {
    assert.equal((await post('/api/login/check', { email: 'random@x.it' })).body.step, 'closed');
    assert.equal((await reg('random@x.it')).status, 403);
    // accesso anticipato (dal file, maiuscole comprese) e organizzatori entrano
    assert.equal((await post('/api/login/check', { email: 'Orlando.Palomba@gmail.com' })).body.step, 'new');
    assert.equal((await reg('orlando.palomba@gmail.com')).status, 200);
    const staff = await reg('staff@x.it');
    assert.equal(staff.status, 200);
    // chi ha già l'account entra anche a iscrizioni chiuse
    assert.equal((await post('/api/login/check', { email: 'orlando.palomba@gmail.com' })).body.step, 'password');
    // email abilitata a mano da un organizzatore
    await post('/api/admin/allow', { email: 'extra@x.it' }, staff.cookie);
    assert.equal((await reg('extra@x.it')).status, 200);
    // solo gli organizzatori possono aprire
    const orl = (await post('/api/register', { email: 'orlando.palomba@gmail.com', password: 'secret1' })).cookie;
    assert.equal((await post('/api/admin/signups', { open: true }, orl)).status, 403);
    assert.equal((await post('/api/admin/signups', { open: true }, staff.cookie)).body.open, true);
    assert.equal((await reg('random@x.it')).status, 200);
  } finally {
    server.close();
    server.closeAllConnections();
  }
});
