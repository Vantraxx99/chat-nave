'use strict';
// Notifiche push: chi le riceve, chi no. L'invio verso Apple/Google è sostituito
// da una funzione finta che registra le notifiche.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-nave-'));
process.env.SECURE_COOKIE = '0';
process.env.PARTICIPANTS_FILE = path.join(process.env.DATA_DIR, 'nessun-elenco');
process.env.ADMIN_EMAILS = 'staff@x.it';

const push = require('../src/push');
const { server } = require('../src/server');

const sent = [];
push.setSender(async (sub, payload) => { sent.push({ endpoint: sub.endpoint, ...JSON.parse(payload) }); });
const settle = () => new Promise((r) => setTimeout(r, 30));

test('le notifiche arrivano a chi deve riceverle e non ha l\'app davanti', async () => {
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = async (first, last, email) => {
    const r = await fetch(base + '/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ firstName: first, lastName: last, email }) });
    const cookie = r.headers.get('set-cookie').split(';')[0];
    const call = (method, url, body) => fetch(base + url, { method, headers: { Cookie: cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
      .then(async (res) => ({ status: res.status, body: await res.json().catch(() => null) }));
    call.cookie = cookie;
    return call;
  };
  const sub = (name) => ({ endpoint: `https://push.example/${name}`, keys: { p256dh: 'k-' + name, auth: 'a-' + name } });
  try {
    const anna = await client('Anna', 'Bianchi', 'anna@x.it');
    const bruno = await client('Bruno', 'Verdi', 'bruno@x.it');
    const staff = await client('Carla', 'Staff', 'staff@x.it');
    assert.match((await anna('GET', '/api/push/key')).body.publicKey, /^[A-Za-z0-9_-]{80,}$/);
    assert.equal((await anna('POST', '/api/push/subscribe', { subscription: { endpoint: 'http://non-https' } })).status, 400);
    for (const [c, n] of [[anna, 'anna'], [bruno, 'bruno'], [staff, 'staff']]) {
      assert.equal((await c('POST', '/api/push/subscribe', { subscription: sub(n) })).status, 200);
    }
    const ids = Object.fromEntries((await anna('GET', '/api/users?q=')).body.users.map((u) => [u.name, u.id]));

    // Chat privata Anna -> Bruno: notifica solo a Bruno, con nome e testo.
    const dm = (await anna('POST', '/api/dm', { userId: ids['Bruno Verdi'] })).body.id;
    sent.length = 0;
    await anna('POST', `/api/conversations/${dm}/messages`, { text: 'Ci vediamo al bar?' });
    await settle();
    assert.deepEqual(sent.map((s) => s.endpoint), ['https://push.example/bruno']);
    assert.equal(sent[0].title, 'Anna Bianchi');
    assert.equal(sent[0].body, 'Ci vediamo al bar?');
    assert.equal(sent[0].convId, dm);

    // Bruno ha l'app aperta e visibile: niente push (gli basta suono e vibrazione).
    const me = (await bruno('GET', '/api/me')).body;
    const controller = new AbortController();
    const waiting = fetch(`${base}/api/poll?since=${me.cursor}&v=1`, { headers: { Cookie: bruno.cookie }, signal: controller.signal }).catch(() => {});
    await new Promise((r) => setTimeout(r, 50));
    sent.length = 0;
    await anna('POST', `/api/conversations/${dm}/messages`, { text: 'Ci sei?' });
    await settle();
    assert.deepEqual(sent, []);
    controller.abort(); await waiting;

    // Annuncio: a tutti tranne chi l'ha scritto.
    const announce = (await staff('GET', '/api/me')).body.conversations.find((c) => c.type === 'announce').id;
    sent.length = 0;
    await staff('POST', `/api/conversations/${announce}/messages`, { text: 'Cena alle 20' });
    await settle();
    assert.deepEqual(sent.map((s) => s.endpoint).sort(), ['https://push.example/anna', 'https://push.example/bruno']);
    assert.equal(sent[0].title, '📢 Annunci');

    // Disiscrizione
    await bruno('POST', '/api/push/unsubscribe', { endpoint: 'https://push.example/bruno' });
    sent.length = 0;
    await anna('POST', `/api/conversations/${dm}/messages`, { text: 'ok' });
    await settle();
    assert.deepEqual(sent, []);
  } finally { server.closeAllConnections(); server.close(); }
});
