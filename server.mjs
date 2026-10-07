import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from 'socket.io';
import WebSocket from 'ws';
import { refreshStreamToEarnCatalog, findStreamToEarnGift, fetchStreamToEarnImageBuffer } from './gifts.mjs';

void refreshStreamToEarnCatalog();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const HOST = '0.0.0.0';
const MAX_SESSIONS = Number(process.env.MAX_SESSIONS) || 50;

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e5 });

app.disable('x-powered-by');
app.get('/health', (_req, res) => res.json({ ok: true, sessions: sessions.size }));

// ---------- Image proxy (fallback when TikTok CDN blocks hotlinking) + cache ----------
const imgCache = new Map(); // url -> {buf, type, at}
const IMG_TTL = 24 * 3600e3, IMG_MAX = 800;
function safeImageUrl(u) {
  try {
    const url = new URL(u);
    if (url.protocol !== 'https:') return null;
    const h = url.hostname;
    if (h === 'localhost' || /^[\d.]+$/.test(h) || h.includes(':') || !h.includes('.')) return null;
    return url.toString();
  } catch { return null; }
}
app.get('/api/img', async (req, res) => {
  const u = safeImageUrl(String(req.query.u || ''));
  if (!u) return res.status(400).end();
  let item = imgCache.get(u);
  if ((!item || Date.now() - item.at > IMG_TTL) && /tiktokcdn\.com$/i.test(new URL(u).hostname)) {
    const got = await fetchStreamToEarnImageBuffer(u);
    if (got) { item = { buf: got.buffer, type: got.contentType, at: Date.now() }; imgCache.set(u, item); }
  }
  if (!item || Date.now() - item.at > IMG_TTL) {
    try {
      const r = await fetch(u, { headers: { 'user-agent': 'Mozilla/5.0', accept: 'image/*' }, redirect: 'follow', signal: AbortSignal.timeout(8000) });
      const type = r.headers.get('content-type') || '';
      if (!r.ok || !/^image\//i.test(type)) return res.status(404).end();
      const buf = Buffer.from(await r.arrayBuffer());
      if (!buf.length || buf.length > 3e6) return res.status(404).end();
      item = { buf, type, at: Date.now() };
      imgCache.set(u, item);
      if (imgCache.size > IMG_MAX) imgCache.delete(imgCache.keys().next().value);
    } catch { return res.status(502).end(); }
  }
  res.set({ 'content-type': item.type, 'cache-control': 'public, max-age=86400' }).send(item.buf);
});

app.use(express.static(path.join(__dirname, 'public')));

// ---------- Helpers (adapted from reference ZIP: server.mjs) ----------
const num = (...v) => { for (const x of v) { const n = Number(x); if (Number.isFinite(n) && n > 0) return n; } return 0; };
const httpUrl = v => {
  if (typeof v !== 'string') return '';
  const s = v.trim();
  if (/^https?:\/\//i.test(s)) return s;
  if (s.startsWith('//')) return 'https:' + s;
  return '';
};
function parseRaw(v) {
  if (!v) return null;
  if (typeof v === 'object') return v;
  try { const p = JSON.parse(v); return p && typeof p === 'object' ? p : null; } catch { return null; }
}
function normalizeAvatar(u = {}) {
  const keys = ['avatarThumb', 'avatarMedium', 'avatarLarger', 'avatar_thumb', 'avatar_medium', 'avatar_larger', 'profilePicture', 'profile_picture', 'profilePic'];
  for (const k of keys) {
    const o = u?.[k];
    const c = Array.isArray(o) ? o[0] : (o?.urlList?.[0] ?? o?.url_list?.[0] ?? o?.urls?.[0] ?? o?.uri);
    const url = httpUrl(c);
    if (url) return url;
  }
  for (const c of [u?.profilePictureUrl, u?.profile_picture_url, u?.avatarUrl, u?.avatar_url]) { const url = httpUrl(c); if (url) return url; }
  return '';
}
function giftImageFrom(v, depth = 0) {
  if (!v || typeof v !== 'object' || depth > 2) return '';
  const direct = [v.imageUri, v.imageURI, v.image_uri, v.imageUrl, v.imageURL, v.image_url, v.uri, v.url,
    v.icon?.uri, v.icon?.url, v.image?.uri, v.image?.url, v.giftImage, v.gift_image];
  for (const c of direct) { const u = httpUrl(c); if (u) return u; }
  for (const l of [v.urlList, v.url_list, v.urls, v.icon?.urlList, v.icon?.url_list, v.image?.urlList, v.image?.url_list,
    v.giftImage?.urlList, v.giftImage?.url_list, v.gift_image?.urlList, v.gift_image?.url_list]) {
    if (Array.isArray(l)) { const m = l.map(httpUrl).find(Boolean); if (m) return m; }
  }
  const raw = parseRaw(v.raw);
  return raw ? giftImageFrom(raw, depth + 1) : '';
}
function normalizeUser(u = {}) {
  return {
    userId: String(u.userId ?? u.user_id ?? u.id ?? u.idStr ?? u.id_str ?? '').trim(),
    uniqueId: String(u.uniqueId ?? u.unique_id ?? u.displayId ?? u.display_id ?? u.handle ?? '').trim(),
    nickname: String(u.nickname ?? u.displayName ?? u.display_name ?? u.name ?? '').trim(),
    avatar: normalizeAvatar(u)
  };
}
function normalizeGift(m = {}) {
  const user = normalizeUser(m.user || m.sender || m.giftSender || m.giftUser || m.fromUser || {});
  const g = m.gift || m.giftInfo || m.gift_info || m.giftDetails || m.gift_details || {};
  const count = Math.max(1, Math.floor(num(m.giftCount, m.gift_count, m.repeatCount, m.repeat_count, m.count, g.giftCount, g.gift_count, g.repeatCount, g.repeat_count, 1)));
  const explicit = num(m.diamondCount, m.diamond_count, m.coinValue, m.coin_value, g.diamondCount, g.diamond_count, g.coinValue, g.coin_value);
  const total = num(m.totalCoins, m.total_coins, g.totalCoins, g.total_coins);
  const amb = num(m.coins, g.coins);
  const per = explicit || (total ? total / count : 0) || amb || 0;
  return {
    user,
    giftId: String(m.giftId ?? m.gift_id ?? g.giftId ?? g.gift_id ?? g.id ?? m.id ?? '').trim(),
    giftName: String(m.giftName ?? m.gift_name ?? g.giftName ?? g.gift_name ?? g.name ?? '').trim(),
    giftImage: giftImageFrom(m) || giftImageFrom(g) || '',
    count, coinValue: Math.max(0, Math.floor(per)),
    giftType: Math.floor(num(m.giftType, m.gift_type, g.giftType, g.gift_type)),
    repeatEnd: Boolean(m.repeatEnd ?? m.repeat_end ?? m.streakEnd ?? m.streak_end ?? false),
    msgId: m.msgId ?? m.messageId ?? m.message_id ?? m.transactionId ?? m.transaction_id ?? null
  };
}

// ---------- Gift catalog (Euler API) ----------
const giftCache = new Map(); // giftId -> meta
async function fetchGiftCatalog(id, key) {
  const c = giftCache.get(id);
  if (c && Date.now() - c.at < 24 * 3600e3) return c;
  try {
    const r = await fetch(`https://tiktok.eulerstream.com/webcast/gifts/catalog/${encodeURIComponent(id)}`, { headers: { 'x-api-key': key }, signal: AbortSignal.timeout(5000) });
    if (!r.ok) return null;
    const j = await r.json();
    const gift = j?.gift || j?.data?.gift || j?.data || (Array.isArray(j?.gifts) ? j.gifts[0] : null);
    if (!gift) return null;
    const raw = parseRaw(gift.raw);
    const meta = {
      name: String(gift.giftName ?? gift.gift_name ?? raw?.giftName ?? raw?.gift_name ?? raw?.name ?? '').trim(),
      coins: Math.floor(num(gift.diamondCount, gift.diamond_count, raw?.diamondCount, raw?.diamond_count, raw?.coinValue, raw?.coin_value)),
      image: giftImageFrom(gift) || giftImageFrom(raw) || '',
      at: Date.now()
    };
    giftCache.set(id, meta);
    if (giftCache.size > 3000) giftCache.delete(giftCache.keys().next().value);
    return meta;
  } catch { return null; }
}
const userCache = new Map();
async function fetchUserAvatar(uniqueId, key) {
  const id = String(uniqueId || '').replace(/^@+/, '').trim().toLowerCase();
  if (!id) return '';
  if (userCache.has(id)) return userCache.get(id);
  try {
    const r = await fetch(`https://tiktok.eulerstream.com/tiktok/users/${encodeURIComponent(id)}/basic`, { headers: { 'x-api-key': key }, signal: AbortSignal.timeout(5000) });
    if (!r.ok) return '';
    const j = await r.json();
    const raw = j?.user || j?.data?.user || j?.data;
    const a = raw ? normalizeAvatar(raw) : '';
    if (a) { userCache.set(id, a); if (userCache.size > 3000) userCache.delete(userCache.keys().next().value); }
    return a;
  } catch { return ''; }
}

// ---------- Per-socket live session ----------
const sessions = new Map(); // socket.id -> session

function closeMessage(code, reason) {
  if (code === 4401 || code === 4403) return 'Euler Key invalid / rejected.';
  if (code === 4404) return 'Username not found or LIVE is offline.';
  if (code === 4429) return 'Euler rate limit reached.';
  return `Disconnected (${code || 'unknown'})${reason ? ': ' + reason : ''}`;
}

class Session {
  constructor(socket) {
    this.socket = socket; this.ws = null; this.gen = 0; this.timer = null; this.attempt = 0; this.want = false;
    this.key = ''; this.username = '';
    this.seen = new Map();      // msgId dedupe
    this.streak = new Map();    // combo baselines
    this.lastChat = new Map();  // userKey -> text
  }
  emit(ev, data) { this.socket.emit(ev, data); }
  status(status, message = '', extra = {}) { this.emit('status', { status, message, ...extra }); }
  connect(key, username) {
    this.stop();
    this.key = String(key || '').trim();
    this.username = String(username || '').trim().replace(/^@+/, '');
    if (!this.key) return this.status('error', 'Euler Key is required.', { code: 'invalid_key' });
    if (!this.username) return this.status('error', 'TikTok username is required.', { code: 'no_user' });
    this.want = true; this.attempt = 0; this.seen.clear(); this.streak.clear(); this.lastChat.clear();
    this.open();
  }
  stop() {
    this.want = false; this.gen++;
    clearTimeout(this.timer); this.timer = null;
    const w = this.ws; this.ws = null;
    if (w) { try { w.close(1000); } catch {} try { w.terminate(); } catch {} }
  }
  open() {
    const gen = ++this.gen;
    this.status('connecting', `Connecting to @${this.username}…`);
    const url = new URL('wss://ws.eulerstream.com');
    url.searchParams.set('uniqueId', this.username);
    url.searchParams.set('apiKey', this.key);
    url.searchParams.set('features.bundleEvents', 'false');
    url.searchParams.set('features.schemaVersion', 'v2');
    url.searchParams.set('features.normalizeUniqueId', 'true');
    url.searchParams.set('features.syntheticPresence', 'false');
    let ws;
    try { ws = new WebSocket(url.toString()); } catch (e) { return this.fail(e.message); }
    this.ws = ws;
    ws.on('open', () => { if (gen !== this.gen) return; this.attempt = 0; this.status('connected', `Connected to @${this.username}`); });
    ws.on('message', buf => { if (gen === this.gen) this.onMessage(buf).catch(e => this.emit('toast', { type: 'error', text: 'Event processing error: ' + e.message })); });
    ws.on('unexpected-response', (_req, res) => {
      if (gen !== this.gen) return;
      const c = res.statusCode;
      const terminal = [401, 403, 404, 429].includes(c);
      const msg = c === 401 || c === 403 ? 'Euler Key invalid / rejected.' : c === 404 ? 'Username not found or LIVE is offline.' : c === 429 ? 'Euler rate limit reached.' : `Server rejected the connection (HTTP ${c}).`;
      this.ws = null;
      this.status('error', msg, { code: c === 401 || c === 403 ? 'invalid_key' : c === 404 ? 'offline' : 'api_error' });
      if (!terminal) this.retry(); else this.want = false;
    });
    ws.on('error', e => { if (gen !== this.gen) return; this.emit('toast', { type: 'error', text: 'Connection error: ' + (e.message || 'unknown') }); });
    ws.on('close', (code, reason) => {
      if (gen !== this.gen) return;
      this.ws = null;
      const terminal = [4400, 4401, 4403, 4404, 4429].includes(code);
      this.status(terminal ? 'error' : 'disconnected', closeMessage(code, String(reason || '')), { code: code === 4401 || code === 4403 ? 'invalid_key' : code === 4404 ? 'offline' : undefined });
      if (terminal) this.want = false; else this.retry();
    });
  }
  fail(msg) { this.status('error', msg); this.retry(); }
  retry() {
    if (!this.want || this.timer) return;
    const d = [3000, 6000, 15000, 30000, 60000][Math.min(this.attempt++, 4)];
    this.emit('toast', { type: 'info', text: `Reconnecting in ${d / 1000}s…` });
    this.timer = setTimeout(() => { this.timer = null; if (this.want) this.open(); }, d);
  }
  async onMessage(buf) {
    const raw = buf.toString();
    if (!raw) return;
    const parsed = JSON.parse(raw);
    const records = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.messages) ? parsed.messages : [parsed]);
    const visit = async rec => {
      if (!rec || typeof rec !== 'object') return;
      const type = String(rec.type || rec.eventType || rec.event_type || rec.method || '').trim();
      const data = rec.data && typeof rec.data === 'object' ? rec.data : rec;
      const nt = String(data.type || data.eventType || data.event_type || data.method || '').trim();
      const t = nt || type;
      const d = data.data && typeof data.data === 'object' ? data.data : data;
      if (/WebcastGiftMessage|gift/i.test(t)) await this.onGift(d);
      else if (/WebcastChatMessage|chat|comment/i.test(t)) this.onChat(d);
      else if (/error|fail/i.test(t) && (d.message || d.error)) this.emit('toast', { type: 'error', text: String(d.message || d.error) });
      if (Array.isArray(d.messages)) for (const c of d.messages) await visit(c);
    };
    for (const r of records) await visit(r);
  }
  keyOf(u) { return u.userId || u.uniqueId.toLowerCase() || u.nickname.toLowerCase(); }
  onChat(d) {
    const u = normalizeUser(d.user || d.userInfo || d.sender || d.fromUser || {});
    const text = String(d.content ?? d.comment ?? d.message ?? d.text ?? '').trim();
    if (!text) return;
    const k = this.keyOf(u);
    if (!k) return;
    this.lastChat.set(k, text);
    if (u.uniqueId) this.lastChat.set(u.uniqueId.toLowerCase(), text);
    if (this.lastChat.size > 4000) this.lastChat.delete(this.lastChat.keys().next().value);
    this.emit('chat', { userId: u.userId, uniqueId: u.uniqueId, nickname: u.nickname, text });
  }
  async onGift(d) {
    const m = normalizeGift(d);
    if (!m.giftId) return;
    if (m.msgId != null) {
      const k = String(m.msgId);
      if (this.seen.has(k)) return;
      this.seen.set(k, Date.now());
      if (this.seen.size > 5000) for (const [kk, v] of this.seen) { if (Date.now() - v > 60000) this.seen.delete(kk); }
    }
    // Catalog = canonical name / coin / image
    const cat = await fetchGiftCatalog(m.giftId, this.key);
    const per = (cat && cat.coins) || m.coinValue;
    const name = (cat && cat.name) || m.giftName || 'TikTok Gift';
    let image = '';
    try { image = (await findStreamToEarnGift(name, per))?.imageUrl || ''; } catch {}
    if (!image) image = (cat && cat.image) || m.giftImage || '';
    const imageFallback = (cat && cat.image) || m.giftImage || '';
    if (per <= 0) { this.emit('toast', { type: 'warn', text: `Gift "${name}" ignored: incomplete coin value.` }); return; }

    let u = m.user;
    const uk = this.keyOf(u);
    if (!uk) return;
    // combo (giftType 1): one combo = one comboId. Server sends the cumulative TOTAL,
    // client updates the same card (no new card on every tick).
    let qty = m.count, comboId = null;
    if (m.giftType === 1) {
      const bk = `${uk}:${m.giftId}`;
      const now = Date.now();
      const st = this.streak.get(bk);
      const alive = st && !st.ended && now - st.t <= 12000;
      if (alive && m.count >= st.c) {
        if (m.count === st.c) { if (m.repeatEnd) st.ended = true; return; }   // duplikat / event penutup
        st.c = m.count; st.t = now; if (m.repeatEnd) st.ended = true;
        comboId = st.id;
      } else {                                                                  // combo baru
        const ns = { id: `${bk}:${now.toString(36)}`, c: m.count, t: now, ended: m.repeatEnd };
        this.streak.set(bk, ns); comboId = ns.id;
      }
      if (this.streak.size > 2000) for (const [k, v] of this.streak) if (now - v.t > 15000) this.streak.delete(k);
    }
    if (!u.avatar) u = { ...u, avatar: await fetchUserAvatar(u.uniqueId || u.nickname, this.key) };
    this.emit('gift', {
      id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
      userId: u.userId, uniqueId: u.uniqueId, nickname: u.nickname || u.uniqueId || 'Unknown',
      avatar: u.avatar, giftId: m.giftId, giftName: name,
      giftImage: image ? '/api/img?u=' + encodeURIComponent(image) : '',
      giftImageAlt: imageFallback && imageFallback !== image ? '/api/img?u=' + encodeURIComponent(imageFallback) : '',
      unitCoins: per, quantity: qty, coins: per * qty, comboId,
      chat: this.lastChat.get(uk) || this.lastChat.get(u.uniqueId.toLowerCase()) || '',
      at: Date.now()
    });
  }
}

io.on('connection', socket => {
  if (sessions.size >= MAX_SESSIONS) { socket.emit('toast', { type: 'error', text: 'Server is full, please try again later.' }); socket.disconnect(true); return; }
  const s = new Session(socket);
  sessions.set(socket.id, s);
  socket.on('connect:live', p => s.connect(p?.key, p?.username));
  socket.on('disconnect:live', () => { s.stop(); s.status('disconnected', 'Disconnected.'); });
  socket.on('disconnect', () => { s.stop(); sessions.delete(socket.id); });
});

server.listen(PORT, HOST, () => console.log(`Server running on http://${HOST}:${PORT}`));
