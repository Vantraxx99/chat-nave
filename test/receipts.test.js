'use strict';
// Spunte (consegnato / letto) e richieste allo staff segnate come risolte.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-nave-'));
process.env.SECURE_COOKIE = '0';
process.env.PARTICIPANTS_FILE = path.join(process.env.DATA_DIR, 'nessun-elenco');
process.env.ADMIN_EMAILS = 'staff1@x.it,staff2@x.it';

const { server } = require('../src/server');

test('spunte e richieste risolte', async () => {
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
    const s1 = await client('Sara', 'Staff', 'staff1@x.it');
    const s2 = await client('Marco', 'Staff', 'staff2@x.it');
    const ids = Object.fromEntries((await s1('GET', '/api/users?q=')).body.users.map((u) => [u.name, u.id]));

    // --- Chat privata: inviato → consegnato (Bruno lo riceve) → letto
    const dm = (await anna('POST', '/api/dm', { userId: ids['Bruno Verdi'] })).body.id;
    const cur = (await anna('GET', '/api/me')).body.cursor;
    const m = (await anna('POST', `/api/conversations/${dm}/messages`, { text: 'Ciao!' })).body.message;
    let r = (await anna('GET', `/api/conversations/${dm}/messages`)).body.receipt;
    assert.deepEqual([r.read, r.delivered], [0, 0]); // solo inviato
    const annaPoll = anna('GET', `/api/poll?since=${cur + 1}`); // Anna aspetta novità
    await bruno('GET', `/api/poll?since=${cur}`); // il messaggio arriva sul telefono di Bruno
    let got = (await annaPoll).body;
    assert.deepEqual(got.receipts, [{ conversationId: dm, read: 0, delivered: m.id }]);
    const annaPoll2 = anna('GET', `/api/poll?since=${got.cursor}`);
    await bruno('POST', `/api/conversations/${dm}/read`, { messageId: m.id });
    got = (await annaPoll2).body;
    assert.deepEqual(got.receipts, [{ conversationId: dm, read: m.id, delivered: m.id }]);
    // Bruno non riceve spunte per i messaggi di Anna; la lista di Anna le ha già
    assert.equal((await anna('GET', '/api/me')).body.conversations.find((c) => c.id === dm).receipt.read, m.id);

    // --- Gruppo: blu solo quando l'hanno letto tutti
    const g = (await anna('POST', '/api/groups', { name: 'Ponte 7', memberIds: [ids['Bruno Verdi'], ids['Carla Neri']] })).body.id;
    const gm = (await anna('POST', `/api/conversations/${g}/messages`, { text: 'Stasera?' })).body.message;
    await bruno('POST', `/api/conversations/${g}/read`, { messageId: gm.id });
    r = (await anna('GET', `/api/conversations/${g}/messages`)).body.receipt;
    assert.ok(r.read < gm.id);
    await carla('GET', `/api/conversations/${g}/messages`); // a Carla è arrivato, non l'ha ancora letto
    r = (await anna('GET', `/api/conversations/${g}/messages`)).body.receipt;
    assert.ok(r.delivered >= gm.id && r.read < gm.id);
    await carla('POST', `/api/conversations/${g}/read`, { messageId: gm.id });
    assert.ok((await anna('GET', `/api/conversations/${g}/messages`)).body.receipt.read >= gm.id);

    // --- Staff: per il partecipante basta che legga un organizzatore
    const sc = (await carla('POST', '/api/staff')).body.id;
    const sm = (await carla('POST', `/api/conversations/${sc}/messages`, { text: 'Aiuto' })).body.message;
    await s2('POST', `/api/conversations/${sc}/read`, { messageId: sm.id });
    assert.equal((await carla('GET', `/api/conversations/${sc}/messages`)).body.receipt.read, sm.id);

    // --- Richiesta risolta: archiviata per tutti gli organizzatori, torna attiva se lei riscrive
    assert.equal((await carla('POST', `/api/conversations/${sc}/resolve`, {})).status, 403);
    const cur2 = (await s2('GET', '/api/me')).body.cursor;
    const s2Poll = s2('GET', `/api/poll?since=${cur2}`);
    const res = (await s1('POST', `/api/conversations/${sc}/resolve`, {})).body;
    assert.equal(res.resolvedId, sm.id);
    assert.equal(res.resolvedBy, 'Sara Staff');
    const pushed = (await s2Poll).body.conversations.find((c) => c.id === sc);
    assert.equal(pushed.resolvedId, sm.id); // l'altro organizzatore lo vede subito
    assert.equal((await carla('GET', '/api/me')).body.conversations.find((c) => c.id === sc).resolvedId, undefined); // la partecipante non vede nulla
    const again = (await carla('POST', `/api/conversations/${sc}/messages`, { text: 'Ancora io' })).body.message;
    const view = (await s1('GET', '/api/me')).body.conversations.find((c) => c.id === sc);
    assert.ok(view.lastMessage.id > view.resolvedId && view.lastMessage.id === again.id);
    // Riaprire a mano
    await s1('POST', `/api/conversations/${sc}/resolve`, {});
    assert.equal((await s1('POST', `/api/conversations/${sc}/resolve`, { resolved: false })).body.resolvedId, 0);
    assert.equal((await s1('POST', `/api/conversations/${dm}/resolve`, {})).status, 404); // non è sua
  } finally {
    server.close();
    server.closeAllConnections?.();
  }
});
