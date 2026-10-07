'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-nave-'));
process.env.SECURE_COOKIE = '0';
process.env.PARTICIPANTS_FILE = path.join(process.env.DATA_DIR, 'nessun-elenco'); // registrazione aperta
process.env.ADMIN_EMAILS = 'Carla@WeRoad.test';

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

const reg = (firstName, lastName, email, password = 'secret1') => ({ firstName, lastName, email, password });

test('flusso completo: login, canali, DM, gruppi, polling, moderazione', async () => {
  const anna = client(), bruno = client(), carla = client(), estraneo = client();

  assert.equal((await anna('POST', '/api/register', reg('Anna', '', 'anna@x.it'))).status, 400);
  assert.equal((await anna('POST', '/api/register', reg('Anna', 'Bianchi', 'non-una-email'))).status, 400);
  assert.equal((await anna('POST', '/api/register', reg('Anna', 'Bianchi', 'anna@x.it'))).status, 200);
  await bruno('POST', '/api/register', reg('Bruno', 'Verdi', 'bruno@x.it'));
  await carla('POST', '/api/register', reg('Carla', 'Staff', 'carla@weroad.test'));
  assert.equal((await estraneo('GET', '/api/me')).status, 401);
  // Qualcuno prova a entrare con l'email di Anna: senza la sua password non passa
  assert.equal((await estraneo('POST', '/api/register', reg('Anna', 'Bianchi', 'anna@x.it', 'indovino'))).status, 401);
  // Rientro da un altro dispositivo: maiuscole, accenti e spazi non contano
  assert.equal((await client()('POST', '/api/register', reg('anna', ' BIANCHÌ ', ' Anna@X.it'))).status, 200);
  assert.equal((await carla('GET', '/api/me')).body.user.isAdmin, true);

  const me = (await anna('GET', '/api/me')).body;
  assert.equal(me.user.name, 'Anna Bianchi');
  // Di default c'è solo il canale Annunci: niente canale generale.
  assert.deepEqual(me.conversations.map((c) => c.type), ['announce']);
  const announce = me.conversations[0];

  // I gruppi li creano i partecipanti.
  const ids = Object.fromEntries((await anna('GET', '/api/users?q=')).body.users.map((u) => [u.name, u.id]));
  const general = { id: (await anna('POST', '/api/groups', { name: 'Ponte 7', memberIds: [ids['Bruno Verdi'], ids['Carla Staff']] })).body.id };

  // Bruno resta in attesa; il messaggio di Anna nel gruppo lo sveglia.
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
  assert.equal((await bruno('POST', '/api/register', reg('Bruno', 'Verdi', 'bruno@x.it'))).status, 403);
});

test('lista partecipanti e codice evento', async () => {
  const { surnameMatches } = require('../src/identity');
  assert.ok(surnameMatches('Anna Maria De Luca', 'de luca'));
  assert.ok(!surnameMatches('Anna Maria De Luca', 'luc'));
  assert.ok(!surnameMatches('Anna Maria De Luca', 'anna'));
  assert.ok(surnameMatches("Lucia D'Amico", 'd amico'));
});

test('protezioni di base', async () => {
  const c = client();
  await c('POST', '/api/register', reg('Anna', 'Bianchi', 'anna@x.it'));
  const general = { id: (await c('POST', '/api/groups', { name: 'Prova', memberIds: [] })).body.id };
  assert.equal((await c('POST', `/api/conversations/${general.id}/messages`, { text: 'a'.repeat(1001) })).status, 400);
  // Richieste non-JSON rifiutate (CSRF da form)
  const res = await fetch(`${base}/api/register`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'email=anna@x.it' });
  assert.equal(res.status, 415);
  // Path traversal sui file statici
  const tr = await fetch(`${base}/..%2Fsrc%2Fserver.js`);
  assert.notEqual(await tr.text().then((t) => t.includes('DatabaseSync')), true);
});
