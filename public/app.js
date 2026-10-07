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
  // Niente zoom, come in un'app: iOS ignora user-scalable=no per il pizzico, quindi
  // blocchiamo anche i gesti a due dita e Ctrl+rotella sul computer.
  for (const ev of ['gesturestart', 'gesturechange', 'gestureend']) {
    window.addEventListener(ev, (e) => e.preventDefault(), { passive: false });
    document.addEventListener(ev, (e) => e.preventDefault(), { passive: false });
  }
  const noPinch = (e) => { if (e.touches && e.touches.length > 1) e.preventDefault(); };
  document.addEventListener('touchstart', noPinch, { passive: false });
  document.addEventListener('touchmove', noPinch, { passive: false });
  document.addEventListener('touchmove', (e) => { if (typeof e.scale === 'number' && e.scale !== 1) e.preventDefault(); }, { passive: false });

  // Su iPhone la tastiera non ridimensiona la pagina: usiamo l'area visibile reale,
  // così intestazione e campo di scrittura restano al loro posto.
  const vv = window.visualViewport;
  if (vv) {
    const fit = () => {
      document.documentElement.style.setProperty('--app-h', vv.height + 'px');
      if (window.scrollY || window.scrollX) window.scrollTo(0, 0);
    };
    vv.addEventListener('resize', fit);
    vv.addEventListener('scroll', fit);
    fit();
  }
  document.addEventListener('wheel', (e) => { if (e.ctrlKey) e.preventDefault(); }, { passive: false });
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && ['+', '-', '=', '0'].includes(e.key)) e.preventDefault();
  });

  // In anteprima (demo.js) le chiamate vanno a un server simulato nel browser.
  const demo = window.DEMO_SERVER || null;

  async function api(method, url, body) {
    if (demo) return demo.request(method, url, body);
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
  // Colori dell'evento assegnati in modo stabile a ogni persona (avatar e nome nelle chat).
  const palette = (n) => Math.abs(Math.floor(Number(n) || 0)) % 5;
  function setAvatar(node, conv) {
    node.textContent = '';
    if (conv.type === 'dm' || conv.type === 'user') {
      node.textContent = initials(conv.title);
      node.className = 'avatar av-' + palette(conv.otherUserId || conv.id);
    } else {
      const m = conv.title.match(/^\p{Extended_Pictographic}/u);
      node.textContent = m ? m[0] : conv.type === 'group' ? '👥' : '#';
      node.className = 'avatar av-' + (conv.type === 'announce' ? 'announce' : conv.type === 'group' ? 'group' : 'public');
    }
  }
  // Titolo senza l'emoji iniziale (che è già nell'avatar).
  const plainTitle = (c) => (c.type === 'dm' ? c.title : c.title.replace(/^\p{Extended_Pictographic}\uFE0F?\s*/u, ''));
  const ICON_PIN = '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M14 3l7 7-3 1-4 4 1 5-2 1-4-4-5 5-1-1 5-5-4-4 1-2 5 1 4-4z" fill="currentColor"/></svg>';
  const ICON_TRASH = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const isJumbo = (t) => t.length <= 12 && /^(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|\u200D|\uFE0F|\s)+$/u.test(t) && (t.match(/\p{Extended_Pictographic}/gu) || []).length <= 3;
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
      $('#join-code-field').classList.toggle('hidden', !cfg.joinCodeRequired);
      $('#join-code').required = !!cfg.joinCodeRequired;
    } catch {}
    try {
      const saved = JSON.parse(localStorage.getItem('gr-login') || 'null');
      if (saved) {
        $('#first-name').value = saved.firstName || '';
        $('#last-name').value = saved.lastName || '';
        $('#email').value = saved.email || '';
      }
    } catch {}
    if (!$('#first-name').value) $('#first-name').focus();
  }

  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#login-error').textContent = '';
    const btn = e.target.querySelector('button');
    const data = {
      firstName: $('#first-name').value,
      lastName: $('#last-name').value,
      email: $('#email').value,
      joinCode: $('#join-code').value,
    };
    btn.disabled = true;
    try {
      await api('POST', '/api/register', data);
      try { localStorage.setItem('gr-login', JSON.stringify({ firstName: data.firstName, lastName: data.lastName, email: data.email })); } catch {}
      start();
    } catch (err) { $('#login-error').textContent = err.message; }
    finally { btn.disabled = false; }
  });

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
    $('#me-avatar').title = state.me.name + (state.me.isAdmin ? ' (organizzatore)' : '');
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
        const data = demo ? await demo.poll(state.cursor) : await fetch('/api/poll?since=' + state.cursor, { signal: state.pollCtrl.signal, credentials: 'same-origin' })
          .then(async (r) => {
            if (r.status === 401 || r.status === 403) { const e = new Error('auth'); e.status = r.status; throw e; }
            if (!r.ok) throw new Error('http ' + r.status);
            return r.json();
          });
        $('#offline').classList.add('hidden');
        delay = 0;
        state.cursor = Math.max(state.cursor, data.cursor);
        if (data.messages.length) {
          handleIncoming(data.messages);
          // Breve pausa prima della prossima richiesta: i messaggi arrivati nel frattempo
          // arrivano tutti insieme. Con migliaia di persone online dimezza il carico
          // del server e risparmia banda satellitare.
          await new Promise((r) => setTimeout(r, 1000));
        }
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

  let tab = 'all';
  const TAB_TEST = {
    all: () => true,
    unread: (c) => c.unread > 0,
    groups: (c) => c.type !== 'dm',
    dm: (c) => c.type === 'dm',
  };
  for (const b of document.querySelectorAll('#tabs button')) {
    b.addEventListener('click', () => {
      tab = b.dataset.tab;
      for (const x of document.querySelectorAll('#tabs button')) x.classList.toggle('on', x === b);
      renderConvList();
    });
  }

  function renderConvList() {
    const ul = $('#conv-list');
    const filter = $('#conv-filter').value.trim().toLowerCase();
    ul.textContent = '';
    let totalUnread = 0;
    let shown = 0;
    for (const c of sortedConvs()) {
      totalUnread += c.unread || 0;
      if (filter && !c.title.toLowerCase().includes(filter)) continue;
      if (!TAB_TEST[tab](c)) continue;
      shown++;
      const li = el('li');
      if (c.id === state.current) li.classList.add('active');
      if (c.unread) li.classList.add('unread');
      const av = el('span', 'avatar');
      setAvatar(av, c);
      const info = el('div', 'info');
      const r1 = el('div', 'row');
      const name = el('span', 'name', plainTitle(c));
      if (c.type === 'announce') name.append(el('span', 'tag', 'Ufficiale'));
      r1.append(name, el('span', 'time', c.lastMessage ? fmtListTime(c.lastMessage.createdAt) : ''));
      const r2 = el('div', 'row');
      let preview = '';
      if (c.lastMessage) {
        const lm = c.lastMessage;
        const who = lm.userId === state.me.id ? 'Tu: ' : c.type !== 'dm' && !isSystemText(lm.text) ? lm.userName.split(' ')[0] + ': ' : '';
        preview = lm.deleted ? '🚫 Messaggio eliminato' : who + lm.text.replace(/\n/g, ' ');
      }
      r2.append(el('span', 'preview', preview));
      if (c.unread) r2.append(el('span', 'badge', c.unread > 99 ? '99+' : String(c.unread)));
      else if (c.type === 'announce' || c.type === 'public') { const pin = el('span', 'pin'); pin.innerHTML = ICON_PIN; pin.title = 'In evidenza'; r2.append(pin); }
      info.append(r1, r2);
      li.append(av, info);
      li.addEventListener('click', () => openConv(c.id));
      ul.append(li);
    }
    if (!shown) {
      const empty = el('li', 'list-empty');
      empty.append(el('span', 'big', tab === 'unread' ? '🎉' : '🌊'), document.createTextNode(
        filter ? 'Nessuna chat con questo nome' : tab === 'unread' ? 'Tutto letto, sei in pari!' : tab === 'dm' ? 'Nessuna chat privata. Premi «Nuova chat» per scrivere a qualcuno.' : 'Ancora niente qui'));
      ul.append(empty);
    }
    const unreadTab = document.querySelector('#tabs [data-tab="unread"]');
    unreadTab.textContent = 'Non lette';
    if (totalUnread) unreadTab.append(el('span', 'n', totalUnread > 99 ? '99+' : String(totalUnread)));
    document.title = (totalUnread ? `(${totalUnread}) ` : '') + 'Global Reunion · Cruise Edition';
  }
  $('#conv-filter').addEventListener('input', renderConvList);

  // ----------------------------------------------------------- Chat aperta
  async function openConv(id) {
    const conv = state.convs.get(id);
    if (!conv) return;
    state.current = id;
    // Su mobile il tasto "indietro" del telefono deve tornare alla lista, non uscire dal sito.
    try {
      if (history.state && history.state.chat) history.replaceState({ chat: true }, '', '#' + id);
      else history.pushState({ chat: true }, '', '#' + id);
    } catch {}
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
    missed = 0;
    updateToBottom();
    syncComposer();
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
    $('#chat-title').textContent = plainTitle(conv);
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
    const list = sortedMsgs(id);
    for (const m of list) { box.append(buildMessage(m, prev)); prev = m; }
    if (!list.length && !state.hasMore.get(id)) box.append(helloCard());
    if (scrollBottom) box.scrollTop = box.scrollHeight;
    else box.scrollTop = box.scrollHeight - prevHeight + prevTop;
  }

  function helloCard() {
    const conv = state.convs.get(state.current);
    const card = el('div', 'chat-hello');
    card.append(el('span', 'big', conv && conv.type === 'dm' ? '👋' : '🌊'), el('strong', null, 'Rompi il ghiaccio'),
      el('span', null, conv && conv.type === 'dm' ? `Scrivi il primo messaggio a ${conv.title.split(' ')[0]}` : 'Scrivi il primo messaggio della chat'));
    return card;
  }

  // Pulsante per tornare agli ultimi messaggi, con il numero di quelli arrivati nel frattempo.
  let missed = 0;
  function updateToBottom() {
    const show = !atBottom();
    if (!show) missed = 0;
    $('#to-bottom').classList.toggle('hidden', !show);
    $('#to-bottom-n').classList.toggle('hidden', !missed);
    $('#to-bottom-n').textContent = missed > 99 ? '99+' : String(missed);
  }
  $('#to-bottom').addEventListener('click', () => {
    const box = $('#messages');
    box.scrollTo({ top: box.scrollHeight, behavior: 'smooth' });
  });

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
    updateToBottom();
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
      const a = el('span', 'author c-' + palette(m.userId), m.userName);
      a.addEventListener('click', (e) => { e.stopPropagation(); userMenu(m.userId, m.userName); });
      div.append(a);
    }
    div.append(el('span', 'text' + (!m.deleted && isJumbo(m.text) ? ' jumbo' : ''), m.deleted ? '🚫 Messaggio eliminato' : m.text));
    div.append(el('span', 'meta', fmtTime(m.createdAt)));
    if (!m.deleted && (mine || state.me.isAdmin)) {
      const del = el('button', 'msg-del');
      del.innerHTML = ICON_TRASH;
      del.title = 'Elimina';
      del.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!await askConfirm('Eliminare questo messaggio per tutti?', 'Elimina')) return;
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
    const hello = box.querySelector('.chat-hello');
    if (hello) hello.remove();
    box.append(buildMessage(m, prev));
    const added = box.lastElementChild;
    if (added) added.classList.add('appear');
    if (nearBottom || m.userId === state.me.id) box.scrollTop = box.scrollHeight;
    else { missed++; updateToBottom(); }
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
  const syncComposer = () => $('#composer').classList.toggle('has-text', input.value.trim().length > 0);
  input.addEventListener('input', () => { autosize(); syncComposer(); });
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
      syncComposer();
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
    modalOnClose = null;
    $('#modal-title').textContent = title;
    const body = $('#modal-body');
    body.textContent = '';
    build(body);
    $('#modal').classList.remove('hidden');
  }
  let modalOnClose = null;
  function closeModal() {
    $('#modal').classList.add('hidden');
    const cb = modalOnClose;
    modalOnClose = null;
    if (cb) cb();
  }
  $('#modal-close').addEventListener('click', closeModal);
  $('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

  // Conferma dentro la pagina (al posto di confirm(), che non sempre è disponibile).
  function askConfirm(question, okLabel = 'Conferma') {
    return new Promise((resolve) => {
      openModal('Sei sicuro?', (body) => {
        body.append(el('p', null, question));
        const row = el('div', 'confirm-row');
        const no = el('button', 'btn secondary', 'Annulla');
        const yes = el('button', 'btn danger', okLabel);
        no.type = yes.type = 'button';
        const answer = (value) => { modalOnClose = null; closeModal(); resolve(value); };
        no.addEventListener('click', () => answer(false));
        yes.addEventListener('click', () => answer(true));
        row.append(no, yes);
        body.append(row);
        setTimeout(() => yes.focus(), 30);
      });
      modalOnClose = () => resolve(false);
    });
  }

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
      // Senza testo mostra i primi partecipanti in ordine alfabetico.
      const term = search.value.trim();
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
    run();
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

  $('#fab-new').addEventListener('click', () => $('#btn-new').click());
  $('#btn-new').addEventListener('click', () => {
    openModal('Nuova chat', (body) => {
      body.append(menuButton('👥  Crea un gruppo', newGroup, 'primary'));
      if (state.me.isAdmin) body.append(menuButton('📣  Nuovo canale pubblico (organizzatori)', newChannel));
      body.append(el('div', 'section-label', 'Scrivi in privato a…'));
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
          if (!await askConfirm(`Sospendere ${userName}? Non potrà più accedere alla chat.`, 'Sospendi')) return;
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
        if (!await askConfirm('Uscire dal gruppo?', 'Esci')) return;
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

  // Per chi è iscritto all'evento con un'email diversa da quella che vuole usare.
  function allowEmailDialog() {
    openModal('Abilita un\'email', (body) => {
      body.append(el('p', 'muted', 'Possono registrarsi solo le email dei partecipanti. Se qualcuno ha prenotato con un altro indirizzo, abilita qui quello che vuole usare.'));
      const input = el('input');
      input.type = 'text';
      input.inputMode = 'email';
      input.placeholder = 'nome@email.com';
      const btn = el('button', 'btn', 'Abilita');
      btn.type = 'button';
      btn.addEventListener('click', async () => {
        try {
          const r = await api('POST', '/api/admin/allow', { email: input.value });
          toast(r.already ? 'Questa email poteva già registrarsi' : 'Email abilitata: ora può registrarsi');
          closeModal();
        } catch (err) { toast(err.message); }
      });
      body.append(input, btn);
      setTimeout(() => input.focus(), 50);
    });
  }

  $('#btn-menu').addEventListener('click', () => {
    openModal('Menu', (body) => {
      body.append(el('p', 'muted', 'Sei connesso come ' + state.me.name + (state.me.isAdmin ? ' ⭐ organizzatore' : '')));
      if (state.me.isAdmin) {
        body.append(menuButton('✉️  Abilita un\'email (organizzatori)', allowEmailDialog));
        body.append(menuButton('📊  Statistiche', async () => {
          try {
            const s = await api('GET', '/api/admin/stats');
            toast(`${s.online} online · ${s.users} iscritti · ${s.messages} messaggi`);
          } catch (err) { toast(err.message); }
        }));
      }
      body.append(menuButton('🚪  Esci', async () => {
        if (!await askConfirm('Uscire? Per rientrare userai di nuovo nome, cognome ed email.', 'Esci')) return;
        try { await api('POST', '/api/logout'); } catch {}
        location.reload();
      }, 'danger'));
    });
  });

  start();
})();
