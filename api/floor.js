/**
 * OpenSea floor price lookup by collection slug.
 *
 * Query: /api/floor?slug=<collection-slug>
 *
 * Hits /api/v2/collections/{slug}/stats which returns the collection's
 * live floor + rolling volume. Cached 15 min per slug.
 *
 * Response:
 *   { slug, floorEth, currency, volume24h, salesTotal, floorSource: 'stats' | null }
 *
 * We choose `slug` over `contract` because the portfolio endpoint already
 * returns the slug for every collection — no need to burn an extra call
 * resolving contract → slug when we already have it.
 */

export const config = { maxDuration: 15 };

const OPENSEA_BASE = 'https://api.opensea.io/api/v2';
const TIMEOUT_MS = 6000;
const TTL = 15 * 60 * 1000;

const cache = (globalThis.__grugFloorCache ||= new Map());

async function osFetch(url, apiKey) {
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

export default async function handler(req, res) {
  const q = req.query || Object.fromEntries(new URL(req.url, 'http://x/').searchParams.entries());
  const slug = (q.slug || '').trim().toLowerCase();

  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('content-type', 'application/json');

  if (!slug || !/^[a-z0-9-]{1,80}$/.test(slug)) {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: 'invalid_slug' }));
    return;
  }

  const apiKey = process.env.OPENSEA_API_KEY;
  if (!apiKey) {
    res.statusCode = 200;
    res.end(JSON.stringify({ configured: false, slug, floorEth: null }));
    return;
  }

  const now = Date.now();
  const hit = cache.get(slug);
  if (hit && hit.expiresAt > now) {
    res.setHeader('cache-control', 'public, max-age=300, s-maxage=300');
    res.statusCode = 200;
    res.end(JSON.stringify({ ...hit.value, cached: true }));
    return;
  }

  const r = await osFetch(`${OPENSEA_BASE}/collections/${slug}/stats`, apiKey);
  if (!r.ok) {
    // Don't cache failures — a 429 or 404 for a slug we haven't verified
    // yet should let the next attempt hit fresh.
    res.setHeader('cache-control', 'public, max-age=15, s-maxage=15');
    res.statusCode = 200;
    res.end(JSON.stringify({ slug, floorEth: null, status: r.status || 0 }));
    return;
  }

  const stats = r.json?.total || {};
  const floorEth = typeof stats.floor_price === 'number' ? stats.floor_price : null;
  const value = {
    slug,
    floorEth,
    currency: stats.floor_price_symbol || (floorEth != null ? 'ETH' : null),
    volume24h: typeof stats.volume === 'number' ? stats.volume : null,
    salesTotal: typeof stats.sales === 'number' ? stats.sales : null,
    floorSource: floorEth != null ? 'stats' : null,
  };
  cache.set(slug, { value, expiresAt: now + TTL });
  res.setHeader('cache-control', 'public, max-age=300, s-maxage=300');
  res.statusCode = 200;
  res.end(JSON.stringify(value));
}
