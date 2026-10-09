'use strict';
// Prima dello sblocco: ci si registra ma non si scrive (gli organizzatori sì).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-nave-'));
process.env.SECURE_COOKIE = '0';
process.env.PARTICIPANTS_FILE = path.join(process.env.DATA_DIR, 'nessun-elenco');
process.env.ADMIN_EMAILS = 'staff@x.it';
const UNLOCK = Date.now() + 3 * 86400_000;
process.env.UNLOCK_AT = new Date(UNLOCK).toISOString();

const { server } = require('../src/server');

test('chat bloccata fino allo sblocco', async () => {
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = async (email) => {
    const r = await fetch(base + '/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ firstName: 'P', lastName: email.split('@')[0], email, password: 'secret1' }) });
    assert.equal(r.status, 200); // registrarsi si può
    const cookie = r.headers.get('set-cookie').split(';')[0];
    return (method, url, body) => fetch(base + url, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
      .then(async (res) => ({ status: res.status, body: await res.json().catch(() => null) }));
  };
  try {
    const anna = await client('anna@x.it');
    const staff = await client('staff@x.it');
    const me = (await anna('GET', '/api/me')).body;
    assert.equal(me.unlockAt, Date.parse(new Date(UNLOCK).toISOString()));
    assert.ok(Math.abs(me.now - Date.now()) < 5000);
    assert.equal((await staff('GET', '/api/me')).body.unlockAt, 0); // organizzatori: chat normale

    const general = me.conversations.find((c) => c.type === 'public');
    if (general) assert.equal((await anna('POST', `/api/conversations/${general.id}/messages`, { text: 'hi' })).status, 403);
    const ids = (await anna('GET', '/api/users?q=P')).body.users;
    const staffId = ids.find((u) => u.name.includes('staff')).id;
    assert.equal((await anna('POST', '/api/dm', { userId: staffId })).status, 403);
    assert.equal((await anna('POST', '/api/groups', { name: 'Cabin', memberIds: [] })).status, 403);
    // il profilo si può già completare
    assert.equal((await anna('PUT', '/api/me/profile', { city: 'Milano' })).status, 200);
    // gli organizzatori scrivono (es. annunci) anche prima
    const ann = (await staff('GET', '/api/me')).body.conversations.find((c) => c.type === 'announce').id;
    assert.equal((await staff('POST', `/api/conversations/${ann}/messages`, { text: 'See you on the 20th!' })).status, 200);
  } finally {
    server.close();
    server.closeAllConnections();
  }
});
