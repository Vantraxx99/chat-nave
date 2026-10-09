'use strict';
// Statistiche live: solo per chi è abilitato, calcolate al massimo ogni 10 secondi.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-nave-'));
process.env.SECURE_COOKIE = '0';
process.env.PARTICIPANTS_FILE = path.join(process.env.DATA_DIR, 'nessun-elenco');
process.env.ADMIN_EMAILS = 'boss@x.it,staff@x.it';
process.env.STATS_EMAILS = 'boss@x.it';

const { server } = require('../src/server');

test('statistiche live', async () => {
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = async (email) => {
    const r = await fetch(base + '/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ firstName: 'P', lastName: email.split('@')[0], email, password: 'secret1' }) });
    const cookie = r.headers.get('set-cookie').split(';')[0];
    return (method, url, body) => fetch(base + url, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
      .then(async (res) => ({ status: res.status, body: await res.json().catch(() => null) }));
  };
  try {
    const boss = await client('boss@x.it');
    const staff = await client('staff@x.it');
    const anna = await client('anna@x.it');
    await client('bruno@x.it');
    assert.equal((await boss('GET', '/api/me')).body.canSeeStats, true);
    assert.equal((await staff('GET', '/api/me')).body.canSeeStats, false);
    assert.equal((await anna('GET', '/api/admin/live-stats')).status, 403);
    assert.equal((await staff('GET', '/api/admin/live-stats')).status, 403);
    const s = (await boss('GET', '/api/admin/live-stats')).body;
    assert.equal(s.users.participants, 2);
    assert.equal(s.users.admins, 2);
    assert.equal(s.users.today, 2);
    assert.equal(s.signupsByDay.length, 14);
    assert.equal(s.signupsByDay[13].n, 2);
    assert.ok(s.activity.active10m >= 3);
    assert.deepEqual(s.recent.map((r) => r.name), ['P bruno', 'P anna']);
    // salute del server: percentuali valide
    for (const v of [s.server.cpu, s.server.memory.pct, s.server.disk.pct]) assert.ok(v >= 0 && v <= 100, String(v));
    assert.ok(s.server.memory.totalMb > 0 && s.server.disk.totalMb > 0);
    // nei 10 secondi successivi la risposta è la stessa (nessun nuovo calcolo)
    await client('carla@x.it');
    assert.equal((await boss('GET', '/api/admin/live-stats')).body.at, s.at);
  } finally {
    server.close();
    server.closeAllConnections();
  }
});
