'use strict';
// Anteprima CONDIVISA su claude.ai: le API di src/server.js implementate sopra
// l'archivio condiviso dell'artifact (capability "db"), così più persone
// invitate possono chattare davvero tra loro. Se l'archivio non è disponibile
// (pagina aperta fuori da claude.ai, o senza permessi di scrittura) si torna
// all'anteprima simulata di demo.js.
//
// È solo per le prove: i controlli (organizzatori, chat private) sono fatti nel
// browser, quindi chi ha accesso alla pagina può tecnicamente leggere tutto.
(() => {
  const ORGANIZERS = (window.ORGANIZER_EMAILS || []).map((e) => e.toLowerCase());
  let backendPromise = null;

  function setBanner(text) {
    const b = document.querySelector('.demo-banner');
    if (b) b.textContent = text;
  }

  async function init() {
    let db = null, user = null, uid = null;
    try {
      if (window.claude && window.claude.use) {
        [db, user] = await Promise.all([window.claude.use('db'), window.claude.use('user')]);
        uid = user ? await user.id() : null;
      }
    } catch {}
    if (db && uid) {
      try {
        const shared = await createShared(db, uid);
        setBanner('Shared test: messages really reach everyone invited to this page.');
        return shared;
      } catch (e) { console.warn('Archivio condiviso non disponibile, uso la simulazione', e); }
    }
    setBanner('Preview: messages and other participants are simulated and stay on this device only.');
    return window.createDemoServer();
  }
  const backend = () => (backendPromise = backendPromise || init());

  window.DEMO_SERVER = {
    request: (method, url, body) => backend().then((s) => s.request(method, url, body)),
    poll: (since) => backend().then((s) => s.poll(since)),
  };

  async function sha256(text) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  // --------------------------------------------------------------------------
  async function createShared(db, uid) {
    const users = new Map();   // num -> { n, uid, name, email, isAdmin }
    const convs = new Map();   // num -> { n, type, name, members[], dmKey }
    const msgs = new Map();    // num -> messaggio nel formato dell'API
    const bans = new Set();
    const reacts = new Map();  // `${msg}_${user}` -> { m, u, e, at }
    const waiters = new Set();
    let seq = 0;
    let loggedOut = false;
    try { loggedOut = localStorage.getItem('gr-shared-out') === '1'; } catch {}

    const newId = () => Date.now() * 1000 + Math.floor(Math.random() * 1000);
    const err = (status, message) => { const e = new Error(message); e.status = status; return e; };
    const meUser = () => [...users.values()].find((u) => u.uid === uid) || null;
    const me = () => (loggedOut ? null : meUser());
    const notify = () => { for (const w of [...waiters]) w(); };

    function toMsg(d, s) {
      const u = users.get(d.u);
      return {
        id: d.n, conversationId: d.c, userId: d.u, userName: d.name || (u && u.name) || 'Partecipante',
        text: d.del ? '' : d.t, deleted: !!d.del, createdAt: d.at, seq: s,
        replyTo: d.rt ? { ...d.rt } : null, reactions: d.del ? null : reactionCounts(d.n),
      };
    }
    function reactionCounts(msgN) {
      const list = [...reacts.values()].filter((r) => r.m === msgN).sort((a, b) => a.at - b.at);
      if (!list.length) return null;
      const counts = {};
      for (const r of list) counts[r.e] = (counts[r.e] || 0) + 1;
      return counts;
    }
    const myReaction = (msgN) => { const r = reacts.get(`${msgN}_${me().n}`); return r ? r.e : null; };

    // Prima consegna di ogni collezione = dati pronti.
    const firstLoad = [];
    function watch(query, onChange) {
      let resolveFirst, rejectFirst;
      firstLoad.push(new Promise((res, rej) => { resolveFirst = res; rejectFirst = rej; }));
      query.onSnapshot((snap) => {
        for (const ch of snap.docChanges()) onChange(ch.type, ch.doc.data(), ch.doc.id);
        resolveFirst();
        notify();
      }, (e) => { rejectFirst(e); console.warn('db', e); });
    }
    watch(db.collection('users'), (type, d, id) => {
      if (type === 'removed' || !d) return;
      users.set(d.n, { n: d.n, uid: id, name: d.name, email: d.email, isAdmin: !!d.isAdmin, profile: d.profile || {}, pw: d.pw || null });
    });
    watch(db.collection('convs'), (type, d) => {
      if (!d) return;
      if (type === 'removed') convs.delete(d.n); else convs.set(d.n, { ...d, members: [...(d.members || [])] });
    });
    watch(db.collection('bans'), (type, d) => {
      if (!d) return;
      if (type === 'removed') bans.delete(d.n); else bans.add(d.n);
    });
    watch(db.collection('msgs').orderBy('n', 'desc').limit(1000), (type, d) => {
      if (!d) return;
      if (type === 'removed') return; // uscito dalla finestra degli ultimi 1000: lo teniamo in memoria
      msgs.set(d.n, toMsg(d, ++seq));
    });
    watch(db.collection('reacts'), (type, d, id) => {
      if (type === 'removed') reacts.delete(id); else if (d) reacts.set(id, d);
      const m = d ? msgs.get(d.m) : msgs.get(Number(String(id).split('_')[0]));
      if (m) msgs.set(m.id, { ...m, reactions: m.deleted ? null : reactionCounts(m.id), seq: ++seq });
    });
    await Promise.race([
      Promise.all(firstLoad),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 10000)),
    ]);

    // Canali di default con id fissi: crearli due volte non fa danni.
    if (!convs.has(1)) await db.doc('convs/1').set({ n: 1, type: 'announce', name: '📢 Announcements', members: [] });
    else if (convs.get(1).name === '📢 Annunci') { await db.doc('convs/1').update({ name: '📢 Announcements' }); convs.get(1).name = '📢 Announcements'; }
    // Il canale generale "Tutti a bordo" non esiste più: lo togliamo se c'era.
    if (convs.has(2) && convs.get(2).type === 'public') { await db.doc('convs/2').delete(); convs.delete(2); }

    // Messaggi letti: per persona, in questo browser.
    const readsKey = 'gr-reads-' + uid;
    let reads = {};
    try { reads = JSON.parse(localStorage.getItem(readsKey) || '{}'); } catch {}
    const setRead = (c, id) => {
      reads[c] = Math.max(reads[c] || 0, id);
      try { localStorage.setItem(readsKey, JSON.stringify(reads)); } catch {}
    };

    const visible = (c) => c && (c.type === 'public' || c.type === 'announce' || c.members.includes(me().n) || (c.type === 'staff' && me().isAdmin));
    const convMsgs = (c) => [...msgs.values()].filter((m) => m.conversationId === c).sort((a, b) => a.id - b.id);
    const otherOf = (c) => c.members.find((id) => id !== me().n);
    const title = (c) => {
      if (c.type === 'staff') {
        const owner = users.get(c.members[0]);
        return me().isAdmin && owner && owner.n !== me().n ? `🛟 ${owner.name}` : '🛟 Staff support';
      }
      return c.type === 'dm' ? (users.get(otherOf(c)) || { name: 'Chat' }).name : c.name;
    };

    function summary(c) {
      const list = convMsgs(c.n);
      const last = list[list.length - 1] || null;
      const lastRead = reads[c.n] || 0;
      const s = {
        id: c.n, type: c.type, title: title(c), lastMessage: last,
        unread: list.filter((m) => m.id > lastRead && m.userId !== me().n && !m.deleted).length,
      };
      if (c.type === 'dm') s.otherUserId = otherOf(c);
      if (c.type === 'group') s.members = c.members.map((id) => ({ id, name: (users.get(id) || {}).name || 'Partecipante' })).sort((a, b) => a.name.localeCompare(b.name));
      return s;
    }

    function getConv(id) {
      const c = convs.get(Number(id));
      if (!visible(c)) throw err(404, 'Chat not found');
      return c;
    }

    async function post(c, text, rt = null) {
      const u = me();
      const n = newId();
      const d = { n, c: c.n, u: u.n, name: u.name, t: text, at: Date.now(), del: false, rt };
      await db.doc('msgs/' + n).set(d);
      setRead(c.n, n);
      return toMsg(d, 0);
    }

    async function createConv(type, name, members) {
      const n = newId();
      const d = { n, type, name, members, createdBy: me().n };
      await db.doc('convs/' + n).set(d);
      convs.set(n, { ...d });
      return convs.get(n);
    }

    async function request(method, url, body = {}) {
      const u = new URL(url, location.href);
      const p = u.pathname;
      let m;
      if (method === 'GET' && p === '/api/config') return { joinCodeRequired: false };
      // Nell'anteprima condivisa l'identità è il proprio account claude.ai; la password è
      // comunque chiesta (hash salvato nel proprio documento) per provare il flusso vero.
      if (method === 'POST' && p === '/api/login/check') {
        const email = String(body.email || '').trim().toLowerCase();
        const prev = meUser();
        if (prev && prev.email === email) return { step: prev.pw ? 'password' : 'setup' };
        if ([...users.values()].some((x) => x.email === email)) throw err(403, 'This email belongs to another person invited to this page');
        return { step: prev ? 'setup' : 'new' };
      }
      if (method === 'POST' && p === '/api/register') {
        const first = String(body.firstName || '').trim(), last = String(body.lastName || '').trim();
        const email = String(body.email || '').trim().toLowerCase();
        const password = String(body.password || '');
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw err(400, 'Invalid email');
        const prev = meUser();
        if (prev && bans.has(prev.n)) throw err(403, 'Account suspended');
        const pwHash = await sha256(uid + ':' + password);
        if (prev && prev.pw && prev.email === email) {
          if (prev.pw !== pwHash) throw err(401, 'Wrong password');
        } else {
          if (password.length < 6) throw err(400, 'Choose a password of at least 6 characters');
          const name = prev && prev.email === email ? prev.name : `${first} ${last}`.replace(/\s+/g, ' ').trim().slice(0, 60);
          if (!prev && (!first || !last)) throw err(400, 'Please enter your first and last name');
          const doc = { profile: (prev && prev.profile) || {}, n: prev ? prev.n : newId(), name: name || (prev && prev.name), email, isAdmin: ORGANIZERS.includes(email), at: Date.now(), pw: pwHash };
          try { await db.doc('users/' + uid).set(doc); }
          catch (e) { throw err(403, 'You don\'t have permission to post on this page: ask to be invited as an Editor.'); }
          users.set(doc.n, { ...doc, uid });
        }
        loggedOut = false;
        try { localStorage.removeItem('gr-shared-out'); } catch {}
        return { ok: true };
      }
      const self = me();
      if (!self) throw err(401, 'Not signed in');
      if (bans.has(self.n)) throw err(403, 'Account suspended');
      if (method === 'POST' && p === '/api/logout') {
        loggedOut = true;
        try { localStorage.setItem('gr-shared-out', '1'); } catch {}
        return { ok: true };
      }
      if (method === 'GET' && p === '/api/me') {
        return { user: { id: self.n, name: self.name, isAdmin: self.isAdmin, profile: self.profile || {}, hasPassword: !!self.pw }, cursor: seq, conversations: [...convs.values()].filter(visible).map(summary) };
      }
      if (method === 'GET' && p === '/api/users') {
        const q = (u.searchParams.get('q') || '').toLowerCase();
        return { users: [...users.values()].filter((x) => x.n !== self.n && !bans.has(x.n) && x.name.toLowerCase().includes(q)).sort((a, b) => a.name.localeCompare(b.name)).slice(0, 30).map((x) => ({ id: x.n, name: x.name })) };
      }
      if ((m = p.match(/^\/api\/conversations\/(\d+)$/)) && method === 'GET') return summary(getConv(m[1]));
      if ((m = p.match(/^\/api\/conversations\/(\d+)\/messages$/))) {
        const c = getConv(m[1]);
        if (method === 'GET') {
          const before = Number(u.searchParams.get('before')) || Infinity;
          const list = convMsgs(c.n).filter((x) => x.id < before);
          return { messages: list.slice(-50).map((x) => ({ ...x, myReaction: myReaction(x.id) })), hasMore: false };
        }
        if (c.type === 'announce' && !self.isAdmin) throw err(403, 'Only organisers can post here');
        const text = String(body.text || '').trim();
        if (!text) throw err(400, 'Empty message');
        if (text.length > 1000) throw err(400, 'Maximum 1000 characters');
        const orig = body.replyTo ? msgs.get(Number(body.replyTo)) : null;
        const rt = orig && orig.conversationId === c.n ? { id: orig.id, userId: orig.userId, userName: orig.userName, text: orig.text.slice(0, 160), deleted: orig.deleted } : null;
        return { message: await post(c, text, rt) };
      }
      if ((m = p.match(/^\/api\/conversations\/(\d+)\/read$/))) {
        const c = getConv(m[1]);
        setRead(c.n, Number(body.messageId) || 0);
        return { ok: true };
      }
      if (method === 'GET' && p === '/api/info') {
        const doc = await db.doc('info/main').get();
        const d = doc.exists ? doc.data() : null;
        return { content: d ? d.content : '# Welcome aboard! 🚢\nOrganisers: tap **Edit** to write this page.', updatedAt: d ? d.at : null, updatedBy: d ? d.by : null };
      }
      if (method === 'PUT' && p === '/api/info') {
        if (!self.isAdmin) throw err(403, 'Organisers only');
        await db.doc('info/main').set({ content: String(body.content || '').slice(0, 10000), at: Date.now(), by: self.name });
        return { ok: true };
      }
      if (method === 'POST' && p === '/api/staff') {
        let c = [...convs.values()].find((x) => x.type === 'staff' && x.members[0] === self.n);
        if (!c) c = await createConv('staff', null, [self.n]);
        return { id: c.n };
      }
      if (method === 'POST' && p === '/api/dm') {
        const other = users.get(Number(body.userId));
        if (!other || other.n === self.n) throw err(404, 'User not found');
        const key = [self.n, other.n].sort((a, b) => a - b).join('-');
        const c = [...convs.values()].find((x) => x.type === 'dm' && x.dmKey === key)
          || await (async () => { const n = newId(); const d = { n, type: 'dm', name: null, dmKey: key, members: [self.n, other.n] }; await db.doc('convs/' + n).set(d); convs.set(n, d); return d; })();
        return { id: c.n };
      }
      if (method === 'POST' && p === '/api/groups') {
        const name = String(body.name || '').trim().slice(0, 60);
        if (name.length < 2) throw err(400, 'Give the group a name');
        const c = await createConv('group', name, [self.n, ...(body.memberIds || []).map(Number)]);
        await post(c, `👋 ${self.name} created the group "${name}"`);
        return { id: c.n };
      }
      if ((m = p.match(/^\/api\/conversations\/(\d+)\/members$/))) {
        const c = getConv(m[1]);
        const ids = (body.userIds || []).map(Number).filter((id) => users.has(id) && !c.members.includes(id));
        if (ids.length) {
          await db.doc('convs/' + c.n).update({ members: [...c.members, ...ids] });
          await post(c, `➕ ${self.name} added ${ids.map((id) => users.get(id).name).join(', ')}`);
        }
        return { ok: true };
      }
      if ((m = p.match(/^\/api\/conversations\/(\d+)\/leave$/))) {
        const c = getConv(m[1]);
        await post(c, `🚪 ${self.name} left the group`);
        await db.doc('convs/' + c.n).update({ members: c.members.filter((id) => id !== self.n) });
        return { ok: true };
      }
      if ((m = p.match(/^\/api\/messages\/(\d+)$/)) && method === 'DELETE') {
        const msg = msgs.get(Number(m[1]));
        if (!msg) throw err(404, 'Message not found');
        if (msg.userId !== self.n && !self.isAdmin) throw err(403, 'You cannot delete this message');
        await db.doc('msgs/' + msg.id).update({ del: true, t: '' });
        return { ok: true };
      }
      if ((m = p.match(/^\/api\/messages\/(\d+)\/react$/)) && method === 'POST') {
        const msg = msgs.get(Number(m[1]));
        if (!msg || msg.deleted) throw err(404, 'Message not found');
        getConv(msg.conversationId);
        const emoji = body.emoji ? String(body.emoji) : '';
        if (emoji && !window.DEMO_REACTIONS.includes(emoji)) throw err(400, 'Reaction not available');
        const key = `${msg.id}_${self.n}`;
        if (emoji) { const d = { m: msg.id, u: self.n, e: emoji, at: Date.now() }; await db.doc('reacts/' + key).set(d); reacts.set(key, d); }
        else { await db.doc('reacts/' + key).delete(); reacts.delete(key); }
        return { message: { ...msg, reactions: reactionCounts(msg.id), myReaction: emoji || null } };
      }
      if ((m = p.match(/^\/api\/messages\/(\d+)\/reactions$/)) && method === 'GET') {
        const msg = msgs.get(Number(m[1]));
        if (!msg) throw err(404, 'Message not found');
        getConv(msg.conversationId);
        return { reactions: [...reacts.values()].filter((r) => r.m === msg.id).sort((a, b) => b.at - a.at)
          .map((r) => ({ emoji: r.e, userId: r.u, name: (users.get(r.u) || {}).name || 'Participant' })) };
      }
      if (method === 'PUT' && p === '/api/me/password') {
        if (self.pw && self.pw !== await sha256(uid + ':' + String(body.current || ''))) throw err(401, 'Your current password is wrong');
        if (String(body.password || '').length < 6) throw err(400, 'Choose a password of at least 6 characters');
        const pw = await sha256(uid + ':' + String(body.password));
        await db.doc('users/' + uid).update({ pw });
        self.pw = pw;
        return { ok: true };
      }
      if (method === 'POST' && p === '/api/admin/reset-password') {
        if (!self.isAdmin) throw err(403, 'Organisers only');
        throw err(400, 'In this shared preview each person signs in with their own claude.ai account: there is nothing to reset.');
      }
      if (method === 'PUT' && p === '/api/me/profile') {
        const profile = window.DEMO_CLEAN_PROFILE(body.profile || {}, err);
        await db.doc('users/' + uid).update({ profile });
        self.profile = profile;
        return { profile };
      }
      if ((m = p.match(/^\/api\/users\/(\d+)$/)) && method === 'GET') {
        const t = users.get(Number(m[1]));
        if (!t) throw err(404, 'User not found');
        return { id: t.n, name: t.name, isAdmin: t.isAdmin, profile: t.profile || {} };
      }
      if (method === 'POST' && p === '/api/admin/channels') {
        if (!self.isAdmin) throw err(403, 'Organisers only');
        const name = String(body.name || '').trim().slice(0, 60);
        if (name.length < 2) throw err(400, 'Channel name too short');
        const c = await createConv(body.announce ? 'announce' : 'public', name, []);
        await post(c, `New channel: ${name}`);
        return { id: c.n };
      }
      if (method === 'POST' && p === '/api/admin/ban') {
        if (!self.isAdmin) throw err(403, 'Organisers only');
        const t = users.get(Number(body.userId));
        if (!t) throw err(404, 'User not found');
        if (t.isAdmin) throw err(400, 'You cannot suspend an organiser');
        await db.doc('bans/' + t.n).set({ n: t.n });
        return { ok: true };
      }
      if (method === 'GET' && p === '/api/admin/stats') {
        return { online: users.size, users: users.size, messages: msgs.size, conversations: convs.size };
      }
      throw err(404, 'Not found');
    }

    function poll(since) {
      const pending = () => {
        const self = me();
        if (!self) return [];
        return [...msgs.values()].filter((x) => x.seq > since && visible(convs.get(x.conversationId))).sort((a, b) => a.seq - b.seq);
      };
      return new Promise((resolve) => {
        const done = () => {
          if (bans.has((me() || {}).n)) { waiters.delete(done); clearTimeout(timer); const e = new Error('auth'); e.status = 403; return resolve(Promise.reject(e)); }
          const list = pending();
          if (!list.length) return;
          waiters.delete(done); clearTimeout(timer);
          resolve({ messages: list, cursor: list[list.length - 1].seq });
        };
        const timer = setTimeout(() => { waiters.delete(done); resolve({ messages: [], cursor: Math.max(since, seq) }); }, 25000);
        waiters.add(done);
        done();
      });
    }

    return { request, poll };
  }
})();
