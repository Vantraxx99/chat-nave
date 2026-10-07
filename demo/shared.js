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
        setBanner('Prova condivisa: i messaggi arrivano davvero a tutti quelli invitati a questa pagina.');
        return shared;
      } catch (e) { console.warn('Archivio condiviso non disponibile, uso la simulazione', e); }
    }
    setBanner('Anteprima: i messaggi e gli altri partecipanti sono simulati e restano solo su questo dispositivo.');
    return window.createDemoServer();
  }
  const backend = () => (backendPromise = backendPromise || init());

  window.DEMO_SERVER = {
    request: (method, url, body) => backend().then((s) => s.request(method, url, body)),
    poll: (since) => backend().then((s) => s.poll(since)),
  };

  // --------------------------------------------------------------------------
  async function createShared(db, uid) {
    const users = new Map();   // num -> { n, uid, name, email, isAdmin }
    const convs = new Map();   // num -> { n, type, name, members[], dmKey }
    const msgs = new Map();    // num -> messaggio nel formato dell'API
    const bans = new Set();
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
      };
    }

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
      users.set(d.n, { n: d.n, uid: id, name: d.name, email: d.email, isAdmin: !!d.isAdmin });
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
    await Promise.race([
      Promise.all(firstLoad),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 10000)),
    ]);

    // Canali di default con id fissi: crearli due volte non fa danni.
    if (!convs.has(1)) await db.doc('convs/1').set({ n: 1, type: 'announce', name: '📢 Annunci', members: [] });
    if (!convs.has(2)) await db.doc('convs/2').set({ n: 2, type: 'public', name: '🚢 Tutti a bordo', members: [] });

    // Messaggi letti: per persona, in questo browser.
    const readsKey = 'gr-reads-' + uid;
    let reads = {};
    try { reads = JSON.parse(localStorage.getItem(readsKey) || '{}'); } catch {}
    const setRead = (c, id) => {
      reads[c] = Math.max(reads[c] || 0, id);
      try { localStorage.setItem(readsKey, JSON.stringify(reads)); } catch {}
    };

    const visible = (c) => c && (c.type === 'public' || c.type === 'announce' || c.members.includes(me().n));
    const convMsgs = (c) => [...msgs.values()].filter((m) => m.conversationId === c).sort((a, b) => a.id - b.id);
    const otherOf = (c) => c.members.find((id) => id !== me().n);
    const title = (c) => (c.type === 'dm' ? (users.get(otherOf(c)) || { name: 'Chat' }).name : c.name);

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
      if (!visible(c)) throw err(404, 'Chat non trovata');
      return c;
    }

    async function post(c, text) {
      const u = me();
      const n = newId();
      const d = { n, c: c.n, u: u.n, name: u.name, t: text, at: Date.now(), del: false };
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
      if (method === 'POST' && p === '/api/register') {
        const first = String(body.firstName || '').trim(), last = String(body.lastName || '').trim();
        const email = String(body.email || '').trim().toLowerCase();
        if (!first || !last) throw err(400, 'Inserisci nome e cognome');
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw err(400, 'Email non valida');
        const prev = meUser();
        if (prev && bans.has(prev.n)) throw err(403, 'Account sospeso');
        const doc = { n: prev ? prev.n : newId(), name: `${first} ${last}`.replace(/\s+/g, ' ').slice(0, 60), email, isAdmin: ORGANIZERS.includes(email), at: Date.now() };
        try { await db.doc('users/' + uid).set(doc); }
        catch (e) { throw err(403, 'Non hai il permesso di scrivere in questa pagina: chiedi di essere invitato come Editor.'); }
        users.set(doc.n, { ...doc, uid });
        loggedOut = false;
        try { localStorage.removeItem('gr-shared-out'); } catch {}
        return { ok: true };
      }
      const self = me();
      if (!self) throw err(401, 'Non autenticato');
      if (bans.has(self.n)) throw err(403, 'Account sospeso');
      if (method === 'POST' && p === '/api/logout') {
        loggedOut = true;
        try { localStorage.setItem('gr-shared-out', '1'); } catch {}
        return { ok: true };
      }
      if (method === 'GET' && p === '/api/me') {
        return { user: { id: self.n, name: self.name, isAdmin: self.isAdmin }, cursor: seq, conversations: [...convs.values()].filter(visible).map(summary) };
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
          return { messages: list.slice(-50), hasMore: false };
        }
        if (c.type === 'announce' && !self.isAdmin) throw err(403, 'Solo gli organizzatori possono scrivere qui');
        const text = String(body.text || '').trim();
        if (!text) throw err(400, 'Messaggio vuoto');
        if (text.length > 1000) throw err(400, 'Massimo 1000 caratteri');
        return { message: await post(c, text) };
      }
      if ((m = p.match(/^\/api\/conversations\/(\d+)\/read$/))) {
        const c = getConv(m[1]);
        setRead(c.n, Number(body.messageId) || 0);
        return { ok: true };
      }
      if (method === 'POST' && p === '/api/dm') {
        const other = users.get(Number(body.userId));
        if (!other || other.n === self.n) throw err(404, 'Utente non trovato');
        const key = [self.n, other.n].sort((a, b) => a - b).join('-');
        const c = [...convs.values()].find((x) => x.type === 'dm' && x.dmKey === key)
          || await (async () => { const n = newId(); const d = { n, type: 'dm', name: null, dmKey: key, members: [self.n, other.n] }; await db.doc('convs/' + n).set(d); convs.set(n, d); return d; })();
        return { id: c.n };
      }
      if (method === 'POST' && p === '/api/groups') {
        const name = String(body.name || '').trim().slice(0, 60);
        if (name.length < 2) throw err(400, 'Dai un nome al gruppo');
        const c = await createConv('group', name, [self.n, ...(body.memberIds || []).map(Number)]);
        await post(c, `👋 ${self.name} ha creato il gruppo "${name}"`);
        return { id: c.n };
      }
      if ((m = p.match(/^\/api\/conversations\/(\d+)\/members$/))) {
        const c = getConv(m[1]);
        const ids = (body.userIds || []).map(Number).filter((id) => users.has(id) && !c.members.includes(id));
        if (ids.length) {
          await db.doc('convs/' + c.n).update({ members: [...c.members, ...ids] });
          await post(c, `➕ ${self.name} ha aggiunto ${ids.map((id) => users.get(id).name).join(', ')}`);
        }
        return { ok: true };
      }
      if ((m = p.match(/^\/api\/conversations\/(\d+)\/leave$/))) {
        const c = getConv(m[1]);
        await post(c, `🚪 ${self.name} ha lasciato il gruppo`);
        await db.doc('convs/' + c.n).update({ members: c.members.filter((id) => id !== self.n) });
        return { ok: true };
      }
      if ((m = p.match(/^\/api\/messages\/(\d+)$/)) && method === 'DELETE') {
        const msg = msgs.get(Number(m[1]));
        if (!msg) throw err(404, 'Messaggio non trovato');
        if (msg.userId !== self.n && !self.isAdmin) throw err(403, 'Non puoi eliminare questo messaggio');
        await db.doc('msgs/' + msg.id).update({ del: true, t: '' });
        return { ok: true };
      }
      if (method === 'POST' && p === '/api/admin/channels') {
        if (!self.isAdmin) throw err(403, 'Solo gli organizzatori');
        const name = String(body.name || '').trim().slice(0, 60);
        if (name.length < 2) throw err(400, 'Nome canale troppo corto');
        const c = await createConv(body.announce ? 'announce' : 'public', name, []);
        await post(c, `Nuovo canale: ${name}`);
        return { id: c.n };
      }
      if (method === 'POST' && p === '/api/admin/ban') {
        if (!self.isAdmin) throw err(403, 'Solo gli organizzatori');
        const t = users.get(Number(body.userId));
        if (!t) throw err(404, 'Utente non trovato');
        if (t.isAdmin) throw err(400, 'Non puoi sospendere un organizzatore');
        await db.doc('bans/' + t.n).set({ n: t.n });
        return { ok: true };
      }
      if (method === 'GET' && p === '/api/admin/stats') {
        return { online: users.size, users: users.size, messages: msgs.size, conversations: convs.size };
      }
      throw err(404, 'Non trovato');
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
