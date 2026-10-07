(() => {
  const $ = id => document.getElementById(id);
  const LS = 'ttGiftReader.v1', MAX_CARDS = 300, MAX_HOT = 8, MAX_P = 420;
  const REDUCED = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const el = { key: $('key'), user: $('user'), min: $('min'), auto: $('auto'), status: $('status'), list: $('list'), empty: $('empty'), connect: $('connect') };
  const dock = $('dock');
  const allCards = () => [...dock.querySelectorAll('.card'), ...el.list.querySelectorAll('.card')];
  const pinnedUsers = new Set();   // pinned user keys
  const ignored = new Set();        // user keys (userId and uniqueId)
  const cardsByUser = new Map();    // user key -> latest card element
  const seenIds = new Set();
  const cardsByCombo = new Map();   // comboId -> card (1 combo = 1 card)
  const deadCombos = new Set();     // combos whose card was deleted by the user
  const hot = [];                   // cards with active animation (capped to avoid lag)
  let connected = false, busy = false, cardN = 0, totalCoins = 0, cardSeq = 0;

  // ---------- toast ----------
  function toast(text, type = 'info', ms = 2500) {
    const t = document.createElement('div');
    t.className = 'toast ' + type; t.textContent = text;
    $('toasts').appendChild(t);
    setTimeout(() => t.remove(), ms);
  }

  // ---------- storage ----------
  function save(silent) {
    try {
      localStorage.setItem(LS, JSON.stringify({ key: el.key.value.trim(), user: el.user.value.trim(), min: el.min.value, auto: el.auto.checked }));
      if (!silent) toast('Saved');
    } catch { toast('Failed to save (storage blocked)', 'error'); }
  }
  function load() {
    try {
      const d = JSON.parse(localStorage.getItem(LS) || 'null');
      if (!d) return;
      el.key.value = d.key || ''; el.user.value = d.user || ''; el.min.value = d.min ?? 5; el.auto.checked = !!d.auto;
    } catch {}
  }
  const autoSave = () => { if (el.auto.checked) save(true); };
  ['input', 'change'].forEach(e => { el.key.addEventListener(e, autoSave); el.user.addEventListener(e, autoSave); el.min.addEventListener(e, autoSave); });
  el.auto.addEventListener('change', () => save(true));
  $('save').onclick = () => save();

  // ---------- status ----------
  function setStatus(s, msg) {
    connected = s === 'connected';
    const wait = s === 'connecting';
    el.status.className = 'status ' + (connected ? 'on' : wait ? 'wait' : 'off');
    el.status.querySelector('em').textContent = connected ? 'CONNECTED' : wait ? 'CONNECTING…' : 'DISCONNECTED';
    el.connect.textContent = connected || wait ? 'DISCONNECT' : 'CONNECT';
    timerSync();
    if (msg && (s === 'error' || s === 'disconnected' || s === 'connected')) toast(msg, s === 'error' ? 'error' : 'info', 4000);
  }

  // ---------- socket ----------
  const socket = io({ reconnection: true });
  socket.on('connect', () => { if (connected || busy) doConnect(true); });
  socket.on('disconnect', () => { setStatus('disconnected'); toast('Server disconnected', 'error'); });
  socket.on('connect_error', () => toast('Unable to reach server', 'error'));
  socket.on('status', s => { busy = s.status === 'connecting' || s.status === 'connected'; setStatus(s.status, s.message); });
  socket.on('toast', t => toast(t.text, t.type, 4000));
  socket.on('gift', onGift);
  socket.on('chat', onChat);

  function doConnect(quiet) {
    if (!quiet) timerReset();
    const key = el.key.value.trim(), username = el.user.value.trim();
    if (!key) return toast('Euler Key is required', 'error');
    if (!username) return toast('TikTok username is required', 'error');
    autoSave(); busy = true;
    socket.emit('connect:live', { key, username });
  }
  el.connect.onclick = () => {
    if (connected || busy) { busy = false; socket.emit('disconnect:live'); setStatus('disconnected'); }
    else doConnect();
  };

  // ---------- helpers ----------
  const userKeys = d => [d.userId, (d.uniqueId || '').toLowerCase()].filter(Boolean);
  const minCoins = () => Math.max(0, Number(el.min.value) || 0);
  function updateCount() {
    $('cardN').textContent = cardN.toLocaleString();
    setCoins(totalCoins);
    el.empty.style.display = cardN ? 'none' : '';
    scheduleView();
  }

  // ---------- live coin counter (count-up) ----------
  const coinEl = $('coinN');
  let coinShown = 0, coinFrom = 0, coinTo = 0, coinT0 = 0, coinDur = 600, coinRaf = 0;
  const renderCoins = () => { coinEl.textContent = Math.round(coinShown).toLocaleString(); };
  function coinStep(ts) {
    const p = Math.min(1, (ts - coinT0) / coinDur), e = 1 - Math.pow(1 - p, 3);
    coinShown = coinFrom + (coinTo - coinFrom) * e; renderCoins();
    if (p < 1) coinRaf = requestAnimationFrame(coinStep); else { coinRaf = 0; coinShown = coinTo; renderCoins(); }
  }
  function setCoins(v, instant) {
    if (v === coinTo && !instant) return;
    const up = v > coinTo; coinTo = v;
    if (instant || REDUCED) { cancelAnimationFrame(coinRaf); coinRaf = 0; coinShown = v; renderCoins(); return; }
    coinFrom = coinShown; coinT0 = performance.now();
    coinDur = Math.min(1000, 350 + Math.log10(1 + Math.abs(v - coinFrom)) * 140);
    if (!coinRaf) coinRaf = requestAnimationFrame(coinStep);
    if (up) pop(coinEl, 1.1);
  }

  // ---------- session timer ----------
  const timerEl = $('timer');
  let tAcc = 0, tSeg = 0, tInt = 0;
  const fmtT = ms => { const s = Math.floor(ms / 1000), p = n => String(n).padStart(2, '0'); return `${p(Math.floor(s / 3600))}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}`; };
  const timerRender = () => { timerEl.textContent = fmtT(tAcc + (tSeg ? Date.now() - tSeg : 0)); };
  function timerSync() {                       // called on every status change
    if (connected && !tSeg) {
      tSeg = Date.now(); tInt = setInterval(timerRender, 1000);
      timerEl.classList.remove('idle');
    } else if (!connected && tSeg) {
      tAcc += Date.now() - tSeg; tSeg = 0; clearInterval(tInt);
      timerEl.classList.add('idle');            // freeze at the last duration
    }
    timerRender();
  }
  function timerReset() { tAcc = 0; if (tSeg) tSeg = Date.now(); timerRender(); }

  // ---------- sound (cha-ching, synthesized with WebAudio, no audio files) ----------
  const SK = 'ttGiftReader.sound';
  let soundOn = true, actx = null, lastSnd = 0;
  try { soundOn = localStorage.getItem(SK) !== '0'; } catch {}
  const sndBtn = $('snd');
  function paintSnd() { sndBtn.textContent = soundOn ? '🔊 Sound' : '🔇 Muted'; sndBtn.setAttribute('aria-pressed', soundOn); }
  function audio() {
    try {
      if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
      if (actx.state === 'suspended') actx.resume();
    } catch { actx = null; }
    return actx;
  }
  function chaChing(tier = 0) {
    if (!soundOn) return;
    const now = performance.now(); if (now - lastSnd < 90) return; lastSnd = now;   // anti-spam
    const ac = audio(); if (!ac || ac.state !== 'running') return;
    const t0 = ac.currentTime, vol = Math.min(0.2, 0.09 + tier * 0.008);
    const out = ac.createGain(); out.gain.value = vol; out.connect(ac.destination);
    const bell = (f, at, dur) => [1, 2.01, 3.02].forEach((m, i) => {
      const o = ac.createOscillator(), g = ac.createGain();
      o.type = i ? 'sine' : 'triangle'; o.frequency.value = f * m;
      const a0 = t0 + at; g.gain.setValueAtTime(0.0001, a0);
      g.gain.exponentialRampToValueAtTime(i ? 0.25 / (i + 1) : 0.7, a0 + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, a0 + dur);
      o.connect(g); g.connect(out); o.start(a0); o.stop(a0 + dur + 0.02);
    });
    // "cha" (short metallic click) + "ching" (two rising bells)
    const n = ac.createBufferSource(), nb = ac.createBuffer(1, ac.sampleRate * 0.05, ac.sampleRate), d = nb.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
    n.buffer = nb; const hp = ac.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 3500;
    n.connect(hp); hp.connect(out); n.start(t0);
    bell(1318, 0.05, 0.35); bell(1976, 0.13, 0.7);
    if (tier >= 8) bell(2637, 0.24, 0.9);       // high tiers: third bell
  }
  sndBtn.onclick = () => {
    soundOn = !soundOn; paintSnd();
    try { localStorage.setItem(SK, soundOn ? '1' : '0'); } catch {}
    if (soundOn) { audio(); lastSnd = 0; chaChing(0); }
  };
  addEventListener('pointerdown', () => { if (soundOn) audio(); }, { once: true });   // unlock autoplay
  paintSnd();

  // ---------- pin ----------
  const isPinned = c => c._keys.some(k => pinnedUsers.has(k));
  function placeCard(c) {
    const p = isPinned(c);
    c.classList.toggle('pinned', p);
    if (c._pinBtn) { c._pinBtn.textContent = p ? 'UNPIN' : 'PIN'; c._pinBtn.classList.toggle('on', p); }
    const target = p ? dock : el.list;
    if (c.parentNode !== target) target.appendChild(c);
  }
  function togglePin(card) {
    const on = !isPinned(card);
    card._keys.forEach(k => on ? pinnedUsers.add(k) : pinnedUsers.delete(k));
    const ks = new Set(card._keys);
    allCards().forEach(c => { if (c._keys.some(k => ks.has(k))) placeCard(c); });   // all cards of that user follow
    applyView();
    toast(on ? 'Pinned' : 'Unpinned', 'info', 1200);
  }

  // ---------- fresh highlight ----------
  let latestCard = null;
  function markFresh(card, upd) {
    const t = card._tier, gold = t >= 3 && t < 7, purple = t >= 7;
    card.classList.remove('fresh', 'upd', 'pg', 'pp'); void card.offsetWidth;
    if (purple) card.style.setProperty('--pc', '#b26bff');
    else if (gold) card.style.setProperty('--pc', '#ffc928');
    else card.style.removeProperty('--pc');
    card.classList.add('fresh');
    if (upd) card.classList.add('upd');
    if (purple) card.classList.add('pp'); else if (gold) card.classList.add('pg');
    clearTimeout(card._ft); card._ft = setTimeout(() => card.classList.remove('fresh', 'upd', 'pg', 'pp'), upd ? 1400 : purple ? 2300 : 1700);
    // "latest" focus: newest card's chat bubble is accented for a moment, then back to normal
    if (latestCard && latestCard !== card) latestCard.classList.remove('latest');
    latestCard = card; card.classList.add('latest');
    clearTimeout(markFresh._lt); markFresh._lt = setTimeout(() => card.classList.remove('latest'), 3200);
  }

  // ---------- sort & filter ----------
  let sortMode = 'old', giftFilter = '', viewQ = 0, giftSig = '';
  const gsel = $('gfilter');
  function scheduleView() { if (!viewQ) viewQ = requestAnimationFrame(applyView); }
  function applyView() {
    viewQ = 0;
    const cards = allCards();
    const counts = new Map();
    cards.forEach(c => counts.set(c._gname, (counts.get(c._gname) || 0) + 1));
    if (giftFilter && !counts.has(giftFilter)) giftFilter = '';
    // rebuild dropdown only when its contents change
    const names = [...counts.keys()].sort((x, y) => x.localeCompare(y));
    const sig = names.map(n => n + ':' + counts.get(n)).join('|') + '#' + giftFilter;
    if (sig !== giftSig) {
      giftSig = sig; gsel.textContent = '';
      const o0 = mk('option', '', 'All gifts'); o0.value = ''; gsel.append(o0);
      names.forEach(n => { const o = mk('option', '', `${n} (${counts.get(n)})`); o.value = n; gsel.append(o); });
      gsel.value = giftFilter;
    }
    const cmp = sortMode === 'new' ? (a, b) => b._seq - a._seq
      : sortMode === 'coin' ? (a, b) => b._coins - a._coins || b._seq - a._seq
      : (a, b) => a._seq - b._seq;
    let vis = 0;
    cards.sort(cmp).forEach((c, i) => {
      c.style.order = i;
      const hide = !!giftFilter && c._gname !== giftFilter;
      c.classList.toggle('hide', hide);
      if (!hide) vis++;
    });
    dock.hidden = !dock.children.length;
    $('nomatch').style.display = cardN && !vis ? '' : 'none';
    const sh = $('shown'); sh.classList.toggle('on', !!giftFilter);
    sh.textContent = giftFilter ? `Showing ${vis} of ${cardN} cards` : '';
  }
  $('sort').onclick = e => {
    const b = e.target.closest('button[data-s]'); if (!b) return;
    sortMode = b.dataset.s;
    $('sort').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
    applyView(); stick = true; hideNew();
    el.list.scrollTop = sortMode === 'old' ? el.list.scrollHeight : 0;
  };
  gsel.onchange = () => { giftFilter = gsel.value; applyView(); stick = true; hideNew(); el.list.scrollTop = sortMode === 'old' ? el.list.scrollHeight : 0; };
  const PH_AV = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect width="48" height="48" fill="#1c1c1c"/><circle cx="24" cy="19" r="8" fill="#555"/><path d="M8 44c2-10 10-14 16-14s14 4 16 14z" fill="#555"/></svg>');
  const PH_GIFT = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none" stroke="#888" stroke-width="3" stroke-linejoin="round"><rect x="10" y="26" width="44" height="28" rx="4"/><rect x="7" y="18" width="50" height="10" rx="3"/><path d="M32 18v36M32 18c-6-10-18-8-14-1 2 3 8 1 14 1zm0 0c6-10 18-8 14-1-2 3-8 1-14 1z"/></svg>');
  function img(srcs, cls, alt, ph) {
    const list = (Array.isArray(srcs) ? srcs : [srcs]).filter(Boolean);
    // avatars: direct URL first, then server proxy; gifts: already proxied
    if (cls === 'av') list.push(...list.filter(s => !s.startsWith('/')).map(s => '/api/img?u=' + encodeURIComponent(s)));
    const i = document.createElement('img');
    i.className = cls; i.alt = alt || ''; i.loading = 'lazy'; i.decoding = 'async'; i.referrerPolicy = 'no-referrer';
    let n = 0;
    i.onerror = () => { n++; i.src = n < list.length ? list[n] : ph; if (n >= list.length) i.onerror = null; };
    i.src = list[0] || ph;
    return i;
  }

  // ---------- tier / effects ----------
  const RB = ['#ff4d4d', '#ffb020', '#fff04d', '#4dff88', '#4dc3ff', '#9b6bff', '#ff4dd2'];
  const RBG = 'linear-gradient(90deg,#ff4d4d,#ffb020,#fff04d,#4dff88,#4dc3ff,#9b6bff,#ff4dd2)';
  const PURPLE_RING = 'conic-gradient(#7c3aed,#e0c2ff,#b26bff,#5b21b6,#e0c2ff,#7c3aed)';
  const RBR = 'conic-gradient(#ff4d4d,#ffb020,#fff04d,#4dff88,#4dc3ff,#9b6bff,#ff4dd2,#ff4d4d)';
  const T = (m, l, c, c2, b1, b2, gl, n, pc, ring, fx) => ({ m, l, c, c2, b1, b2, gl, n, pc: pc || [c, c2, '#fff'], ring: ring || '', fx: fx || '' });
  const TIERS = [
    T(0,    '',        '#8b8b94', '#8b8b94', '#131316', '#0e0e10', 0,  'none'),
    T(10,   'NICE',    '#2dd4bf', '#38bdf8', '#0b1f20', '#0b0f12', 14, 'linear-gradient(90deg,#5eead4,#7dd3fc)'),
    T(50,   'BLUE',    '#4da3ff', '#7a8cff', '#0a1830', '#080d18', 20, 'linear-gradient(90deg,#6db6ff,#a5b8ff)'),
    T(100,  'GOLD',    '#ffc928', '#ff9d1c', '#241b00', '#0e0c05', 26, 'linear-gradient(90deg,#ffe27a,#ffb020)'),
    T(200,  'FIRE',    '#ff7a1a', '#ff3d3d', '#2a1000', '#100804', 30, 'linear-gradient(90deg,#ffc04d,#ff5a3c)', null, null, 'fire'),
    T(300,  'ROSE',    '#ff4fa3', '#ff8ac6', '#2a0a1d', '#10070c', 34, 'linear-gradient(90deg,#ff9ccf,#ff4fa3,#ffb3dd)'),
    T(400,  'EMERALD', '#2bff9a', '#12d6ff', '#052416', '#06100c', 38, 'linear-gradient(90deg,#8bffc8,#38e8ff)', null, null, 'galaxy'),
    T(500,  'ROYAL',   '#b26bff', '#7c3aed', '#2a0b4d', '#0d0714', 44, 'linear-gradient(90deg,#f0d9ff,#b26bff,#e0c2ff)', null, null, 'galaxy'),
    T(600,  'NEON',    '#5b8cff', '#d04dff', '#13123f', '#09081a', 48, 'linear-gradient(90deg,#7fd0ff,#b07bff,#ff6bd6)', null, null, 'galaxy'),
    T(700,  'INFERNO', '#ff3b3b', '#ffb020', '#33080a', '#120506', 52, 'linear-gradient(90deg,#ffd166,#ff5a3c,#ff2d55)', null, null, 'fire'),
    T(800,  'RAINBOW', '#ff6bd6', '#4dc3ff', '#1a0f2e', '#09070f', 56, RBG, RB, RBR, 'storm'),
    T(900,  'PRISM',   '#4dff88', '#9b6bff', '#10132e', '#07080f', 60, RBG, RB, RBR, 'prism'),
    T(1000, 'LEGEND',  '#ffd54a', '#ff6bd6', '#2b2000', '#0d0a02', 68, 'linear-gradient(90deg,#fff6c2,#ffd54a,#ff9ad5,#9ee7ff,#fff6c2)', ['#ffd54a', '#fff', '#ff9ad5', '#9ee7ff'],
      'conic-gradient(#fff6c2,#ffd54a,#ff6bd6,#6bd0ff,#fff6c2)', 'prism'),
    T(2000, 'MYTHIC',  '#ffffff', '#ffd54a', '#2e2300', '#0f0b03', 80, 'linear-gradient(90deg,#fff,#ffd54a,#ff6bd6,#6bd0ff,#fff)', ['#fff', '#ffd54a', '#ff6bd6', '#6bd0ff', '#4dff88'],
      'conic-gradient(#fff,#ffd54a,#ff4dd2,#4dc3ff,#4dff88,#fff)', 'myth')
  ];
  const tierOf = coins => { let t = 0; for (let i = 1; i < TIERS.length; i++) if (coins >= TIERS[i].m) t = i; return t; };
  const mk = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };

  // ---------- particle canvas (single canvas, loop only runs while particles exist) ----------
  const cv = $('fx'), cx = cv.getContext('2d'), flash = $('flash'), banner = $('banner');
  const DPR = Math.min(window.devicePixelRatio || 1, 1.5);
  let VW = 0, VH = 0, raf = 0, lastTs = 0;
  const P = [];
  function resizeCv() { VW = innerWidth; VH = innerHeight; cv.width = VW * DPR; cv.height = VH * DPR; cx.setTransform(DPR, 0, 0, DPR, 0, 0); }
  resizeCv(); addEventListener('resize', resizeCv);
  function burst(x, y, n, colors, power = 1) {
    if (REDUCED) return;
    n = Math.min(n, MAX_P - P.length);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, sp = (1.5 + Math.random() * 5) * power;
      P.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 1.5, l: 0, t: 45 + Math.random() * 45, s: 2 + Math.random() * 3.2, c: colors[i % colors.length] });
    }
    if (!raf && P.length) { lastTs = 0; raf = requestAnimationFrame(tick); }
  }
  function tick(ts) {
    const k = Math.min(2.5, lastTs ? (ts - lastTs) / 16.7 : 1); lastTs = ts;
    cx.clearRect(0, 0, VW, VH);
    for (let i = P.length - 1; i >= 0; i--) {
      const p = P[i];
      p.l += k;
      if (p.l >= p.t) { P[i] = P[P.length - 1]; P.pop(); continue; }
      p.vy += 0.09 * k; p.vx *= 0.985; p.x += p.vx * k; p.y += p.vy * k;
      cx.globalAlpha = 1 - p.l / p.t; cx.fillStyle = p.c;
      cx.fillRect(p.x, p.y, p.s, p.s);
    }
    cx.globalAlpha = 1;
    raf = P.length ? requestAnimationFrame(tick) : 0;
    if (!raf) cx.clearRect(0, 0, VW, VH);
  }

  function showBanner(card, t) {
    const T_ = TIERS[t];
    banner.textContent = ''; banner.style.setProperty('--c', T_.c);
    const gi = card.querySelector('.gi');
    const im = mk('img'); im.alt = ''; if (gi) im.src = gi.currentSrc || gi.src;
    const tx = mk('div', 'bt');
    tx.append(mk('b', '', `${T_.l} • ${card._nick}`), mk('span', '', `${card._qty > 1 ? card._qty + '× ' : ''}${card._gname} — ${card._coins.toLocaleString()} Coins`));
    banner.append(im, tx);
    banner.className = 'banner ' + (t >= 13 ? 'mega ' : '') + 'show';
    clearTimeout(showBanner._t);
    showBanner._t = setTimeout(() => banner.classList.remove('show'), t >= 13 ? 4800 : 3400);
  }
  function celebrate(card, t) {
    if (REDUCED || t < 4) return;
    requestAnimationFrame(() => {
      if (!card.isConnected) return;
      const r = card.getBoundingClientRect();
      const x = Math.min(Math.max(r.left + r.width / 2, 60), VW - 60), y = Math.min(Math.max(r.top + r.height / 2, 60), VH - 60);
      const pc = TIERS[t].pc;
      if (t < 8) burst(x, y, 14 + (t - 4) * 8, pc, 0.9);
      else if (t < 10) burst(x, y, 50, pc, 1.1);
      else if (t < 12) { burst(x, y, 80, pc, 1.25); }
      else if (t === 12) { burst(x, y, 130, pc, 1.4); setTimeout(() => burst(x, y, 70, pc, 1.1), 250); showBanner(card, t); }
      else {
        showBanner(card, t);
        flash.animate([{ opacity: 0 }, { opacity: 1, offset: 0.15 }, { opacity: 0 }], { duration: 900, easing: 'ease-out' });
        burst(VW / 2, VH * 0.4, 120, pc, 1.7);
        [220, 520, 860].forEach(d => setTimeout(() => burst(VW * (0.15 + Math.random() * 0.7), VH * (0.15 + Math.random() * 0.45), 90, pc, 1.4), d));
      }
    });
  }

  // ---------- card styling per tier ----------
  const FX_CLASSES = ['t-glow', 't-pulse', 't-name', 't-nameanim', 't-shine', 't-spark', 't-ring', 't-crown', 't-mega', 't-fire', 't-galaxy', 't-storm', 't-prism', 't-myth'];
  const FX_CLASS_OF = { fire: 't-fire', galaxy: 't-galaxy', storm: 't-storm', prism: 't-prism', myth: 't-myth' };
  function applyTier(card, t) {
    const X = TIERS[t], st = card.style;
    card._tier = t;
    FX_CLASSES.forEach(c => card.classList.remove(c));
    st.setProperty('--c', X.c); st.setProperty('--c2', X.c2); st.setProperty('--bc', X.c + (t >= 10 ? 'ff' : 'aa'));
    st.setProperty('--b1', X.b1); st.setProperty('--b2', X.b2); st.setProperty('--gl', X.gl + 'px');
    st.setProperty('--s0', t >= 7 ? '0.82' : '0.85');   // entrance start scale (subtle; 500+ slightly stronger)
    st.setProperty('--ng', X.n); st.setProperty('--ringbg', X.ring || (t >= 7 ? PURPLE_RING : 'none'));
    const add = c => card.classList.add(c);
    if (t >= 1) { add('t-glow'); add('t-name'); }
    if (t >= 3) add('t-pulse');
    if (t >= 7) add('t-shine');
    if (t >= 8) { add('t-spark'); add('t-nameanim'); }
    if (t >= 7) add('t-ring');
    if (t >= 12) add('t-crown');
    if (t >= 13) add('t-mega');
    if (X.fx && FX_CLASS_OF[X.fx]) add(FX_CLASS_OF[X.fx]);
    // overlay layer (ring / shine / sparkle / signature fx)
    const old = card.querySelector('.fxwrap'); if (old) old.remove();
    if (t >= 4 || X.fx) {
      const w = mk('div', 'fxwrap');
      const clip = mk('div', 'clipbox');
      if (t >= 7) { clip.append(mk('i', 'ring'), mk('i', 'surf')); }
      clip.append(mk('i', 'shine'));
      if (t >= 8) for (let i = 0; i < 6; i++) {
        const sp = mk('i', 'spk');
        sp.style.cssText = `--x:${6 + Math.random() * 88}%;--y:${8 + Math.random() * 80}%;--d:${(Math.random() * 2.4).toFixed(2)}s;--s:${10 + Math.random() * 10 | 0}px`;
        clip.append(sp);
      }
      w.append(clip);
      if (X.fx === 'fire') for (let i = 0; i < 9; i++) {
        const f = mk('i', 'flame');
        f.style.cssText = `--x:${2 + Math.random() * 92}%;--s:${16 + Math.random() * 16 | 0}px;--d:${(Math.random() * 1.1).toFixed(2)}s;--r:${(Math.random() * 16 - 8).toFixed(0)}deg`;
        w.append(f);
      }
      if (X.fx === 'galaxy') for (let i = 0; i < 9; i++) {
        const o = mk('i', 'orb');
        o.style.cssText = `--r:${38 + Math.random() * 30 | 0}px;--od:${(2.6 + Math.random() * 3).toFixed(2)}s;--d:${(Math.random() * 3).toFixed(2)}s;--os:${7 + Math.random() * 5 | 0}px`;
        w.append(o);
      }
      if (X.fx === 'storm') for (let i = 0; i < 6; i++) {
        const b = mk('i', 'bolt');
        b.style.cssText = `--x:${6 + Math.random() * 86}%;--y:${2 + Math.random() * 60}%;--s:${28 + Math.random() * 26 | 0}px;--r:${(Math.random() * 40 - 20).toFixed(0)}deg;--d:${(Math.random() * 2.6).toFixed(2)}s`;
        w.append(b);
      }
      if (X.fx === 'prism') for (let i = 0; i < 8; i++) {
        const sh = mk('i', 'rshard');
        sh.style.cssText = `--x:${2 + Math.random() * 92}%;--y:${2 + Math.random() * 88}%;--s:${16 + Math.random() * 16 | 0}px;--d:${(Math.random() * 2.8).toFixed(2)}s`;
        w.append(sh);
      }
      if (X.fx === 'myth') for (let i = 0; i < 12; i++) {
        const s = mk('i', 'starfx');
        s.style.cssText = `--x:${0 + Math.random() * 96}%;--y:${0 + Math.random() * 92}%;--s:${10 + Math.random() * 12 | 0}px;--d:${(Math.random() * 2).toFixed(2)}s`;
        w.append(s);
      }
      card.prepend(w);
    }
    card._tag.textContent = X.l;
    card._crown.textContent = t >= 12 ? '👑' : '';
    // continuous animation only for the newest "hot" cards (anti-lag)
    const i = hot.indexOf(card); if (i > -1) hot.splice(i, 1);
    if (t >= 3) {
      hot.push(card); card.classList.add('fxon');
      while (hot.length > MAX_HOT) hot.shift().classList.remove('fxon');
    }
  }

  // ---------- events ----------
  function giftLabel(card) { return (card._qty > 1 ? card._qty + '× ' : '') + card._gname; }
  function setGiftText(card) {
    card._gnEl.textContent = giftLabel(card);
    card._coinEl.textContent = `${card._coins.toLocaleString()} Coins`;
  }
  function pop(e, s = 1.3) { if (e && e.animate && !REDUCED) e.animate([{ transform: 'scale(1)' }, { transform: `scale(${s})` }, { transform: 'scale(1)' }], { duration: 360, easing: 'cubic-bezier(.2,.9,.3,1.4)' }); }

  const QUINT = 'cubic-bezier(.22,1,.36,1)', BACK = 'cubic-bezier(.34,1.56,.64,1)';
  function bumpCard(card) {                 // existing card updated: 1.0 -> 1.04 -> 1.0 (500+ a bit stronger)
    if (REDUCED || !card.animate) return;
    const s = card._tier >= 7 ? 1.06 : card._tier >= 3 ? 1.05 : 1.04;
    card.animate([{ transform: 'scale(1)' }, { transform: `scale(${s})`, offset: 0.4 }, { transform: 'scale(1)' }], { duration: card._tier >= 7 ? 440 : 340, easing: 'ease-out' });
  }
  function bounceGift(e) {
    if (REDUCED || !e || !e.animate) return;
    e.animate([{ transform: 'scale(1) rotate(0)' }, { transform: 'scale(1.22) rotate(-12deg)', offset: 0.3 }, { transform: 'scale(.95) rotate(6deg)', offset: 0.62 }, { transform: 'scale(1) rotate(0)' }], { duration: 480, easing: 'ease-out' });
  }
  function slideChat(e, delay = 0) {        // latest chat: fade + slide in
    if (REDUCED || !e || !e.animate) return;
    e.animate([{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'translateY(0)' }], { duration: 300, delay, easing: QUINT, fill: 'backwards' });
  }

  // ---------- auto scroll + "new gifts" indicator ----------
  const newBtn = $('newbtn');
  let stick = true, progUntil = 0, newCount = 0, newTarget = null;
  const edgeMode = () => sortMode === 'old' ? 'bottom' : sortMode === 'new' ? 'top' : 'none';
  function atEdge() {
    const l = el.list, m = edgeMode();
    if (m === 'bottom') return l.scrollHeight - l.scrollTop - l.clientHeight < 140;
    if (m === 'top') return l.scrollTop < 140;
    return false;
  }
  function scrollEdge() {
    const m = edgeMode(); if (m === 'none') return;
    progUntil = Date.now() + 700;
    el.list.scrollTo({ top: m === 'bottom' ? el.list.scrollHeight : 0, behavior: REDUCED ? 'auto' : 'smooth' });
  }
  const inView = c => { const a = c.getBoundingClientRect(), b = el.list.getBoundingClientRect(); return a.top >= b.top - 10 && a.bottom <= b.bottom + 10; };
  function hideNew() { newCount = 0; newBtn.hidden = true; }
  function showNew() {
    const m = edgeMode(), r = el.list.getBoundingClientRect();
    newBtn.classList.toggle('up', m === 'top');
    newBtn.style.top = m === 'top' ? Math.max(8, r.top + 10) + 'px' : 'auto';
    newBtn.style.bottom = m === 'top' ? 'auto' : Math.max(12, innerHeight - r.bottom + 14) + 'px';
    newBtn.textContent = `${m === 'top' ? '↑' : '↓'} ${newCount} New Gift${newCount > 1 ? 's' : ''}`;
    const was = newBtn.hidden; newBtn.hidden = false;
    if (!was && !REDUCED) newBtn.animate([{ transform: 'translateX(-50%) scale(1)' }, { transform: 'translateX(-50%) scale(1.08)' }, { transform: 'translateX(-50%) scale(1)' }], { duration: 260, easing: 'ease-out' });
  }
  // called after a gift event was rendered (created = new card, else existing card updated)
  function noteEvent(card, created) {
    if (edgeMode() === 'none' || card.parentNode !== el.list) return;   // pinned cards live in the dock (always visible)
    requestAnimationFrame(() => {                                       // after applyView() has ordered the cards
      if (!card.isConnected) return;
      newTarget = card;
      if (stick && created) return scrollEdge();                        // user is at the latest edge -> follow
      if (inView(card)) return;
      newCount++; showNew();                                            // reading old chat -> don't force scroll, just hint
    });
  }
  newBtn.onclick = () => {
    const t = newTarget, newest = !t || !t.isConnected || t._seq === cardSeq;
    if (newest) scrollEdge();
    else { progUntil = Date.now() + 900; t.scrollIntoView({ behavior: REDUCED ? 'auto' : 'smooth', block: 'center' }); }
    stick = newest; hideNew();
  };
  el.list.addEventListener('scroll', () => {
    if (Date.now() < progUntil) { progUntil = Math.max(progUntil, Date.now() + 120); return; }   // ignore our own smooth scroll
    stick = atEdge();
    if (stick) hideNew();
  }, { passive: true });
  ['wheel', 'touchstart', 'pointerdown', 'keydown'].forEach(ev => el.list.addEventListener(ev, () => { progUntil = 0; }, { passive: true }));

  function onGift(g) {
    if (!g || !g.id || seenIds.has(g.id)) return;
    seenIds.add(g.id); if (seenIds.size > 2000) seenIds.delete(seenIds.values().next().value);
    const coins = Number(g.coins) || 0;
    if (!(coins >= minCoins())) return;           // gift only: total coins >= minimum
    if (g.comboId && deadCombos.has(g.comboId)) return;
    const keys = userKeys(g);
    if (!keys.length) return;
    keys.forEach(k => ignored.delete(k));          // qualifying gift reactivates ignored user

    const ex = g.comboId && cardsByCombo.get(g.comboId);
    if (ex && ex.isConnected) return updateCard(ex, g, coins);
    createCard(g, coins, keys);
  }

  function updateCard(card, g, coins) {
    totalCoins += coins - card._coins;
    card._coins = coins; card._qty = Number(g.quantity) || card._qty;
    if (g.chat && g.chat !== card._chat) { card._chat = g.chat; setChat(card); slideChat(card._chatEl); }
    setGiftText(card);
    pop(card._gnEl, 1.2); pop(card._coinEl, 1.2);
    bounceGift(card.querySelector('.gi')); bumpCard(card);
    const t = tierOf(coins);
    if (t > card._tier) { applyTier(card, t); celebrate(card, t); }
    else if (t >= 8 && !REDUCED) {
      const r = card.getBoundingClientRect();
      if (r.bottom > 0 && r.top < VH) burst(r.left + r.width * 0.8, r.top + r.height / 2, 8, TIERS[t].pc, 0.7);
    }
    markFresh(card, true); chaChing(t);
    updateCount();
    noteEvent(card, false);
  }

  function createCard(g, coins, keys) {
    const card = mk('div', 'card');
    card._seq = ++cardSeq; card._keys = keys; card._chat = g.chat || ''; card._coins = coins; card._qty = Number(g.quantity) || 1;
    card._gname = g.giftName || 'Gift'; card._nick = g.nickname || g.uniqueId || 'Unknown'; card._combo = g.comboId || '';

    const avw = mk('div', 'avw'); card._crown = mk('span', 'crown');
    avw.append(card._crown, img(g.avatar, 'av', g.nickname, PH_AV));
    const body = mk('div', 'body');
    const name = mk('div', 'name');
    name.appendChild(mk('span', 'nm', card._nick));
    if (g.uniqueId && g.uniqueId !== g.nickname) name.appendChild(mk('small', '', '@' + g.uniqueId));
    card._tag = mk('em', 'tag'); name.appendChild(card._tag);
    const gift = mk('div', 'gift');
    card._gnEl = mk('span', 'gn'); card._coinEl = mk('span', 'coin');
    gift.append(card._gnEl, document.createTextNode(' • '), card._coinEl);
    const chat = mk('div', 'chat'); card._chatEl = chat; setChat(card);
    setGiftText(card);
    body.append(name, gift, chat);
    const gw = mk('div', 'giw'); gw.appendChild(img([g.giftImage, g.giftImageAlt], 'gi', g.giftName, PH_GIFT));
    card.append(avw, body, gw);

    const acts = mk('div', 'acts');
    const cp = mk('button', '', 'COPY'); cp.onclick = () => copy(card._chat);
    const del = mk('button', '', 'DELETE');
    del.onclick = () => {
      card._keys.forEach(k => { ignored.add(k); pinnedUsers.delete(k); });
      if (card._combo) { deadCombos.add(card._combo); if (deadCombos.size > 500) deadCombos.delete(deadCombos.values().next().value); }
      removeUserCards(card._keys);
    };
    card._pinBtn = mk('button', '', 'PIN'); card._pinBtn.onclick = () => togglePin(card);
    acts.append(cp, card._pinBtn, del); card.appendChild(acts);

    applyTier(card, tierOf(coins));
    el.list.appendChild(card);                      // oldest top, newest bottom
    placeCard(card);                                // pinned user -> automatically goes to the dock
    cardN++; totalCoins += coins;
    keys.forEach(k => cardsByUser.set(k, card));
    if (card._combo) cardsByCombo.set(card._combo, card);
    while (cardN > MAX_CARDS) { const old = el.list.querySelector('.card'); if (!old) break; dropCard(old); }   // pinned cards in the dock are never evicted
    updateCount();
    noteEvent(card, true);
    celebrate(card, card._tier);
    markFresh(card); chaChing(card._tier);
    slideChat(card._chatEl, 140);
  }
  function onChat(c) {
    const keys = userKeys(c);
    if (!keys.length || keys.some(k => ignored.has(k))) return;
    const card = keys.map(k => cardsByUser.get(k)).find(Boolean);
    if (!card || !card.isConnected) return;
    if (c.text === card._chat) return;
    card._chat = c.text; setChat(card); slideChat(card._chatEl);
  }
  function setChat(card) {
    card._chatEl.textContent = card._chat || '(no chat yet)';
    card._chatEl.classList.toggle('none', !card._chat);
  }
  function dropCard(card) {
    if (!card) return;
    card._keys.forEach(k => { if (cardsByUser.get(k) === card) cardsByUser.delete(k); });
    if (card._combo && cardsByCombo.get(card._combo) === card) cardsByCombo.delete(card._combo);
    const i = hot.indexOf(card); if (i > -1) hot.splice(i, 1);
    if (latestCard === card) latestCard = null;
    if (newTarget === card) newTarget = null;
    if (card.isConnected) cardN--;
    card.remove();
  }
  function removeUserCards(keys) {
    allCards().forEach(c => { if (c._keys.some(k => keys.includes(k))) dropCard(c); });
    updateCount();
  }
  async function copy(text) {
    if (!text) return toast('No chat to copy yet', 'warn');
    try { await navigator.clipboard.writeText(text); }
    catch {
      const t = document.createElement('textarea'); t.value = text; t.style.position = 'fixed'; t.style.opacity = 0;
      document.body.appendChild(t); t.select();
      try { document.execCommand('copy'); } catch { return toast('Failed to copy', 'error'); }
      t.remove();
    }
    toast('Copied!', 'info', 1500);
  }

  // ---------- reset ----------
  $('reset').onclick = () => $('modal').classList.remove('hidden');
  $('no').onclick = () => $('modal').classList.add('hidden');
  $('yes').onclick = () => {
    allCards().forEach(c => c.remove()); pinnedUsers.clear(); dock.hidden = true;
    ignored.clear(); cardsByUser.clear(); seenIds.clear(); cardsByCombo.clear(); deadCombos.clear(); hot.length = 0;
    cardN = 0; totalCoins = 0; P.length = 0; giftFilter = ''; latestCard = null; newTarget = null; stick = true; hideNew(); setCoins(0, true);
    updateCount(); $('modal').classList.add('hidden');
    toast('All users & chats reset');
  };

  // ---------- test panel (fake users, only to preview effects) ----------
  const tp = $('tpanel'), tgear = $('tgear'), tcoins = $('tcoins');
  const setTP = open => { tp.hidden = !open; tgear.setAttribute('aria-expanded', open); if (open) { tcoins.focus(); tcoins.select(); } };
  tgear.onclick = () => setTP(tp.hidden);
  $('tclose').onclick = () => setTP(false);
  addEventListener('keydown', e => { if (e.key === 'Escape' && !tp.hidden) setTP(false); });
  tp.querySelectorAll('.chip').forEach(b => b.onclick = () => { tcoins.value = b.dataset.c; });
  tcoins.addEventListener('keydown', e => { if (e.key === 'Enter') $('trun').click(); });

  const FAKE_NAMES = ['Nadia', 'Rizky', 'Putri', 'Bayu', 'Salsa', 'Dimas', 'Keisha', 'Fajar', 'Mawar', 'Arga', 'Lintang', 'Bima'];
  const FAKE_CHATS = ['semangat kak! 🔥', 'live nya seru banget', 'halo dari Surabaya 👋', 'gas terus kak', 'mantap jiwa 😍', 'first time gift hehe', 'salam kenal semuanya', 'lanjut kak jangan kendor'];
  const FAKE_GIFTS = [[1000, 'Universe', '🪐'], [500, 'Lion', '🦁'], [200, 'Galaxy', '🌌'], [100, 'Diamond', '💎'], [50, 'Heart Me', '💖'], [10, 'Rose', '🌹'], [0, 'Heart', '❤️']];
  const AV_COL = ['#ef4444', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#ec4899', '#14b8a6'];
  const svgURI = x => 'data:image/svg+xml,' + encodeURIComponent(x);
  let fakeSeq = 0, lastFake = null;
  const pick = a => a[Math.random() * a.length | 0];
  function newFake() {
    const n = ++fakeSeq, name = pick(FAKE_NAMES), id = `${name.toLowerCase()}_${n}`;
    const col = AV_COL[n % AV_COL.length];
    return { n, userId: 'test-' + n, uniqueId: id, nickname: name, comboId: 'test-combo-' + n,
      avatar: svgURI(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect width="48" height="48" fill="${col}"/><text x="24" y="31" font-size="22" font-family="sans-serif" font-weight="700" text-anchor="middle" fill="#fff">${name[0]}</text></svg>`) };
  }
  $('trun').onclick = () => {
    const add = Math.floor(Number(tcoins.value) || 0);
    if (add <= 0) return toast('Enter a coin amount', 'warn', 1800);
    let u = null, coins = add, qty = 1;
    const prev = lastFake && cardsByCombo.get(lastFake.comboId);
    if ($('tsame').checked && prev && prev.isConnected) { u = lastFake; coins = prev._coins + add; qty = prev._qty + 1; }   // combo: same card, cumulative
    else u = lastFake = newFake();
    if (coins < minCoins()) return toast(`Below Minimum Coins (${minCoins()}) - wouldn't show`, 'warn', 2500);
    const [, gname, emoji] = FAKE_GIFTS.find(x => (coins / qty) >= x[0]);
    onGift({ id: `test-${Date.now()}-${++fakeSeq}`, coins, quantity: qty, comboId: u.comboId, userId: u.userId, uniqueId: u.uniqueId, nickname: u.nickname, avatar: u.avatar,
      giftName: gname, chat: pick(FAKE_CHATS),
      giftImage: svgURI(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><text x="32" y="34" font-size="46" text-anchor="middle" dominant-baseline="middle">${emoji}</text></svg>`) });
  };

  load(); updateCount();
})();
