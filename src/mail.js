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

const APP_URL = (process.env.APP_URL || 'https://globalreunionchat.com').replace(/\/$/, '');
const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Email con il codice, nella grafica dell'evento. Tabelle e stili in linea: è l'unico modo
// perché Gmail, Outlook e Apple Mail la mostrino tutti uguale. Le immagini arrivano dal sito.
// purpose: 'signup' (prima registrazione) | 'reset' (nuova password)
function codeEmail(code, { name = '', purpose = 'signup' } = {}) {
  const hi = name ? `Hi ${esc(name)}! 👋` : 'Hi! 👋';
  const why = purpose === 'reset'
    ? 'Here is your code to choose a new password for the Global Reunion chat:'
    : 'Welcome aboard the private chat of the Global Reunion – Cruise Edition! Here is your code to finish signing up:';
  const subject = purpose === 'reset' ? `${code} is your code to reset your password` : `${code} is your Global Reunion chat code`;
  const text = `${name ? `Hi ${name}!` : 'Hi!'}\n\n${why}\n\n${code}\n\nIt expires in 15 minutes. If you didn't ask for it, just ignore this email.\n\nOpen the chat: ${APP_URL}\n\nWeRoad Global Reunion · Cruise Edition`;
  const tip = (icon, title, body) => `<tr><td style="padding:0 0 14px"><table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
    <td width="40" valign="top" style="font-size:22px;line-height:26px">${icon}</td>
    <td valign="top" style="font-family:Helvetica,Arial,sans-serif;font-size:14px;line-height:20px;color:#33475e"><strong style="color:#07253D">${title}</strong><br>${body}</td></tr></table></td></tr>`;
  const tips = purpose === 'reset' ? '' : `
  <tr><td style="padding:8px 32px 6px;font-family:Helvetica,Arial,sans-serif;font-size:12px;font-weight:bold;letter-spacing:1.5px;text-transform:uppercase;color:#286AD8">Before you board</td></tr>
  <tr><td style="padding:8px 32px 4px"><table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
    ${tip('📲', 'Add it to your Home Screen', 'It opens full screen like an app. In the chat: Menu ⋮ → Add to Home Screen.')}
    ${tip('🔔', 'Turn on notifications', 'So you never miss a message from your new friends.')}
    ${tip('🚢', 'On the ship', 'Connect to the ship\'s Wi-Fi and sign in with your email and password.')}
  </table></td></tr>`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:#EEF3FB">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">Your code: ${code} · valid for 15 minutes</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#EEF3FB"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;background:#ffffff;border-radius:24px;overflow:hidden">
  <tr><td align="center" style="background:#286AD8;padding:34px 24px 18px">
    <img src="${APP_URL}/wordmark-t.png" width="270" alt="WeRoad Global Reunion – Cruise Edition" style="display:block;width:270px;max-width:80%;height:auto;border:0;color:#EDFB8A;font:bold 24px Helvetica,Arial,sans-serif">
    <div style="font-family:Helvetica,Arial,sans-serif;font-size:12px;font-weight:bold;letter-spacing:2.5px;text-transform:uppercase;color:#EDFB8A;padding-top:16px">The private chat of the reunion</div>
  </td></tr>
  <tr><td style="background:#286AD8;line-height:0"><img src="${APP_URL}/waves.jpg" width="520" alt="" style="display:block;width:100%;height:auto;border:0"></td></tr>
  <tr><td style="padding:30px 32px 6px;font-family:Helvetica,Arial,sans-serif;font-size:24px;font-weight:bold;color:#07253D">${hi}</td></tr>
  <tr><td style="padding:0 32px 22px;font-family:Helvetica,Arial,sans-serif;font-size:16px;line-height:24px;color:#33475e">${why}</td></tr>
  <tr><td align="center" style="padding:0 32px">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td style="background:#EDFB8A;border:2px solid #07253D;border-radius:18px;padding:14px 26px;font-family:'Courier New',Courier,monospace;font-size:40px;font-weight:bold;letter-spacing:10px;color:#07253D">${code}</td></tr></table>
  </td></tr>
  <tr><td align="center" style="padding:12px 32px 26px;font-family:Helvetica,Arial,sans-serif;font-size:13px;color:#5E7089">The code expires in 15 minutes.</td></tr>
  ${tips}
  <tr><td align="center" style="padding:10px 32px 34px">
    <a href="${APP_URL}" style="display:inline-block;background:#286AD8;color:#ffffff;font-family:Helvetica,Arial,sans-serif;font-size:16px;font-weight:bold;text-decoration:none;padding:14px 30px;border-radius:999px">Open the chat →</a>
  </td></tr>
  <tr><td style="background:#07253D;padding:20px 32px;font-family:Helvetica,Arial,sans-serif;font-size:12px;line-height:18px;color:#c9d6ea" align="center">
    <strong style="color:#EDFB8A">WeRoad Global Reunion · Cruise Edition</strong><br>
    <a href="${APP_URL}" style="color:#ffffff;text-decoration:none">${APP_URL.replace(/^https?:\/\//, '')}</a><br>
    <span style="color:#93A6C2">Didn't ask for this code? Just ignore this email: nobody can sign in without it.</span>
  </td></tr>
</table>
</td></tr></table>
</body></html>`;
  return { subject, text, html };
}

function sendCode(to, code, opts) {
  const { subject, text, html } = codeEmail(code, opts);
  return sender(to, subject, text, html);
}

module.exports = {
  get enabled() { return !!sender; },
  sendCode,
  codeEmail,
  // Per i test: sostituisce l'invio vero.
  setSender(fn) { sender = fn; },
};
