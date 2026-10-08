'use strict';
// Rete instabile: attesa del polling più corta su richiesta e seconda spunta dalla notifica push.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-nave-'));
process.env.SECURE_COOKIE = '0';
process.env.PARTICIPANTS_FILE = path.join(process.env.DATA_DIR, 'nessun-elenco');

const { server } = require('../src/server');

test('polling breve e consegna confermata dal service worker', async () => {
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
    const ids = Object.fromEntries((await anna('GET', '/api/users?q=')).body.users.map((u) => [u.name, u.id]));

    // t=5: il server risponde (vuoto) dopo 5 secondi invece di 25
    const cur = (await anna('GET', '/api/me')).body.cursor;
    const t0 = Date.now();
    const empty = (await anna('GET', `/api/poll?since=${cur}&t=5`)).body;
    const took = Date.now() - t0;
    assert.ok(took >= 4500 && took < 9000, `attesa ${took} ms`);
    assert.deepEqual(empty.messages, []);

    // Bruno ha l'app chiusa: la notifica arriva e il service worker conferma la consegna
    const dm = (await anna('POST', '/api/dm', { userId: ids['Bruno Verdi'] })).body.id;
    const m = (await anna('POST', `/api/conversations/${dm}/messages`, { text: 'Ciao!' })).body.message;
    assert.equal((await bruno('POST', '/api/delivered', { messageId: m.id })).status, 200);
    const r = (await anna('GET', `/api/conversations/${dm}/messages`)).body.receipt;
    assert.deepEqual([r.read, r.delivered], [0, m.id]);

    // Bruno blocca il telefono: la richiesta in attesa si chiude subito
    const bcur = (await bruno('GET', '/api/me')).body.cursor;
    const t1 = Date.now();
    const pending = bruno('GET', `/api/poll?since=${bcur}&v=1`);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal((await bruno('POST', '/api/away', {})).status, 200);
    await pending;
    assert.ok(Date.now() - t1 < 2000);

    // Chi non vede la chat non può segnarla come consegnata
    assert.equal((await carla('POST', '/api/delivered', { messageId: m.id })).status, 404);
    assert.equal((await carla('POST', '/api/delivered', { messageId: 999999 })).status, 404);
  } finally {
    server.close();
    server.closeAllConnections();
  }
});
