'use strict';
// Email con il codice di verifica (OTP). Si usa un servizio di invio via HTTPS, scelto dalle
// variabili d'ambiente:
//   BREVO_API_KEY  oppure  RESEND_API_KEY   (uno dei due)
//   MAIL_FROM      mittente, es. "Global Reunion <chat@vostrodominio.it>"
// Senza chiave l'invio è spento e l'app non chiede il codice (utile per prove in locale).

const FROM = process.env.MAIL_FROM || '';

function parseFrom(from) {
  const m = from.match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
  return m ? { name: m[1].replace(/^"|"$/g, ''), email: m[2] } : { name: 'Global Reunion', email: from.trim() };
}

async function sendBrevo(to, subject, text, html) {
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': process.env.BREVO_API_KEY, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ sender: parseFrom(FROM), to: [{ email: to }], subject, textContent: text, htmlContent: html }),
  });
  if (!res.ok) throw new Error(`Brevo ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

async function sendResend(to, subject, text, html) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: FROM, to: [to], subject, text, html }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

let sender = process.env.BREVO_API_KEY && FROM ? sendBrevo : process.env.RESEND_API_KEY && FROM ? sendResend : null;

function sendCode(to, code) {
  const subject = `${code} is your Global Reunion chat code`;
  const text = `Your code for the Global Reunion – Cruise Edition chat is: ${code}\n\nIt expires in 15 minutes. If you didn't ask for it, just ignore this email.`;
  const html = `<div style="font-family:Arial,sans-serif;max-width:420px;margin:auto;padding:24px;background:#286AD8;border-radius:20px;color:#fff;text-align:center">
  <p style="margin:0 0 6px;font-size:13px;letter-spacing:1px;text-transform:uppercase">WeRoad Global Reunion · Cruise Edition</p>
  <p style="margin:0 0 18px;font-size:16px">Your code to join the chat:</p>
  <p style="margin:0 auto 18px;display:inline-block;background:#EDFB8A;color:#07253D;font-size:34px;font-weight:bold;letter-spacing:8px;padding:12px 20px;border-radius:14px">${code}</p>
  <p style="margin:0;font-size:13px;opacity:.85">It expires in 15 minutes. If you didn't ask for it, just ignore this email.</p>
</div>`;
  return sender(to, subject, text, html);
}

module.exports = {
  get enabled() { return !!sender; },
  sendCode,
  // Per i test: sostituisce l'invio vero.
  setSender(fn) { sender = fn; },
};
