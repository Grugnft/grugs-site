/**
 * Look up an OpenSea collection by its slug and return the first NFT
 * contract address + the chain it lives on.
 *
 * Query:  /api/collection-by-slug?slug=arcs-punks
 * Response:
 *   {
 *     ok:      boolean,
 *     slug,
 *     contract:        "0x…" | null,
 *     openseaChain:    "arc" | "robinhood" | "ethereum" | ...   (OpenSea slug)
 *     chain:           "arc" | "rhc" | null                     (grug chain id, when supported)
 *     name, image
 *   }
 *
 * Used by the Chrome extension: on `opensea.io/collection/{slug}` we don't
 * have the contract in the URL. This endpoint bridges slug → contract so
 * the badge can then call /api/rug-score.
 *
 * Cached 30 min per slug. Requires OPENSEA_API_KEY.
 */

const OPENSEA_BASE = 'https://api.opensea.io';
const TIMEOUT_MS = 6000;
const CACHE_TTL = 30 * 60 * 1000;

const cache = (globalThis.__grugCollBySlugCache ||= new Map());

// OpenSea chain slug → grug chain id. When null, the badge stays silent
// (we support Arc + RHC only right now).
const CHAIN_ALIAS = { arc: 'arc', robinhood: 'rhc' };

async function osFetch(path, apiKey) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(OPENSEA_BASE + path, {
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
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('content-type', 'application/json');

  const q = req.query || Object.fromEntries(new URL(req.url, 'http://x/').searchParams.entries());
  const slug = String(q.slug || '').toLowerCase().replace(/[^a-z0-9\-_]/g, '');
  if (!slug) {
    res.statusCode = 400;
    res.end(JSON.stringify({ ok: false, error: 'invalid_slug' }));
    return;
  }

  const apiKey = process.env.OPENSEA_API_KEY;
  if (!apiKey) {
    res.statusCode = 200;
    res.end(JSON.stringify({ ok: false, configured: false, slug }));
    return;
  }

  const now = Date.now();
  const hit = cache.get(slug);
  if (hit && hit.expiresAt > now) {
    res.setHeader('cache-control', 'public, max-age=300, s-maxage=1800');
    res.statusCode = 200;
    res.end(JSON.stringify({ ...hit.value, cached: true }));
    return;
  }

  // OpenSea's /api/v2/collections/{slug} returns { contracts: [{address, chain}], name, ... }
  const step1 = await osFetch(`/api/v2/collections/${encodeURIComponent(slug)}`, apiKey);
  if (!step1.ok) {
    const transient = step1.status && step1.status !== 404;
    const payload = { ok: false, slug, contract: null, chain: null };
    // Short TTL on transient upstream problems so a rate-limit doesn't
    // cache "not found" for 30 min at the CDN.
    cache.set(slug, { value: payload, expiresAt: now + (transient ? 60_000 : CACHE_TTL) });
    res.setHeader('cache-control', transient ? 'public, max-age=30' : 'public, max-age=1800, s-maxage=1800');
    res.statusCode = 200;
    res.end(JSON.stringify(payload));
    return;
  }

  const c = step1.json || {};
  // A collection may span multiple contracts; pick the first one that lives
  // on a chain we support, falling back to the first contract listed.
  const contracts = Array.isArray(c.contracts) ? c.contracts : [];
  const supported = contracts.find(x => CHAIN_ALIAS[String(x.chain || '').toLowerCase()]);
  const chosen = supported || contracts[0] || null;
  const openseaChain = chosen ? String(chosen.chain || '').toLowerCase() : null;
  const contract = chosen ? String(chosen.address || '').toLowerCase() : null;
  const chain = openseaChain ? (CHAIN_ALIAS[openseaChain] || null) : null;

  const payload = {
    ok: !!contract,
    slug,
    contract,
    openseaChain,
    chain,
    name: c.name || null,
    image: c.image_url || null,
  };
  cache.set(slug, { value: payload, expiresAt: now + CACHE_TTL });
  res.setHeader('cache-control', 'public, max-age=300, s-maxage=1800');
  res.statusCode = 200;
  res.end(JSON.stringify(payload));
}
