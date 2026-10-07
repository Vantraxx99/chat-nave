'use strict';
// "Delete chat": chat private nascoste e svuotate solo per chi le elimina, uscita dai gruppi.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-nave-'));
process.env.SECURE_COOKIE = '0';
process.env.PARTICIPANTS_FILE = path.join(process.env.DATA_DIR, 'nessun-elenco');

const { server } = require('../src/server');

test('elimina chat', async () => {
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = async (first, last, email) => {
    const r = await fetch(base + '/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ firstName: first, lastName: last, email, password: 'secret1' }) });
    const cookie = r.headers.get('set-cookie').split(';')[0];
    return (method, url, body) => fetch(base + url, { method, headers: { Cookie: cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
      .then(async (res) => ({ status: res.status, body: await res.json().catch(() => null) }));
  };
  try {
    const anna = await client('Anna', 'Bianchi', 'anna@x.it');
    const bruno = await client('Bruno', 'Verdi', 'bruno@x.it');
    const carla = await client('Carla', 'Neri', 'carla@x.it');
    const ids = Object.fromEntries((await carla('GET', '/api/users?q=')).body.users.map((u) => [u.name, u.id]));
    const dm = (await anna('POST', '/api/dm', { userId: ids['Bruno Verdi'] })).body.id;
    const old = (await bruno('POST', `/api/conversations/${dm}/messages`, { text: 'Vecchio messaggio' })).body.message;
    await anna('POST', `/api/conversations/${dm}/messages`, { text: 'Risposta' });
    await bruno('POST', `/api/conversations/${dm}/messages`, { text: 'Non ancora letto' });

    // Anna elimina la chat: per lei è vuota e senza non letti; Bruno vede tutto
    assert.equal((await anna('DELETE', `/api/conversations/${dm}`)).status, 200);
    let mine = (await anna('GET', '/api/me')).body.conversations.find((c) => c.id === dm);
    assert.equal(mine.lastMessage, null);
    assert.equal(mine.unread, 0);
    assert.ok(mine.clearedId > 0);
    assert.equal((await anna('GET', `/api/conversations/${dm}/messages`)).body.messages.length, 0);
    assert.equal((await bruno('GET', `/api/conversations/${dm}/messages`)).body.messages.length, 3);

    // Una reazione a un messaggio vecchio non la riporta su; un messaggio nuovo sì
    const cursor = (await anna('GET', '/api/me')).body.cursor;
    await bruno('POST', `/api/messages/${old.id}/react`, { emoji: '❤️' });
    await bruno('POST', `/api/conversations/${dm}/messages`, { text: 'Ci sei?' });
    const polled = (await anna('GET', `/api/poll?since=${cursor}`)).body.messages;
    assert.deepEqual(polled.map((m) => m.text), ['Ci sei?']);
    mine = (await anna('GET', '/api/me')).body.conversations.find((c) => c.id === dm);
    assert.equal(mine.lastMessage.text, 'Ci sei?');
    assert.equal(mine.unread, 1);
    assert.deepEqual((await anna('GET', `/api/conversations/${dm}/messages`)).body.messages.map((m) => m.text), ['Ci sei?']);
    // Riaprire la chat privata con la stessa persona porta alla stessa chat
    assert.equal((await anna('POST', '/api/dm', { userId: ids['Bruno Verdi'] })).body.id, dm);

    // Gruppo: eliminarlo vuol dire uscirne
    const group = (await anna('POST', '/api/groups', { name: 'Ponte 7', memberIds: [ids['Bruno Verdi']] })).body.id;
    assert.equal((await bruno('DELETE', `/api/conversations/${group}`)).status, 200);
    assert.equal((await bruno('GET', '/api/me')).body.conversations.some((c) => c.id === group), false);
    assert.equal((await anna('GET', `/api/conversations/${group}/messages`)).body.messages.pop().text, '🚪 Bruno Verdi left the group');

    // Annunci non si eliminano; le chat degli altri nemmeno
    const ann = (await anna('GET', '/api/me')).body.conversations.find((c) => c.type === 'announce').id;
    assert.equal((await anna('DELETE', `/api/conversations/${ann}`)).status, 400);
    assert.equal((await carla('DELETE', `/api/conversations/${dm}`)).status, 404);
  } finally {
    server.close();
    server.closeAllConnections?.();
  }
});
