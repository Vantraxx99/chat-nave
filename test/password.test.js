'use strict';
// Password: primo accesso, rientro, vecchi account senza password, cambio, reset dello staff.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-nave-'));
process.env.SECURE_COOKIE = '0';
process.env.PARTICIPANTS_FILE = path.join(process.env.DATA_DIR, 'nessun-elenco');
process.env.ADMIN_EMAILS = 'staff1@x.it';

const { db } = require('../src/db');
const { server } = require('../src/server');

test('password', async () => {
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (method, url, body, cookie) => fetch(base + url, {
    method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined,
  }).then(async (res) => ({ status: res.status, body: await res.json().catch(() => null), cookie: (res.headers.get('set-cookie') || '').split(';')[0] }));
  const step = async (email) => (await call('POST', '/api/login/check', { email })).body.step;
  try {
    // Primo accesso: serve una password di almeno 6 caratteri
    assert.equal(await step('anna@x.it'), 'new');
    assert.equal((await call('POST', '/api/register', { firstName: 'Anna', lastName: 'Bianchi', email: 'anna@x.it', password: '123' })).status, 400);
    assert.equal(await step('anna@x.it'), 'new'); // niente account creato a metà
    const first = await call('POST', '/api/register', { firstName: 'Anna', lastName: 'Bianchi', email: 'anna@x.it', password: 'mare2026' });
    assert.equal(first.status, 200);
    assert.equal((await call('GET', '/api/me', null, first.cookie)).body.user.hasPassword, true);
    assert.equal(db.prepare(`SELECT password_hash FROM users WHERE email = 'anna@x.it'`).get().password_hash.includes('mare2026'), false);

    // Rientro: basta la password giusta (nome e cognome non servono)
    assert.equal(await step(' ANNA@x.it '), 'password');
    assert.equal((await call('POST', '/api/register', { email: 'anna@x.it', password: 'sbagliata' })).status, 401);
    assert.equal((await call('POST', '/api/register', { firstName: 'Anna', lastName: 'Bianchi', email: 'anna@x.it' })).status, 401);
    const again = await call('POST', '/api/register', { email: 'anna@x.it', password: 'mare2026' });
    assert.equal(again.status, 200);

    // Account di prima delle password: cognome giusto + nuova password, poi solo password
    db.prepare(`INSERT INTO users (name, email, created_at) VALUES ('Bruno Verdi', 'bruno@x.it', 0)`).run();
    assert.equal(await step('bruno@x.it'), 'setup');
    assert.equal((await call('POST', '/api/register', { lastName: 'Rossi', email: 'bruno@x.it', password: 'nave1234' })).status, 401);
    assert.equal((await call('POST', '/api/register', { lastName: 'Verdi', email: 'bruno@x.it', password: 'x' })).status, 400);
    const bruno = await call('POST', '/api/register', { lastName: 'verdi', email: 'bruno@x.it', password: 'nave1234' });
    assert.equal(bruno.status, 200);
    assert.equal(await step('bruno@x.it'), 'password');
    assert.equal((await call('POST', '/api/register', { lastName: 'Verdi', email: 'bruno@x.it', password: 'altra123' })).status, 401);

    // Chi era già dentro senza password la sceglie dall'app
    db.prepare(`INSERT INTO users (name, email, created_at) VALUES ('Carla Neri', 'carla@x.it', 0)`).run();
    const carla = await call('POST', '/api/register', { lastName: 'Neri', email: 'carla@x.it', password: 'primaxx' });
    db.prepare(`UPDATE users SET password_hash = NULL WHERE email = 'carla@x.it'`).run();
    assert.equal((await call('GET', '/api/me', null, carla.cookie)).body.user.hasPassword, false);
    assert.equal((await call('PUT', '/api/me/password', { password: 'carla2026' }, carla.cookie)).status, 200);
    assert.equal((await call('GET', '/api/me', null, carla.cookie)).body.user.hasPassword, true);

    // Cambio password: serve quella attuale; gli altri dispositivi vengono disconnessi
    assert.equal((await call('PUT', '/api/me/password', { current: 'nope', password: 'nuova2026' }, first.cookie)).status, 401);
    assert.equal((await call('PUT', '/api/me/password', { current: 'mare2026', password: 'nuova2026' }, first.cookie)).status, 200);
    assert.equal((await call('GET', '/api/me', null, first.cookie)).status, 200);
    assert.equal((await call('GET', '/api/me', null, again.cookie)).status, 401);
    assert.equal((await call('POST', '/api/register', { email: 'anna@x.it', password: 'mare2026' })).status, 401);
    assert.equal((await call('POST', '/api/register', { email: 'anna@x.it', password: 'nuova2026' })).status, 200);

    // Troppi tentativi sbagliati sullo stesso account: bloccato anche con la password giusta
    for (let i = 0; i < 10; i++) await call('POST', '/api/register', { email: 'bruno@x.it', password: 'tentativo' + i });
    assert.equal((await call('POST', '/api/register', { email: 'bruno@x.it', password: 'nave1234' })).status, 429);

    // Password dimenticata: un organizzatore la azzera (e sblocca l'account)
    const staff = await call('POST', '/api/register', { firstName: 'Sara', lastName: 'Staff', email: 'staff1@x.it', password: 'staff2026' });
    const brunoId = db.prepare(`SELECT id FROM users WHERE email = 'bruno@x.it'`).get().id;
    assert.equal((await call('POST', '/api/admin/reset-password', { userId: brunoId }, first.cookie)).status, 403);
    assert.equal((await call('POST', '/api/admin/reset-password', { userId: brunoId }, staff.cookie)).status, 200);
    assert.equal((await call('GET', '/api/me', null, bruno.cookie)).status, 401);
    assert.equal(await step('bruno@x.it'), 'setup');
    assert.equal((await call('POST', '/api/register', { lastName: 'Verdi', email: 'bruno@x.it', password: 'ricordo99' })).status, 200);
  } finally {
    server.close();
    server.closeAllConnections?.();
  }
});
