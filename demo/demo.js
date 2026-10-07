'use strict';
// Server simulato nel browser, usato SOLO per l'anteprima statica.
// Imita le API di src/server.js e popola la chat con partecipanti finti.
(() => {
// Come src/server.js: reazioni disponibili e pulizia dei campi del profilo.
window.DEMO_REACTIONS = ['❤️', '😂', '👍', '🔥', '😮', '😢', '🎉'];
window.DEMO_CLEAN_PROFILE = (input, err) => {
  const handle = (re, label) => (v) => {
    const h = String(v || '').trim().replace(/^https?:\/\/(www\.)?[^/]+\/(in\/)?/i, '').replace(/^@/, '').replace(/[/?#].*$/, '');
    if (h && !re.test(h)) throw err(400, `${label} doesn't look right`);
    return h;
  };
  const text = (max) => (v) => String(v || '').replace(/\s+/g, ' ').trim().slice(0, max);
  const fields = {
    instagram: handle(/^[A-Za-z0-9._]{1,30}$/, 'Instagram username'),
    tiktok: handle(/^[A-Za-z0-9._]{2,24}$/, 'TikTok username'),
    linkedin: handle(/^[A-Za-z0-9\-_%]{3,100}$/, 'LinkedIn profile'),
    whatsapp: (v) => {
      const raw = String(v || '').trim();
      if (!raw) return '';
      const n = (raw.startsWith('+') || raw.startsWith('00') ? '+' : '') + raw.replace(/^00/, '').replace(/\D/g, '');
      if (!/^\+?\d{6,16}$/.test(n)) throw err(400, 'WhatsApp number doesn\'t look right');
      return n;
    },
    city: text(40),
    bio: text(160),
  };
  const out = {};
  for (const [k, f] of Object.entries(fields)) { const v = f(input[k]); if (v) out[k] = v; }
  return out;
};
function createDemoServer() {
  const NAMES = [
    'Giulia Romano', 'Luca Ferri', 'Sara Conti', 'Marco Galli', 'Chiara Costa', 'Davide Greco',
    'Elena Marino', 'Paolo Rizzo', 'Francesca Lombardi', 'Andrea Moretti', 'Martina Barbieri',
    'Simone Fontana', 'Alessia Santoro', 'Matteo Caruso', 'Valentina Leone', 'Federico Longo',
    'Laura Gentile', 'Stefano Martinelli', 'Ilaria Vitale', 'Riccardo Serra', 'Beatrice Coppola',
    'Tommaso De Luca', 'Camilla Pellegrini', 'Nicola Ferrara', 'Giorgia Bianco', 'Lorenzo Villa',
  ];
  const CHATTER = [
    'Anyone seen the sunset from deck 9? 🌅', 'Who\'s coming to the pool after lunch?',
    'Tonight\'s buffet is a 10/10 🍝', 'Guys, what a view this morning!!', 'Meet at the main bar at 6pm 🍹',
    'Anyone have a USB-C charger to lend?', 'This ship is huge, I got lost 3 times 😂',
    'Deck party tonight, remember to wear white! 🤍', 'Who was on the Mykonos tour? Amazing photos',
    'Found a group for the beach volley tournament, who\'s in?', 'Good morning Global Reunion! ☀️',
  ];
  const REPLIES = ['Hi! 😊', 'Sure, I\'m in!', 'Haha amazing 😂', 'See you there then!', 'Great, see you later 🙌', 'Nice! I\'m on deck 7'];

  const now = Date.now();
  const users = new Map();
  let nextUser = 1;
  const addUser = (name, extra = {}) => { const u = { id: nextUser++, name, isAdmin: false, banned: false, ...extra }; users.set(u.id, u); return u; };
  const staff = addUser('Team Global Reunion', { isAdmin: true });
  const people = NAMES.map((n) => addUser(n));
  people[0].profile = { city: 'Milan', bio: 'Sunsets, pasta and karaoke 🎤', instagram: 'giulia.romano', tiktok: 'giuliar' };
  people[1].profile = { city: 'Rome', instagram: 'luca.ferri', linkedin: 'luca-ferri' };

  const convs = new Map();
  let nextConv = 1;
  const addConv = (type, name, members = []) => { const c = { id: nextConv++, type, name, members: new Set(members) }; convs.set(c.id, c); return c; };
  const announce = addConv('announce', '📢 Announcements');
  // Un gruppo creato dai partecipanti: chi entra nell'anteprima viene aggiunto.
  const party = addConv('group', '🎶 Deck party', people.slice(0, 12).map((u) => u.id));

  const messages = [];
  const reacts = new Map(); // msgId -> Map(userId -> emoji)
  const counts = (id) => {
    const r = reacts.get(id);
    if (!r || !r.size) return null;
    const c = {};
    for (const e of r.values()) c[e] = (c[e] || 0) + 1;
    return c;
  };
  const out = (x) => ({ ...x, reactions: x.deleted ? null : counts(x.id) });
  let nextMsg = 1, seq = 0;
  const reads = new Map(); // `${userId}:${convId}` -> lastReadId
  const waiters = new Set();

  function post(conv, user, text, at = Date.now(), replyTo = null) {
    const m = { id: nextMsg++, conversationId: conv.id, userId: user.id, userName: user.name, text, deleted: false, createdAt: at, seq: ++seq, replyTo };
    messages.push(m);
    for (const w of [...waiters]) w();
    return m;
  }
  // Storia iniziale
  post(announce, staff, 'Welcome aboard the Global Reunion – Cruise Edition! 🚢 All official updates will be posted here.', now - 5 * 3600e3);
  post(announce, staff, '🕗 Welcome party tonight at 9pm on deck 11. Dress code: white!', now - 2 * 3600e3);
  post(party, people[0], `👋 ${people[0].name} created the group "🎶 Deck party"`, now - 3 * 3600e3);
  for (let i = 0; i < 12; i++) {
    const u = people[(i * 5) % 12];
    post(party, u, CHATTER[i % CHATTER.length], now - (12 - i) * 9 * 60e3);
  }

  let me = null;
  let info = '# Welcome aboard! 🚢\nThis is a preview of the Useful info page. Organisers can edit it.\n\n## Staff\n- Need help? Tap **Contact staff**.\n\n## Good to know\n- Breakfast 08:00–10:30, deck 9\n- Welcome party tonight at 21:00, deck 11';

  const err = (status, message) => { const e = new Error(message); e.status = status; return e; };
  const visible = (c) => c.type === 'public' || c.type === 'announce' || (me && c.members.has(me.id));
  const title = (c) => c.type === 'dm' ? users.get([...c.members].find((id) => id !== me.id)).name : c.name;

  function summary(c) {
    const list = messages.filter((m) => m.conversationId === c.id);
    const last = list[list.length - 1] || null;
    const lastRead = reads.get(`${me.id}:${c.id}`) || 0;
    const s = {
      id: c.id, type: c.type, title: title(c), lastMessage: last ? { ...last } : null,
      unread: list.filter((m) => m.id > lastRead && m.userId !== me.id && !m.deleted).length,
    };
    if (c.type === 'dm') s.otherUserId = [...c.members].find((id) => id !== me.id);
    if (c.type === 'group') s.members = [...c.members].map((id) => ({ id, name: users.get(id).name })).sort((a, b) => a.name.localeCompare(b.name));
    return s;
  }

  function getConv(id) {
    const c = convs.get(Number(id));
    if (!c || !visible(c)) throw err(404, 'Chat not found');
    return c;
  }

  function botReply(conv, fromUser) {
    setTimeout(() => {
      if (!convs.has(conv.id)) return;
      post(conv, fromUser, REPLIES[Math.floor(Math.random() * REPLIES.length)]);
    }, 1500 + Math.random() * 2500);
  }

  // Un po' di vita nel gruppo
  setInterval(() => {
    if (!me || Math.random() < 0.4) return;
    const u = people[Math.floor(Math.random() * 12)];
    post(party, u, CHATTER[Math.floor(Math.random() * CHATTER.length)]);
  }, 9000);

  async function request(method, url, body = {}) {
    await new Promise((r) => setTimeout(r, 60));
    const u = new URL(url, location.href);
    const p = u.pathname;
    let m;
    if (method === 'GET' && p === '/api/config') return { joinCodeRequired: false };
    if (method === 'POST' && p === '/api/register') {
      const first = String(body.firstName || '').trim(), last = String(body.lastName || '').trim();
      const email = String(body.email || '').trim();
      if (!first || !last) throw err(400, 'Please enter your first and last name');
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw err(400, 'Invalid email');
      // In anteprima sei un organizzatore, così vedi tutte le funzioni.
      me = addUser(`${first} ${last}`, { isAdmin: true });
      party.members.add(me.id);
      setTimeout(() => {
        const dm = addConv('dm', null, [me.id, people[0].id]);
        post(dm, people[0], `Hi ${first}! See you at the party tonight? 🎉`);
      }, 4000);
      return { ok: true };
    }
    if (!me) throw err(401, 'Not signed in');
    if (method === 'POST' && p === '/api/logout') { me = null; return { ok: true }; }
    if (method === 'GET' && p === '/api/me') {
      return { user: { id: me.id, name: me.name, isAdmin: me.isAdmin, profile: me.profile || {} }, cursor: seq, conversations: [...convs.values()].filter(visible).map(summary) };
    }
    if (method === 'GET' && p === '/api/users') {
      const q = (u.searchParams.get('q') || '').toLowerCase();
      return { users: [...users.values()].filter((x) => x.id !== me.id && !x.banned && x.name.toLowerCase().includes(q)).sort((a, b) => a.name.localeCompare(b.name)).slice(0, 30).map(({ id, name }) => ({ id, name })) };
    }
    if ((m = p.match(/^\/api\/conversations\/(\d+)$/)) && method === 'GET') return summary(getConv(m[1]));
    if ((m = p.match(/^\/api\/conversations\/(\d+)\/messages$/))) {
      const c = getConv(m[1]);
      if (method === 'GET') {
        const before = Number(u.searchParams.get('before')) || Infinity;
        const list = messages.filter((x) => x.conversationId === c.id && x.id < before).slice(-50);
        return { messages: list.map((x) => ({ ...out(x), myReaction: (reacts.get(x.id) || new Map()).get(me.id) || null })), hasMore: false };
      }
      if (c.type === 'announce' && !me.isAdmin) throw err(403, 'Only organisers can post here');
      const text = String(body.text || '').trim();
      if (!text) throw err(400, 'Empty message');
      const orig = body.replyTo ? messages.find((x) => x.id === Number(body.replyTo) && x.conversationId === c.id) : null;
      const msg = post(c, me, text, Date.now(), orig ? { id: orig.id, userId: orig.userId, userName: orig.userName, text: orig.text.slice(0, 160), deleted: orig.deleted } : null);
      if (c.type === 'staff') setTimeout(() => post(c, staff, 'Thanks for your message! A member of the team will get back to you here shortly. 🛟'), 2500);
      reads.set(`${me.id}:${c.id}`, msg.id);
      if (c.type === 'dm') botReply(c, users.get([...c.members].find((id) => id !== me.id)));
      if (c.type === 'group') botReply(c, users.get([...c.members].find((id) => id !== me.id)) || people[1]);
      return { message: out(msg) };
    }
    if ((m = p.match(/^\/api\/conversations\/(\d+)\/read$/))) {
      const c = getConv(m[1]);
      reads.set(`${me.id}:${c.id}`, Math.max(reads.get(`${me.id}:${c.id}`) || 0, Number(body.messageId) || 0));
      return { ok: true };
    }
    if (method === 'GET' && p === '/api/info') return { content: info, updatedAt: null, updatedBy: null };
    if (method === 'PUT' && p === '/api/info') { info = String(body.content || '').trim() || info; return { ok: true }; }
    if (method === 'POST' && p === '/api/staff') {
      let c = [...convs.values()].find((x) => x.type === 'staff' && x.members.has(me.id));
      if (!c) c = addConv('staff', '🛟 Staff support', [me.id]);
      return { id: c.id };
    }
    if (method === 'POST' && p === '/api/dm') {
      const other = users.get(Number(body.userId));
      if (!other) throw err(404, 'User not found');
      let c = [...convs.values()].find((x) => x.type === 'dm' && x.members.has(me.id) && x.members.has(other.id));
      if (!c) c = addConv('dm', null, [me.id, other.id]);
      return { id: c.id };
    }
    if (method === 'POST' && p === '/api/groups') {
      const name = String(body.name || '').trim();
      if (name.length < 2) throw err(400, 'Give the group a name');
      const c = addConv('group', name, [me.id, ...(body.memberIds || [])]);
      post(c, me, `👋 ${me.name} created the group "${name}"`);
      return { id: c.id };
    }
    if ((m = p.match(/^\/api\/conversations\/(\d+)\/members$/))) {
      const c = getConv(m[1]);
      const added = (body.userIds || []).filter((id) => !c.members.has(id)).map((id) => { c.members.add(id); return users.get(id).name; });
      if (added.length) post(c, me, `➕ ${me.name} added ${added.join(', ')}`);
      return { ok: true };
    }
    if ((m = p.match(/^\/api\/conversations\/(\d+)\/leave$/))) {
      const c = getConv(m[1]);
      post(c, me, `🚪 ${me.name} left the group`);
      c.members.delete(me.id);
      return { ok: true };
    }
    if ((m = p.match(/^\/api\/messages\/(\d+)$/)) && method === 'DELETE') {
      const msg = messages.find((x) => x.id === Number(m[1]));
      if (!msg) throw err(404, 'Message not found');
      msg.deleted = true; msg.text = ''; msg.seq = ++seq;
      for (const w of [...waiters]) w();
      return { ok: true };
    }
    if ((m = p.match(/^\/api\/messages\/(\d+)\/react$/)) && method === 'POST') {
      const msg = messages.find((x) => x.id === Number(m[1]));
      if (!msg || msg.deleted) throw err(404, 'Message not found');
      const emoji = body.emoji ? String(body.emoji) : '';
      if (emoji && !window.DEMO_REACTIONS.includes(emoji)) throw err(400, 'Reaction not available');
      if (!reacts.has(msg.id)) reacts.set(msg.id, new Map());
      if (emoji) reacts.get(msg.id).set(me.id, emoji); else reacts.get(msg.id).delete(me.id);
      msg.seq = ++seq;
      for (const w of [...waiters]) w();
      // Qualcuno ricambia la reazione, per far vedere i conteggi che cambiano.
      if (emoji && Math.random() < 0.6) setTimeout(() => {
        reacts.get(msg.id).set(people[Math.floor(Math.random() * 12)].id, window.DEMO_REACTIONS[Math.floor(Math.random() * 4)]);
        msg.seq = ++seq;
        for (const w of [...waiters]) w();
      }, 1800);
      return { message: { ...out(msg), myReaction: emoji || null } };
    }
    if ((m = p.match(/^\/api\/messages\/(\d+)\/reactions$/)) && method === 'GET') {
      return { reactions: [...(reacts.get(Number(m[1])) || new Map())].map(([id, emoji]) => ({ emoji, userId: id, name: users.get(id).name })) };
    }
    if (method === 'PUT' && p === '/api/me/profile') {
      me.profile = window.DEMO_CLEAN_PROFILE(body.profile || {}, err);
      return { profile: me.profile };
    }
    if ((m = p.match(/^\/api\/users\/(\d+)$/)) && method === 'GET') {
      const t = users.get(Number(m[1]));
      if (!t) throw err(404, 'User not found');
      return { id: t.id, name: t.name, isAdmin: t.isAdmin, profile: t.profile || {} };
    }
    if (method === 'POST' && p === '/api/admin/channels') {
      const name = String(body.name || '').trim();
      if (name.length < 2) throw err(400, 'Channel name too short');
      const c = addConv(body.announce ? 'announce' : 'public', name);
      post(c, me, `New channel: ${name}`);
      return { id: c.id };
    }
    if (method === 'POST' && p === '/api/admin/ban') {
      const t = users.get(Number(body.userId));
      if (t) t.banned = true;
      return { ok: true };
    }
    if (method === 'GET' && p === '/api/admin/stats') {
      return { online: 1, users: users.size, messages: messages.length, conversations: convs.size };
    }
    throw err(404, 'Not found');
  }

  function poll(since) {
    const pending = () => messages.filter((m) => m.seq > since && visible(convs.get(m.conversationId))).sort((a, b) => a.seq - b.seq);
    return new Promise((resolve) => {
      const done = () => {
        const list = pending();
        if (!list.length) return;
        waiters.delete(done); clearTimeout(timer);
        setTimeout(() => resolve({ messages: list.map(out), cursor: list[list.length - 1].seq }), 30);
      };
      const timer = setTimeout(() => { waiters.delete(done); resolve({ messages: [], cursor: Math.max(since, seq) }); }, 25000);
      waiters.add(done);
      done();
    });
  }

  return { request, poll };
}

window.createDemoServer = createDemoServer;
// Se shared.js ha già preparato il server condiviso, la simulazione parte solo come ripiego.
if (!window.DEMO_SERVER) window.DEMO_SERVER = createDemoServer();
})();
