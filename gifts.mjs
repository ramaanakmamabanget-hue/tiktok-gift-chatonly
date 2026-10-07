// Gift artwork resolver ported from reference ZIP (StreamToEarn catalog + TikTok CDN fetch)
const STREAMTOEARN_GIFTS_URL = 'https://streamtoearn.io/gifts';
let streamToEarnCatalogCache = { loadedAt: 0, entries: [], byName: new Map() };
let streamToEarnCatalogPromise = null;
const streamToEarnImageCache = new Map();

function decodeHtmlEntities(value = '') {
  return String(value)
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#x2F;/gi, '/')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

function normalizeGiftName(value = '') {
  return decodeHtmlEntities(String(value))
    .replace(/\s*tiktok\s+gift\s*$/i, '')
    .replace(/[’‘]/g, "'")
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function absoluteGiftImageUrl(value) {
  const raw = decodeHtmlEntities(String(value || '').trim());
  if (!raw) return '';
  try {
    const url = new URL(raw, STREAMTOEARN_GIFTS_URL);
    if (!/^https?:$/i.test(url.protocol)) return '';
    if (!/tiktokcdn\.com$/i.test(url.hostname) && !/\.tiktokcdn\.com$/i.test(url.hostname)) return '';
    return url.toString();
  } catch {
    return '';
  }
}

function normalizeCatalogAlt(value) {
  return decodeHtmlEntities(String(value || ''))
    .replace(/^\s*image:\s*/i, '')
    .replace(/\s*tiktok\s+gift\s*$/i, '')
    .trim();
}

function attrFromTag(tag, attr) {
  const re = new RegExp(`\\b${attr}\\s*=\\s*["']([^"']+)["']`, 'i');
  return re.exec(tag)?.[1] || '';
}

function firstTikTokUrl(value) {
  const raw = decodeHtmlEntities(String(value || ''));
  if (!raw) return '';
  const bits = raw.split(',').map(x => x.trim().split(/\s+/)[0]).filter(Boolean);
  for (const bit of bits) {
    const direct = absoluteGiftImageUrl(bit);
    if (direct) return direct;
  }
  return '';
}

function parseStreamToEarnCatalogHtml(html) {
  const byName = new Map();
  const source = String(html || '');
  const imgTagRe = /<img\b[^>]*>/gi;
  const matches = [...source.matchAll(imgTagRe)];

  for (let i = 0; i < matches.length; i += 1) {
    const tag = matches[i][0];
    const start = matches[i].index || 0;
    const nextStart = i + 1 < matches.length ? (matches[i + 1].index || source.length) : source.length;
    const afterBlock = source.slice(start, Math.min(nextStart, start + 4000));
    const beforeBlock = source.slice(Math.max(0, start - 1600), start + tag.length);

    const altRaw = attrFromTag(tag, 'alt');
    const name = normalizeCatalogAlt(altRaw);
    if (!name) continue;

    let imageUrl =
      firstTikTokUrl(attrFromTag(tag, 'src')) ||
      firstTikTokUrl(attrFromTag(tag, 'data-src')) ||
      firstTikTokUrl(attrFromTag(tag, 'data-lazy-src')) ||
      firstTikTokUrl(attrFromTag(tag, 'srcset')) ||
      firstTikTokUrl(attrFromTag(tag, 'data-srcset'));

    if (!imageUrl) {
      const anchorHref = /<a\b[^>]*?href=["']([^"']*tiktokcdn\.com[^"']*)["'][^>]*>[\s\S]*?<img\b/i.exec(beforeBlock + afterBlock)?.[1];
      imageUrl = firstTikTokUrl(anchorHref);
    }
    if (!imageUrl) continue;

    const text = `${beforeBlock} ${afterBlock}`
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/\s+/g, ' ')
      .trim();
    const priceMatch = text.match(/\b(\d{1,6})\s+Image\b/i);
    const coins = priceMatch ? Number(priceMatch[1]) : 0;
    addStreamToEarnGiftEntry(byName, name, imageUrl, coins);
  }

  return byName;
}

function addStreamToEarnGiftEntry(entriesByName, name, imageUrl, coins = 0) {
  const cleanName = normalizeCatalogAlt(name);
  const image = absoluteGiftImageUrl(imageUrl);
  if (!cleanName || !image) return;
  const key = normalizeGiftName(cleanName);
  if (!key) return;
  const list = entriesByName.get(key) || [];
  if (!list.some(item => item.imageUrl === image && Number(item.coins) === Number(coins || 0))) {
    list.push({ name: cleanName, imageUrl: image, coins: Number(coins) || 0 });
  }
  entriesByName.set(key, list);
}

function extractCoinsNearGift(html, start, end) {
  const block = String(html).slice(start, Math.min(html.length, end));
  const text = block
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
  const match = text.match(/\b(\d{1,6})\s+Image\b/i);
  return match ? Number(match[1]) : 0;
}

async function fetchStreamToEarnCatalogPage(url) {
  const res = await fetch(url, {
    headers: {
      'user-agent': 'Mozilla/5.0 (compatible; TikTok-Gift-Priority-Overlay/2.4.4)',
      'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9',
      'referer': 'https://streamtoearn.io/'
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) throw new Error(`StreamToEarn catalog HTTP ${res.status}`);
  return res.text();
}

async function refreshStreamToEarnCatalog({ force = false } = {}) {
  const fresh = Date.now() - streamToEarnCatalogCache.loadedAt < 6 * 60 * 60 * 1000;
  if (!force && fresh && streamToEarnCatalogCache.entries.length) return streamToEarnCatalogCache;
  if (streamToEarnCatalogPromise) return streamToEarnCatalogPromise;

  streamToEarnCatalogPromise = (async () => {
    try {
      const urls = [
        'https://streamtoearn.io/gifts?region=ID',
        'https://streamtoearn.io/gifts'
      ];
      const byName = new Map();
      for (const url of urls) {
        try {
          const html = await fetchStreamToEarnCatalogPage(url);
          const parsed = parseStreamToEarnCatalogHtml(html);
          for (const [key, items] of parsed.entries()) {
            const list = byName.get(key) || [];
            for (const item of items) {
              if (!list.some(existing => existing.imageUrl === item.imageUrl && Number(existing.coins) === Number(item.coins))) {
                list.push(item);
              }
            }
            byName.set(key, list);
          }
        } catch {
          // Try the next catalog source.
        }
      }

      const entries = [];
      for (const [normalizedName, items] of byName.entries()) {
        for (const item of items) entries.push({ normalizedName, ...item });
      }
      if (entries.length) streamToEarnCatalogCache = { loadedAt: Date.now(), entries, byName };
      return streamToEarnCatalogCache;
    } catch {
      return streamToEarnCatalogCache;
    } finally {
      streamToEarnCatalogPromise = null;
    }
  })();

  return streamToEarnCatalogPromise;
}

async function findStreamToEarnGift(giftName, coinValue = 0) {
  const key = normalizeGiftName(giftName);
  if (!key) return null;
  const catalog = await refreshStreamToEarnCatalog();
  const candidates = catalog.byName.get(key) || [];
  if (!candidates.length) return null;
  if (Number(coinValue) > 0) {
    const exact = candidates.find(item => Number(item.coins) === Number(coinValue));
    if (exact) return exact;
  }
  return candidates[0];
}

async function fetchStreamToEarnImageBuffer(imageUrl) {
  const url = absoluteGiftImageUrl(imageUrl);
  if (!url) return null;
  const cached = streamToEarnImageCache.get(url);
  if (cached && Date.now() - cached.cachedAt < 24 * 60 * 60 * 1000) return cached;

  const candidates = [url];
  try {
    const u = new URL(url);
    if (u.hostname.startsWith('p16-')) {
      candidates.push(url.replace(u.hostname, u.hostname.replace(/^p16-/, 'p19-')));
    }
  } catch {}

  for (const candidate of candidates) {
    try {
      const res = await fetch(candidate, {
        headers: {
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/145.0 Safari/537.36',
          'referer': 'https://streamtoearn.io/gifts',
          'origin': 'https://streamtoearn.io',
          'accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8'
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(12000)
      });
      if (!res.ok) continue;
      const contentType = res.headers.get('content-type') || 'image/webp';
      if (!/^image\//i.test(contentType)) continue;
      const buffer = Buffer.from(await res.arrayBuffer());
      if (!buffer.length) continue;
      const item = { buffer, contentType, cachedAt: Date.now() };
      streamToEarnImageCache.set(url, item);
      return item;
    } catch {}
  }

  // Last-resort server-side fetch through a public image relay. This keeps the
  // actual TikTok gift artwork the same while avoiding CDN hotlink failures.
  try {
    const relay = `https://wsrv.nl/?url=${encodeURIComponent(url)}`;
    const res = await fetch(relay, {
      headers: { 'user-agent': 'Mozilla/5.0', 'accept': 'image/avif,image/webp,image/*,*/*;q=0.8' },
      redirect: 'follow',
      signal: AbortSignal.timeout(15000)
    });
    if (res.ok) {
      const contentType = res.headers.get('content-type') || 'image/webp';
      if (/^image\//i.test(contentType)) {
        const buffer = Buffer.from(await res.arrayBuffer());
        if (buffer.length) {
          const item = { buffer, contentType, cachedAt: Date.now() };
          streamToEarnImageCache.set(url, item);
          return item;
        }
      }
    }
  } catch {}
  return null;
}


export { refreshStreamToEarnCatalog, findStreamToEarnGift, fetchStreamToEarnImageBuffer, absoluteGiftImageUrl };
