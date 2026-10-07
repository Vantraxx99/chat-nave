'use strict';
(() => {
  const $ = (s) => document.querySelector(s);
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };

  const state = {
    me: null,
    cursor: 0,
    convs: new Map(),     // id -> summary
    messages: new Map(),  // convId -> Map(msgId -> msg)
    hasMore: new Map(),   // convId -> bool
    current: null,
    pollCtrl: null,
    refreshTimer: null,
  };

  // ------------------------------------------------------------------ API
  async function api(method, url, body) {
    const opts = { method, headers: {}, credentials: 'same-origin' };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(url, opts);
    let data = {};
    try { data = await res.json(); } catch {}
    if (!res.ok) {
      const err = new Error(data.error || 'Errore di rete');
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function toast(text) {
    const t = $('#toast');
    t.textContent = text;
    t.classList.remove('hidden');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => t.classList.add('hidden'), 3000);
  }

  // ------------------------------------------------------------ Utility
  const initials = (name) => (name || '?').replace(/[^\p{L}\p{N}\s]/gu, '').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || (name || '?').slice(0, 2);
  const hue = (n) => (Number(n) * 137) % 360;
  function setAvatar(node, conv) {
    node.textContent = '';
    if (conv.type === 'dm' || conv.type === 'user') {
      node.textContent = initials(conv.title);
      node.style.background = `hsl(${hue(conv.otherUserId || conv.id)} 45% 42%)`;
    } else {
      const m = conv.title.match(/^\p{Extended_Pictographic}/u);
      node.textContent = m ? m[0] : conv.type === 'group' ? '👥' : '#';
      node.style.background = '';
    }
  }
  function fmtTime(ts) {
    const d = new Date(ts);
    return d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
  }
  function fmtListTime(ts) {
    const d = new Date(ts);
    const today = new Date();
    if (d.toDateString() === today.toDateString()) return fmtTime(ts);
    const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
    if (d.toDateString() === yesterday.toDateString()) return 'Ieri';
    return d.toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit' });
  }
  function fmtDay(ts) {
    const d = new Date(ts);
    const today = new Date();
    if (d.toDateString() === today.toDateString()) return 'Oggi';
    const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
    if (d.toDateString() === yesterday.toDateString()) return 'Ieri';
    return d.toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long' });
  }
  const isSystemText = (t) => /^(👋|➕|🚪) /.test(t);
  function show(id) {
    for (const s of document.querySelectorAll('.screen')) s.classList.toggle('hidden', s.id !== id);
  }

  // --------------------------------------------------------------- Login
  async function initLogin() {
    show('login');
    try {
      const cfg = await api('GET', '/api/config');
      $('#join-box').classList.toggle('hidden', !cfg.joinEnabled);
    } catch {}
    $('#code').focus();
  }

  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#login-error').textContent = '';
    try {
      await api('POST', '/api/login', { code: $('#code').value });
      start();
    } catch (err) { $('#login-error').textContent = err.message; }
  });

  $('#join-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#login-error').textContent = '';
    try {
      const r = await api('POST', '/api/join', { name: $('#join-name').value, joinCode: $('#join-code').value });
      $('#welcome-code').textContent = r.code;
      show('welcome');
    } catch (err) { $('#login-error').textContent = err.message; }
  });
  $('#welcome-continue').addEventListener('click', () => start());

  // ---------------------------------------------------------------- Avvio
  async function start() {
    let data;
    try { data = await api('GET', '/api/me'); }
    catch (err) {
      if (err.status === 401 || err.status === 403) return initLogin();
      $('#offline').classList.remove('hidden');
      setTimeout(start, 4000);
      return;
    }
    state.me = data.user;
    state.cursor = data.cursor;
    state.convs.clear();
    for (const c of data.conversations) state.convs.set(c.id, c);
    $('#me-name').textContent = state.me.name + (state.me.isAdmin ? ' ⭐' : '');
    setAvatar($('#me-avatar'), { type: 'user', title: state.me.name, otherUserId: state.me.id });
    show('app');
    renderConvList();
    const fromHash = Number(location.hash.slice(1));
    if (fromHash && state.convs.has(fromHash)) openConv(fromHash);
    poll();
  }

  async function refreshConvs() {
    try {
      const data = await api('GET', '/api/me');
      state.convs.clear();
      for (const c of data.conversations) state.convs.set(c.id, c);
      if (state.current) {
        const c = state.convs.get(state.current);
        if (c) c.unread = 0;
        else closeConv();
      }
      renderConvList();
      if (state.current) renderChatHeader();
    } catch {}
  }
  function scheduleRefresh() {
    clearTimeout(state.refreshTimer);
    state.refreshTimer = setTimeout(refreshConvs, 300);
  }

  // -------------------------------------------------------- Long-polling
  async function poll() {
    let delay = 0;
    while (state.me) {
      try {
        state.pollCtrl = new AbortController();
        const data = await fetch('/api/poll?since=' + state.cursor, { signal: state.pollCtrl.signal, credentials: 'same-origin' })
          .then(async (r) => {
            if (r.status === 401 || r.status === 403) { const e = new Error('auth'); e.status = r.status; throw e; }
            if (!r.ok) throw new Error('http ' + r.status);
            return r.json();
          });
        $('#offline').classList.add('hidden');
        delay = 0;
        state.cursor = Math.max(state.cursor, data.cursor);
        if (data.messages.length) handleIncoming(data.messages);
      } catch (err) {
        if (err.status === 401 || err.status === 403) { state.me = null; return initLogin(); }
        $('#offline').classList.remove('hidden');
        delay = Math.min(delay ? delay * 2 : 1000, 15000);
        await new Promise((r) => setTimeout(r, delay + Math.random() * 1000));
      }
    }
  }

  function handleIncoming(list) {
    let needRefresh = false;
    let listChanged = false;
    for (const m of list) {
      const conv = state.convs.get(m.conversationId);
      if (!conv) { needRefresh = true; continue; }
      const store = state.messages.get(m.conversationId);
      const known = store && store.has(m.id);
      if (store) store.set(m.id, m);

      const isNewest = !conv.lastMessage || m.id >= conv.lastMessage.id;
      if (isNewest) { conv.lastMessage = m; listChanged = true; }
      if (!known && !m.deleted && m.userId !== state.me.id && state.current !== m.conversationId
          && (!conv.lastSeenId || m.id > conv.lastSeenId)) {
        conv.unread = (conv.unread || 0) + 1;
        listChanged = true;
      }
      conv.lastSeenId = Math.max(conv.lastSeenId || 0, m.id);
      if (state.current === m.conversationId) renderMessage(m);
    }
    if (state.current) markRead();
    if (listChanged) renderConvList();
    if (needRefresh) scheduleRefresh();
  }

  // ---------------------------------------------------- Lista delle chat
  function sortedConvs() {
    const pinned = (c) => (c.type === 'announce' ? 2 : c.type === 'public' ? 1 : 0);
    return [...state.convs.values()].sort((a, b) => {
      const at = a.lastMessage ? a.lastMessage.createdAt : 0;
      const bt = b.lastMessage ? b.lastMessage.createdAt : 0;
      return pinned(b) - pinned(a) || bt - at;
    });
  }

  function renderConvList() {
    const ul = $('#conv-list');
    const filter = $('#conv-filter').value.trim().toLowerCase();
    ul.textContent = '';
    let totalUnread = 0;
    for (const c of sortedConvs()) {
      totalUnread += c.unread || 0;
      if (filter && !c.title.toLowerCase().includes(filter)) continue;
      const li = el('li');
      if (c.id === state.current) li.classList.add('active');
      if (c.unread) li.classList.add('unread');
      const av = el('span', 'avatar');
      setAvatar(av, c);
      const info = el('div', 'info');
      const r1 = el('div', 'row');
      r1.append(el('span', 'name', c.title), el('span', 'time', c.lastMessage ? fmtListTime(c.lastMessage.createdAt) : ''));
      const r2 = el('div', 'row');
      let preview = '';
      if (c.lastMessage) {
        const lm = c.lastMessage;
        const who = lm.userId === state.me.id ? 'Tu: ' : c.type !== 'dm' && !isSystemText(lm.text) ? lm.userName.split(' ')[0] + ': ' : '';
        preview = lm.deleted ? '🚫 Messaggio eliminato' : who + lm.text.replace(/\n/g, ' ');
      }
      r2.append(el('span', 'preview', preview));
      if (c.unread) r2.append(el('span', 'badge', c.unread > 99 ? '99+' : String(c.unread)));
      info.append(r1, r2);
      li.append(av, info);
      li.addEventListener('click', () => openConv(c.id));
      ul.append(li);
    }
    document.title = totalUnread ? `(${totalUnread}) Chat di bordo` : 'Chat di bordo';
  }
  $('#conv-filter').addEventListener('input', renderConvList);

  // ----------------------------------------------------------- Chat aperta
  async function openConv(id) {
    const conv = state.convs.get(id);
    if (!conv) return;
    state.current = id;
    // Su mobile il tasto "indietro" del telefono deve tornare alla lista, non uscire dal sito.
    if (history.state && history.state.chat) history.replaceState({ chat: true }, '', '#' + id);
    else history.pushState({ chat: true }, '', '#' + id);
    document.body.classList.add('in-chat');
    $('#chat-empty').classList.add('hidden');
    $('#chat-view').classList.remove('hidden');
    renderChatHeader();
    const canWrite = conv.type !== 'announce' || state.me.isAdmin;
    $('#composer').classList.toggle('hidden', !canWrite);
    $('#readonly-note').classList.toggle('hidden', canWrite);
    conv.unread = 0;
    renderConvList();

    const box = $('#messages');
    box.textContent = '';
    if (!state.messages.has(id)) {
      box.append(el('div', 'day', 'Caricamento…'));
      try {
        const data = await api('GET', `/api/conversations/${id}/messages`);
        const store = new Map();
        for (const m of data.messages) store.set(m.id, m);
        // Messaggi arrivati via polling durante il caricamento
        const existing = state.messages.get(id);
        if (existing) for (const [k, v] of existing) store.set(k, v);
        state.messages.set(id, store);
        state.hasMore.set(id, data.hasMore);
      } catch (err) {
        if (state.current === id) { box.textContent = ''; box.append(el('div', 'day', err.message)); }
        return;
      }
      if (state.current !== id) return;
    }
    renderAllMessages(true);
    markRead();
    if (window.matchMedia('(min-width: 761px)').matches) $('#msg-input').focus();
  }

  function closeConv() {
    state.current = null;
    document.body.classList.remove('in-chat');
    $('#chat-view').classList.add('hidden');
    $('#chat-empty').classList.remove('hidden');
    renderConvList();
  }
  function goBack() {
    if (history.state && history.state.chat) history.back(); else closeConv();
  }
  $('#btn-back').addEventListener('click', goBack);
  window.addEventListener('popstate', () => {
    if (state.current && !(history.state && history.state.chat)) closeConv();
  });

  function renderChatHeader() {
    const conv = state.convs.get(state.current);
    if (!conv) return;
    $('#chat-title').textContent = conv.title;
    setAvatar($('#chat-avatar'), conv);
    const sub = { public: 'Canale aperto a tutti i partecipanti', announce: 'Comunicazioni degli organizzatori', group: 'Gruppo · tocca per i dettagli', dm: 'Chat privata' };
    $('#chat-subtitle').textContent = sub[conv.type] || '';
  }

  let readTimer = null;
  function markRead() {
    clearTimeout(readTimer);
    readTimer = setTimeout(() => {
      const id = state.current;
      const conv = id && state.convs.get(id);
      if (!conv || !conv.lastMessage || document.hidden) return;
      if (conv.readSent >= conv.lastMessage.id) return;
      conv.readSent = conv.lastMessage.id;
      api('POST', `/api/conversations/${id}/read`, { messageId: conv.lastMessage.id }).catch(() => {});
    }, 800);
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) markRead(); });

  function sortedMsgs(id) {
    return [...(state.messages.get(id) || new Map()).values()].sort((a, b) => a.id - b.id);
  }

  function renderAllMessages(scrollBottom) {
    const box = $('#messages');
    const id = state.current;
    const prevHeight = box.scrollHeight;
    const prevTop = box.scrollTop;
    box.textContent = '';
    if (state.hasMore.get(id)) {
      const b = el('button', 'load-more', 'Carica messaggi precedenti');
      b.addEventListener('click', loadOlder);
      box.append(b);
    }
    let prev = null;
    for (const m of sortedMsgs(id)) { box.append(buildMessage(m, prev)); prev = m; }
    if (scrollBottom) box.scrollTop = box.scrollHeight;
    else box.scrollTop = box.scrollHeight - prevHeight + prevTop;
  }

  async function loadOlder() {
    const id = state.current;
    const list = sortedMsgs(id);
    if (!list.length) return;
    try {
      const data = await api('GET', `/api/conversations/${id}/messages?before=${list[0].id}`);
      const store = state.messages.get(id);
      for (const m of data.messages) if (!store.has(m.id)) store.set(m.id, m);
      state.hasMore.set(id, data.hasMore);
      if (state.current === id) renderAllMessages(false);
    } catch (err) { toast(err.message); }
  }
  $('#messages').addEventListener('scroll', (e) => {
    if (e.target.scrollTop < 40 && state.hasMore.get(state.current) && !loadOlder.busy) {
      loadOlder.busy = true;
      loadOlder().finally(() => { loadOlder.busy = false; });
    }
  });

  function buildMessage(m, prev) {
    const frag = document.createDocumentFragment();
    const conv = state.convs.get(m.conversationId);
    if (!prev || new Date(prev.createdAt).toDateString() !== new Date(m.createdAt).toDateString()) {
      frag.append(el('div', 'day', fmtDay(m.createdAt)));
      prev = null;
    }
    if (isSystemText(m.text) && !m.deleted) {
      const s = el('div', 'msg system', m.text);
      s.dataset.id = m.id;
      frag.append(s);
      return frag;
    }
    const mine = m.userId === state.me.id;
    const div = el('div', 'msg' + (mine ? ' me' : '') + (m.deleted ? ' deleted' : ''));
    div.dataset.id = m.id;
    div.dataset.user = m.userId;
    const sameAuthor = prev && prev.userId === m.userId && !isSystemText(prev.text) && m.createdAt - prev.createdAt < 5 * 60_000;
    if (sameAuthor) div.classList.add('cont');
    if (!mine && conv && conv.type !== 'dm' && !sameAuthor) {
      const a = el('span', 'author', m.userName);
      a.style.color = `hsl(${hue(m.userId)} 55% 40%)`;
      a.addEventListener('click', (e) => { e.stopPropagation(); userMenu(m.userId, m.userName); });
      div.append(a);
    }
    div.append(el('span', 'text', m.deleted ? '🚫 Messaggio eliminato' : m.text));
    div.append(el('span', 'meta', fmtTime(m.createdAt)));
    if (!m.deleted && (mine || state.me.isAdmin)) {
      const del = el('button', 'msg-del', '🗑');
      del.title = 'Elimina';
      del.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm('Eliminare questo messaggio per tutti?')) return;
        try { await api('DELETE', `/api/messages/${m.id}`); } catch (err) { toast(err.message); }
      });
      div.append(del);
      div.addEventListener('click', () => div.classList.toggle('show-actions'));
    }
    frag.append(div);
    return frag;
  }

  function renderMessage(m) {
    const box = $('#messages');
    const existing = box.querySelector(`[data-id="${m.id}"]`);
    if (existing) {
      const prevEl = existing.previousElementSibling;
      const prevMsg = prevEl && prevEl.dataset.id ? state.messages.get(m.conversationId)?.get(Number(prevEl.dataset.id)) : null;
      const frag = buildMessage(m, prevMsg || { createdAt: m.createdAt, userId: -1, text: '' });
      existing.replaceWith(frag);
      return;
    }
    const list = sortedMsgs(m.conversationId);
    const last = list[list.length - 1];
    if (last && last.id !== m.id) return renderAllMessages(atBottom()); // arrivato fuori ordine
    const nearBottom = atBottom();
    const prev = list[list.length - 2] || null;
    box.append(buildMessage(m, prev));
    if (nearBottom || m.userId === state.me.id) box.scrollTop = box.scrollHeight;
  }
  function atBottom() {
    const box = $('#messages');
    return box.scrollHeight - box.scrollTop - box.clientHeight < 120;
  }

  // ------------------------------------------------------------- Invio
  const input = $('#msg-input');
  function autosize() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 140) + 'px';
  }
  input.addEventListener('input', autosize);
  input.addEventListener('keydown', (e) => {
    const touch = window.matchMedia('(pointer: coarse)').matches;
    if (e.key === 'Enter' && !e.shiftKey && !touch) { e.preventDefault(); $('#composer').requestSubmit(); }
  });
  $('#composer').addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    const id = state.current;
    if (!text || !id) return;
    const btn = $('#send-btn');
    btn.disabled = true;
    try {
      const { message } = await api('POST', `/api/conversations/${id}/messages`, { text });
      input.value = '';
      autosize();
      handleIncoming([message]);
    } catch (err) {
      toast(err.message);
    } finally {
      btn.disabled = false;
      input.focus();
    }
  });

  // ------------------------------------------------------------ Modale
  function openModal(title, build) {
    $('#modal-title').textContent = title;
    const body = $('#modal-body');
    body.textContent = '';
    build(body);
    $('#modal').classList.remove('hidden');
  }
  function closeModal() { $('#modal').classList.add('hidden'); }
  $('#modal-close').addEventListener('click', closeModal);
  $('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

  function menuButton(label, onClick, cls) {
    const b = el('button', 'menu-btn' + (cls ? ' ' + cls : ''), label);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }

  // Ricerca utenti con lista cliccabile. multi = selezione multipla.
  function userPicker(body, { multi = false, onPick, exclude = new Set() }) {
    const search = el('input');
    search.type = 'search';
    search.placeholder = 'Cerca per nome tra i partecipanti';
    const ul = el('ul', 'list');
    ul.dataset.empty = 'Scrivi un nome per cercare';
    const selected = new Map();
    const chips = el('div', 'chips');
    let timer = null;
    async function run() {
      const term = search.value.trim();
      if (term.length < 2) { ul.textContent = ''; ul.dataset.empty = 'Scrivi almeno 2 lettere'; return; }
      try {
        const { users } = await api('GET', '/api/users?q=' + encodeURIComponent(term));
        ul.textContent = '';
        ul.dataset.empty = 'Nessun partecipante trovato';
        for (const u of users) {
          if (exclude.has(u.id)) continue;
          const li = el('li');
          const av = el('span', 'avatar');
          setAvatar(av, { type: 'user', title: u.name, otherUserId: u.id });
          li.append(av, el('div', 'info name', u.name));
          if (multi) {
            const check = el('span', 'check', selected.has(u.id) ? '✔' : '');
            li.append(check);
            if (selected.has(u.id)) li.classList.add('checked');
            li.addEventListener('click', () => {
              if (selected.has(u.id)) selected.delete(u.id); else selected.set(u.id, u.name);
              li.classList.toggle('checked'); check.textContent = selected.has(u.id) ? '✔' : '';
              renderChips();
            });
          } else li.addEventListener('click', () => onPick(u));
          ul.append(li);
        }
      } catch (err) { toast(err.message); }
    }
    function renderChips() {
      chips.textContent = '';
      for (const name of selected.values()) chips.append(el('span', 'chip', name));
    }
    search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 250); });
    body.append(search, chips, ul);
    setTimeout(() => search.focus(), 50);
    return { selected };
  }

  async function startDm(userId) {
    try {
      const { id } = await api('POST', '/api/dm', { userId });
      closeModal();
      if (!state.convs.has(id)) await refreshConvs();
      openConv(id);
    } catch (err) { toast(err.message); }
  }

  $('#btn-new').addEventListener('click', () => {
    openModal('Nuova chat', (body) => {
      body.append(menuButton('👥  Nuovo gruppo', newGroup));
      if (state.me.isAdmin) body.append(menuButton('📣  Nuovo canale pubblico (organizzatori)', newChannel));
      userPicker(body, { onPick: (u) => startDm(u.id) });
    });
  });

  function newGroup() {
    openModal('Nuovo gruppo', (body) => {
      const name = el('input');
      name.type = 'text';
      name.placeholder = 'Nome del gruppo (es. Cabina 512, Gita Mykonos…)';
      name.maxLength = 60;
      body.append(name);
      const picker = userPicker(body, { multi: true });
      const create = el('button', 'btn', 'Crea gruppo');
      create.addEventListener('click', async () => {
        try {
          const { id } = await api('POST', '/api/groups', { name: name.value, memberIds: [...picker.selected.keys()] });
          closeModal();
          await refreshConvs();
          openConv(id);
        } catch (err) { toast(err.message); }
      });
      body.append(create);
      setTimeout(() => name.focus(), 60);
    });
  }

  function newChannel() {
    openModal('Nuovo canale', (body) => {
      body.append(el('p', 'muted', 'I canali sono visibili a tutti i partecipanti.'));
      const name = el('input');
      name.type = 'text';
      name.placeholder = 'Es. 🎶 Festa sul ponte';
      name.maxLength = 60;
      const lbl = el('label');
      const chk = el('input');
      chk.type = 'checkbox';
      lbl.append(chk, document.createTextNode(' Solo gli organizzatori possono scrivere'));
      const create = el('button', 'btn', 'Crea canale');
      create.addEventListener('click', async () => {
        try {
          const { id } = await api('POST', '/api/admin/channels', { name: name.value, announce: chk.checked });
          closeModal();
          await refreshConvs();
          openConv(id);
        } catch (err) { toast(err.message); }
      });
      body.append(name, lbl, create);
    });
  }

  function userMenu(userId, userName) {
    if (userId === state.me.id) return;
    openModal(userName, (body) => {
      body.append(menuButton('💬  Scrivi in privato', () => startDm(userId)));
      if (state.me.isAdmin) {
        body.append(menuButton('⛔  Sospendi utente (organizzatori)', async () => {
          if (!confirm(`Sospendere ${userName}? Non potrà più accedere alla chat.`)) return;
          try { await api('POST', '/api/admin/ban', { userId }); toast('Utente sospeso'); closeModal(); }
          catch (err) { toast(err.message); }
        }, 'danger'));
      }
    });
  }

  $('#chat-title-btn').addEventListener('click', async () => {
    const conv = state.convs.get(state.current);
    if (!conv) return;
    if (conv.type === 'dm') return userMenu(conv.otherUserId, conv.title);
    if (conv.type !== 'group') return;
    let info;
    try { info = await api('GET', `/api/conversations/${conv.id}`); } catch (err) { return toast(err.message); }
    openModal(conv.title, (body) => {
      body.append(el('p', 'muted', `${info.members.length} partecipanti`));
      const ul = el('ul', 'list');
      for (const u of info.members) {
        const li = el('li');
        const av = el('span', 'avatar');
        setAvatar(av, { type: 'user', title: u.name, otherUserId: u.id });
        li.append(av, el('div', 'info name', u.name + (u.id === state.me.id ? ' (tu)' : '')));
        if (u.id !== state.me.id) li.addEventListener('click', () => userMenu(u.id, u.name));
        ul.append(li);
      }
      body.append(ul);
      body.append(menuButton('➕  Aggiungi persone', () => addMembers(conv, new Set(info.members.map((u) => u.id)))));
      body.append(menuButton('🚪  Esci dal gruppo', async () => {
        if (!confirm('Uscire dal gruppo?')) return;
        try {
          await api('POST', `/api/conversations/${conv.id}/leave`);
          closeModal();
          state.convs.delete(conv.id);
          state.messages.delete(conv.id);
          goBack();
        } catch (err) { toast(err.message); }
      }, 'danger'));
    });
  });

  function addMembers(conv, exclude) {
    openModal('Aggiungi a ' + conv.title, (body) => {
      const picker = userPicker(body, { multi: true, exclude });
      const btn = el('button', 'btn', 'Aggiungi');
      btn.addEventListener('click', async () => {
        try {
          await api('POST', `/api/conversations/${conv.id}/members`, { userIds: [...picker.selected.keys()] });
          closeModal();
        } catch (err) { toast(err.message); }
      });
      body.append(btn);
    });
  }

  $('#btn-menu').addEventListener('click', () => {
    openModal('Menu', (body) => {
      if (state.me.isAdmin) {
        body.append(menuButton('📊  Statistiche', async () => {
          try {
            const s = await api('GET', '/api/admin/stats');
            toast(`${s.online} online · ${s.users} iscritti · ${s.messages} messaggi`);
          } catch (err) { toast(err.message); }
        }));
      }
      body.append(menuButton('🚪  Esci', async () => {
        if (!confirm('Uscire? Per rientrare ti servirà il tuo codice personale.')) return;
        try { await api('POST', '/api/logout'); } catch {}
        location.reload();
      }, 'danger'));
    });
  });

  start();
})();
