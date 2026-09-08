/**
 * NFT Trencher API — Never Fucking Trade upcoming-drops feed.
 *
 * API: https://neverfuckingtrade.com/api/v1
 * Auth: X-API-Key header (Cassette NFT holders only — key from
 *       neverfuckingtrade.com profile → Alerts & links → MAKE KEY).
 *       If the Cassette leaves the signed wallet, the key goes dark
 *       within ten minutes and returns 401.
 *
 * Rate limits:
 *   - 120 req/min per key (bursts of 30/sec ok)
 *   - Board rebuilds ~40s; responses cached 15s server-side
 *   - Polling faster than 1/min buys nothing → our TTL_OK is 5min
 *
 * Query:
 *   /api/nft-drops              → upcoming RHC drops (default limit 20)
 *   /api/nft-drops?limit=50
 *   /api/nft-drops?includeDust=1 → include tier=dust (folded by default)
 *   /api/nft-drops?debug=1      → include raw upstream payload
 *
 * Requires NFT_API_TOKEN in the environment. Without it, returns
 * { configured: false, mints: [] } so the mints page gracefully skips
 * this source instead of erroring.
 */

// Two hosts serve the same data. Site host goes through the edge; cdn host
// is the origin. Prefer the site host so we hit their cache layer.
const NFT_BASE     = process.env.NFT_API_BASE || 'https://neverfuckingtrade.com/api/v1';
const NFT_MINTS    = process.env.NFT_API_MINTS_PATH || '/mints';
const RHC_PARAM    = 'robinhood';   // their chain slug for RHC

const TIMEOUT_MS = 8000;
const TTL_OK        = 5 * 60 * 1000;   // 5min on success (respect their "1/min max" guidance)
const TTL_TRANSIENT = 30 * 1000;       // 30s on flaky failure

const cache = (globalThis.__grugNftDropsCache ||= new Map());

async function fetchOnce(url, token) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      signal: ac.signal,
      headers: {
        // NFT Trencher accepts either header — X-API-Key is their documented
        // primary. If a proxy strips custom headers we fall back to Bearer.
        'x-api-key':     token,
        'authorization': 'Bearer ' + token,
        'accept':        'application/json',
        'user-agent':    'GrugsRugRadar/1.0 (+https://grugnft.xyz)',
      },
    });
    clearTimeout(t);
    // Capture Retry-After on 429 so the caller can back off honestly.
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

// Convert an NFT Trencher mint object into the shape the mints page expects.
// Their response is well-typed — much less guessing than the earlier scaffold.
//
// Mint start time comes from next_stage (the first stage ahead) when present,
// else the earliest upcoming stage in the stages array. Price uses the same
// stage. We prefer stages open to visitors so we don't advertise dev/team-only
// windows the user can't enter.
function normalize(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.chain !== 'robinhood') return null; // hard filter — RHC only

  const links = raw.links || {};

  // Pick the stage to advertise: next_stage first, else the earliest upcoming
  // stage that's open to visitors. Fall back to any upcoming stage if only
  // gated-team stages remain (rare).
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

  // Price label: their price is a native-coin float. `null` means unknown,
  // `0` means free. Show currency alongside so ETH vs $HOOD is unambiguous.
  let priceLabel = 'TBA';
  if (preferred && preferred.price != null) {
    priceLabel = preferred.price === 0
      ? 'FREE'
      : `${preferred.price} ${preferred.currency || 'ETH'}`;
  }

  // Twitter link comes as a full URL, no @-stripping needed.
  const twitter = links.x || links.twitter || null;

  return {
    source: 'nft-drops',
    id: raw.id || null,                   // "robinhood:0x…"
    name: raw.name || 'Untitled drop',
    symbol: raw.symbol || '',
    slug: raw.slug || null,
    contract: raw.contract ? String(raw.contract).toLowerCase() : '',
    chain: 'RHC',
    mintStart,
    priceLabel,
    supply: raw.supply ?? null,
    minted: raw.minted ?? null,
    tagline: '',                          // API doesn't ship descriptions
    image: null,                          // API doesn't ship images either — the mint card handles null
    twitter,
    website: links.site || null,
    opensea: links.opensea || null,
    mintUrl: links.mint || null,
    discord: null,                        // not in this API
    // Trencher-specific extras — useful for the "why is it upcoming" chip
    status: raw.status || null,           // upcoming | live | sold_out | ended
    tier: raw.tier || null,               // hot | warm | cold | dust
    flags: Array.isArray(raw.flags) ? raw.flags : [],
    stageKind: preferred?.kind || null,   // public | gtd | fcfs | wl | og | holder | raffle | team | other
    stageLabel: preferred?.label || null,
    maxPerWallet: preferred?.max_per_wallet ?? null,
    updatedAt: raw.updated_at || null,
  };
}

export default async function handler(req, res) {
  const q = req.query || Object.fromEntries(new URL(req.url, 'http://x/').searchParams.entries());
  const limit = Math.min(Math.max(parseInt(q.limit || '20', 10), 1), 100);
  const includeDust = q.includeDust === '1' || q.includeDust === 'true';

  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('content-type', 'application/json');

  const token = process.env.NFT_API_TOKEN;
  if (!token) {
    // No key set — return a graceful "not wired up yet" response so the mints
    // page can render its other sources without a red error.
    res.statusCode = 200;
    res.end(JSON.stringify({
      configured: false,
      hint: 'Set NFT_API_TOKEN in .env with your NFT Trencher key (Cassette profile → Alerts & links → MAKE KEY).',
      mints: [],
    }));
    return;
  }

  const cacheKey = `limit=${limit}&dust=${includeDust ? 1 : 0}`;
  const now = Date.now();
  const hit = cache.get(cacheKey);
  if (hit && hit.expiresAt > now && !q.debug) {
    res.setHeader('cache-control', 'public, max-age=60, s-maxage=300');
    res.statusCode = 200;
    res.end(JSON.stringify({ configured: true, cached: true, ...hit.value }));
    return;
  }

  // Ask for upcoming RHC mints only. Their board rebuilds every ~40s so the
  // "upcoming" filter is authoritative at that instant.
  const url = `${NFT_BASE}${NFT_MINTS}?chain=${encodeURIComponent(RHC_PARAM)}&status=upcoming`;
  const r = await fetchWithRetry(url, token);

  if (!r.value) {
    if (r.status === 401) {
      res.statusCode = 200;
      res.end(JSON.stringify({
        configured: true,
        error: 'auth_failed',
        status: r.status,
        hint: 'NFT_API_TOKEN was rejected. Either the key was revoked, or the Cassette left the signed wallet (their check runs every ~10 min).',
        mints: [],
      }));
      return;
    }
    if (r.status === 429) {
      // Rate-limited. Their docs say Retry-After: 5 typically — we still
      // hard-fail so the mints page falls through to other sources.
      res.setHeader('cache-control', 'public, max-age=15');
      res.statusCode = 200;
      res.end(JSON.stringify({
        configured: true,
        error: 'rate_limited',
        status: 429,
        retryAfter: r.retryAfter || '5',
        mints: [],
      }));
      return;
    }
    // Transient upstream flake — short cache-control so we retry soon.
    res.setHeader('cache-control', 'public, max-age=30');
    res.statusCode = 200;
    res.end(JSON.stringify({
      configured: true,
      error: 'upstream_unreachable',
      status: r.status,
      mints: [],
    }));
    return;
  }

  // Response shape is documented: { v, built, count, mints: [...] }
  const items = Array.isArray(r.value.mints) ? r.value.mints
              : Array.isArray(r.value)        ? r.value
              : [];

  let mints = items.map(normalize).filter(m => m && m.name);
  // Fold `dust` tier by default — matches the board's own behavior.
  if (!includeDust) mints = mints.filter(m => m.tier !== 'dust');
  mints = mints.slice(0, limit);

  const payload = {
    count: mints.length,
    built: r.value.built || null,
    mints,
  };
  cache.set(cacheKey, { value: payload, expiresAt: now + TTL_OK });
  res.setHeader('cache-control', 'public, max-age=60, s-maxage=300');
  res.statusCode = 200;

  if (q.debug) {
    res.end(JSON.stringify({
      configured: true,
      cached: false,
      raw: items.slice(0, 3),   // first three upstream items for shape-checking
      ...payload,
    }, null, 2));
    return;
  }
  res.end(JSON.stringify({ configured: true, cached: false, ...payload }));
}
