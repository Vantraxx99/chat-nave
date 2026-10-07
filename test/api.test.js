'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-nave-'));
process.env.SECURE_COOKIE = '0';
process.env.JOIN_CODE = 'CROCIERA';

const { db } = require('../src/db');
const { server } = require('../src/server');

let base;
test.before(() => new Promise((r) => server.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; r(); })));
test.after(() => { server.closeAllConnections(); server.close(); });

function client() {
  let cookie = '';
  return async (method, url, body) => {
    const res = await fetch(base + url, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, body: await res.json().catch(() => null) };
  };
}

function addUser(name, code, admin = 0) {
  db.prepare(`INSERT INTO users (name, code, is_admin, created_at) VALUES (?, ?, ?, ?)`).run(name, code, admin, Date.now());
}

test('flusso completo: login, canali, DM, gruppi, polling, moderazione', async () => {
  addUser('Anna Bianchi', 'ANNA22');
  addUser('Bruno Verdi', 'BRUNO2');
  addUser('Carla Staff', 'STAFF9', 1);
  const anna = client(), bruno = client(), carla = client(), estraneo = client();

  assert.equal((await anna('POST', '/api/login', { code: 'wrong' })).status, 401);
  assert.equal((await anna('POST', '/api/login', { code: 'anna22' })).status, 200);
  await bruno('POST', '/api/login', { code: 'BRUNO2' });
  await carla('POST', '/api/login', { code: 'STAFF9' });
  assert.equal((await estraneo('GET', '/api/me')).status, 401);

  const me = (await anna('GET', '/api/me')).body;
  assert.equal(me.user.name, 'Anna Bianchi');
  const general = me.conversations.find((c) => c.type === 'public');
  const announce = me.conversations.find((c) => c.type === 'announce');
  assert.ok(general && announce);

  // Bruno resta in attesa; il messaggio di Anna nel canale generale lo sveglia.
  const cursor = (await bruno('GET', '/api/me')).body.cursor;
  const pending = bruno('GET', `/api/poll?since=${cursor}`);
  await new Promise((r) => setTimeout(r, 50));
  const sent = await anna('POST', `/api/conversations/${general.id}/messages`, { text: 'Ciao a tutti! 🌊' });
  assert.equal(sent.status, 200);
  const polled = (await pending).body;
  assert.equal(polled.messages.length, 1);
  assert.equal(polled.messages[0].text, 'Ciao a tutti! 🌊');

  // Solo gli admin scrivono negli annunci
  assert.equal((await anna('POST', `/api/conversations/${announce.id}/messages`, { text: 'x' })).status, 403);
  assert.equal((await carla('POST', `/api/conversations/${announce.id}/messages`, { text: 'Cena alle 20' })).status, 200);

  // Ricerca e DM
  const found = (await anna('GET', '/api/users?q=brun')).body.users;
  assert.deepEqual(found.map((u) => u.name), ['Bruno Verdi']);
  const dm = (await anna('POST', '/api/dm', { userId: found[0].id })).body;
  const dmAgain = (await bruno('POST', '/api/dm', { userId: me.user.id })).body;
  assert.equal(dm.id, dmAgain.id);
  await anna('POST', `/api/conversations/${dm.id}/messages`, { text: 'Ci vediamo al bar?' });

  // Carla non vede il DM
  assert.equal((await carla('GET', `/api/conversations/${dm.id}/messages`)).status, 404);
  const carlaPoll = (await carla('GET', '/api/poll?since=0')).body.messages;
  assert.ok(!carlaPoll.some((m) => m.conversationId === dm.id));

  // Non letti per Bruno
  const brunoConvs = (await bruno('GET', '/api/me')).body.conversations;
  const brunoDm = brunoConvs.find((c) => c.id === dm.id);
  assert.equal(brunoDm.unread, 1);
  assert.equal(brunoDm.title, 'Anna Bianchi');
  await bruno('POST', `/api/conversations/${dm.id}/read`, { messageId: brunoDm.lastMessage.id });
  assert.equal((await bruno('GET', '/api/me')).body.conversations.find((c) => c.id === dm.id).unread, 0);

  // Gruppi
  const group = (await anna('POST', '/api/groups', { name: 'Cabina 512', memberIds: [found[0].id] })).body;
  assert.ok((await bruno('GET', '/api/me')).body.conversations.some((c) => c.id === group.id));
  assert.equal((await carla('GET', `/api/conversations/${group.id}/messages`)).status, 404);

  // Cancellazione: solo autore o admin, e arriva via polling
  const msgId = sent.body.message.id;
  const c2 = (await bruno('GET', '/api/me')).body.cursor;
  assert.equal((await bruno('DELETE', `/api/messages/${msgId}`)).status, 403);
  assert.equal((await carla('DELETE', `/api/messages/${msgId}`)).status, 200);
  const del = (await bruno('GET', `/api/poll?since=${c2}`)).body.messages;
  assert.equal(del[0].id, msgId);
  assert.equal(del[0].deleted, true);
  assert.equal(del[0].text, '');

  // Sospensione
  assert.equal((await carla('POST', '/api/admin/ban', { userId: found[0].id })).status, 200);
  assert.equal((await bruno('GET', '/api/me')).status, 401);
  assert.equal((await bruno('POST', '/api/login', { code: 'BRUNO2' })).status, 403);
});

test('registrazione con codice evento', async () => {
  const nuovo = client();
  assert.equal((await nuovo('POST', '/api/join', { name: 'Dario', joinCode: 'sbagliato' })).status, 401);
  const r = await nuovo('POST', '/api/join', { name: 'Dario Neri', joinCode: 'crociera' });
  assert.equal(r.status, 200);
  assert.match(r.body.code, /^[A-Z0-9]{6}$/);
  assert.equal((await nuovo('GET', '/api/me')).body.user.name, 'Dario Neri');
});

test('protezioni di base', async () => {
  const c = client();
  await c('POST', '/api/login', { code: 'ANNA22' });
  const general = (await c('GET', '/api/me')).body.conversations.find((x) => x.type === 'public');
  assert.equal((await c('POST', `/api/conversations/${general.id}/messages`, { text: 'a'.repeat(1001) })).status, 400);
  // Richieste non-JSON rifiutate (CSRF da form)
  const res = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'code=ANNA22' });
  assert.equal(res.status, 415);
  // Path traversal sui file statici
  const tr = await fetch(`${base}/..%2Fsrc%2Fserver.js`);
  assert.notEqual(await tr.text().then((t) => t.includes('DatabaseSync')), true);
});
