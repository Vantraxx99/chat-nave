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
      const err = new Error(data.error || 'Network error');
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
    return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  }
  function fmtListTime(ts) {
    const d = new Date(ts);
    const today = new Date();
    if (d.toDateString() === today.toDateString()) return fmtTime(ts);
    const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
    if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit' });
  }
  function fmtDay(ts) {
    const d = new Date(ts);
    const today = new Date();
    if (d.toDateString() === today.toDateString()) return 'Today';
    const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
    if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
    return d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
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
    $('#me-avatar').title = state.me.name + (state.me.isAdmin ? ' (organiser)' : '');
    setAvatar($('#me-avatar'), { type: 'user', title: state.me.name, otherUserId: state.me.id });
    show('app');
    renderConvList();
    refreshPushCard();
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
        const visible = document.visibilityState === 'visible' ? 1 : 0;
        const data = demo ? await demo.poll(state.cursor) : await fetch(`/api/poll?since=${state.cursor}&v=${visible}`, { signal: state.pollCtrl.signal, credentials: 'same-origin' })
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
        if (err.name === 'AbortError') continue; // riavvio voluto (app in primo piano / in background)
        $('#offline').classList.remove('hidden');
        delay = Math.min(delay ? delay * 2 : 1000, 15000);
        await new Promise((r) => setTimeout(r, delay + Math.random() * 1000));
      }
    }
  }

  // Quando l'app passa in primo piano o in background riapriamo la richiesta,
  // così il server sa se mandare la notifica push o no.
  document.addEventListener('visibilitychange', () => {
    if (state.me && state.pollCtrl && !demo) state.pollCtrl.abort();
  });

  function handleIncoming(list) {
    let needRefresh = false;
    let listChanged = false;
    let ring = null;
    for (const m of list) {
      const conv = state.convs.get(m.conversationId);
      if (!conv) {
        // Chat nuova (es. la prima volta che qualcuno ti scrive): la lista si aggiorna a parte.
        needRefresh = true;
        if (!m.deleted && m.userId !== state.me.id) ring = ring || 'message';
        continue;
      }
      const store = state.messages.get(m.conversationId);
      const known = store && store.has(m.id);
      if (store) store.set(m.id, m);

      const isNewest = !conv.lastMessage || m.id >= conv.lastMessage.id;
      if (isNewest) { conv.lastMessage = m; listChanged = true; }
      if (!known && !m.deleted && m.userId !== state.me.id && state.current !== m.conversationId
          && (!conv.lastSeenId || m.id > conv.lastSeenId)) {
        conv.unread = (conv.unread || 0) + 1;
        listChanged = true;
        ring = conv.type === 'announce' ? 'announce' : ring || 'message';
      }
      conv.lastSeenId = Math.max(conv.lastSeenId || 0, m.id);
      if (state.current === m.conversationId) renderMessage(m);
    }
    if (state.current) markRead();
    if (listChanged) renderConvList();
    if (needRefresh) scheduleRefresh();
    if (ring) alertUser(ring);
  }

  // --------------------------------------------------- Suono e vibrazione
  // Il suono è generato al volo (nessun file da scaricare via satellite).
  const prefs = { sound: true, vibrate: true };
  try { Object.assign(prefs, JSON.parse(localStorage.getItem('gr-prefs') || '{}')); } catch {}
  const savePrefs = () => { try { localStorage.setItem('gr-prefs', JSON.stringify(prefs)); } catch {} };
  let audioCtx = null;
  function unlockAudio() {
    // Su iPhone l'audio parte solo dopo un tocco dell'utente.
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
    } catch {}
  }
  for (const ev of ['pointerdown', 'keydown', 'touchend']) document.addEventListener(ev, unlockAudio, { passive: true });

  function playTone(kind) {
    if (!audioCtx || audioCtx.state !== 'running') return;
    const notes = kind === 'announce' ? [659, 880, 1175] : [880, 1320];
    const t0 = audioCtx.currentTime + 0.01;
    notes.forEach((f, i) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = f;
      const t = t0 + i * 0.11;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.18, t + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(t);
      osc.stop(t + 0.25);
    });
  }

  let lastAlert = 0;
  function alertUser(kind) {
    // In background ci pensa la notifica push; qui solo con l'app davanti.
    if (document.visibilityState !== 'visible') return;
    const now = Date.now();
    if (now - lastAlert < 1500) return;
    lastAlert = now;
    if (prefs.sound) playTone(kind);
    if (prefs.vibrate && navigator.vibrate) navigator.vibrate(kind === 'announce' ? [120, 60, 120, 60, 120] : [90, 50, 90]);
  }

  // --------------------------------------------------- Notifiche push
  const pushSupported = !demo && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  let swReg = null;
  if (!demo && 'serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').then((r) => { swReg = r; refreshPushCard(); }).catch(() => {});
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data && e.data.type === 'open-conv' && e.data.convId && state.convs.has(e.data.convId)) openConv(e.data.convId);
    });
  }

  function urlB64ToBytes(b64) {
    const pad = '='.repeat((4 - (b64.length % 4)) % 4);
    const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(raw, (c) => c.charCodeAt(0));
  }

  async function pushStatus() {
    if (isIOS && !isStandalone) return 'ios-home';
    if (!pushSupported) return 'unsupported';
    if (Notification.permission === 'denied') return 'denied';
    const reg = swReg || await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    return sub && Notification.permission === 'granted' ? 'on' : 'off';
  }

  async function enablePush() {
    try {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') { toast('Notifications not allowed: you can turn them on in your phone settings'); return false; }
      const reg = swReg || await navigator.serviceWorker.ready;
      const { publicKey } = await api('GET', '/api/push/key');
      let sub = await reg.pushManager.getSubscription();
      if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToBytes(publicKey) });
      await api('POST', '/api/push/subscribe', { subscription: sub.toJSON() });
      toast('🔔 Notifications on');
      refreshPushCard();
      return true;
    } catch (err) {
      toast('Could not turn on notifications');
      return false;
    }
  }

  async function disablePush() {
    try {
      const reg = swReg || await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await api('POST', '/api/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {});
        await sub.unsubscribe();
      }
    } catch {}
  }

  // ------------------------------------------- Installazione sulla Home
  // Android/Chrome: il browser ci offre il suo pulsante "Installa".
  let installPrompt = null;
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e; refreshPushCard(); });
  window.addEventListener('appinstalled', () => { installPrompt = null; refreshPushCard(); });
  const isAndroid = /Android/i.test(navigator.userAgent);
  const inAppBrowser = /Instagram|FBAN|FBAV|Line\/|TikTok|Snapchat/i.test(navigator.userAgent);

  async function installApp() {
    if (!installPrompt) return installGuide();
    installPrompt.prompt();
    try { await installPrompt.userChoice; } catch {}
    installPrompt = null;
    refreshPushCard();
  }

  const SVG = {
    share: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M12 3v12M8 7l4-4 4 4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M6 10H5v10h14V10h-1" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>',
    plus: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="4" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 8v8M8 12h8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    dots: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><circle cx="12" cy="5" r="2" fill="currentColor"/><circle cx="12" cy="12" r="2" fill="currentColor"/><circle cx="12" cy="19" r="2" fill="currentColor"/></svg>',
    more: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><circle cx="5" cy="12" r="2" fill="currentColor"/><circle cx="12" cy="12" r="2" fill="currentColor"/><circle cx="19" cy="12" r="2" fill="currentColor"/></svg>',
  };
  const GUIDE = {
    ios: [
      ['Open the chat in <b>Safari</b>. If you opened it from Instagram, WhatsApp or another app, first choose “Open in Safari”.', null],
      ['Tap <b>Share</b> in the bottom bar. If you can\'t see it, tap <b>⋯</b> first.', 'share'],
      ['Scroll down and tap <b>“Add to Home Screen”</b>.', 'plus'],
      ['Tap <b>Add</b> in the top right. From now on, open the chat from the <b>Global Reunion</b> icon.', null],
    ],
    android: [
      ['Open the chat in <b>Chrome</b>.', null],
      ['Tap the <b>⋮</b> menu in the top right.', 'dots'],
      ['Tap <b>“Add to Home screen”</b> or <b>“Install app”</b>.', 'plus'],
      ['Confirm with <b>Install</b>. The <b>Global Reunion</b> icon appears with your apps.', null],
    ],
  };

  function installGuide() {
    openModal('Add to Home Screen', (body) => {
      body.append(el('p', 'muted', 'The chat opens full screen like an app, and you can get notifications.'));
      const seg = el('div', 'seg');
      const steps = el('ol', 'steps');
      const tabs = [['ios', '📱 iPhone'], ['android', '🤖 Android']];
      const showTab = (key) => {
        for (const b of seg.children) b.classList.toggle('on', b.dataset.k === key);
        steps.textContent = '';
        GUIDE[key].forEach(([html, icon], i) => {
          const li = el('li');
          const n = el('span', 'step-n', String(i + 1));
          const t = el('span', 'step-t');
          t.innerHTML = html; // testo fisso scritto da noi, nessun dato degli utenti
          li.append(n, t);
          if (icon) { const ic = el('span', 'step-ic'); ic.innerHTML = SVG[icon]; li.append(ic); }
          steps.append(li);
        });
      };
      for (const [k, label] of tabs) {
        const b = el('button', null, label);
        b.type = 'button';
        b.dataset.k = k;
        b.addEventListener('click', () => showTab(k));
        seg.append(b);
      }
      body.append(seg, steps);
      if (installPrompt) {
        const quick = el('button', 'btn lime', '📲 Install in one tap');
        quick.type = 'button';
        quick.addEventListener('click', () => { closeModal(); installApp(); });
        body.append(quick);
      }
      if (inAppBrowser) body.append(el('p', 'note', '⚠️ You are using another app\'s built-in browser: open the chat in Safari or Chrome to add it to your Home Screen.'));
      showTab(isAndroid ? 'android' : 'ios');
    });
  }
  $('#home-guide-link').addEventListener('click', installGuide);

  // In cima alla lista: prima l'invito a mettere l'app sulla Home, poi quello per le notifiche.
  async function refreshPushCard() {
    const card = $('#push-card');
    if (!card || !state.me) return;
    let dismissedPush = false, dismissedHome = false;
    try {
      dismissedPush = localStorage.getItem('gr-push-card') === 'no';
      dismissedHome = localStorage.getItem('gr-home-card') === 'no';
    } catch {}
    card.textContent = '';
    const text = el('div', 'push-text');
    const close = el('button', 'push-close');
    close.type = 'button';
    close.setAttribute('aria-label', 'Not now');
    close.textContent = '✕';
    const isMobile = isIOS || isAndroid;
    if (!isStandalone && isMobile && !dismissedHome) {
      card.classList.remove('hidden');
      close.addEventListener('click', () => { try { localStorage.setItem('gr-home-card', 'no'); } catch {} refreshPushCard(); });
      text.append(el('strong', null, '📲 Add the chat to your Home Screen'), el('span', null, 'It opens full screen like an app, and you get notifications.'));
      const btn = el('button', 'btn lime push-on', installPrompt ? 'Install' : 'How to');
      btn.type = 'button';
      btn.addEventListener('click', installApp);
      card.append(text, btn, close);
      return;
    }
    const st = await pushStatus().catch(() => 'unsupported');
    if (dismissedPush || st === 'on' || st === 'unsupported' || st === 'denied') { card.classList.add('hidden'); return; }
    card.classList.remove('hidden');
    close.addEventListener('click', () => { try { localStorage.setItem('gr-push-card', 'no'); } catch {} card.classList.add('hidden'); });
    if (st === 'ios-home') {
      text.append(el('strong', null, '🔔 Notifications on iPhone'), el('span', null, 'They only work when you open the chat from your Home Screen.'));
      const how = el('button', 'btn lime push-on', 'How to');
      how.type = 'button';
      how.addEventListener('click', installGuide);
      card.append(text, how, close);
    } else {
      text.append(el('strong', null, '🔔 Don\'t miss a message'), el('span', null, 'Get notified even when the chat is closed.'));
      const btn = el('button', 'btn lime push-on', 'Turn on');
      btn.type = 'button';
      btn.addEventListener('click', enablePush);
      card.append(text, btn, close);
    }
  }

  function notificationsDialog() {
    openModal('Notifications', async (body) => {
      const st = await pushStatus().catch(() => 'unsupported');
      const label = {
        on: '✅ Push notifications are on for this device',
        off: 'Push notifications are off',
        denied: 'Notifications are blocked: turn them back on in your phone settings',
        unsupported: 'This browser does not support push notifications',
        'ios-home': 'On iPhone, notifications only work after adding the chat to your Home Screen',
      }[st];
      body.append(el('p', null, label));
      if (st === 'off') body.append(menuButton('🔔  Turn on push notifications', async () => { if (await enablePush()) closeModal(); }, 'primary'));
      if (st === 'on') body.append(menuButton('🔕  Turn off on this device', async () => { await disablePush(); toast('Notifications off'); closeModal(); refreshPushCard(); }));
      const soundBtn = menuButton('', () => { prefs.sound = !prefs.sound; savePrefs(); paint(); if (prefs.sound) { unlockAudio(); playTone('message'); } });
      const vibBtn = menuButton('', () => { prefs.vibrate = !prefs.vibrate; savePrefs(); paint(); if (prefs.vibrate && navigator.vibrate) navigator.vibrate(80); });
      const paint = () => {
        soundBtn.textContent = (prefs.sound ? '🔊  Sound: on' : '🔇  Sound: off');
        vibBtn.textContent = (prefs.vibrate ? '📳  Vibration: on' : '📴  Vibration: off');
      };
      paint();
      body.append(el('div', 'section-label', 'While the chat is open'), soundBtn, vibBtn);
      if (!navigator.vibrate) body.append(el('p', 'muted', 'Vibration is not available on iPhone in the browser.'));
    });
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
      if (c.type === 'announce') name.append(el('span', 'tag', 'Official'));
      r1.append(name, el('span', 'time', c.lastMessage ? fmtListTime(c.lastMessage.createdAt) : ''));
      const r2 = el('div', 'row');
      let preview = '';
      if (c.lastMessage) {
        const lm = c.lastMessage;
        const who = lm.userId === state.me.id ? 'You: ' : c.type !== 'dm' && !isSystemText(lm.text) ? lm.userName.split(' ')[0] + ': ' : '';
        preview = lm.deleted ? '🚫 Message deleted' : who + lm.text.replace(/\n/g, ' ');
      }
      r2.append(el('span', 'preview', preview));
      if (c.unread) r2.append(el('span', 'badge', c.unread > 99 ? '99+' : String(c.unread)));
      else if (c.type === 'announce' || c.type === 'public') { const pin = el('span', 'pin'); pin.innerHTML = ICON_PIN; pin.title = 'Pinned'; r2.append(pin); }
      info.append(r1, r2);
      li.append(av, info);
      li.addEventListener('click', () => openConv(c.id));
      ul.append(li);
    }
    if (!shown) {
      const empty = el('li', 'list-empty');
      empty.append(el('span', 'big', tab === 'unread' ? '🎉' : '🌊'), document.createTextNode(
        filter ? 'No chats with this name' : tab === 'unread' ? 'All caught up!' : tab === 'dm' ? 'No private chats yet. Tap “New chat” to message someone.' : 'Nothing here yet'));
      ul.append(empty);
    }
    const unreadTab = document.querySelector('#tabs [data-tab="unread"]');
    unreadTab.textContent = 'Unread';
    if (totalUnread) unreadTab.append(el('span', 'n', totalUnread > 99 ? '99+' : String(totalUnread)));
    document.title = (totalUnread ? `(${totalUnread}) ` : '') + 'Global Reunion · Cruise Edition';
    try {
      if (navigator.setAppBadge) totalUnread ? navigator.setAppBadge(totalUnread) : navigator.clearAppBadge();
    } catch {}
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
      box.append(el('div', 'day', 'Loading…'));
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
    const sub = { public: 'Channel open to all participants', announce: 'Official updates from the organisers', group: 'Group · tap for details', dm: 'Private chat' };
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
      const b = el('button', 'load-more', 'Load earlier messages');
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
    card.append(el('span', 'big', conv && conv.type === 'dm' ? '👋' : '🌊'), el('strong', null, 'Break the ice'),
      el('span', null, conv && conv.type === 'dm' ? `Send the first message to ${conv.title.split(' ')[0]}` : 'Send the first message in this chat'));
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
    div.append(el('span', 'text' + (!m.deleted && isJumbo(m.text) ? ' jumbo' : ''), m.deleted ? '🚫 Message deleted' : m.text));
    div.append(el('span', 'meta', fmtTime(m.createdAt)));
    if (!m.deleted && (mine || state.me.isAdmin)) {
      const del = el('button', 'msg-del');
      del.innerHTML = ICON_TRASH;
      del.title = 'Delete';
      del.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!await askConfirm('Delete this message for everyone?', 'Delete')) return;
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
  function askConfirm(question, okLabel = 'Confirm') {
    return new Promise((resolve) => {
      openModal('Are you sure?', (body) => {
        body.append(el('p', null, question));
        const row = el('div', 'confirm-row');
        const no = el('button', 'btn secondary', 'Cancel');
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
    search.placeholder = 'Search participants by name';
    const ul = el('ul', 'list');
    ul.dataset.empty = 'Type a name to search';
    const selected = new Map();
    const chips = el('div', 'chips');
    let timer = null;
    async function run() {
      // Senza testo mostra i primi partecipanti in ordine alfabetico.
      const term = search.value.trim();
      try {
        const { users } = await api('GET', '/api/users?q=' + encodeURIComponent(term));
        ul.textContent = '';
        ul.dataset.empty = 'No participants found';
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
    openModal('New chat', (body) => {
      body.append(menuButton('👥  Create a group', newGroup, 'primary'));
      if (state.me.isAdmin) body.append(menuButton('📣  New public channel (organisers)', newChannel));
      body.append(el('div', 'section-label', 'Message privately…'));
      userPicker(body, { onPick: (u) => startDm(u.id) });
    });
  });

  function newGroup() {
    openModal('New group', (body) => {
      const name = el('input');
      name.type = 'text';
      name.placeholder = 'Group name (e.g. Cabin 512, Mykonos trip…)';
      name.maxLength = 60;
      body.append(name);
      const picker = userPicker(body, { multi: true });
      const create = el('button', 'btn', 'Create group');
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
    openModal('New channel', (body) => {
      body.append(el('p', 'muted', 'Channels are visible to all participants.'));
      const name = el('input');
      name.type = 'text';
      name.placeholder = 'E.g. 🎶 Deck party';
      name.maxLength = 60;
      const lbl = el('label');
      const chk = el('input');
      chk.type = 'checkbox';
      lbl.append(chk, document.createTextNode(' Only organisers can post'));
      const create = el('button', 'btn', 'Create channel');
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
      body.append(menuButton('💬  Send a private message', () => startDm(userId)));
      if (state.me.isAdmin) {
        body.append(menuButton('⛔  Suspend user (organisers)', async () => {
          if (!await askConfirm(`Suspend ${userName}? They will no longer be able to use the chat.`, 'Suspend')) return;
          try { await api('POST', '/api/admin/ban', { userId }); toast('User suspended'); closeModal(); }
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
      body.append(el('p', 'muted', `${info.members.length} participants`));
      const ul = el('ul', 'list');
      for (const u of info.members) {
        const li = el('li');
        const av = el('span', 'avatar');
        setAvatar(av, { type: 'user', title: u.name, otherUserId: u.id });
        li.append(av, el('div', 'info name', u.name + (u.id === state.me.id ? ' (you)' : '')));
        if (u.id !== state.me.id) li.addEventListener('click', () => userMenu(u.id, u.name));
        ul.append(li);
      }
      body.append(ul);
      body.append(menuButton('➕  Add people', () => addMembers(conv, new Set(info.members.map((u) => u.id)))));
      body.append(menuButton('🚪  Leave group', async () => {
        if (!await askConfirm('Leave this group?', 'Leave')) return;
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
    openModal('Add to ' + conv.title, (body) => {
      const picker = userPicker(body, { multi: true, exclude });
      const btn = el('button', 'btn', 'Add');
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
    openModal('Allow an email', (body) => {
      body.append(el('p', 'muted', 'Only participants\' emails can sign up. If someone booked with a different address, allow the one they want to use here.'));
      const input = el('input');
      input.type = 'text';
      input.inputMode = 'email';
      input.placeholder = 'nome@email.com';
      const btn = el('button', 'btn', 'Allow');
      btn.type = 'button';
      btn.addEventListener('click', async () => {
        try {
          const r = await api('POST', '/api/admin/allow', { email: input.value });
          toast(r.already ? 'This email could already sign up' : 'Email allowed: they can now sign up');
          closeModal();
        } catch (err) { toast(err.message); }
      });
      body.append(input, btn);
      setTimeout(() => input.focus(), 50);
    });
  }

  $('#btn-menu').addEventListener('click', () => {
    openModal('Menu', (body) => {
      body.append(el('p', 'muted', 'Signed in as ' + state.me.name + (state.me.isAdmin ? ' ⭐ organiser' : '')));
      if (state.me.isAdmin) {
        body.append(menuButton('✉️  Allow an email (organisers)', allowEmailDialog));
        body.append(menuButton('📊  Stats', async () => {
          try {
            const s = await api('GET', '/api/admin/stats');
            toast(`${s.online} online · ${s.users} members · ${s.messages} messages`);
          } catch (err) { toast(err.message); }
        }));
      }
      body.append(menuButton('🔔  Notifications, sound & vibration', notificationsDialog));
      body.append(menuButton('📲  Add to Home Screen', installGuide));
      body.append(menuButton('🚪  Sign out', async () => {
        if (!await askConfirm('Sign out? To sign back in, just use your name, surname and email again.', 'Sign out')) return;
        await disablePush();
        try { await api('POST', '/api/logout'); } catch {}
        location.reload();
      }, 'danger'));
    });
  });

  start();
})();
