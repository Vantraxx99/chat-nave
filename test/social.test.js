'use strict';
// Reazioni ai messaggi e profili dei partecipanti.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-nave-'));
process.env.SECURE_COOKIE = '0';
process.env.PARTICIPANTS_FILE = path.join(process.env.DATA_DIR, 'nessun-elenco');
process.env.ADMIN_EMAILS = 'staff1@x.it';

const { server } = require('../src/server');

test('reazioni e profili', async () => {
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
    const carla = await client('Carla', 'Neri', 'carla@x.it');
    const staff = await client('Sara', 'Staff', 'staff1@x.it');
    const ids = Object.fromEntries((await carla('GET', '/api/users?q=')).body.users.map((u) => [u.name, u.id]));

    // --- Reazioni
    const dm = (await anna('POST', '/api/dm', { userId: ids['Bruno Verdi'] })).body.id;
    const msg = (await anna('POST', `/api/conversations/${dm}/messages`, { text: 'Aperitivo?' })).body.message;
    const cursor = (await bruno('GET', '/api/me')).body.cursor;
    const pollP = bruno('GET', `/api/poll?since=${cursor}`);
    const r1 = await bruno('POST', `/api/messages/${msg.id}/react`, { emoji: '❤️' });
    assert.equal(r1.status, 200);
    assert.deepEqual(r1.body.message.reactions, { '❤️': 1 });
    assert.equal(r1.body.message.myReaction, '❤️');
    // L'altra persona riceve il messaggio aggiornato dal polling
    const polled = (await pollP).body.messages.find((m) => m.id === msg.id);
    assert.deepEqual(polled.reactions, { '❤️': 1 });
    await anna('POST', `/api/messages/${msg.id}/react`, { emoji: '😂' });
    // Una sola reazione a testa: cambiarla sostituisce la precedente
    await bruno('POST', `/api/messages/${msg.id}/react`, { emoji: '😂' });
    let hist = (await anna('GET', `/api/conversations/${dm}/messages`)).body.messages;
    assert.deepEqual(hist[0].reactions, { '😂': 2 });
    assert.equal(hist[0].myReaction, '😂');
    const who = (await anna('GET', `/api/messages/${msg.id}/reactions`)).body.reactions;
    assert.deepEqual(who.map((r) => r.name).sort(), ['Anna Bianchi', 'Bruno Verdi']);
    // Togliere la reazione
    await bruno('POST', `/api/messages/${msg.id}/react`, { emoji: null });
    hist = (await bruno('GET', `/api/conversations/${dm}/messages`)).body.messages;
    assert.deepEqual(hist[0].reactions, { '😂': 1 });
    assert.equal(hist[0].myReaction, null);
    // Solo le emoji previste; chi non vede la chat non può reagire
    assert.equal((await bruno('POST', `/api/messages/${msg.id}/react`, { emoji: '💩' })).status, 400);
    assert.equal((await carla('POST', `/api/messages/${msg.id}/react`, { emoji: '❤️' })).status, 404);
    assert.equal((await carla('GET', `/api/messages/${msg.id}/reactions`)).status, 404);
    // Anche gli annunci si possono "reagire" da tutti
    const ann = (await staff('GET', '/api/me')).body.conversations.find((c) => c.type === 'announce').id;
    const annMsg = (await staff('POST', `/api/conversations/${ann}/messages`, { text: 'Si salpa!' })).body.message;
    assert.equal((await carla('POST', `/api/messages/${annMsg.id}/react`, { emoji: '🎉' })).status, 200);
    // Un messaggio cancellato perde le reazioni
    await anna('DELETE', `/api/messages/${msg.id}`);
    hist = (await bruno('GET', `/api/conversations/${dm}/messages`)).body.messages;
    assert.equal(hist[0].reactions, null);
    assert.equal((await bruno('POST', `/api/messages/${msg.id}/react`, { emoji: '❤️' })).status, 404);

    // --- Profili
    const saved = await anna('PUT', '/api/me/profile', { profile: {
      instagram: 'https://www.instagram.com/anna.bianchi/', tiktok: '@annab', linkedin: 'https://linkedin.com/in/anna-bianchi',
      whatsapp: '0039 333 123 4567', city: '  Milano  ', bio: 'Amo il mare', extra: 'ignorato',
    } });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.body.profile, { instagram: 'anna.bianchi', tiktok: 'annab', linkedin: 'anna-bianchi', whatsapp: '+393331234567', city: 'Milano', bio: 'Amo il mare' });
    const seen = (await carla('GET', `/api/users/${ids['Anna Bianchi']}`)).body;
    assert.equal(seen.name, 'Anna Bianchi');
    assert.equal(seen.profile.instagram, 'anna.bianchi');
    assert.equal((await anna('GET', '/api/me')).body.user.profile.city, 'Milano');
    assert.equal((await anna('PUT', '/api/me/profile', { profile: { instagram: 'not valid!!' } })).status, 400);
    assert.equal((await anna('PUT', '/api/me/profile', { profile: { whatsapp: 'abc' } })).status, 400);
    // Svuotare il profilo
    assert.deepEqual((await anna('PUT', '/api/me/profile', { profile: {} })).body.profile, {});
    assert.deepEqual((await carla('GET', `/api/users/${ids['Anna Bianchi']}`)).body.profile, {});
    assert.equal((await carla('GET', '/api/users/99999')).status, 404);
  } finally {
    server.close();
    server.closeAllConnections?.();
  }
});
