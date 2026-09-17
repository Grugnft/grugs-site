/**
 * NFT Trencher proxy — merged drops + changes.
 *
 * Replaces the old /api/nft-drops and /api/nft-changes so we stay under
 * Vercel's Hobby function limit. Same upstream (neverfuckingtrade.com),
 * same auth key (NFT_API_TOKEN), same rate-limit budget — one file now
 * dispatches on `?mode=drops|changes`.
 *
 * DROPS mode (default):
 *   /api/trencher?mode=drops                → upcoming RHC drops (limit 20)
 *   /api/trencher?limit=50&includeDust=1
 *   /api/trencher?debug=1                   → include raw upstream sample
 *
 * CHANGES mode:
 *   /api/trencher?mode=changes&since=<iso|unix-seconds|unix-ms>
 *
 * Upstream: https://neverfuckingtrade.com/api/v1
 * Auth: X-API-Key (with Bearer fallback), NFT_API_TOKEN in env.
 *
 * Rate limits (docs): 120 req/min per key, board rebuilds ~40s. Cached
 * server-side: 5 min for drops (their guidance = 1/min max), 60 s for
 * changes (meant to be polled fresh).
 *
 * If NFT_API_TOKEN isn't set: returns { configured: false, mints/changed: [] }
 * so the mints page gracefully skips this source.
 */

const NFT_BASE     = process.env.NFT_API_BASE            || 'https://neverfuckingtrade.com/api/v1';
const NFT_MINTS    = process.env.NFT_API_MINTS_PATH      || '/mints';
const NFT_CHANGES  = process.env.NFT_API_CHANGES_PATH    || '/changes';
const RHC_PARAM    = 'robinhood';

const TIMEOUT_MS   = 8000;
const TTL_DROPS    = 5 * 60 * 1000;  // 5 min on success
const TTL_CHANGES  = 60 * 1000;      // 60 s — changes are poll-fresh

// Two caches so drops/changes never collide. Keeping the keys separate also
// makes it possible to bust one without the other during ops incidents.
const dropsCache   = (globalThis.__grugTrencherDropsCache   ||= new Map());
const changesCache = (globalThis.__grugTrencherChangesCache ||= new Map());

async function fetchOnce(url, token) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      signal: ac.signal,
      headers: {
        // NFT Trencher accepts either header. If a proxy strips the custom
        // one we fall through to Bearer.
        'x-api-key':     token,
        'authorization': 'Bearer ' + token,
        'accept':        'application/json',
        'user-agent':    'GrugsRugRadar/1.0 (+https://grugnft.xyz)',
      },
    });
    clearTimeout(t);
    const retryAfter = r.headers.get('retry-after');
    if (!r.ok) return { value: null, status: r.status, retryAfter };
    const ct = r.headers.get('content-type') || '';
    if (!/json/i.test(ct)) return { value: null, status: r.status };
    return { value: await r.json(), status: r.status };
  } catch (e) {
    clearTimeout(t);
    return { value: null, status: 0 };
  }
}

async function fetchWithRetry(url, token) {
  let r = await fetchOnce(url, token);
  const flaky = x => x.value === null && (x.status === 0 || x.status >= 500);
  if (flaky(r)) {
    await new Promise(res => setTimeout(res, 500));
    r = await fetchOnce(url, token);
  }
  if (flaky(r)) {
    await new Promise(res => setTimeout(res, 1200));
    r = await fetchOnce(url, token);
  }
  return r;
}

// ---------------------------------------------------------------- drops ----

function normalizeDrop(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.chain !== 'robinhood') return null;

  const links = raw.links || {};
  const stages = Array.isArray(raw.stages) ? raw.stages : [];
  const upcoming = stages
    .filter(s => s.state === 'upcoming' && s.start)
    .sort((a, b) => new Date(a.start) - new Date(b.start));
  const preferred =
    (raw.next_stage && raw.next_stage.open_to_visitors !== false) ? raw.next_stage :
    upcoming.find(s => s.open_to_visitors !== false) ||
    raw.active_stage ||
    upcoming[0] ||
    null;

  const mintStart = preferred?.start || null;
  let priceLabel = 'TBA';
  if (preferred && preferred.price != null) {
    priceLabel = preferred.price === 0
      ? 'FREE'
      : `${preferred.price} ${preferred.currency || 'ETH'}`;
  }

  return {
    source: 'nft-drops',
    id: raw.id || null,
    name: raw.name || 'Untitled drop',
    symbol: raw.symbol || '',
    slug: raw.slug || null,
    contract: raw.contract ? String(raw.contract).toLowerCase() : '',
    chain: 'RHC',
    mintStart,
    priceLabel,
    supply: raw.supply ?? null,
    minted: raw.minted ?? null,
    tagline: '',
    image: null,
    twitter: links.x || links.twitter || null,
    website: links.site || null,
    opensea: links.opensea || null,
    mintUrl: links.mint || null,
    discord: null,
    status: raw.status || null,
    tier: raw.tier || null,
    flags: Array.isArray(raw.flags) ? raw.flags : [],
    stageKind: preferred?.kind || null,
    stageLabel: preferred?.label || null,
    maxPerWallet: preferred?.max_per_wallet ?? null,
    updatedAt: raw.updated_at || null,
  };
}

async function handleDrops(q, token, res) {
  const limit = Math.min(Math.max(parseInt(q.limit || '20', 10), 1), 100);
  const includeDust = q.includeDust === '1' || q.includeDust === 'true';
  const cacheKey = `limit=${limit}&dust=${includeDust ? 1 : 0}`;
  const now = Date.now();
  const hit = dropsCache.get(cacheKey);
  if (hit && hit.expiresAt > now && !q.debug) {
    res.setHeader('cache-control', 'public, max-age=60, s-maxage=300');
    res.statusCode = 200;
    res.end(JSON.stringify({ configured: true, cached: true, ...hit.value }));
    return;
  }

  const url = `${NFT_BASE}${NFT_MINTS}?chain=${encodeURIComponent(RHC_PARAM)}&status=upcoming`;
  const r = await fetchWithRetry(url, token);
  if (!r.value) {
    if (r.status === 401) {
      res.statusCode = 200;
      res.end(JSON.stringify({
        configured: true, error: 'auth_failed', status: r.status,
        hint: 'NFT_API_TOKEN was rejected. Either the key was revoked, or the Cassette left the signed wallet.',
        mints: [],
      }));
      return;
    }
    if (r.status === 429) {
      res.setHeader('cache-control', 'public, max-age=15');
      res.statusCode = 200;
      res.end(JSON.stringify({ configured: true, error: 'rate_limited', status: 429, retryAfter: r.retryAfter || '5', mints: [] }));
      return;
    }
    res.setHeader('cache-control', 'public, max-age=30');
    res.statusCode = 200;
    res.end(JSON.stringify({ configured: true, error: 'upstream_unreachable', status: r.status, mints: [] }));
    return;
  }

  const items = Array.isArray(r.value.mints) ? r.value.mints
              : Array.isArray(r.value)        ? r.value
              : [];
  let mints = items.map(normalizeDrop).filter(m => m && m.name);
  if (!includeDust) mints = mints.filter(m => m.tier !== 'dust');
  mints = mints.slice(0, limit);

  const payload = { count: mints.length, built: r.value.built || null, mints };
  dropsCache.set(cacheKey, { value: payload, expiresAt: now + TTL_DROPS });
  res.setHeader('cache-control', 'public, max-age=60, s-maxage=300');
  res.statusCode = 200;
  if (q.debug) {
    res.end(JSON.stringify({ configured: true, cached: false, raw: items.slice(0, 3), ...payload }, null, 2));
    return;
  }
  res.end(JSON.stringify({ configured: true, cached: false, ...payload }));
}

// -------------------------------------------------------------- changes ----

async function handleChanges(q, token, res) {
  const since = q.since || '';
  const cacheKey = `since=${since}`;
  const now = Date.now();
  const hit = changesCache.get(cacheKey);
  if (hit && hit.expiresAt > now) {
    res.setHeader('cache-control', 'public, max-age=30');
    res.statusCode = 200;
    res.end(JSON.stringify({ configured: true, cached: true, ...hit.value }));
    return;
  }

  const params = new URLSearchParams({ chain: 'robinhood' });
  if (since) params.set('since', since);
  const url = `${NFT_BASE}${NFT_CHANGES}?${params.toString()}`;
  const r = await fetchWithRetry(url, token);

  if (!r.value) {
    if (r.status === 401) {
      res.statusCode = 200;
      res.end(JSON.stringify({ configured: true, error: 'auth_failed', status: r.status, changed: [], removed: [] }));
      return;
    }
    res.setHeader('cache-control', 'public, max-age=30');
    res.statusCode = 200;
    res.end(JSON.stringify({ configured: true, error: 'upstream_unreachable', status: r.status, changed: [], removed: [] }));
    return;
  }

  const changed = Array.isArray(r.value.changed) ? r.value.changed : [];
  const removed = Array.isArray(r.value.removed) ? r.value.removed : [];
  const payload = {
    built: r.value.built || null,
    since: r.value.since || since || null,
    changedIds: changed.map(m => ({
      id: m.id || null,
      contract: m.contract ? String(m.contract).toLowerCase() : null,
      chain: m.chain || null,
      name: m.name || null,
      updatedAt: m.updated_at || null,
    })).filter(x => x.contract),
    removedIds: removed.map(r => r.id).filter(Boolean),
    changedCount: changed.length,
    removedCount: removed.length,
  };

  changesCache.set(cacheKey, { value: payload, expiresAt: now + TTL_CHANGES });
  res.setHeader('cache-control', 'public, max-age=30, s-maxage=60');
  res.statusCode = 200;
  res.end(JSON.stringify({ configured: true, cached: false, ...payload }));
}

// ---------------------------------------------------------------- entry ----

export default async function handler(req, res) {
  const q = req.query || Object.fromEntries(new URL(req.url, 'http://x/').searchParams.entries());
  const mode = (q.mode || 'drops').toLowerCase();

  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('content-type', 'application/json');

  const token = process.env.NFT_API_TOKEN;
  if (!token) {
    // Graceful "not wired up" shape — different keys for drops vs changes
    // so the client can render whichever it expected.
    res.statusCode = 200;
    if (mode === 'changes') {
      res.end(JSON.stringify({ configured: false, changed: [], removed: [] }));
    } else {
      res.end(JSON.stringify({
        configured: false,
        hint: 'Set NFT_API_TOKEN in .env with your NFT Trencher key.',
        mints: [],
      }));
    }
    return;
  }

  if (mode === 'changes') return handleChanges(q, token, res);
  return handleDrops(q, token, res);
}
