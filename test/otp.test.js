'use strict';
// Codice via email alla registrazione e codice dato dallo staff dopo un reset.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-nave-'));
process.env.SECURE_COOKIE = '0';
process.env.PARTICIPANTS_FILE = path.join(process.env.DATA_DIR, 'elenco.sha256');
process.env.ADMIN_EMAILS = 'staff1@x.it';
const { hashEmail } = require('../src/allowlist');
fs.writeFileSync(process.env.PARTICIPANTS_FILE, ['anna@x.it', 'bruno@x.it'].map(hashEmail).join('\n'));

const mail = require('../src/mail');
const inbox = [];
mail.setSender(async (to, subject, text) => { inbox.push({ to, code: text.match(/\b\d{6}\b/)[0] }); });
const { db } = require('../src/db');
const { server } = require('../src/server');

test('codici di verifica', async () => {
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (method, url, body, cookie) => fetch(base + url, {
    method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined,
  }).then(async (res) => ({ status: res.status, body: await res.json().catch(() => null), cookie: (res.headers.get('set-cookie') || '').split(';')[0] }));
  const anna = { firstName: 'Anna', lastName: 'Bianchi', email: 'anna@x.it', password: 'mare2026' };
  try {
    assert.deepEqual((await call('POST', '/api/login/check', { email: 'anna@x.it' })).body, { step: 'new', codeRequired: true });
    // Senza codice l'account non nasce
    assert.equal((await call('POST', '/api/register', anna)).status, 400);
    // Il codice arriva solo a chi è in elenco
    assert.equal((await call('POST', '/api/login/send-code', { email: 'estraneo@x.it' })).status, 403);
    assert.equal(inbox.length, 0);
    assert.equal((await call('POST', '/api/login/send-code', { email: 'Anna@x.it' })).status, 200);
    assert.equal(inbox.length, 1);
    assert.equal(inbox[0].to, 'anna@x.it');
    // Non si chiedono codici a raffica
    assert.equal((await call('POST', '/api/login/send-code', { email: 'anna@x.it' })).status, 429);
    // Codice sbagliato → no; il codice nel database non è in chiaro
    assert.equal((await call('POST', '/api/register', { ...anna, code: '000000' === inbox[0].code ? '111111' : '000000' })).status, 401);
    assert.notEqual(db.prepare(`SELECT code_hash FROM codes WHERE email = 'anna@x.it'`).get().code_hash, inbox[0].code);
    const ok = await call('POST', '/api/register', { ...anna, code: inbox[0].code });
    assert.equal(ok.status, 200);
    // Il codice vale una volta sola; poi si entra con la password
    assert.equal((await call('POST', '/api/login/check', { email: 'anna@x.it' })).body.step, 'password');
    assert.equal((await call('POST', '/api/login/send-code', { email: 'anna@x.it' })).status, 400);
    assert.equal((await call('POST', '/api/register', { email: 'anna@x.it', password: 'mare2026' })).status, 200);

    // Codice indovinato a caso: dopo 5 tentativi sbagliati non vale più, anche se giusto
    db.prepare(`UPDATE codes SET sent_at = 0`).run();
    await call('POST', '/api/login/send-code', { email: 'bruno@x.it' });
    const brunoCode = inbox[inbox.length - 1].code;
    const wrong = brunoCode === '123456' ? '654321' : '123456';
    for (let i = 0; i < 5; i++) await call('POST', '/api/register', { firstName: 'Bruno', lastName: 'Verdi', email: 'bruno@x.it', password: 'nave1234', code: wrong });
    assert.equal((await call('POST', '/api/register', { firstName: 'Bruno', lastName: 'Verdi', email: 'bruno@x.it', password: 'nave1234', code: brunoCode })).status, 401);

    // Password dimenticata a bordo: l'organizzatore la azzera e riceve un codice da dare a voce
    const staffCode = (await call('POST', '/api/login/send-code', { email: 'staff1@x.it' }), inbox[inbox.length - 1].code);
    const staff = await call('POST', '/api/register', { firstName: 'Sara', lastName: 'Staff', email: 'staff1@x.it', password: 'staff2026', code: staffCode });
    assert.equal(staff.status, 200);
    const annaId = db.prepare(`SELECT id FROM users WHERE email = 'anna@x.it'`).get().id;
    const reset = await call('POST', '/api/admin/reset-password', { userId: annaId }, staff.cookie);
    assert.match(reset.body.code, /^\d{6}$/);
    assert.deepEqual((await call('POST', '/api/login/check', { email: 'anna@x.it' })).body, { step: 'setup', codeRequired: true });
    // Chiedere anche il codice via email non annulla quello dato dallo staff
    db.prepare(`UPDATE codes SET sent_at = 0`).run();
    assert.equal((await call('POST', '/api/login/send-code', { email: 'anna@x.it' })).status, 200);
    // Il cognome da solo non basta più: serve il codice
    assert.equal((await call('POST', '/api/register', { lastName: 'Bianchi', email: 'anna@x.it', password: 'nuova2026' })).status, 400);
    assert.equal((await call('POST', '/api/register', { email: 'anna@x.it', password: 'nuova2026', code: reset.body.code })).status, 200);
    assert.equal((await call('POST', '/api/register', { email: 'anna@x.it', password: 'nuova2026' })).status, 200);

    // Se l'email non parte, lo diciamo e il codice non resta valido
    mail.setSender(async () => { throw new Error('servizio giù'); });
    db.prepare(`DELETE FROM users WHERE email = 'bruno@x.it'`).run();
    db.prepare(`UPDATE codes SET sent_at = 0`).run();
    assert.equal((await call('POST', '/api/login/send-code', { email: 'bruno@x.it' })).status, 502);
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM codes WHERE email = 'bruno@x.it'`).get().n, 0);
  } finally {
    server.close();
    server.closeAllConnections?.();
  }
});
