'use strict';
// Server simulato nel browser, usato SOLO per l'anteprima statica.
// Imita le API di src/server.js e popola la chat con partecipanti finti.
(() => {
  const NAMES = [
    'Giulia Romano', 'Luca Ferri', 'Sara Conti', 'Marco Galli', 'Chiara Costa', 'Davide Greco',
    'Elena Marino', 'Paolo Rizzo', 'Francesca Lombardi', 'Andrea Moretti', 'Martina Barbieri',
    'Simone Fontana', 'Alessia Santoro', 'Matteo Caruso', 'Valentina Leone', 'Federico Longo',
    'Laura Gentile', 'Stefano Martinelli', 'Ilaria Vitale', 'Riccardo Serra', 'Beatrice Coppola',
    'Tommaso De Luca', 'Camilla Pellegrini', 'Nicola Ferrara', 'Giorgia Bianco', 'Lorenzo Villa',
  ];
  const CHATTER = [
    'Qualcuno ha visto il tramonto dal ponte 9? 🌅', 'Chi viene in piscina dopo pranzo?',
    'Il buffet di stasera è da 10 e lode 🍝', 'Ragazzi che vista stamattina!!', 'Ci vediamo al bar centrale alle 18 🍹',
    'Qualcuno ha un caricabatterie USB-C da prestare?', 'Questa nave è enorme, mi sono perso 3 volte 😂',
    'Stasera festa sul ponte, outfit bianco ricordate! 🤍', 'Chi era al tour di Mykonos? Foto pazzesche',
    'Ho trovato un gruppo per il torneo di beach volley, chi si unisce?', 'Buongiorno global reunion! ☀️',
  ];
  const REPLIES = ['Ciao! 😊', 'Certo, ci sto!', 'Ahah top 😂', 'Ci vediamo lì allora!', 'Grande, a dopo 🙌', 'Che bello! Io sono al ponte 7'];

  const now = Date.now();
  const users = new Map();
  let nextUser = 1;
  const addUser = (name, extra = {}) => { const u = { id: nextUser++, name, isAdmin: false, banned: false, ...extra }; users.set(u.id, u); return u; };
  const staff = addUser('Team Global Reunion', { isAdmin: true });
  const people = NAMES.map((n) => addUser(n));

  const convs = new Map();
  let nextConv = 1;
  const addConv = (type, name, members = []) => { const c = { id: nextConv++, type, name, members: new Set(members) }; convs.set(c.id, c); return c; };
  const announce = addConv('announce', '📢 Annunci');
  const general = addConv('public', '🚢 Tutti a bordo');
  const party = addConv('public', '🎶 Festa sul ponte');

  const messages = [];
  let nextMsg = 1, seq = 0;
  const reads = new Map(); // `${userId}:${convId}` -> lastReadId
  const waiters = new Set();

  function post(conv, user, text, at = Date.now()) {
    const m = { id: nextMsg++, conversationId: conv.id, userId: user.id, userName: user.name, text, deleted: false, createdAt: at, seq: ++seq };
    messages.push(m);
    for (const w of [...waiters]) w();
    return m;
  }
  // Storia iniziale
  post(announce, staff, 'Benvenuti a bordo della Global Reunion – Cruise Edition! 🚢 Qui troverete tutte le comunicazioni ufficiali.', now - 5 * 3600e3);
  post(announce, staff, '🕗 Stasera alle 21:00 party di benvenuto sul ponte 11. Dress code: bianco!', now - 2 * 3600e3);
  for (let i = 0; i < 14; i++) {
    const u = people[(i * 7) % people.length];
    post(general, u, CHATTER[i % CHATTER.length], now - (14 - i) * 9 * 60e3);
  }
  post(party, people[3], 'Playlist per stasera: mandate le vostre canzoni qui 🎵', now - 50 * 60e3);
  post(party, people[8], 'Mamma Mia degli ABBA, obbligatoria 💃', now - 45 * 60e3);

  let me = null;

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
    if (!c || !visible(c)) throw err(404, 'Chat non trovata');
    return c;
  }

  function botReply(conv, fromUser) {
    setTimeout(() => {
      if (!convs.has(conv.id)) return;
      post(conv, fromUser, REPLIES[Math.floor(Math.random() * REPLIES.length)]);
    }, 1500 + Math.random() * 2500);
  }

  // Un po' di vita nel canale generale
  setInterval(() => {
    if (!me || Math.random() < 0.4) return;
    const u = people[Math.floor(Math.random() * people.length)];
    post(general, u, CHATTER[Math.floor(Math.random() * CHATTER.length)]);
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
      if (!first || !last) throw err(400, 'Inserisci nome e cognome');
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw err(400, 'Email non valida');
      // In anteprima sei un organizzatore, così vedi tutte le funzioni.
      me = addUser(`${first} ${last}`, { isAdmin: true });
      setTimeout(() => {
        const dm = addConv('dm', null, [me.id, people[0].id]);
        post(dm, people[0], `Ciao ${first}! Ci vediamo stasera alla festa? 🎉`);
      }, 4000);
      return { ok: true };
    }
    if (!me) throw err(401, 'Non autenticato');
    if (method === 'POST' && p === '/api/logout') { me = null; return { ok: true }; }
    if (method === 'GET' && p === '/api/me') {
      return { user: { id: me.id, name: me.name, isAdmin: me.isAdmin }, cursor: seq, conversations: [...convs.values()].filter(visible).map(summary) };
    }
    if (method === 'GET' && p === '/api/users') {
      const q = (u.searchParams.get('q') || '').toLowerCase();
      return { users: [...users.values()].filter((x) => x.id !== me.id && !x.banned && x.name.toLowerCase().includes(q)).slice(0, 30).map(({ id, name }) => ({ id, name })) };
    }
    if ((m = p.match(/^\/api\/conversations\/(\d+)$/)) && method === 'GET') return summary(getConv(m[1]));
    if ((m = p.match(/^\/api\/conversations\/(\d+)\/messages$/))) {
      const c = getConv(m[1]);
      if (method === 'GET') {
        const before = Number(u.searchParams.get('before')) || Infinity;
        const list = messages.filter((x) => x.conversationId === c.id && x.id < before).slice(-50);
        return { messages: list.map((x) => ({ ...x })), hasMore: false };
      }
      if (c.type === 'announce' && !me.isAdmin) throw err(403, 'Solo gli organizzatori possono scrivere qui');
      const text = String(body.text || '').trim();
      if (!text) throw err(400, 'Messaggio vuoto');
      const msg = post(c, me, text);
      reads.set(`${me.id}:${c.id}`, msg.id);
      if (c.type === 'dm') botReply(c, users.get([...c.members].find((id) => id !== me.id)));
      if (c.type === 'group') botReply(c, users.get([...c.members].find((id) => id !== me.id)) || people[1]);
      return { message: { ...msg } };
    }
    if ((m = p.match(/^\/api\/conversations\/(\d+)\/read$/))) {
      const c = getConv(m[1]);
      reads.set(`${me.id}:${c.id}`, Math.max(reads.get(`${me.id}:${c.id}`) || 0, Number(body.messageId) || 0));
      return { ok: true };
    }
    if (method === 'POST' && p === '/api/dm') {
      const other = users.get(Number(body.userId));
      if (!other) throw err(404, 'Utente non trovato');
      let c = [...convs.values()].find((x) => x.type === 'dm' && x.members.has(me.id) && x.members.has(other.id));
      if (!c) c = addConv('dm', null, [me.id, other.id]);
      return { id: c.id };
    }
    if (method === 'POST' && p === '/api/groups') {
      const name = String(body.name || '').trim();
      if (name.length < 2) throw err(400, 'Dai un nome al gruppo');
      const c = addConv('group', name, [me.id, ...(body.memberIds || [])]);
      post(c, me, `👋 ${me.name} ha creato il gruppo "${name}"`);
      return { id: c.id };
    }
    if ((m = p.match(/^\/api\/conversations\/(\d+)\/members$/))) {
      const c = getConv(m[1]);
      const added = (body.userIds || []).filter((id) => !c.members.has(id)).map((id) => { c.members.add(id); return users.get(id).name; });
      if (added.length) post(c, me, `➕ ${me.name} ha aggiunto ${added.join(', ')}`);
      return { ok: true };
    }
    if ((m = p.match(/^\/api\/conversations\/(\d+)\/leave$/))) {
      const c = getConv(m[1]);
      post(c, me, `🚪 ${me.name} ha lasciato il gruppo`);
      c.members.delete(me.id);
      return { ok: true };
    }
    if ((m = p.match(/^\/api\/messages\/(\d+)$/)) && method === 'DELETE') {
      const msg = messages.find((x) => x.id === Number(m[1]));
      if (!msg) throw err(404, 'Messaggio non trovato');
      msg.deleted = true; msg.text = ''; msg.seq = ++seq;
      for (const w of [...waiters]) w();
      return { ok: true };
    }
    if (method === 'POST' && p === '/api/admin/channels') {
      const name = String(body.name || '').trim();
      if (name.length < 2) throw err(400, 'Nome canale troppo corto');
      const c = addConv(body.announce ? 'announce' : 'public', name);
      post(c, me, `Nuovo canale: ${name}`);
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
    throw err(404, 'Non trovato');
  }

  function poll(since) {
    const pending = () => messages.filter((m) => m.seq > since && visible(convs.get(m.conversationId))).sort((a, b) => a.seq - b.seq);
    return new Promise((resolve) => {
      const done = () => {
        const list = pending();
        if (!list.length) return;
        waiters.delete(done); clearTimeout(timer);
        setTimeout(() => resolve({ messages: list.map((m) => ({ ...m })), cursor: list[list.length - 1].seq }), 30);
      };
      const timer = setTimeout(() => { waiters.delete(done); resolve({ messages: [], cursor: Math.max(since, seq) }); }, 25000);
      waiters.add(done);
      done();
    });
  }

  window.DEMO_SERVER = { request, poll };
})();
