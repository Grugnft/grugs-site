/**
 * OpenSea collection detail lookup by contract address.
 *
 * Query: /api/collection-detail?contract=0x…&chain=robinhood_chain
 *
 * Two-step OpenSea call:
 *   1. GET /api/v2/chain/{chain}/contract/{address}      → returns { collection: "slug" }
 *   2. GET /api/v2/collections/{slug}                    → returns full details
 *
 * Response (normalized):
 *   {
 *     ok, slug, name, description, image,
 *     twitter, discord, website,
 *     openseaUrl, safelist
 *   }
 *
 * Cached 15min per contract. Requires OPENSEA_API_KEY; without a key returns
 * { configured: false } so the client can gracefully skip enrichment.
 */

const OPENSEA_BASE = 'https://api.opensea.io';
const TIMEOUT_MS = 6000;
const CACHE_TTL = 15 * 60 * 1000;

const cache = (globalThis.__grugCollDetailCache ||= new Map());

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
    if (!r.ok) return { ok: false, status: r.status };
    return { ok: true, json: await r.json() };
  } catch (e) {
    clearTimeout(t);
    return { ok: false, error: e.name || 'error' };
  }
}

function normalize(c, slug) {
  // OpenSea occasionally returns 200 with a null/empty body — guard the
  // property accesses instead of throwing out of the whole request.
  c = c || {};
  const twitterHandle = c.twitter_username ? String(c.twitter_username).replace(/^@/, '') : null;
  return {
    slug,
    name: c.name || slug || null,
    description: c.description ? String(c.description).slice(0, 400) : null,
    image: c.image_url || null,
    banner: c.banner_image_url || null,
    twitter: twitterHandle ? `https://twitter.com/${twitterHandle}` : null,
    twitterHandle,
    discord: c.discord_url || null,
    website: c.project_url || null,
    openseaUrl: slug ? `https://opensea.io/collection/${slug}` : null,
    safelist: c.safelist_status || null,
    // OpenSea's collection-listed date. Close proxy for on-chain deploy date
    // (usually within a day of it) and much more reliable than Blockscout's
    // creation_tx_hash lookup, which returns null for most RHC contracts.
    createdDate: c.created_date || null,
  };
}

export default async function handler(req, res) {
  const q = req.query || Object.fromEntries(new URL(req.url, 'http://x/').searchParams.entries());
  const contract = (q.contract || '').toLowerCase();
  // OpenSea's /chain/{chain}/contract/ endpoint uses the marketing slug
  // "robinhood" (NOT "robinhood_chain" — that returns "Unrecognized chain").
  // /drops and /collections silently accept either. Different endpoints,
  // different rules, thanks OpenSea.
  const chain = q.chain || 'robinhood';

  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('content-type', 'application/json');
  // NOTE: cache-control is set per-branch below. Setting it here would cache
  // transient errors (429 / 500 / abort) at the CDN edge for 15 min, and
  // the collection would appear un-enrichable long after OpenSea recovered.

  if (!/^0x[0-9a-f]{40}$/.test(contract)) {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: 'invalid_contract' }));
    return;
  }

  const apiKey = process.env.OPENSEA_API_KEY;
  if (!apiKey) {
    res.statusCode = 200;
    res.end(JSON.stringify({ configured: false, ok: false }));
    return;
  }

  const cacheKey = `${chain}|${contract}`;
  const now = Date.now();
  const hit = cache.get(cacheKey);
  if (hit && hit.expiresAt > now) {
    res.statusCode = 200;
    res.end(JSON.stringify({ configured: true, cached: true, ...hit.value }));
    return;
  }

  // Short TTL for transient upstream problems, full TTL for definitive results
  // (success or 404). This way OpenSea recovering from a rate-limit doesn't
  // require waiting out the full 15-min window.
  const shortTtl = 60 * 1000;
  const isTransient = (r) => !r.ok && r.status !== 404;

  // Step 1: contract → slug
  const step1 = await osFetch(`/api/v2/chain/${encodeURIComponent(chain)}/contract/${contract}`, apiKey);
  if (!step1.ok) {
    // Not-found is common (OpenSea doesn't know about every RHC contract yet)
    // — cache that for the full TTL. Transient failures use the short TTL so
    // we re-poll upstream soon.
    const transient = isTransient(step1);
    const payload = { ok: false, slug: null, contract, transient: transient || undefined };
    cache.set(cacheKey, { value: payload, expiresAt: now + (transient ? shortTtl : CACHE_TTL) });
    res.setHeader('cache-control', transient ? 'public, max-age=30' : 'public, max-age=900, s-maxage=900');
    res.statusCode = 200;
    res.end(JSON.stringify({ configured: true, cached: false, ...payload }));
    return;
  }
  const slug = step1.json?.collection;
  if (!slug) {
    const payload = { ok: false, slug: null, contract, hint: 'contract known to OpenSea but no collection slug' };
    cache.set(cacheKey, { value: payload, expiresAt: now + CACHE_TTL });
    res.setHeader('cache-control', 'public, max-age=900, s-maxage=900');
    res.statusCode = 200;
    res.end(JSON.stringify({ configured: true, cached: false, ...payload }));
    return;
  }

  // Step 2 & 3: fetch details + stats in parallel. Stats gives us the market-
  // activity signal (total_sales / total_volume / num_owners) so the scanner
  // can flag "collection has been live but nobody bought". If the stats call
  // fails but details succeed, we still return details — stats is enrichment.
  const [step2, step3] = await Promise.all([
    osFetch(`/api/v2/collections/${encodeURIComponent(slug)}`, apiKey),
    osFetch(`/api/v2/collections/${encodeURIComponent(slug)}/stats`, apiKey),
  ]);
  if (!step2.ok) {
    const transient = isTransient(step2);
    const payload = { ok: false, slug, contract, hint: 'collection lookup failed', transient: transient || undefined };
    cache.set(cacheKey, { value: payload, expiresAt: now + (transient ? shortTtl : CACHE_TTL) });
    res.setHeader('cache-control', transient ? 'public, max-age=30' : 'public, max-age=900, s-maxage=900');
    res.statusCode = 200;
    res.end(JSON.stringify({ configured: true, cached: false, ...payload }));
    return;
  }

  // Extract stats we care about. OpenSea returns { total: {volume, sales, num_owners, ...}, intervals: [...] }
  const statsBlock = step3.ok ? step3.json?.total : null;
  const stats = statsBlock ? {
    totalSales: statsBlock.sales ?? null,
    totalVolume: statsBlock.volume ?? null,
    numOwners: statsBlock.num_owners ?? null,
    floorPrice: statsBlock.floor_price ?? null,
    marketCap: statsBlock.market_cap ?? null,
  } : null;

  const payload = { ok: true, contract, stats, ...normalize(step2.json, slug) };
  cache.set(cacheKey, { value: payload, expiresAt: now + CACHE_TTL });
  res.setHeader('cache-control', 'public, max-age=900, s-maxage=900');
  res.statusCode = 200;
  res.end(JSON.stringify({ configured: true, cached: false, ...payload }));
}
