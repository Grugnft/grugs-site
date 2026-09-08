/**
 * OpenSea collections proxy — recently-deployed NFT collections on
 * Robinhood Chain. Complements /api/opensea-drops (which only lists
 * projects currently doing a SeaDrop mint) by surfacing the much larger
 * set of collections that just exist on RHC, sorted by recency.
 *
 * Query:
 *   /api/opensea-collections               → newest RHC collections (default limit 20)
 *   /api/opensea-collections?limit=50
 *   /api/opensea-collections?debug=1       → include raw OpenSea payload
 *
 * Requires OPENSEA_API_KEY. If missing, returns { configured: false, items: [] }.
 */

const OPENSEA_BASE = 'https://api.opensea.io';
// OpenSea's /collections endpoint rejects "robinhood_chain" with 400 —
// only /drops silently ignores unknown chain params. Use "robinhood".
// (Same quirk as api/collection-detail.js; see the comment there.)
const CHAIN_SLUG = 'robinhood';
const TIMEOUT_MS = 8000;
const CACHE_TTL = 10 * 60 * 1000; // 10min

const cache = (globalThis.__grugOsCollCache ||= new Map());

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

/* Collection payload shape from /api/v2/collections (observed 2026-09):
   {
     collections: [{
       collection: "slug",           // sometimes this is the slug key
       name, description, image_url, banner_image_url,
       owner, safelist_status,
       contracts: [{ address, chain }],
       twitter_username, project_url, discord_url,
       total_supply, created_date, ...
     }, ...],
     next: "cursor"
   }
   The primary contract is contracts[0]; chain filter is done client-side
   in case OpenSea's ?chain= is ignored (same quirk as /drops). */
function normalizeCollection(c) {
  const contract = Array.isArray(c.contracts) && c.contracts[0]?.address || '';
  const chainRaw = (Array.isArray(c.contracts) && c.contracts[0]?.chain) || c.chain || '';
  const twitterHandle = c.twitter_username ? String(c.twitter_username).replace(/^@/, '') : null;

  return {
    source: 'collection',
    name: c.name || c.collection || 'Untitled collection',
    symbol: '',
    contract,
    chain: /robinhood/i.test(chainRaw) ? 'RHC' : (chainRaw || 'unknown'),
    _chainRaw: chainRaw,
    mintStart: c.created_date || null,           // used as an approximate "on chain since"
    priceLabel: c.total_supply ? `${Number(c.total_supply).toLocaleString()} supply` : '—',
    supply: c.total_supply ? Number(c.total_supply) : null,
    twitter: twitterHandle ? `https://twitter.com/${twitterHandle}` : null,
    website: c.project_url || null,
    discord: c.discord_url || null,
    image: c.image_url || null,
    tagline: c.description ? String(c.description).slice(0, 140) : '',
    openseaSlug: c.collection || c.slug || null,
    openseaUrl: (c.collection || c.slug) ? `https://opensea.io/collection/${c.collection || c.slug}` : null,
    safelist: c.safelist_status || null,
  };
}

export default async function handler(req, res) {
  const q = req.query || Object.fromEntries(new URL(req.url, 'http://x/').searchParams.entries());
  const limit = Math.min(Math.max(parseInt(q.limit || '20', 10), 1), 100);

  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('content-type', 'application/json');
  res.setHeader('cache-control', 'public, max-age=600, s-maxage=600');

  const apiKey = process.env.OPENSEA_API_KEY;
  if (!apiKey) {
    res.statusCode = 200;
    res.end(JSON.stringify({
      configured: false,
      hint: 'Set OPENSEA_API_KEY to enable OpenSea collection discovery. Free key at docs.opensea.io/reference/api-keys',
      items: [],
    }));
    return;
  }

  const cacheKey = `limit=${limit}`;
  const now = Date.now();
  const hit = cache.get(cacheKey);
  if (hit && hit.expiresAt > now && !q.debug) {
    res.statusCode = 200;
    res.end(JSON.stringify({ configured: true, cached: true, ...hit.value }));
    return;
  }

  // Sort by created_date desc so newest deploys come first.
  const r = await osFetch(
    `/api/v2/collections?chain=${encodeURIComponent(CHAIN_SLUG)}&order_by=created_date&limit=${limit}`,
    apiKey
  );

  if (!r.ok) {
    if (r.status === 401) {
      res.statusCode = 401;
      res.end(JSON.stringify({ configured: true, error: 'unauthorized', hint: 'OPENSEA_API_KEY rejected — check the key.' }));
      return;
    }
    res.statusCode = 502;
    res.end(JSON.stringify({ configured: true, error: 'opensea_unreachable', status: r.status }));
    return;
  }

  const rawCollections = Array.isArray(r.json?.collections) ? r.json.collections : [];
  // Client-side filter to RHC only — OpenSea's ?chain= is unreliable
  const RHC_RE = /^(robinhood|robinhood_chain|robinhoodchain)$/i;
  const items = rawCollections
    .map(normalizeCollection)
    .filter(c => c.name && RHC_RE.test(c._chainRaw || ''));
  items.forEach(c => delete c._chainRaw);

  const payload = {
    chainSlug: CHAIN_SLUG,
    count: items.length,
    totalReturned: rawCollections.length,
    items,
  };
  cache.set(cacheKey, { value: payload, expiresAt: now + CACHE_TTL });

  if (q.debug) {
    res.statusCode = 200;
    res.end(JSON.stringify({ configured: true, cached: false, raw: rawCollections.slice(0, 3), ...payload }, null, 2));
    return;
  }

  res.statusCode = 200;
  res.end(JSON.stringify({ configured: true, cached: false, ...payload }));
}
