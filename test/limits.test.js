'use strict';
// Gruppi di massimo 20 persone; chat con lo staff chiusa finché gli organizzatori non la aprono.
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

const { server } = require('../src/server');

test('limite gruppi e assistenza chiusa', async () => {
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = async (email) => {
    const r = await fetch(base + '/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ firstName: 'P', lastName: email.split('@')[0], email, password: 'secret1' }) });
    const cookie = r.headers.get('set-cookie').split(';')[0];
    return (method, url, body) => fetch(base + url, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
      .then(async (res) => ({ status: res.status, body: await res.json().catch(() => null) }));
  };
  try {
    const staff = await client('staff@x.it');
    // a iscrizioni chiuse servono le email abilitate
    const people = [];
    for (let i = 0; i < 22; i++) { await staff('POST', '/api/admin/allow', { email: `u${i}@x.it` }); people.push(await client(`u${i}@x.it`)); }
    const me = people[0];
    const ids = (await me('GET', '/api/users?q=')).body.users.filter((u) => u.name !== 'P staff').map((u) => u.id);
    assert.ok(ids.length >= 20);

    // 1 + 20 = 21: troppi; 1 + 19 = 20: ok
    assert.equal((await me('POST', '/api/groups', { name: 'Big', memberIds: ids.slice(0, 20) })).status, 400);
    const g = (await me('POST', '/api/groups', { name: 'Cabin', memberIds: ids.slice(0, 19) })).body.id;
    assert.ok(g);
    const add = await me('POST', `/api/conversations/${g}/members`, { userIds: [ids[19]] });
    assert.equal(add.status, 400);
    assert.match(add.body.error, /full/);
    // gruppo da 18: si possono aggiungere 2, non 3
    const g2 = (await me('POST', '/api/groups', { name: 'Deck', memberIds: ids.slice(0, 17) })).body.id;
    assert.equal((await me('POST', `/api/conversations/${g2}/members`, { userIds: ids.slice(17, 20) })).status, 400);
    assert.equal((await me('POST', `/api/conversations/${g2}/members`, { userIds: ids.slice(17, 19) })).status, 200);

    // Assistenza: chiusa per i partecipanti, aperta per gli organizzatori
    assert.equal((await me('GET', '/api/me')).body.supportOpen, false);
    assert.equal((await me('POST', '/api/staff')).status, 403);
    assert.equal((await staff('POST', '/api/staff')).status, 200);
    assert.equal((await me('PUT', '/api/admin/support', { open: true })).status, 403);
    assert.equal((await staff('PUT', '/api/admin/support', { open: true })).body.open, true);
    const sc = (await me('POST', '/api/staff')).body.id;
    assert.equal((await me('POST', `/api/conversations/${sc}/messages`, { text: 'help' })).status, 200);
    // richiusa: la chat esistente non accetta messaggi dal partecipante
    await staff('PUT', '/api/admin/support', { open: false });
    assert.equal((await me('POST', `/api/conversations/${sc}/messages`, { text: 'again' })).status, 403);
    assert.equal((await staff('POST', `/api/conversations/${sc}/messages`, { text: 'we answer' })).status, 200);
  } finally {
    server.close();
    server.closeAllConnections();
  }
});
