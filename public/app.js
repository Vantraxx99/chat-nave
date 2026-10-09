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
    receipts: new Map(),  // convId -> { read, delivered } (spunte dei miei messaggi)
    current: null,
    pollCtrl: null,
    refreshTimer: null,
  };

  // ------------------------------------------------------------------ API
  // Animazione di apertura: dura circa 4,5 secondi (un tocco la chiude subito), poi si
  // toglie. Saltata dopo un aggiornamento automatico (la pagina si ricarica da sola).
  (() => {
    const splash = document.getElementById('splash');
    if (!splash) return;
    let skip = false;
    try { skip = sessionStorage.getItem('gr-skip-splash') === '1'; sessionStorage.removeItem('gr-skip-splash'); } catch {}
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (skip) { splash.remove(); return; }
    const timer = setTimeout(() => splash.remove(), reduce ? 1250 : 4650);
    splash.addEventListener('click', () => {
      clearTimeout(timer);
      splash.classList.add('out');
      setTimeout(() => splash.remove(), 380);
    }, { once: true });
  })();

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
  // (Aperta dalla Home, iOS può lasciare sotto la pagina una fascia che colora lui con il
  // blu dell'evento: per questo le barre in basso dell'app sono blu, così si fondono.)
  const vv = window.visualViewport;
  if (vv) {
    const typing = () => { const a = document.activeElement; return !!a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA'); };
    const fit = () => {
      // Senza nessun campo attivo la tastiera è chiusa: altezza piena anche se iOS
      // non ha ancora aggiornato l'area visibile (niente spazio vuoto in basso).
      const h = typing() ? vv.height : Math.max(vv.height, window.innerHeight);
      document.documentElement.style.setProperty('--app-h', h + 'px');
      // Con la tastiera aperta il margine per la barretta in basso dell'iPhone non serve.
      document.documentElement.classList.toggle('kb-open', typing() && vv.height < (screen.height || 9999) * 0.75);
      if (window.scrollY || window.scrollX) window.scrollTo(0, 0);
    };
    vv.addEventListener('resize', fit);
    vv.addEventListener('scroll', fit);
    document.addEventListener('focusout', () => { for (const t of [50, 300, 700]) setTimeout(fit, t); });
    window.fitViewport = fit;
    fit();
  }
  document.addEventListener('wheel', (e) => { if (e.ctrlKey) e.preventDefault(); }, { passive: false });
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && ['+', '-', '=', '0'].includes(e.key)) e.preventDefault();
  });

  // In anteprima (demo.js) le chiamate vanno a un server simulato nel browser.
  const demo = window.DEMO_SERVER || null;

  // Aggiornamento automatico: la pagina conosce la sua versione, il server manda
  // la sua con ogni risposta. Se cambiano, ricarichiamo appena è sicuro farlo.
  const myVersion = (document.querySelector('meta[name="app-version"]') || {}).content || '';
  function checkVersion(res) {
    const v = res && res.headers && res.headers.get('X-App-Version');
    if (!v || !myVersion || myVersion.startsWith('__') || v === myVersion || checkVersion.pending) return;
    checkVersion.pending = true;
    const tryReload = () => {
      // Mai dentro una chat: la pagina "dietro" (nella cronologia) sarebbe quella vecchia e
      // il gesto indietro di iOS ricaricherebbe tutto (schermo bianco). Si aggiorna dalla lista.
      const busy = ($('#msg-input') && $('#msg-input').value.trim()) || !$('#modal').classList.contains('hidden')
        || (state.current && isPhone());
      if (busy) return setTimeout(tryReload, 3000);
      try { sessionStorage.setItem('gr-skip-splash', '1'); } catch {}
      try { history.replaceState(history.state && history.state.list ? history.state : null, '', location.pathname); } catch {}
      location.reload();
    };
    tryReload();
  }

  async function api(method, url, body) {
    if (demo) return demo.request(method, url, body);
    const opts = { method, headers: {}, credentials: 'same-origin' };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(url, opts);
    checkVersion(res);
    let data = {};
    try { data = await res.json(); } catch {}
    if (!res.ok) {
      const err = new Error(data.error || 'Network error');
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function toast(text, ms = 3000) {
    const t = $('#toast');
    t.textContent = text;
    t.classList.remove('hidden');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => t.classList.add('hidden'), ms);
  }

  // Errori imprevisti: li mostriamo in un avviso, così sul telefono si vede cosa non va.
  window.addEventListener('error', (e) => { if (e && e.message) toast('⚠️ ' + e.message); });
  window.addEventListener('unhandledrejection', (e) => {
    const r = e && e.reason;
    if (r && r.name !== 'AbortError' && r.message && r.message !== 'auth') toast('⚠️ ' + r.message);
  });

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
      node.className = 'avatar av-' + (conv.type === 'announce' ? 'announce' : conv.type === 'group' ? 'group' : conv.type === 'staff' ? 'staff' : 'public');
    }
  }
  // Titolo senza l'emoji iniziale (che è già nell'avatar).
  const plainTitle = (c) => (c.type === 'dm' ? c.title : c.title.replace(/^\p{Extended_Pictographic}\uFE0F?\s*/u, ''));
  const ICON_PIN = '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M14 3l7 7-3 1-4 4 1 5-2 1-4-4-5 5-1-1 5-5-4-4 1-2 5 1 4-4z" fill="currentColor"/></svg>';
  const ICON_REPLY = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M10 7L4 12l6 5M4 12h10a6 6 0 0 1 6 6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const ICON_SMILE = '<svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8.5 14.5q3.5 3.5 7 0" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="9" cy="10" r="1.3" fill="currentColor"/><circle cx="15" cy="10" r="1.3" fill="currentColor"/></svg>';
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
  // Accesso a passi. "email" → il server dice cosa serve:
  //  password (account esistente) · new (prima volta: nome, cognome e password)
  //  setup (account di prima delle password: cognome + nuova password)
  let loginStep = 'email';
  let codeRequired = false;   // il server manda un codice per email prima di creare l'account
  let pending = null;          // dati della registrazione in attesa del codice
  const LOGIN_STEPS = {
    email: { title: 'Sign in or join', button: 'Continue', hint: 'New here? You\'ll create your account in a moment. Already joined? You\'ll just need your password.' },
    password: { title: 'Welcome back!', button: 'Sign in', hint: 'Forgot your password? Ask an organiser to reset it: they\'ll give you a code to choose a new one.' },
    new: { title: 'Create your account', button: 'Join the chat', hint: 'Choose a password you\'ll remember: you\'ll need it to sign in on another phone, and nobody else can write as you.' },
    newCode: { title: 'Create your account', button: 'Send me the code', hint: 'We\'ll email you a 6-digit code to confirm it\'s really you. Then you\'ll sign in with your email and password.' },
    verify: { title: 'Check your email', button: 'Join the chat', hint: '' },
    setup: { title: 'Secure your account', button: 'Save & sign in', hint: 'Chats now have passwords, so nobody can write pretending to be you. Confirm your last name and choose one.' },
    setupCode: { title: 'Choose a new password', button: 'Save & sign in', hint: 'Enter the code an organiser gave you, or tap “Email me a code”.' },
  };
  function setLoginStep(step) {
    loginStep = step;
    const key = codeRequired && step === 'new' ? 'newCode' : codeRequired && step === 'setup' ? 'setupCode' : step;
    const cfg = LOGIN_STEPS[key];
    $('#login-title').textContent = cfg.title;
    $('#login-submit').textContent = cfg.button;
    $('#login-hint').textContent = step === 'verify'
      ? `We sent a 6-digit code to ${pending.email}. It can take a minute: check your spam folder too.` : cfg.hint;
    $('#login-error').textContent = '';
    const email = $('#email');
    email.readOnly = step !== 'email';
    $('#email-change').classList.toggle('hidden', step === 'email');
    const names = step === 'new' || (step === 'setup' && !codeRequired);
    $('#f-names').classList.toggle('hidden', !names);
    $('#f-first').classList.toggle('hidden', step !== 'new');
    $('#f-password').classList.toggle('hidden', step === 'email' || step === 'verify');
    $('#f-password2').classList.toggle('hidden', step !== 'new' && step !== 'setup');
    $('#f-code').classList.toggle('hidden', !(step === 'verify' || (step === 'setup' && codeRequired)));
    $('#otp-send').textContent = step === 'verify' ? 'Resend code' : 'Email me a code';
    $('#otp').value = '';
    $('#join-code-field').classList.toggle('hidden', step !== 'new' || !initLogin.joinCode);
    const pw = $('#password');
    if (step !== 'verify') { pw.value = ''; $('#password2').value = ''; }
    pw.autocomplete = step === 'password' ? 'current-password' : 'new-password';
    $('#password-label').textContent = step === 'password' ? 'Password' : 'Choose a password (min. 6 characters)';
    const focus = {
      email, password: pw, verify: $('#otp'),
      new: $('#first-name').value ? pw : $('#first-name'),
      setup: codeRequired ? pw : $('#last-name').value ? pw : $('#last-name'),
    }[step];
    setTimeout(() => focus.focus(), 30);
  }
  async function sendCode() {
    const btn = $('#otp-send');
    btn.disabled = true;
    try {
      await api('POST', '/api/login/send-code', { email: $('#email').value.trim(), firstName: (pending && pending.firstName) || $('#first-name').value.trim() });
      toast('Code sent: check your email 📬');
      setTimeout(() => { btn.disabled = false; }, 60_000);
      return true;
    } catch (e) {
      $('#login-error').textContent = e.message;
      btn.disabled = false;
      return false;
    }
  }
  $('#otp-send').addEventListener('click', sendCode);
  $('#otp').addEventListener('input', (e) => { e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6); });
  $('#email-change').addEventListener('click', () => setLoginStep('email'));
  for (const eye of document.querySelectorAll('.pw-eye')) {
    eye.addEventListener('click', () => {
      const inp = document.getElementById(eye.dataset.for);
      const show = inp.type === 'password';
      inp.type = show ? 'text' : 'password';
      eye.classList.toggle('on', show);
      eye.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    });
  }

  async function initLogin() {
    show('login');
    try {
      const cfg = await api('GET', '/api/config');
      initLogin.joinCode = !!cfg.joinCodeRequired;
    } catch {}
    try {
      const saved = JSON.parse(localStorage.getItem('gr-login') || 'null');
      if (saved) {
        $('#first-name').value = saved.firstName || '';
        $('#last-name').value = saved.lastName || '';
        $('#email').value = saved.email || '';
      }
    } catch {}
    setLoginStep('email');
  }

  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = (t) => { $('#login-error').textContent = t; };
    err('');
    const btn = $('#login-submit');
    const email = $('#email').value.trim();
    if (!email) return err('Please enter your email');
    btn.disabled = true;
    try {
      if (loginStep === 'email') {
        const res = await api('POST', '/api/login/check', { email });
        if (res.step === 'closed') return err('Sign-ups are not open yet: the organisers will send you the link when the chat opens. See you soon! 🚢');
        if (res.step === 'not-allowed') return err('This email is not on the Global Reunion participant list. Use the one you booked the trip with, or ask an organiser to allow it.');
        codeRequired = !!res.codeRequired;
        return setLoginStep(res.step);
      }
      const data = loginStep === 'verify' ? { ...pending } : {
        email,
        password: $('#password').value,
        firstName: $('#first-name').value.trim(),
        lastName: $('#last-name').value.trim(),
        joinCode: $('#join-code').value,
      };
      if (loginStep === 'new' && (!data.firstName || !data.lastName)) return err('Please enter your first and last name');
      if (loginStep === 'setup' && !codeRequired && !data.lastName) return err('Please enter your last name');
      if (!data.password) return err('Please enter your password');
      if (loginStep === 'new' || loginStep === 'setup') {
        if (data.password.length < 6) return err('Choose a password of at least 6 characters');
        if (data.password !== $('#password2').value) return err('The two passwords don\'t match');
      }
      if (loginStep === 'new' && codeRequired) {
        // Prima il codice via email, poi l'account.
        pending = data;
        if (await sendCode()) setLoginStep('verify');
        return;
      }
      if (loginStep === 'verify' || (loginStep === 'setup' && codeRequired)) {
        data.code = $('#otp').value;
        if (data.code.length !== 6) return err('Enter the 6-digit code');
      }
      await api('POST', '/api/register', data);
      pending = null;
      try { localStorage.setItem('gr-login', JSON.stringify({ firstName: data.firstName, lastName: data.lastName, email })); } catch {}
      $('#password').value = ''; $('#password2').value = '';
      start();
    } catch (e2) {
      if (e2.status === 409) setLoginStep('password');
      err(e2.message);
    } finally { btn.disabled = false; }
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
    state.supportOpen = data.supportOpen !== false;
    state.cursor = data.cursor;
    state.convs.clear();
    for (const c of data.conversations) { c.lastSeenId = c.lastMessage ? c.lastMessage.id : 0; state.convs.set(c.id, c); if (c.receipt) state.receipts.set(c.id, c.receipt); }
    $('#me-avatar').title = state.me.name + (state.me.isAdmin ? ' (organiser)' : '');
    setAvatar($('#me-avatar'), { type: 'user', title: state.me.name, otherUserId: state.me.id });
    $('#tab-support').classList.toggle('hidden', !state.me.isAdmin);
    show('app');
    renderConvList();
    refreshPushCard();
    syncPush();
    // Si parte sempre dalla lista (anche dopo un aggiornamento o da una notifica): la chat
    // si apre sopra, così "indietro" torna alla lista e non esce dall'app.
    const fromHash = Number(location.hash.slice(1));
    // Su telefono, dietro la lista c'è una pagina "di guardia" dell'app: scorrendo indietro
    // dalla lista si torna lì e l'app rimette subito la lista, invece di finire sulla pagina
    // vuota del browser che iOS tiene in fondo alla cronologia.
    try {
      if (isPhone()) { history.replaceState({ root: true }, '', location.pathname); history.pushState({ list: true }, '', location.pathname); }
      else history.replaceState(null, '', location.pathname);
    } catch {}
    if (fromHash && state.convs.has(fromHash)) openConv(fromHash);
    poll();
    // Chi era entrato prima delle password ne sceglie una subito.
    if (!state.me.hasPassword) passwordDialog(true);
  }

  async function refreshConvs() {
    try {
      const data = await api('GET', '/api/me');
      state.convs.clear();
      for (const c of data.conversations) { c.lastSeenId = c.lastMessage ? c.lastMessage.id : 0; state.convs.set(c.id, c); if (c.receipt) state.receipts.set(c.id, c.receipt); }
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
  // Il banner "No connection" compare solo se il problema dura: un singolo errore
  // (telefono bloccato, cambio di rete, connessione chiusa dalla rete di bordo) si
  // ripara da solo in un attimo e non deve allarmare nessuno.
  let pollWait = 25; // secondi che il server tiene aperta la richiesta
  let wakePoll = null; // interrompe la pausa tra un tentativo e l'altro
  let failingSince = 0;
  let offlineTimer = null;
  function pollOk() {
    failingSince = 0;
    clearTimeout(offlineTimer); offlineTimer = null;
    $('#offline').classList.add('hidden');
  }
  function pollFailed() {
    if (!failingSince) failingSince = Date.now();
    if (!offlineTimer) offlineTimer = setTimeout(() => { if (failingSince) $('#offline').classList.remove('hidden'); }, 6000);
  }
  function pause(ms) {
    return new Promise((r) => { const t = setTimeout(r, ms); wakePoll = () => { clearTimeout(t); r(); }; }).finally(() => { wakePoll = null; });
  }
  async function poll() {
    let delay = 0;
    while (state.me) {
      const ctrl = new AbortController();
      state.pollCtrl = ctrl;
      // Una richiesta che non risponde più (connessione morta in silenzio) si chiude da sola.
      const watchdog = setTimeout(() => { ctrl.stale = true; ctrl.abort(); }, (pollWait + 15) * 1000);
      const started = Date.now();
      try {
        // Dopo un errore la richiesta torna subito: così il banner sparisce appena la rete c'è.
        const visible = document.visibilityState === 'visible' ? 1 : 0;
        const data = demo ? await demo.poll(state.cursor) : await fetch(`/api/poll?since=${state.cursor}&v=${visible}&t=${failingSince ? 1 : pollWait}`, { signal: ctrl.signal, credentials: 'same-origin', cache: 'no-store' })
          .then(async (r) => {
            checkVersion(r);
            if (r.status === 401 || r.status === 403) { const e = new Error('auth'); e.status = r.status; throw e; }
            if (!r.ok) throw new Error('http ' + r.status);
            return r.json();
          });
        clearTimeout(watchdog);
        pollOk();
        delay = 0;
        state.cursor = Math.max(state.cursor, data.cursor);
        if (data.receipts && data.receipts.length) applyReceipts(data.receipts);
        if (data.conversations && data.conversations.length) mergeConvs(data.conversations);
        if (data.messages.length) {
          handleIncoming(data.messages);
          // Breve pausa prima della prossima richiesta: i messaggi arrivati nel frattempo
          // arrivano tutti insieme. Con migliaia di persone online dimezza il carico
          // del server e risparmia banda satellitare.
          await new Promise((r) => setTimeout(r, 1000));
        }
      } catch (err) {
        clearTimeout(watchdog);
        if (err.status === 401 || err.status === 403) { state.me = null; return initLogin(); }
        if (err.name === 'AbortError' && !ctrl.stale) continue; // riavvio voluto (app in primo piano / in background)
        // Richiesta caduta dopo essere rimasta aperta un po': la rete chiude le connessioni
        // ferme. Da qui in poi attese più corte, che la rete lascia passare.
        if (document.visibilityState === 'visible' && Date.now() - started > 8000 && pollWait > 10) pollWait = 10;
        pollFailed();
        // Primo tentativo subito, poi sempre più distanziati (massimo 10 s).
        delay = delay ? Math.min(delay * 2, 10000) : 300;
        await pause(delay + Math.random() * 500);
      }
    }
  }

  // Quando l'app passa in primo piano o in background riapriamo la richiesta,
  // così il server sa se mandare la notifica push o no.
  document.addEventListener('visibilitychange', () => {
    if (state.me && !demo && document.visibilityState === 'hidden' && navigator.sendBeacon) {
      try { navigator.sendBeacon('/api/away', new Blob(['{}'], { type: 'application/json' })); } catch {}
    }
    if (state.me && state.pollCtrl && !demo) state.pollCtrl.abort();
    if (document.visibilityState === 'visible' && wakePoll) wakePoll();
    if (document.visibilityState === 'visible' && !demo) fetch('/healthz', { cache: 'no-store' }).then(checkVersion).catch(() => {});
  });
  // Rete tornata: riprova subito invece di aspettare la pausa.
  window.addEventListener('online', () => { if (wakePoll) wakePoll(); });

  // ----------------------------------------------------------- Spunte
  // ✓ inviato · ✓✓ consegnato (arrivato sul telefono) · ✓✓ blu letto. Il server manda,
  // per ogni chat, fin dove gli altri hanno ricevuto e letto.
  const TICK_CHATS = new Set(['dm', 'group', 'staff']);
  const ICON_TICK = '<svg viewBox="0 0 16 11" width="16" height="11" aria-hidden="true"><path d="M1.5 6l3.2 3.2L11 2.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const ICON_TICKS = '<svg viewBox="0 0 16 11" width="16" height="11" aria-hidden="true"><path d="M1 6l3 3L10.2 2.5M6.6 8.4l.6.6L13.6 2.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  function tickState(m) {
    const r = state.receipts.get(m.conversationId);
    if (r && m.id <= r.read) return 'read';
    if (r && m.id <= r.delivered) return 'delivered';
    return 'sent';
  }
  function tickNode(m) {
    const st = tickState(m);
    const t = el('span', 'ticks ' + st);
    t.innerHTML = st === 'sent' ? ICON_TICK : ICON_TICKS;
    t.title = st === 'read' ? 'Read' : st === 'delivered' ? 'Delivered' : 'Sent';
    return t;
  }
  function updateTicks() {
    const store = state.messages.get(state.current);
    if (!store) return;
    for (const node of $('#messages').querySelectorAll('.msg.me .ticks')) {
      const m = store.get(Number(node.closest('.msg').dataset.id));
      if (m) node.replaceWith(tickNode(m));
    }
  }
  function applyReceipts(list) {
    let listChanged = false;
    for (const r of list) {
      state.receipts.set(r.conversationId, r);
      if (r.conversationId === state.current) updateTicks();
      const c = state.convs.get(r.conversationId);
      if (c && c.lastMessage && c.lastMessage.userId === state.me.id) listChanged = true;
    }
    if (listChanged) renderConvList();
  }
  // Chat aggiornate dal server (es. una richiesta allo staff segnata come risolta da un altro organizzatore).
  function mergeConvs(list) {
    for (const c of list) {
      const old = state.convs.get(c.id);
      if (old) { c.lastSeenId = old.lastSeenId; c.unread = old.unread; }
      else c.lastSeenId = c.lastMessage ? c.lastMessage.id : 0;
      state.convs.set(c.id, c);
      if (c.receipt) state.receipts.set(c.id, c.receipt);
    }
    renderConvList();
    if (state.current) renderChatHeader();
  }

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
      // Il polling manda i conteggi a tutti, ma non "la mia" reazione: la teniamo da prima.
      if (known && m.myReaction === undefined) m.myReaction = m.deleted ? null : store.get(m.id).myReaction;
      if (store) store.set(m.id, m);

      const isNewest = !conv.lastMessage || m.id >= conv.lastMessage.id;
      if (vanishes(m, conv)) {
        // Annuncio cancellato: sparisce del tutto, anche dall'anteprima nella lista.
        if (isNewest) { const rest = store ? sortedMsgs(conv.id) : []; conv.lastMessage = rest[rest.length - 1] || null; listChanged = true; }
        if (state.current === m.conversationId) renderAllMessages(false);
        continue;
      }
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

  // A ogni apertura: se le notifiche sono attive, il telefono rimanda al server il suo
  // "indirizzo" per le notifiche. Così il server lo ritrova anche se l'aveva perso
  // (database rifatto, iscrizione scaduta, chiavi cambiate) e non resta muto.
  async function syncPush() {
    try {
      if (demo || !pushSupported || Notification.permission !== 'granted' || (isIOS && !isStandalone)) return;
      const reg = swReg || await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      const { publicKey } = await api('GET', '/api/push/key');
      const key = urlB64ToBytes(publicKey);
      const old = sub && sub.options && sub.options.applicationServerKey;
      if (sub && old && !sameBytes(new Uint8Array(old), key)) { await sub.unsubscribe(); sub = null; }
      if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      await api('POST', '/api/push/subscribe', { subscription: sub.toJSON() });
    } catch {}
  }
  function sameBytes(a, b) { return a.length === b.length && a.every((v, i) => v === b[i]); }

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
  let pushCardRun = 0;
  async function refreshPushCard() {
    const card = $('#push-card');
    if (!card || !state.me) return;
    // Può essere chiamata più volte di fila: vale solo l'ultima chiamata,
    // altrimenti il riquadro compare due volte.
    const run = ++pushCardRun;
    let dismissedPush = false, dismissedHome = false;
    try {
      dismissedPush = localStorage.getItem('gr-push-card') === 'no';
      dismissedHome = localStorage.getItem('gr-home-card') === 'no';
    } catch {}
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
      card.replaceChildren(text, btn, close);
      return;
    }
    const st = await pushStatus().catch(() => 'unsupported');
    if (run !== pushCardRun) return; // nel frattempo è partita una chiamata più recente
    if (dismissedPush || st === 'on' || st === 'unsupported' || st === 'denied') { card.classList.add('hidden'); return; }
    card.classList.remove('hidden');
    close.addEventListener('click', () => { try { localStorage.setItem('gr-push-card', 'no'); } catch {} card.classList.add('hidden'); });
    if (st === 'ios-home') {
      text.append(el('strong', null, '🔔 Notifications on iPhone'), el('span', null, 'They only work when you open the chat from your Home Screen.'));
      const how = el('button', 'btn lime push-on', 'How to');
      how.type = 'button';
      how.addEventListener('click', installGuide);
      card.replaceChildren(text, how, close);
    } else {
      text.append(el('strong', null, '🔔 Don\'t miss a message'), el('span', null, 'Get notified even when the chat is closed.'));
      const btn = el('button', 'btn lime push-on', 'Turn on');
      btn.type = 'button';
      btn.addEventListener('click', enablePush);
      card.replaceChildren(text, btn, close);
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
      if (st === 'on') {
        // Prova: dice subito se il server conosce questo telefono e cosa risponde Apple/Google.
        body.append(menuButton('🧪  Send a test notification now', async () => {
          await syncPush();
          try {
            const { results } = await api('POST', '/api/push/test', { delay: 0 });
            if (!results.length) return toast('⚠️ The server has no notification address for you. Turn notifications off and on again here.', 9000);
            const bad = results.filter((r) => !r.ok);
            if (!bad.length) return toast(`✅ Sent to ${results.length} device${results.length === 1 ? '' : 's'}. If nothing shows up, check iPhone Settings → Notifications → Global Reunion and Focus mode.`, 9000);
            toast(`⚠️ Not delivered (${bad.map((r) => `${r.device}: ${r.status || ''} ${r.error}`).join(' · ')})`, 12000);
          } catch (e) { toast(e.message); }
        }));
        body.append(menuButton('🔒  Test with the app closed (arrives in 15 s)', async () => {
          await syncPush();
          try {
            const { devices } = await api('POST', '/api/push/test', { delay: 15 });
            if (!devices) return toast('⚠️ The server has no notification address for you. Turn notifications off and on again here.', 9000);
            closeModal();
            toast('Now close the app and lock your phone: the test arrives in 15 seconds', 6000);
          } catch (e) { toast(e.message); }
        }));
      }
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
  // Chat di assistenza ricevute da un organizzatore (quelle dei partecipanti).
  // Organizzatori: tutte le chat con lo staff stanno nella voce unica "Staff support" e nella
  // scheda Support. "Attive" = con messaggi e non segnate come risolte (o riscritte dopo).
  const isInbox = (c) => c.type === 'staff' && !c.virtual && state.me && state.me.isAdmin;
  const isActiveRequest = (c) => isInbox(c) && c.lastMessage && c.lastMessage.id > (c.resolvedId || 0);
  const isResolvedRequest = (c) => isInbox(c) && c.lastMessage && c.lastMessage.id <= (c.resolvedId || 0);
  let showResolved = false;
  const byTime = (a, b) => (b.lastMessage ? b.lastMessage.createdAt : 0) - (a.lastMessage ? a.lastMessage.createdAt : 0);

  function sortedConvs() {
    // In cima, fissati: Staff support, poi Announcements, poi i canali pubblici.
    const pinned = (c) => (c.type === 'staff' ? 3 : c.type === 'announce' ? 2 : c.type === 'public' ? 1 : 0);
    // Chat private eliminate: nascoste finché non arriva un messaggio nuovo.
    const all = [...state.convs.values()].filter((c) => !(c.type === 'dm' && c.clearedId && !c.lastMessage && state.current !== c.id));
    if (tab === 'support') return all.filter(isActiveRequest).sort((a, b) => (b.unread ? 1 : 0) - (a.unread ? 1 : 0) || byTime(a, b));
    let list;
    if (state.me.isAdmin) {
      // Organizzatori: una sola voce "Staff support" che raccoglie tutte le richieste.
      const inbox = all.filter(isActiveRequest).sort(byTime);
      list = all.filter((c) => !isInbox(c));
      list.push({
        id: 'support-inbox', type: 'staff', title: '🛟 Staff support', virtual: 'inbox',
        unread: inbox.reduce((n, c) => n + (c.unread || 0), 0),
        // (le richieste risolte stanno nella scheda Support, sezione "Resolved")
        lastMessage: inbox[0] ? inbox[0].lastMessage : null, count: inbox.length,
      });
    } else {
      list = all;
      // Il partecipante vede sempre "Staff support", anche prima di aver scritto (la chat si crea al primo tocco).
      if (!list.some((c) => c.type === 'staff')) list.push({ id: 'staff', type: 'staff', title: '🛟 Staff support', lastMessage: null, unread: 0, virtual: 'new' });
    }
    return list.sort((a, b) => {
      const at = a.lastMessage ? a.lastMessage.createdAt : 0;
      const bt = b.lastMessage ? b.lastMessage.createdAt : 0;
      return pinned(b) - pinned(a) || bt - at;
    });
  }

  let tab = 'all';
  const TAB_TEST = {
    all: () => true,
    unread: (c) => c.unread > 0,
    groups: (c) => c.type !== 'dm' && c.type !== 'staff',
    dm: (c) => c.type === 'dm' || c.type === 'staff',
    support: () => true,
  };
  function selectTab(name) {
    tab = name;
    for (const x of document.querySelectorAll('#tabs button')) x.classList.toggle('on', x.dataset.tab === name);
    renderConvList();
  }
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
    for (const c of state.convs.values()) totalUnread += c.unread || 0;
    let shown = 0;
    let list = sortedConvs();
    // Scheda Support: in fondo le richieste risolte, in una sezione che si apre a richiesta.
    let resolvedCount = 0;
    if (tab === 'support') {
      const resolved = [...state.convs.values()].filter(isResolvedRequest).sort(byTime);
      resolvedCount = resolved.length;
      if (resolved.length) list = list.concat([{ sep: true }], showResolved ? resolved : []);
    }
    for (const c of list) {
      if (c.sep) {
        const sep = el('li', 'list-section');
        sep.append(el('span', null, `✅ Resolved · ${resolvedCount}`), el('span', 'chev', showResolved ? 'Hide' : 'Show'));
        sep.addEventListener('click', () => { showResolved = !showResolved; renderConvList(); });
        ul.append(sep);
        continue;
      }
      if (filter && !c.title.toLowerCase().includes(filter)) continue;
      if (!TAB_TEST[tab](c)) continue;
      shown++;
      const li = el('li');
      if (c.id === state.current) li.classList.add('active');
      if (isResolvedRequest(c)) li.classList.add('resolved');
      if (c.unread) li.classList.add('unread');
      const av = el('span', 'avatar');
      setAvatar(av, c);
      const info = el('div', 'info');
      const r1 = el('div', 'row');
      const name = el('span', 'name', plainTitle(c));
      if (c.type === 'announce') name.append(el('span', 'tag', 'Official'));
      if (c.virtual === 'inbox') name.append(el('span', 'tag', c.count ? `${c.count} chat${c.count === 1 ? '' : 's'}` : 'Inbox'));
      r1.append(name, el('span', 'time', c.lastMessage ? fmtListTime(c.lastMessage.createdAt) : ''));
      const r2 = el('div', 'row');
      let preview = '';
      if (c.lastMessage) {
        const lm = c.lastMessage;
        const who = lm.userId === state.me.id ? 'You: ' : c.type !== 'dm' && !isSystemText(lm.text) ? lm.userName.split(' ')[0] + ': ' : '';
        preview = lm.deleted ? '🚫 Message deleted' : who + lm.text.replace(/\n/g, ' ');
      } else if (c.virtual === 'new') {
        preview = supportLocked() ? 'Opens once we are on board 🚢' : 'Questions? Write to the organisers';
      } else if (c.virtual === 'inbox') {
        preview = 'Support requests from participants will appear here';
      }
      const pv = el('span', 'preview');
      const lm = c.lastMessage;
      if (lm && lm.userId === state.me.id && !lm.deleted && TICK_CHATS.has(c.type) && !isSystemText(lm.text)) {
        pv.append(tickNode(lm), document.createTextNode(lm.text.replace(/\n/g, ' ')));
      } else pv.textContent = preview;
      r2.append(pv);
      if (c.unread) r2.append(el('span', 'badge', c.unread > 99 ? '99+' : String(c.unread)));
      else if (c.type === 'announce' || c.type === 'public' || (c.type === 'staff' && tab !== 'support')) { const pin = el('span', 'pin'); pin.innerHTML = ICON_PIN; pin.title = 'Pinned'; r2.append(pin); }
      info.append(r1, r2);
      li.append(av, info);
      li.addEventListener('click', () => (li.dataset.held ? null : c.virtual === 'new' ? contactStaff() : c.virtual === 'inbox' ? selectTab('support') : openConv(c.id)));
      // Appena il dito tocca la chat iniziamo a scaricarne i messaggi (si guadagna ~100-300 ms).
      if (!c.virtual) li.addEventListener('pointerdown', () => { loadMessages(c.id).catch(() => {}); }, { passive: true });
      // Tieni premuto (o tasto destro) per eliminare la chat, come su WhatsApp.
      if (c.type === 'dm' || c.type === 'group') onLongPress(li, () => chatActions(c));
      else if (isInbox(c)) onLongPress(li, () => staffActions(c));
      ul.append(li);
    }
    if (!shown) {
      const empty = el('li', 'list-empty');
      if (tab === 'support' && resolvedCount) empty.classList.add('compact');
      empty.append(el('span', 'big', tab === 'unread' ? '🎉' : '🌊'), document.createTextNode(
        filter ? 'No chats with this name' : tab === 'unread' ? 'All caught up!' : tab === 'support' ? (resolvedCount ? 'No open requests: all resolved!' : 'No support requests yet') : tab === 'dm' ? 'No private chats yet. Tap “New chat” to message someone.' : 'Nothing here yet'));
      if (tab === 'support' && resolvedCount) ul.prepend(empty); else ul.append(empty);
    }
    // Scheda "Support" degli organizzatori: quante richieste di assistenza da leggere.
    const supportTab = $('#tab-support');
    if (state.me.isAdmin) {
      const pending = [...state.convs.values()].filter((c) => isActiveRequest(c) && c.unread).length;
      supportTab.textContent = '🛟 Support';
      if (pending) supportTab.append(el('span', 'n', String(pending)));
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
    if (state.current !== id) cancelReply();
    state.current = id;
    // Su mobile il tasto "indietro" del telefono deve tornare alla lista, non uscire dal sito.
    try {
      if (history.state && history.state.chat) history.replaceState({ chat: true }, '', '#' + id);
      else history.pushState({ chat: true }, '', '#' + id);
    } catch {}
    // Se i messaggi sono già sul telefono la chat si prepara prima e poi entra:
    // l'animazione parte pulita, senza il lavoro di disegno nel mezzo.
    const cached = state.messages.has(id);
    if (!cached) document.body.classList.add('in-chat');
    $('#chat-empty').classList.add('hidden');
    $('#chat-view').classList.remove('hidden');
    renderChatHeader();
    const staffLocked = conv.type === 'staff' && supportLocked();
    const canWrite = (conv.type !== 'announce' || state.me.isAdmin) && !staffLocked;
    $('#readonly-note').textContent = staffLocked ? '🛟 ' + SUPPORT_CLOSED : '📢 Only organisers can post here';
    $('#composer').classList.toggle('hidden', !canWrite);
    $('#readonly-note').classList.toggle('hidden', canWrite);
    conv.unread = 0;
    // Su telefono la lista è sotto la chat che entra: la aggiorniamo a animazione finita.
    if (isPhone()) setTimeout(renderConvList, 320); else renderConvList();

    const box = $('#messages');
    box.textContent = '';
    if (!state.messages.has(id)) {
      // "Loading…" solo se il caricamento dura: di solito i messaggi arrivano durante l'animazione.
      const slow = setTimeout(() => { if (state.current === id && !box.firstChild) box.append(el('div', 'day', 'Loading…')); }, 350);
      try {
        await loadMessages(id);
      } catch (err) {
        if (state.current === id) { box.textContent = ''; box.append(el('div', 'day', err.message)); }
        return;
      } finally { clearTimeout(slow); }
      if (state.current !== id) return;
    }
    renderAllMessages(true);
    missed = 0;
    updateToBottom();
    syncComposer();
    if (cached) requestAnimationFrame(() => { if (state.current === id) document.body.classList.add('in-chat'); });
    markRead();
    if (window.matchMedia('(min-width: 761px)').matches) $('#msg-input').focus();
  }

  const isPhone = () => window.matchMedia('(max-width: 760px)').matches;
  // Carica i messaggi di una chat una volta sola (anche se richiesti due volte insieme).
  const loading = new Map();
  function loadMessages(id) {
    if (state.messages.has(id)) return Promise.resolve();
    if (!loading.has(id)) {
      loading.set(id, api('GET', `/api/conversations/${id}/messages`).then((data) => {
        const store = new Map();
        for (const m of data.messages) store.set(m.id, m);
        // Messaggi arrivati via polling durante il caricamento
        const existing = state.messages.get(id);
        if (existing) for (const [k, v] of existing) store.set(k, v);
        state.messages.set(id, store);
        state.hasMore.set(id, data.hasMore);
        if (data.receipt) state.receipts.set(id, data.receipt);
      }).finally(() => loading.delete(id)));
    }
    return loading.get(id);
  }

  function closeConv() {
    state.current = null;
    // Chiude la tastiera: un campo rimasto attivo nella chat nascosta la lascerebbe "aperta".
    if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
    document.body.classList.remove('in-chat');
    if (window.fitViewport) window.fitViewport();
    // Su telefono la lista si ridisegna a animazione finita: l'uscita resta fluida.
    if (isPhone()) setTimeout(() => { if (!state.current) renderConvList(); }, 330); else renderConvList();
    // Su telefono la chat esce scorrendo: la svuotiamo solo dopo l'animazione.
    const hide = () => {
      if (state.current) return;
      $('#chat-view').classList.add('hidden');
      $('#chat-empty').classList.remove('hidden');
    };
    if (isPhone() && !document.body.classList.contains('instant')) setTimeout(hide, 320); else hide();
  }
  let backByButton = false;
  function goBack() {
    backByButton = true; // indietro con la nostra freccia: la chat esce con la sua animazione
    if (history.state && history.state.chat) history.back(); else closeConv();
  }

  // Pressione lunga (telefono) o tasto destro (computer). Il click che segue viene ignorato.
  function onLongPress(node, fn) {
    let timer = null, x = 0, y = 0;
    const cancel = () => { clearTimeout(timer); timer = null; };
    node.addEventListener('touchstart', (e) => {
      x = e.touches[0].clientX; y = e.touches[0].clientY;
      timer = setTimeout(() => {
        timer = null;
        node.dataset.held = '1';
        setTimeout(() => { delete node.dataset.held; }, 700);
        if (navigator.vibrate && prefs.vibrate) navigator.vibrate(15);
        fn();
      }, 500);
    }, { passive: true });
    node.addEventListener('touchmove', (e) => {
      if (timer && (Math.abs(e.touches[0].clientX - x) > 8 || Math.abs(e.touches[0].clientY - y) > 8)) cancel();
    }, { passive: true });
    node.addEventListener('touchend', cancel);
    node.addEventListener('touchcancel', cancel);
    node.addEventListener('contextmenu', (e) => { e.preventDefault(); if (!node.dataset.held) fn(); });
  }

  // Organizzatori: richiesta allo staff → risolta (archiviata per tutti) / riaperta, profilo.
  function staffActions(c) {
    const resolved = isResolvedRequest(c);
    openModal(plainTitle(c), (body) => {
      if (resolved && c.resolvedBy) body.append(el('p', 'muted', `✅ Marked as resolved by ${c.resolvedBy}. It reopens by itself if they write again.`));
      if (c.lastMessage) {
        body.append(resolved
          ? menuButton('↩️  Reopen request', () => resolveRequest(c, false))
          : menuButton('✅  Mark as resolved', () => resolveRequest(c, true)));
      }
      if (c.ownerId) body.append(menuButton('👤  View profile', () => showProfile(c.ownerId)));
    });
  }
  async function resolveRequest(c, resolved) {
    let summary;
    try { summary = await api('POST', `/api/conversations/${c.id}/resolve`, { resolved }); } catch (err) { return toast(err.message); }
    closeModal();
    mergeConvs([summary]);
    toast(resolved ? '✅ Resolved: moved to the Resolved list for all organisers' : 'Request reopened');
    if (resolved && state.current === c.id) goBack();
  }

  function chatActions(c) {
    openModal(plainTitle(c), (body) => {
      if (c.type === 'group') body.append(menuButton('🚪  Leave & delete group', () => deleteChat(c), 'danger'));
      else body.append(menuButton('🗑️  Delete chat', () => deleteChat(c), 'danger'));
    });
  }

  async function deleteChat(c) {
    const question = c.type === 'group'
      ? `Leave "${plainTitle(c)}"? You'll stop receiving its messages and it will disappear from your chats.`
      : `Delete your chat with ${c.title}? Messages are removed for you only: ${c.title.split(' ')[0]} will still see them. If they write again, the chat comes back.`;
    if (!await askConfirm(question, c.type === 'group' ? 'Leave' : 'Delete')) return;
    try { await api('DELETE', `/api/conversations/${c.id}`); } catch (err) { return toast(err.message); }
    state.messages.delete(c.id);
    if (c.type === 'group') state.convs.delete(c.id);
    else {
      const conv = state.convs.get(c.id);
      if (conv) { conv.clearedId = (conv.lastMessage && conv.lastMessage.id) || conv.lastSeenId || 1; conv.lastMessage = null; conv.unread = 0; }
    }
    if (state.current === c.id) goBack();
    renderConvList();
    toast(c.type === 'group' ? 'You left the group' : 'Chat deleted');
  }
  $('#btn-back').addEventListener('click', goBack);
  window.addEventListener('popstate', () => {
    if (state.current && !(history.state && history.state.chat)) {
      // Indietro con il gesto di iOS (scorrere da sinistra): il sistema ha già animato il
      // passaggio, quindi chiudiamo la chat senza la nostra animazione (niente doppio scatto).
      if (!backByButton) {
        document.body.classList.add('instant');
        requestAnimationFrame(() => requestAnimationFrame(() => document.body.classList.remove('instant')));
      }
      closeConv();
    }
    if (history.state && history.state.root) { try { history.pushState({ list: true }, '', location.pathname); } catch {} }
    backByButton = false;
  });

  function renderChatHeader() {
    const conv = state.convs.get(state.current);
    if (!conv) return;
    $('#chat-title').textContent = plainTitle(conv);
    setAvatar($('#chat-avatar'), conv);
    const sub = {
      public: 'Channel open to all participants', announce: 'Official updates from the organisers', group: 'Group · tap for details', dm: 'Private chat',
      staff: !isInbox(conv) ? 'Private chat with the organisers'
        : isResolvedRequest(conv) ? `✅ Resolved${conv.resolvedBy ? ' by ' + conv.resolvedBy.split(' ')[0] : ''} · tap for options`
        : 'Support request · tap to mark as resolved',
    };
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

  // Negli Annunci un messaggio cancellato non lascia traccia ("Message deleted" solo nelle chat).
  const vanishes = (m, conv) => m.deleted && conv && conv.type === 'announce';
  function sortedMsgs(id) {
    const conv = state.convs.get(id);
    return [...(state.messages.get(id) || new Map()).values()].filter((m) => !vanishes(m, conv)).sort((a, b) => a.id - b.id);
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
    if (conv && conv.type === 'staff') {
      card.append(el('span', 'big', '🛟'), el('strong', null, 'How can we help?'),
        el('span', null, 'Write to the organisers here: everyone on the staff team sees your message and replies in this chat.'));
      return card;
    }
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
      a.addEventListener('click', (e) => { e.stopPropagation(); showProfile(m.userId, m.userName); });
      div.append(a);
    }
    if (m.replyTo && !m.deleted) {
      const qt = el('button', 'quote');
      qt.type = 'button';
      qt.append(el('span', 'quote-name c-' + palette(m.replyTo.userId), m.replyTo.userId === state.me.id ? 'You' : m.replyTo.userName),
        el('span', 'quote-text', m.replyTo.deleted ? '🚫 Message deleted' : m.replyTo.text));
      qt.addEventListener('click', (e) => { e.stopPropagation(); jumpTo(m.replyTo.id); });
      div.append(qt);
    }
    div.append(el('span', 'text' + (!m.deleted && isJumbo(m.text) ? ' jumbo' : ''), m.deleted ? '🚫 Message deleted' : m.text));
    const meta = el('span', 'meta', fmtTime(m.createdAt));
    if (mine && !m.deleted && conv && TICK_CHATS.has(conv.type)) meta.append(tickNode(m));
    div.append(meta);
    // Reazioni sotto la bolla, come su WhatsApp: toccandole si vede chi ha reagito.
    const reacts = !m.deleted && m.reactions && Object.entries(m.reactions).filter(([, n]) => n > 0);
    if (reacts && reacts.length) {
      div.classList.add('has-reacts');
      const rb = el('button', 'reacts');
      rb.type = 'button';
      let total = 0;
      for (const [emoji, n] of reacts) {
        total += n;
        rb.append(el('span', 'r-emoji' + (m.myReaction === emoji ? ' mine' : ''), emoji));
      }
      if (total > 1) rb.append(el('span', 'r-count', String(total)));
      rb.title = 'See who reacted';
      rb.addEventListener('click', (e) => { e.stopPropagation(); showReactions(m); });
      div.append(rb);
    }
    const canReact = !m.deleted;
    const canReply = !m.deleted && conv && (conv.type !== 'announce' || state.me.isAdmin);
    const canDelete = !m.deleted && (mine || state.me.isAdmin);
    if (canReact || canReply || canDelete) {
      const tools = el('div', 'msg-tools');
      const tool = (cls, icon, label, fn) => {
        const b = el('button', 'msg-act ' + cls);
        b.type = 'button';
        b.innerHTML = icon;
        b.title = label;
        b.setAttribute('aria-label', label);
        b.addEventListener('click', (e) => { e.stopPropagation(); div.classList.remove('show-actions'); fn(); });
        tools.append(b);
      };
      if (canReact) tool('msg-react', ICON_SMILE, 'React', () => openReactPicker(div, m));
      if (canReply) tool('msg-reply', ICON_REPLY, 'Reply', () => startReply(m));
      if (canDelete) {
        tool('msg-del', ICON_TRASH, 'Delete', async () => {
          if (!await askConfirm('Delete this message for everyone?', 'Delete')) return;
          try { await api('DELETE', `/api/messages/${m.id}`); } catch (err) { toast(err.message); }
        });
      }
      div.append(tools);
      div.addEventListener('click', () => {
        if (longPressed) return;
        for (const o of document.querySelectorAll('.msg.show-actions')) if (o !== div) o.classList.remove('show-actions');
        div.classList.toggle('show-actions');
      });
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

  // ----------------------------------------------------------- Risposte
  let replyTo = null;
  function startReply(m) {
    replyTo = m;
    $('#reply-name').textContent = m.userId === state.me.id ? 'You' : m.userName;
    $('#reply-name').className = 'c-' + palette(m.userId);
    $('#reply-text').textContent = m.text;
    $('#reply-bar').classList.remove('hidden');
    $('#msg-input').focus();
  }
  function cancelReply() {
    replyTo = null;
    $('#reply-bar').classList.add('hidden');
  }
  $('#reply-cancel').addEventListener('click', cancelReply);

  function jumpTo(id) {
    const target = $('#messages').querySelector(`.msg[data-id="${id}"]`);
    if (!target) return toast('That message is further up: scroll up to load it');
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    target.classList.remove('flash');
    void target.offsetWidth;
    target.classList.add('flash');
  }

  // ----------------------------------------------------------- Reazioni
  const REACTIONS = ['❤️', '😂', '👍', '🔥', '😮', '😢', '🎉'];
  let longPressed = false;

  function closeReactPicker() {
    const pop = document.getElementById('react-pop');
    if (pop) pop.remove();
  }
  function openReactPicker(bubble, m) {
    closeReactPicker();
    const pop = el('div', 'react-pop');
    pop.id = 'react-pop';
    for (const emoji of REACTIONS) {
      const b = el('button', 'react-opt' + (m.myReaction === emoji ? ' on' : ''), emoji);
      b.type = 'button';
      b.setAttribute('aria-label', 'React ' + emoji);
      b.addEventListener('click', (e) => { e.stopPropagation(); closeReactPicker(); react(m, m.myReaction === emoji ? null : emoji); });
      pop.append(b);
    }
    document.body.append(pop);
    // Sopra la bolla (o sotto, se non c'è spazio), senza uscire dallo schermo.
    const r = bubble.getBoundingClientRect();
    const w = pop.offsetWidth, h = pop.offsetHeight;
    const vw = document.documentElement.clientWidth;
    let left = bubble.classList.contains('me') ? r.right - w : r.left;
    left = Math.max(8, Math.min(left, vw - w - 8));
    let top = r.top - h - 8;
    if (top < 70) top = r.bottom + 8;
    pop.style.left = left + 'px';
    pop.style.top = top + 'px';
    if (navigator.vibrate && prefs.vibrate) navigator.vibrate(12);
  }
  document.addEventListener('pointerdown', (e) => { if (!e.target.closest('#react-pop')) closeReactPicker(); }, true);
  // Si chiude se scorri tu (non quando arriva un messaggio e la chat scorre da sola).
  $('#messages').addEventListener('wheel', closeReactPicker, { passive: true });
  $('#messages').addEventListener('touchmove', closeReactPicker, { passive: true });

  async function react(m, emoji) {
    // Subito a schermo, poi il server conferma (e manda i conteggi a tutti).
    const before = { reactions: m.reactions, myReaction: m.myReaction };
    const counts = { ...(m.reactions || {}) };
    if (m.myReaction) { counts[m.myReaction] = (counts[m.myReaction] || 1) - 1; if (counts[m.myReaction] <= 0) delete counts[m.myReaction]; }
    if (emoji) counts[emoji] = (counts[emoji] || 0) + 1;
    const apply = (patch) => {
      const store = state.messages.get(m.conversationId);
      const cur = (store && store.get(m.id)) || m;
      const next = { ...cur, ...patch };
      if (store) store.set(m.id, next);
      if (state.current === m.conversationId) renderMessage(next);
      return next;
    };
    m = apply({ reactions: Object.keys(counts).length ? counts : null, myReaction: emoji });
    try {
      const res = await api('POST', `/api/messages/${m.id}/react`, { emoji });
      apply({ reactions: res.message.reactions, myReaction: res.message.myReaction });
    } catch (err) {
      apply(before);
      toast(err.message);
    }
  }

  async function showReactions(m) {
    let list;
    try { list = (await api('GET', `/api/messages/${m.id}/reactions`)).reactions; } catch (err) { return toast(err.message); }
    openModal('Reactions', (body) => {
      const counts = {};
      for (const r of list) counts[r.emoji] = (counts[r.emoji] || 0) + 1;
      const summary = el('div', 'react-summary');
      for (const [emoji, n] of Object.entries(counts)) summary.append(el('span', 'react-chip', `${emoji} ${n}`));
      body.append(summary);
      const ul = el('ul', 'list');
      for (const r of list) {
        const li = el('li');
        const av = el('span', 'avatar');
        setAvatar(av, { type: 'user', title: r.name, otherUserId: r.userId });
        const isMe = r.userId === state.me.id;
        const info = el('div', 'info');
        info.append(el('span', 'name', isMe ? 'You' : r.name));
        if (isMe) info.append(el('span', 'preview', 'Tap to remove'));
        li.append(av, info, el('span', 'react-big', r.emoji));
        li.addEventListener('click', () => {
          closeModal();
          if (isMe) react(state.messages.get(m.conversationId)?.get(m.id) || m, null);
          else showProfile(r.userId, r.name);
        });
        ul.append(li);
      }
      if (!list.length) body.append(el('p', 'muted center', 'No reactions yet'));
      body.append(ul);
    });
  }

  // Tieni premuto su una bolla per reagire.
  (() => {
    let timer = null, startX = 0, startY = 0;
    const box = $('#messages');
    const cancel = () => { clearTimeout(timer); timer = null; };
    box.addEventListener('touchstart', (e) => {
      const b = e.target.closest('.msg');
      longPressed = false;
      if (!b || !b.querySelector('.msg-react') || e.touches.length > 1 || e.target.closest('button, a')) return;
      startX = e.touches[0].clientX; startY = e.touches[0].clientY;
      timer = setTimeout(() => {
        timer = null;
        const msg = state.messages.get(state.current)?.get(Number(b.dataset.id));
        if (!msg) return;
        longPressed = true;
        setTimeout(() => { longPressed = false; }, 600);
        openReactPicker(b, msg);
      }, 450);
    }, { passive: true });
    box.addEventListener('touchmove', (e) => {
      if (timer && (Math.abs(e.touches[0].clientX - startX) > 8 || Math.abs(e.touches[0].clientY - startY) > 8)) cancel();
    }, { passive: true });
    box.addEventListener('touchend', cancel);
    box.addEventListener('touchcancel', cancel);
    box.addEventListener('contextmenu', (e) => { if (e.target.closest('.msg')) e.preventDefault(); });
  })();

  // Su telefono: scorri una bolla verso destra per rispondere, come su WhatsApp.
  (() => {
    let startX = 0, startY = 0, bubble = null, dx = 0;
    const box = $('#messages');
    box.addEventListener('touchstart', (e) => {
      const b = e.target.closest('.msg');
      if (!b || b.classList.contains('system') || !b.querySelector('.msg-reply') || e.touches.length > 1) { bubble = null; return; }
      bubble = b; startX = e.touches[0].clientX; startY = e.touches[0].clientY; dx = 0;
    }, { passive: true });
    box.addEventListener('touchmove', (e) => {
      if (!bubble) return;
      dx = e.touches[0].clientX - startX;
      const dy = Math.abs(e.touches[0].clientY - startY);
      if (dy > 30 && dx < 20) { bubble.style.transform = ''; bubble = null; return; }
      if (dx > 0) bubble.style.transform = `translateX(${Math.min(dx, 80)}px)`;
    }, { passive: true });
    box.addEventListener('touchend', () => {
      if (!bubble) return;
      const b = bubble;
      bubble = null;
      b.style.transition = 'transform .15s';
      b.style.transform = '';
      setTimeout(() => { b.style.transition = ''; }, 160);
      if (dx > 60) {
        const msg = state.messages.get(state.current)?.get(Number(b.dataset.id));
        if (msg) { startReply(msg); if (navigator.vibrate && prefs.vibrate) navigator.vibrate(15); }
      }
    });
  })();

  // ------------------------------------------------------------- Invio
  const input = $('#msg-input');
  // Come su WhatsApp: trascinando i messaggi verso il basso la tastiera si chiude.
  (() => {
    let y0 = null, x0 = 0;
    const box = $('#messages');
    box.addEventListener('touchstart', (e) => {
      y0 = document.activeElement === input && e.touches.length === 1 ? e.touches[0].clientY : null;
      if (y0 !== null) x0 = e.touches[0].clientX;
    }, { passive: true });
    box.addEventListener('touchmove', (e) => {
      if (y0 === null) return;
      const dy = e.touches[0].clientY - y0;
      const dx = Math.abs(e.touches[0].clientX - x0);
      if (dy > 24 && dy > dx * 1.5) { y0 = null; input.blur(); }
    }, { passive: true });
  })();
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
      const payload = { text };
      if (replyTo && replyTo.conversationId === id) payload.replyTo = replyTo.id;
      const { message } = await api('POST', `/api/conversations/${id}/messages`, payload);
      cancelReply();
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
  function userPicker(body, { multi = false, onPick, exclude = new Set(), max = Infinity }) {
    const search = el('input');
    search.type = 'search';
    search.placeholder = 'Search participants by name';
    const ul = el('ul', 'list');
    ul.dataset.empty = 'Type a name to search';
    const selected = new Map();
    const chips = el('div', 'chips');
    let timer = null;
    async function run() {
      // Si cerca per nome: con centinaia di iscritti l'elenco completo non serve.
      const term = search.value.trim();
      if (!term) { ul.textContent = ''; ul.dataset.empty = 'Type a name to search'; return; }
      try {
        const { users } = await api('GET', '/api/users?q=' + encodeURIComponent(term));
        if (search.value.trim() !== term) return; // nel frattempo è cambiata la ricerca
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
              if (!selected.has(u.id) && selected.size >= max) return toast(`Groups can have up to ${GROUP_MAX} people`);
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
      if (multi && max !== Infinity && selected.size) chips.append(el('span', 'chip count', `${selected.size}/${max}`));
      for (const name of selected.values()) chips.append(el('span', 'chip', name));
    }
    search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 250); });
    body.append(search, chips, ul);
    run();
    setTimeout(() => search.focus(), 50);
    return { selected };
  }

  // ------------------------------------------------- Contatta lo staff
  const SUPPORT_CLOSED = 'Staff support opens once we are on board. See you on the ship! 🚢';
  const supportLocked = () => !state.supportOpen && !(state.me && state.me.isAdmin);
  async function contactStaff() {
    if (supportLocked()) { closeModal(); return toast('🛟 ' + SUPPORT_CLOSED); }
    try {
      const { id } = await api('POST', '/api/staff');
      closeModal();
      if (!state.convs.has(id)) await refreshConvs();
      openConv(id);
    } catch (err) { toast(err.message); }
  }

  // ---------------------------------------------------- Info utili
  // La pagina è fatta di sezioni (icona, titolo, righe "voce → valore").
  // Gli organizzatori la modificano direttamente sulla pagina, senza simboli da ricordare.
  const INFO_ICONS = ['📍', '🕒', '🍽️', '🍹', '📶', '🚨', '🛟', '👗', '🎉', '🏝️', '🚢', '🛏️', '💊', '💶', '📸', '🎵', '☀️', '🧳', '🚌', 'ℹ️', '⭐', '❤️', '⚠️', '📞'];
  const INFO_PRESETS = [
    { icon: '📍', title: 'Reception', items: [{ t: 'Where', v: 'Deck 5' }, { t: 'Open', v: '24 hours' }] },
    { icon: '🕒', title: 'Schedule', items: [{ t: 'Breakfast', v: '08:00–10:30' }, { t: 'Dinner', v: '19:30–22:00' }] },
    { icon: '🍽️', title: 'Food & drinks', items: [{ t: 'Main restaurant', v: 'Deck 6' }, { t: 'Bar', v: 'Deck 11, until 02:00' }] },
    { icon: '📶', title: 'Wi‑Fi', items: [{ t: 'Network', v: 'Ship Wi‑Fi' }, { t: 'Works for', v: 'This chat only' }] },
    { icon: '🚨', title: 'Emergency', items: [{ t: 'Medical centre', v: 'Deck 4' }, { t: 'Muster station', v: 'See your cabin card' }] },
    { icon: '👗', title: 'Dress code', items: [{ t: 'Tonight', v: 'All white' }] },
  ];
  const blankInfo = () => ({ title: 'Welcome aboard! 🚢', intro: '', sections: [] });

  // Converte le pagine salvate prima in testo semplice ("# titolo", "## sezione", "- riga").
  function parseInfo(content) {
    try {
      const d = JSON.parse(content);
      if (d && Array.isArray(d.sections)) return { title: d.title || '', intro: d.intro || '', sections: d.sections };
    } catch {}
    const info = blankInfo();
    info.title = '';
    let sec = null;
    for (const raw of String(content || '').split('\n')) {
      const line = raw.replace(/\*\*/g, '').trim();
      if (!line) continue;
      if (/^## /.test(line)) { sec = { icon: 'ℹ️', title: line.slice(3), items: [] }; info.sections.push(sec); continue; }
      if (/^# /.test(line)) { if (!info.title) info.title = line.slice(2); continue; }
      const text = line.replace(/^- /, '');
      const i = text.indexOf(': ');
      const item = i > 0 ? { t: text.slice(0, i), v: text.slice(i + 2) } : { t: text, v: '' };
      if (!sec) { if (!info.intro && !/^- /.test(line)) { info.intro = text; continue; } sec = { icon: 'ℹ️', title: 'Info', items: [] }; info.sections.push(sec); }
      sec.items.push(item);
    }
    return info;
  }

  function renderInfoView(container, info) {
    container.textContent = '';
    if (info.title) container.append(el('h3', 'info-title', info.title));
    if (info.intro) container.append(el('p', 'info-intro', info.intro));
    info.sections.forEach((sec, i) => {
      const card = el('section', 'info-card');
      const head = el('div', 'info-card-head');
      head.append(el('span', 'info-icon ic-' + (i % 4), sec.icon || 'ℹ️'), el('h4', 'info-card-title', sec.title));
      card.append(head);
      for (const it of sec.items || []) {
        if (!it.t && !it.v) continue;
        const row = el('div', 'info-row' + (it.v ? '' : ' single'));
        row.append(el('span', 'info-label', it.t || ''));
        if (it.v) row.append(el('span', 'info-value', it.v));
        card.append(row);
      }
      container.append(card);
    });
    if (!info.sections.length && !info.intro) container.append(el('p', 'muted', 'Nothing here yet.'));
  }

  async function usefulInfo() {
    let data;
    try { data = await api('GET', '/api/info'); } catch (err) { return toast(err.message); }
    const info = parseInfo(data.content);
    openModal('Useful info', (body) => {
      if (state.me.isAdmin) {
        const edit = el('button', 'info-edit-btn', '✏️ Edit');
        edit.type = 'button';
        edit.addEventListener('click', () => editInfo(info));
        body.append(edit);
      }
      const page = el('div', 'info-page');
      renderInfoView(page, info);
      body.append(page);
      if (data.updatedAt) {
        const when = new Date(data.updatedAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
        body.append(el('p', 'muted info-updated', `Updated ${when}${data.updatedBy ? ' by ' + data.updatedBy : ''}`));
      }
      body.append(menuButton('🛟  Contact staff', contactStaff, 'primary'));
    });
  }

  // Editor visuale: campi al posto del testo, sezioni pronte, frecce per riordinare.
  function editInfo(original) {
    const info = JSON.parse(JSON.stringify(original));
    openModal('Edit info', (body) => {
      const wrap = el('div', 'info-editor-wrap');
      const input = (value, placeholder, cls, onInput, max = 120) => {
        const i = el('input', cls);
        i.type = 'text'; i.value = value || ''; i.placeholder = placeholder; i.maxLength = max;
        i.addEventListener('input', () => onInput(i.value));
        return i;
      };
      const iconBtn = (sec, redraw) => {
        const b = el('button', 'ed-icon', sec.icon || 'ℹ️');
        b.type = 'button';
        b.setAttribute('aria-label', 'Change icon');
        b.addEventListener('click', () => {
          const open = b.nextElementSibling && b.nextElementSibling.classList.contains('ed-icons');
          wrap.querySelectorAll('.ed-icons').forEach((g) => g.remove());
          if (open) return;
          const grid = el('div', 'ed-icons');
          for (const ic of INFO_ICONS) {
            const o = el('button', null, ic); o.type = 'button';
            o.addEventListener('click', () => { sec.icon = ic; redraw(); });
            grid.append(o);
          }
          b.after(grid);
        });
        return b;
      };
      const draw = () => {
        wrap.textContent = '';
        const top = el('div', 'ed-card ed-top');
        top.append(el('label', 'ed-label', 'Page title'), input(info.title, 'Welcome aboard! 🚢', 'ed-title', (v) => { info.title = v; }, 80),
          el('label', 'ed-label', 'Intro (optional)'), input(info.intro, 'A short welcome message', 'ed-intro', (v) => { info.intro = v; }, 300));
        wrap.append(top);
        info.sections.forEach((sec, si) => {
          const card = el('div', 'ed-card');
          const head = el('div', 'ed-head');
          const tools = el('div', 'ed-tools');
          const tool = (label, title, fn, disabled) => { const t = el('button', 'ed-tool', label); t.type = 'button'; t.title = title; t.setAttribute('aria-label', title); t.disabled = !!disabled; t.addEventListener('click', fn); return t; };
          tools.append(
            tool('↑', 'Move up', () => { [info.sections[si - 1], info.sections[si]] = [info.sections[si], info.sections[si - 1]]; draw(); }, si === 0),
            tool('↓', 'Move down', () => { [info.sections[si + 1], info.sections[si]] = [info.sections[si], info.sections[si + 1]]; draw(); }, si === info.sections.length - 1),
            tool('🗑', 'Delete section', async () => { if (await confirmInline(card, 'Delete this section?')) { info.sections.splice(si, 1); draw(); } }),
          );
          head.append(iconBtn(sec, draw), input(sec.title, 'Section title', 'ed-sec-title', (v) => { sec.title = v; }, 60), tools);
          card.append(head);
          (sec.items = sec.items || []).forEach((it, ii) => {
            const row = el('div', 'ed-row');
            const del = el('button', 'ed-del', '✕'); del.type = 'button'; del.setAttribute('aria-label', 'Remove line');
            del.addEventListener('click', () => { sec.items.splice(ii, 1); draw(); });
            row.append(input(it.t, 'Label (e.g. Breakfast)', 'ed-t', (v) => { it.t = v; }), input(it.v, 'Details (e.g. 08:00, deck 9)', 'ed-v', (v) => { it.v = v; }, 200), del);
            card.append(row);
          });
          const add = el('button', 'ed-add', '+ Add line'); add.type = 'button';
          add.addEventListener('click', () => { sec.items.push({ t: '', v: '' }); draw(); const rows = wrap.querySelectorAll('.ed-card')[si + 1].querySelectorAll('.ed-t'); rows[rows.length - 1].focus(); });
          card.append(add);
          wrap.append(card);
        });
        const presets = el('div', 'ed-card ed-presets');
        presets.append(el('div', 'ed-label', 'Add a section'));
        const chips = el('div', 'ed-chips');
        for (const pr of [...INFO_PRESETS, { icon: '➕', title: 'Empty section', items: [{ t: '', v: '' }] }]) {
          const c = el('button', 'ed-chip', `${pr.icon} ${pr.title}`); c.type = 'button';
          c.addEventListener('click', () => {
            const copy = JSON.parse(JSON.stringify(pr));
            if (copy.icon === '➕') { copy.icon = 'ℹ️'; copy.title = ''; }
            info.sections.push(copy); draw();
            const cards = wrap.querySelectorAll('.ed-card');
            cards[cards.length - 2].scrollIntoView({ behavior: 'smooth', block: 'center' });
          });
          chips.append(c);
        }
        presets.append(chips);
        wrap.append(presets);
      };
      draw();

      const bar = el('div', 'ed-bar');
      const notifyLbl = el('label', 'ed-notify');
      const notify = el('input'); notify.type = 'checkbox';
      notifyLbl.append(notify, document.createTextNode(' Tell everyone in Announcements'));
      const cancel = el('button', 'btn secondary', 'Cancel'); cancel.type = 'button';
      cancel.addEventListener('click', () => usefulInfo());
      const save = el('button', 'btn lime', 'Save'); save.type = 'button';
      save.addEventListener('click', async () => {
        const clean = {
          title: info.title.trim(), intro: info.intro.trim(),
          sections: info.sections
            .map((sec) => ({ icon: sec.icon || 'ℹ️', title: (sec.title || '').trim(), items: (sec.items || []).map((it) => ({ t: (it.t || '').trim(), v: (it.v || '').trim() })).filter((it) => it.t || it.v) }))
            .filter((sec) => sec.title || sec.items.length),
        };
        save.disabled = true;
        try {
          await api('PUT', '/api/info', { content: JSON.stringify(clean), announce: notify.checked });
          toast('✅ Saved');
          usefulInfo();
        } catch (err) { toast(err.message); save.disabled = false; }
      });
      const btns = el('div', 'ed-btns'); btns.append(cancel, save);
      bar.append(notifyLbl, btns);
      body.append(wrap, bar);
    });
  }

  // Conferma piccola dentro la scheda (senza chiudere l'editor).
  function confirmInline(card, question) {
    return new Promise((resolve) => {
      card.querySelectorAll('.ed-confirm').forEach((x) => x.remove());
      const box = el('div', 'ed-confirm');
      const no = el('button', 'btn secondary', 'Keep'); no.type = 'button';
      const yes = el('button', 'btn danger', 'Delete'); yes.type = 'button';
      no.addEventListener('click', () => { box.remove(); resolve(false); });
      yes.addEventListener('click', () => { box.remove(); resolve(true); });
      box.append(el('span', null, question), no, yes);
      card.append(box);
    });
  }
  $('#btn-info').addEventListener('click', usefulInfo);

  async function startDm(userId) {
    try {
      const { id } = await api('POST', '/api/dm', { userId });
      closeModal();
      if (!state.convs.has(id)) await refreshConvs();
      openConv(id);
    } catch (err) { toast(err.message); }
  }

  $('#fab-new').addEventListener('click', () => $('#btn-new').click());
  $('#fab-info').addEventListener('click', usefulInfo);
  $('#btn-new').addEventListener('click', () => {
    openModal('New chat', (body) => {
      body.append(menuButton('👥  Create a group', newGroup, 'primary'));
      body.append(menuButton('🛟  Contact staff', contactStaff));
      if (state.me.isAdmin) body.append(menuButton('📣  New public channel (organisers)', newChannel));
      body.append(el('div', 'section-label', 'Message privately…'));
      userPicker(body, { onPick: (u) => startDm(u.id) });
    });
  });

  const GROUP_MAX = 20; // persone per gruppo, creatore compreso (lo controlla anche il server)
  function newGroup() {
    openModal('New group', (body) => {
      const name = el('input');
      name.type = 'text';
      name.placeholder = 'Group name (e.g. Cabin 512, Mykonos trip…)';
      name.maxLength = 60;
      body.append(name);
      const picker = userPicker(body, { multi: true, max: GROUP_MAX - 1 });
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

  // ----------------------------------------------------------- Profili
  // Instagram & co. per ritrovarsi una volta scesi dalla nave. Si apre toccando un nome
  // (o il proprio avatar in alto); da qui anche il messaggio privato.
  const SOCIALS = [
    { key: 'instagram', label: 'Instagram', icon: '📸', url: (h) => `https://instagram.com/${h}`, show: (h) => '@' + h, hint: 'your.username' },
    { key: 'tiktok', label: 'TikTok', icon: '🎵', url: (h) => `https://www.tiktok.com/@${h}`, show: (h) => '@' + h, hint: 'your.username' },
    { key: 'linkedin', label: 'LinkedIn', icon: '💼', url: (h) => `https://www.linkedin.com/in/${h}`, show: (h) => h, hint: 'linkedin.com/in/…' },
    { key: 'whatsapp', label: 'WhatsApp', icon: '💬', url: (h) => `https://wa.me/${h.replace(/\D/g, '')}`, show: (h) => h, hint: '+39 333 123 4567' },
  ];

  async function showProfile(userId, userName) {
    const mine = userId === state.me.id;
    let user = mine ? { ...state.me } : { id: userId, name: userName || '', profile: null };
    const draw = () => openModal(mine ? 'My profile' : 'Profile', (body) => {
      const card = el('div', 'profile-card');
      const av = el('span', 'avatar');
      setAvatar(av, { type: 'user', title: user.name, otherUserId: user.id });
      card.append(av, el('strong', 'profile-name', user.name));
      if (user.isAdmin) card.append(el('span', 'profile-badge', '⭐ Organiser'));
      const p = user.profile || {};
      if (p.city) card.append(el('span', 'profile-city', '📍 ' + p.city));
      if (p.bio) card.append(el('p', 'profile-bio', p.bio));
      body.append(card);
      if (!user.profile) body.append(el('p', 'muted center', 'Loading…'));
      const links = SOCIALS.filter((s) => p[s.key]);
      if (links.length) {
        const box = el('div', 'profile-links');
        for (const s of links) {
          const a = el('a', 'profile-link');
          a.href = s.url(p[s.key]);
          a.target = '_blank';
          a.rel = 'noopener';
          a.append(el('span', 'pl-icon', s.icon), el('span', 'pl-label', s.label), el('span', 'pl-value', s.show(p[s.key])));
          box.append(a);
        }
        body.append(box, el('p', 'muted small center', 'Links open once you are back on land 🏝️'));
      } else if (user.profile) {
        body.append(el('p', 'muted center', mine ? 'Add your Instagram and more, so new friends can find you after the cruise.' : `${user.name.split(' ')[0]} hasn't added any socials yet.`));
      }
      if (mine) body.append(menuButton('✏️  Edit my profile', editProfile));
      else {
        body.append(menuButton('💬  Send a private message', () => startDm(userId)));
        const dm = [...state.convs.values()].find((c) => c.type === 'dm' && c.otherUserId === userId && (c.lastMessage || state.current === c.id));
        if (dm) body.append(menuButton('🗑️  Delete chat', () => deleteChat(dm), 'danger'));
        if (state.me.isAdmin) {
          body.append(menuButton('🔑  Reset password (organisers)', async () => {
            if (!await askConfirm(`Reset ${user.name}'s password? They will be signed out and will choose a new one by confirming their last name.`, 'Reset')) return;
            let res;
            try { res = await api('POST', '/api/admin/reset-password', { userId }); } catch (err) { return toast(err.message); }
            openModal('Password reset', (b) => {
              b.append(el('p', null, `Give ${user.name.split(' ')[0]} this code. At the next sign-in they enter it and choose a new password (valid 48 hours):`));
              b.append(el('p', 'reset-code', res.code));
              b.append(el('p', 'muted small center', 'They can also get a new code by email, if email works where they are.'));
            });
          }));
        }
        if (state.me.isAdmin && !user.isAdmin) {
          body.append(menuButton('⛔  Suspend user (organisers)', async () => {
            if (!await askConfirm(`Suspend ${user.name}? They will no longer be able to use the chat.`, 'Suspend')) return;
            try { await api('POST', '/api/admin/ban', { userId }); toast('User suspended'); closeModal(); }
            catch (err) { toast(err.message); }
          }, 'danger'));
        }
      }
    });
    if (!mine) {
      draw();
      try { user = await api('GET', `/api/users/${userId}`); } catch (err) { return toast(err.message); }
      if (!$('#modal').classList.contains('hidden')) draw();
    } else {
      user.profile = user.profile || {};
      draw();
    }
  }

  function editProfile() {
    const p = { ...(state.me.profile || {}) };
    openModal('Edit profile', (body) => {
      const form = el('form', 'profile-form');
      const field = (key, label, hint, opts = {}) => {
        const wrap = el('label', 'field');
        wrap.append(el('span', 'ed-label', label));
        const inp = el(opts.area ? 'textarea' : 'input', 'ed-input');
        if (!opts.area) inp.type = opts.type || 'text';
        inp.name = key;
        inp.placeholder = hint;
        inp.value = p[key] || '';
        if (opts.max) inp.maxLength = opts.max;
        if (opts.area) inp.rows = 2;
        inp.autocapitalize = opts.caps ? 'sentences' : 'off';
        inp.autocomplete = 'off';
        inp.spellcheck = !!opts.caps;
        wrap.append(inp);
        form.append(wrap);
      };
      field('city', '📍 Where are you from', 'e.g. Milan', { max: 40, caps: true });
      field('bio', '👋 About you', 'Two lines about you', { max: 160, area: true, caps: true });
      for (const s of SOCIALS) field(s.key, `${s.icon} ${s.label}`, s.hint, { type: s.key === 'whatsapp' ? 'tel' : 'text' });
      form.append(el('p', 'muted small', 'Everything is optional and visible to the other Global Reunion participants.'));
      const row = el('div', 'confirm-row');
      const cancel = el('button', 'btn secondary', 'Cancel');
      cancel.type = 'button';
      cancel.addEventListener('click', () => showProfile(state.me.id));
      const save = el('button', 'btn', 'Save');
      save.type = 'submit';
      row.append(cancel, save);
      form.append(row);
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const profile = Object.fromEntries([...form.querySelectorAll('[name]')].map((i) => [i.name, i.value]));
        save.disabled = true;
        try {
          const res = await api('PUT', '/api/me/profile', { profile });
          state.me.profile = res.profile;
          toast('Profile saved');
          showProfile(state.me.id);
        } catch (err) { toast(err.message); save.disabled = false; }
      });
      body.append(form);
    });
  }
  $('#me-avatar').addEventListener('click', () => showProfile(state.me.id));

  // Scegliere (la prima volta) o cambiare la password.
  function passwordDialog(firstTime = false) {
    const change = !firstTime && state.me.hasPassword;
    openModal(change ? 'Change password' : 'Choose a password', (body) => {
      if (!change) body.append(el('p', null, 'Chats now have passwords, so nobody can sign in and write pretending to be you. Choose one you\'ll remember: you\'ll need it to sign in on another phone.'));
      const form = el('form', 'profile-form');
      const field = (name, label, ac) => {
        const wrap = el('label', 'field');
        wrap.append(el('span', 'ed-label', label));
        const pw = el('div', 'pw-wrap');
        const inp = el('input', 'ed-input');
        inp.type = 'password'; inp.name = name; inp.autocomplete = ac; inp.maxLength = 200;
        const eye = el('button', 'pw-eye', '👁️');
        eye.type = 'button';
        eye.setAttribute('aria-label', 'Show password');
        eye.addEventListener('click', () => { const show = inp.type === 'password'; inp.type = show ? 'text' : 'password'; eye.classList.toggle('on', show); });
        pw.append(inp, eye);
        wrap.append(pw);
        form.append(wrap);
        return inp;
      };
      const user = el('input'); // per i gestori di password: a quale account appartiene
      user.type = 'email'; user.autocomplete = 'username'; user.hidden = true;
      try { user.value = (JSON.parse(localStorage.getItem('gr-login') || '{}').email) || ''; } catch {}
      form.append(user);
      const current = change ? field('current', 'Current password', 'current-password') : null;
      const pw1 = field('password', 'New password (min. 6 characters)', 'new-password');
      const pw2 = field('password2', 'Repeat new password', 'new-password');
      const error = el('p', 'error');
      const row = el('div', 'confirm-row');
      if (!firstTime) {
        const cancel = el('button', 'btn secondary', 'Cancel');
        cancel.type = 'button';
        cancel.addEventListener('click', closeModal);
        row.append(cancel);
      }
      const save = el('button', 'btn', 'Save password');
      save.type = 'submit';
      row.append(save);
      form.append(error, row);
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        error.textContent = '';
        if (pw1.value.length < 6) return (error.textContent = 'At least 6 characters, please');
        if (pw1.value !== pw2.value) return (error.textContent = 'The two passwords don\'t match');
        save.disabled = true;
        try {
          await api('PUT', '/api/me/password', { current: current ? current.value : undefined, password: pw1.value });
          state.me.hasPassword = true;
          modalOnClose = null;
          closeModal();
          toast(change ? 'Password changed' : 'Password saved 🔒');
        } catch (err) { error.textContent = err.message; save.disabled = false; }
      });
      body.append(form);
      setTimeout(() => (current || pw1).focus(), 50);
    });
    // La prima volta non si salta: se chiudi la finestra, riappare.
    if (firstTime) modalOnClose = () => setTimeout(() => { if (!state.me.hasPassword) passwordDialog(true); }, 300);
  }

  $('#chat-title-btn').addEventListener('click', async () => {
    const conv = state.convs.get(state.current);
    if (!conv) return;
    if (conv.type === 'dm') return showProfile(conv.otherUserId, conv.title);
    if (isInbox(conv)) return staffActions(conv);
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
        li.addEventListener('click', () => showProfile(u.id, u.name));
        ul.append(li);
      }
      body.append(ul);
      body.append(menuButton('➕  Add people', () => addMembers(conv, new Set(info.members.map((u) => u.id)))));
      body.append(menuButton('🚪  Leave & delete group', () => deleteChat(conv), 'danger'));
    });
  });

  function addMembers(conv, exclude) {
    const left = GROUP_MAX - exclude.size;
    if (left <= 0) return toast(`This group is full: groups can have up to ${GROUP_MAX} people`);
    openModal('Add to ' + conv.title, (body) => {
      const picker = userPicker(body, { multi: true, exclude, max: left });
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

  // Organizzatori: interruttori aperto/chiuso (iscrizioni nuove, chat con lo staff).
  function switchDialog({ title, path, onText, offText, openLabel, closeLabel, confirmText }) {
    openModal(title, async (body) => {
      let open;
      try { open = (await api('GET', path)).open; } catch (e) { body.append(el('p', null, e.message)); return; }
      body.append(el('p', null, open ? '🟢 ' + onText : '🔴 ' + offText));
      body.append(menuButton(open ? '🔒  ' + closeLabel : '🔓  ' + openLabel, async () => {
        if (!open && !await askConfirm(confirmText, 'Open')) return;
        try { await api('PUT', path, { open: !open }); toast(open ? '🔒 Closed' : '🔓 Open'); closeModal(); }
        catch (e) { toast(e.message); }
      }, open ? '' : 'primary'));
    });
  }
  const signupsDialog = () => switchDialog({
    title: 'Sign-ups', path: '/api/admin/signups',
    onText: 'Open: everyone on the participant list can create an account.',
    offText: 'Closed: only organisers, the early-access emails and the emails you allowed can create an account. People who already have one can still sign in.',
    openLabel: 'Open sign-ups to everyone', closeLabel: 'Close sign-ups',
    confirmText: 'Open sign-ups? Everyone on the participant list will be able to create an account.',
  });
  const supportDialog = () => switchDialog({
    title: 'Staff support', path: '/api/admin/support',
    onText: 'Open: participants can write to the organisers.',
    offText: 'Closed: participants see "Staff support opens once we are on board" and cannot write. Organisers are not affected.',
    openLabel: 'Open staff support', closeLabel: 'Close staff support',
    confirmText: 'Open staff support? Participants will be able to write to the organisers (they see it next time they open the app).',
  });

  $('#btn-menu').addEventListener('click', () => {
    openModal('Menu', (body) => {
      body.append(el('p', 'muted', 'Signed in as ' + state.me.name + (state.me.isAdmin ? ' ⭐ organiser' : '')));
      if (state.me.isAdmin) {
        body.append(menuButton('✉️  Allow an email (organisers)', allowEmailDialog));
        body.append(menuButton('🔐  Sign-ups for new participants', signupsDialog));
        body.append(menuButton('🛟  Staff support on / off', supportDialog));
        body.append(menuButton('📊  Stats', async () => {
          try {
            const s = await api('GET', '/api/admin/stats');
            toast(`${s.online} online · ${s.users} members · ${s.messages} messages`);
          } catch (err) { toast(err.message); }
        }));
      }
      body.append(menuButton('👤  My profile', () => showProfile(state.me.id)));
      body.append(menuButton('🔑  Change password', () => passwordDialog()));
      body.append(menuButton('ℹ️  Useful info', usefulInfo));
      body.append(menuButton('🛟  Contact staff', contactStaff));
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
