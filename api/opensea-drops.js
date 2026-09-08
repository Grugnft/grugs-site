/**
 * OpenSea drops proxy — pulls the upcoming/live/recent NFT drops on
 * Robinhood Chain and normalizes them to the shape mints.html expects.
 *
 * Query:
 *   /api/opensea-drops                    → upcoming (default)
 *   /api/opensea-drops?by_type=live       → live now
 *   /api/opensea-drops?by_type=recently_minted
 *
 * Requires an OPENSEA_API_KEY env var. Get one free at:
 *   https://docs.opensea.io/reference/api-keys
 *
 * On Vercel: add OPENSEA_API_KEY in Project Settings → Environment Variables.
 * Locally: create a `.env` file at the repo root with:
 *   OPENSEA_API_KEY=your_key_here
 * and start the dev server with `node --env-file=.env scripts/dev-server.mjs`
 * (or export it in your shell before starting the server).
 *
 * If the key is missing, this endpoint returns a 200 with { configured: false,
 * mints: [] } so the mints page can render cleanly without hard-failing.
 */

const OPENSEA_BASE = 'https://api.opensea.io';
const RHC_CHAIN_SLUG = 'robinhood_chain'; // OpenSea's chain identifier; if this
                                          // returns empty, try 'robinhood' — the
                                          // marketing slug — as a fallback.
const CHAIN_FALLBACKS = ['robinhood_chain', 'robinhood'];
const TIMEOUT_MS = 8000;
const CACHE_TTL = 5 * 60 * 1000; // 5min

const cache = (globalThis.__grugOsCache ||= new Map());

async function osFetch(path, apiKey) {
  const url = OPENSEA_BASE + path;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      signal: ac.signal,
      headers: {
        'x-api-key': apiKey,
        'accept': 'application/json',
        'user-agent': 'GrugsRugRadar/1.0 (+https://grugnft.xyz)',
      },
    });
    clearTimeout(t);
    if (!r.ok) return { ok: false, status: r.status, error: await r.text().catch(() => '') };
    return { ok: true, json: await r.json() };
  } catch (e) {
    clearTimeout(t);
    return { ok: false, error: e.name || 'error' };
  }
}

/* Actual OpenSea v2 /drops payload shape (observed 2026-09):
   {
     drops: [
       {
         collection_slug, collection_name, chain,
         contract_address, drop_type, is_minting,
         image_url, opensea_url,
         active_stage: { stage_type, label, price (wei string),
                         start_time, end_time, max_per_wallet },
         next_stage: null | { … same shape … },
       }, …
     ]
   }
   NOTE: the ?chain= query param on /drops is currently ignored by OpenSea's API —
   the endpoint returns a mixed-chain default list of 4 items regardless. We must
   filter client-side by d.chain to keep just RHC drops.
   Twitter/Discord/website are NOT on the drops endpoint — a separate call to
   /api/v2/collections/{slug} is needed to enrich those. Deferred to avoid N+1
   per page load; the openseaUrl link lets users jump through in one click.
*/
function pickStage(d) {
  // Prefer the currently-active stage.
  if (d.active_stage) return d.active_stage;
  // Otherwise, from the full stages array, pick the earliest future stage;
  // if all are past, pick the most recent past stage (so past-mints render
  // with real dates on the mints page instead of "TBA").
  const stages = Array.isArray(d.stages) ? d.stages.filter(s => s && s.start_time) : [];
  if (!stages.length) return d.next_stage || {};
  const now = Date.now();
  const future = stages
    .filter(s => new Date(s.start_time).getTime() > now)
    .sort((a, b) => new Date(a.start_time) - new Date(b.start_time));
  if (future.length) return future[0];
  const past = stages
    .filter(s => new Date(s.start_time).getTime() <= now)
    .sort((a, b) => new Date(b.start_time) - new Date(a.start_time));
  return past[0] || d.next_stage || {};
}

function normalizeDrop(d) {
  const stage = pickStage(d);
  let priceLabel = '—';
  try {
    const wei = stage.price ? BigInt(stage.price) : 0n;
    if (wei > 0n) {
      const eth = Number(wei) / 1e18;
      priceLabel = eth < 0.001 ? `${eth.toFixed(5)} ETH` : `${eth.toFixed(3)} ETH`;
    } else if (stage.max_per_wallet) {
      priceLabel = `free · ${stage.max_per_wallet}/wallet`;
    } else if (stage.price === '0') {
      priceLabel = 'free';
    }
  } catch (e) {}

  return {
    source: 'opensea',
    name: d.collection_name || d.collection_slug || 'Untitled drop',
    symbol: '',
    contract: d.contract_address || '',
    chain: d.chain === 'robinhood' ? 'RHC' : (d.chain || 'unknown'),
    mintStart: stage.start_time || null,
    mintEnd:   stage.end_time || null,
    priceLabel,
    supply: null,
    twitter: null,
    website: null,
    discord: null,
    image: d.image_url || null,
    tagline: d.is_minting ? 'Minting now.' : (stage.label ? `${stage.label}.` : ''),
    openseaSlug: d.collection_slug || null,
    openseaUrl: d.opensea_url || null,
    isMinting: !!d.is_minting,
  };
}

export default async function handler(req, res) {
  const q = req.query || Object.fromEntries(new URL(req.url, 'http://x/').searchParams.entries());
  const byType = (q.by_type || 'upcoming').toLowerCase();
  const validTypes = ['upcoming', 'live', 'recently_minted', 'featured'];
  const type = validTypes.includes(byType) ? byType : 'upcoming';

  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('content-type', 'application/json');
  res.setHeader('cache-control', 'public, max-age=300, s-maxage=300');

  const apiKey = process.env.OPENSEA_API_KEY;
  if (!apiKey) {
    // Not an error — just tell the client the integration isn't wired yet.
    res.statusCode = 200;
    res.end(JSON.stringify({
      configured: false,
      hint: 'Set OPENSEA_API_KEY in your env to enable OpenSea auto-fetch. Free key at docs.opensea.io/reference/api-keys',
      mints: [],
    }));
    return;
  }

  const cacheKey = `${type}`;
  const now = Date.now();
  const hit = cache.get(cacheKey);
  if (hit && hit.expiresAt > now && !q.debug) {
    res.statusCode = 200;
    res.end(JSON.stringify({ configured: true, cached: true, ...hit.value }));
    return;
  }

  // Try each chain slug; keep the one that gives us anything
  let picked = null;
  for (const slug of CHAIN_FALLBACKS) {
    const r = await osFetch(`/api/v2/drops?by_type=${encodeURIComponent(type)}&chain=${encodeURIComponent(slug)}&limit=50`, apiKey);
    if (r.ok && Array.isArray(r.json?.drops)) {
      picked = { chainSlug: slug, drops: r.json.drops };
      if (r.json.drops.length > 0) break;
    } else if (!r.ok && r.status === 401) {
      res.statusCode = 401;
      res.end(JSON.stringify({ configured: true, error: 'unauthorized', hint: 'OPENSEA_API_KEY rejected — check the key.' }));
      return;
    }
  }

  if (!picked) {
    res.statusCode = 502;
    res.end(JSON.stringify({ configured: true, error: 'opensea_unreachable' }));
    return;
  }

  // OpenSea's ?chain= filter is currently ignored, so filter server-side.
  // We keep everything OpenSea labels as `chain === "robinhood"`.
  const RHC_CHAINS = new Set(['robinhood', 'robinhood_chain', 'robinhoodchain']);
  const rhcRawDrops = picked.drops.filter(d => RHC_CHAINS.has((d.chain || '').toLowerCase()));

  // Enrich each RHC drop with a detail call — the LIST endpoint only returns
  // the current active_stage (often null for scheduled or ended drops); the
  // DETAIL endpoint returns the full `stages` array so we can pick the right
  // schedule window.
  const enriched = await Promise.all(rhcRawDrops.map(async (d) => {
    if (!d.collection_slug) return d;
    const detail = await osFetch(`/api/v2/drops/${encodeURIComponent(d.collection_slug)}`, apiKey);
    if (detail.ok && detail.json) {
      // Merge: keep base fields, prefer detail's stages
      return { ...d, ...detail.json };
    }
    return d;
  }));

  const mints = enriched.map(normalizeDrop).filter(m => m.name);
  const totalReturned = picked.drops.length;
  const payload = {
    chainSlug: picked.chainSlug, type,
    count: mints.length, totalReturned, rhcTotal: rhcRawDrops.length,
    mints,
  };
  cache.set(cacheKey, { value: payload, expiresAt: now + CACHE_TTL });

  // Debug tap: append &debug=1 to see the raw OpenSea shape so we can
  // adjust the normalizer as the API evolves. Never cached.
  if (q.debug) {
    res.statusCode = 200;
    res.end(JSON.stringify({ configured: true, cached: false, raw: picked.drops, ...payload }, null, 2));
    return;
  }

  res.statusCode = 200;
  res.end(JSON.stringify({ configured: true, cached: false, ...payload }));
}
