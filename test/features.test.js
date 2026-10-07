'use strict';
// Risposte ai messaggi, chat con lo staff, pagina "Useful info".
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-nave-'));
process.env.SECURE_COOKIE = '0';
process.env.PARTICIPANTS_FILE = path.join(process.env.DATA_DIR, 'nessun-elenco');
process.env.ADMIN_EMAILS = 'staff1@x.it,staff2@x.it';

const push = require('../src/push');
const { server } = require('../src/server');
const sent = [];
push.setSender(async (sub, payload) => { sent.push({ endpoint: sub.endpoint, ...JSON.parse(payload) }); });

test('risposte, chat con lo staff e info utili', async () => {
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = async (first, last, email) => {
    const r = await fetch(base + '/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ firstName: first, lastName: last, email }) });
    const cookie = r.headers.get('set-cookie').split(';')[0];
    return (method, url, body) => fetch(base + url, { method, headers: { Cookie: cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
      .then(async (res) => ({ status: res.status, body: await res.json().catch(() => null) }));
  };
  try {
    const anna = await client('Anna', 'Bianchi', 'anna@x.it');
    const bruno = await client('Bruno', 'Verdi', 'bruno@x.it');
    const s1 = await client('Sara', 'Staff', 'staff1@x.it');
    const s2 = await client('Marco', 'Staff', 'staff2@x.it');
    const ids = Object.fromEntries((await anna('GET', '/api/users?q=')).body.users.map((u) => [u.name, u.id]));

    // --- Risposte
    const dm = (await anna('POST', '/api/dm', { userId: ids['Bruno Verdi'] })).body.id;
    const first = (await anna('POST', `/api/conversations/${dm}/messages`, { text: 'Cena alle 20?' })).body.message;
    const reply = (await bruno('POST', `/api/conversations/${dm}/messages`, { text: 'Perfetto!', replyTo: first.id })).body.message;
    assert.deepEqual(reply.replyTo, { id: first.id, userId: first.userId, userName: 'Anna Bianchi', text: 'Cena alle 20?', deleted: false });
    const hist = (await anna('GET', `/api/conversations/${dm}/messages`)).body.messages;
    assert.equal(hist.find((m) => m.id === reply.id).replyTo.text, 'Cena alle 20?');
    // Non si risponde a un messaggio di un'altra chat
    const ann = (await s1('GET', '/api/me')).body.conversations.find((c) => c.type === 'announce').id;
    const annMsg = (await s1('POST', `/api/conversations/${ann}/messages`, { text: 'Benvenuti' })).body.message;
    assert.equal((await anna('POST', `/api/conversations/${dm}/messages`, { text: 'x', replyTo: annMsg.id })).status, 400);
    // Se l'originale viene cancellato, la citazione lo dice
    await anna('DELETE', `/api/messages/${first.id}`);
    const after = (await bruno('GET', `/api/conversations/${dm}/messages`)).body.messages.find((m) => m.id === reply.id);
    assert.equal(after.replyTo.deleted, true);
    assert.equal(after.replyTo.text, '');

    // --- Chat con lo staff
    const staffConv = (await anna('POST', '/api/staff')).body.id;
    assert.equal((await anna('POST', '/api/staff')).body.id, staffConv); // sempre la stessa
    for (const [c, n] of [[anna, 'anna'], [s1, 's1'], [s2, 's2'], [bruno, 'bruno']]) {
      await c('POST', '/api/push/subscribe', { subscription: { endpoint: `https://push.example/${n}`, keys: { p256dh: 'k', auth: 'a' } } });
    }
    sent.length = 0;
    await anna('POST', `/api/conversations/${staffConv}/messages`, { text: 'Ho perso la tessera della cabina' });
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(sent.map((x) => x.endpoint).sort(), ['https://push.example/s1', 'https://push.example/s2']);
    assert.equal(sent[0].title, '🛟 Anna Bianchi');
    // Anna la vede come "Staff support", gli organizzatori con il suo nome, Bruno non la vede
    const annaView = (await anna('GET', '/api/me')).body.conversations.find((c) => c.id === staffConv);
    assert.equal(annaView.title, '🛟 Staff support');
    const s2View = (await s2('GET', '/api/me')).body.conversations.find((c) => c.id === staffConv);
    assert.equal(s2View.title, '🛟 Anna Bianchi');
    assert.equal(s2View.unread, 1);
    assert.ok(!(await bruno('GET', '/api/me')).body.conversations.some((c) => c.id === staffConv));
    assert.equal((await bruno('GET', `/api/conversations/${staffConv}/messages`)).status, 404);
    // Risponde un organizzatore: la notifica va ad Anna (e all'altro organizzatore)
    sent.length = 0;
    await s2('POST', `/api/conversations/${staffConv}/messages`, { text: 'Passa alla reception, ponte 5' });
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(sent.map((x) => x.endpoint).sort(), ['https://push.example/anna', 'https://push.example/s1']);
    assert.equal(sent.find((x) => x.endpoint.endsWith('anna')).title, '🛟 Staff support');

    // --- Useful info
    const def = (await anna('GET', '/api/info')).body;
    assert.match(def.content, /Welcome aboard/);
    assert.equal((await anna('PUT', '/api/info', { content: 'hack' })).status, 403);
    assert.equal((await s1('PUT', '/api/info', { content: '# Info\n- Reception: deck 5' })).status, 200);
    const info = (await bruno('GET', '/api/info')).body;
    assert.equal(info.content, '# Info\n- Reception: deck 5');
    assert.equal(info.updatedBy, 'Sara Staff');
  } finally { server.closeAllConnections(); server.close(); }
});
