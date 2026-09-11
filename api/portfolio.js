/**
 * Wallet portfolio — every NFT a wallet holds on Robinhood Chain, as
 * OpenSea sees it.
 *
 * Query: /api/portfolio?wallet=<addr>
 *
 * Uses OpenSea's /chain/robinhood/account/{addr}/nfts endpoint — the same
 * feed that powers a user's OpenSea profile. Free wins over walking
 * Blockscout ourselves:
 *
 *   - spam / airdrop chaff already filtered by OpenSea's own algorithm
 *   - names + images come from OpenSea's normalized metadata (no IPFS
 *     gateway roulette, no missing images)
 *   - the list matches exactly what the user sees on their OpenSea profile,
 *     which is the mental model they walk in with
 *
 * Response shape:
 *   {
 *     wallet, ownedTokens, collectionCount, truncated,
 *     collections: [{
 *       contract, slug, name, iconUrl,
 *       ownedCount,
 *       openseaCollectionUrl,
 *       tokens: [{
 *         id, name, imageUrl, animationUrl, openseaUrl, isNsfw
 *       }],
 *     }],
 *   }
 *
 * Server-side in-memory cache with 15min TTL keyed by wallet. Empty
 * responses never cache — likely an OpenSea 429 on the cold call.
 */

export const config = { maxDuration: 30 };

const OPENSEA_BASE = 'https://api.opensea.io/api/v2';
// OpenSea's marketing slug for Robinhood Chain. `/chain/` endpoints reject
// "robinhood_chain" — matches the same rule collection-detail.js hit.
const CHAIN = 'robinhood';
const TIMEOUT_MS = 8000;
const PER_PAGE = 50;
const MAX_PAGES = 20;                    // 50 * 20 = 1000-nft cap
const TTL = 15 * 60 * 1000;
const BACKOFFS = [400, 1200, 3000];

const cache = (globalThis.__grugPortfolioV2Cache ||= new Map());

async function osFetchOnce(url, apiKey) {
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
    return { ok: false, error: e.name || 'error', status: 0 };
  }
}

async function osFetch(url, apiKey) {
  const shouldRetry = r => !r.ok && (r.status === 0 || r.status === 429 || r.status >= 500);
  let result = await osFetchOnce(url, apiKey);
  for (let i = 0; i < BACKOFFS.length && shouldRetry(result); i++) {
    await new Promise(r => setTimeout(r, BACKOFFS[i]));
    result = await osFetchOnce(url, apiKey);
  }
  return result;
}

// Derive a display name for a collection from the token names we saw. Most
// collections use "Name #123" — strip the suffix and you have the collection
// name for free, avoiding a per-collection /api/v2/collections/{slug} call.
// Falls back to the OpenSea slug prettified (kebab → Title Case).
function deriveCollectionName(tokens, slug) {
  const first = tokens[0]?.name;
  if (first) {
    const m = first.match(/^(.+?)\s*#\s*\d+\s*$/);
    if (m) return m[1].trim();
    // Uniform names? Use the shared name.
    if (tokens.every(t => t.name === first)) return first;
  }
  if (slug) {
    return slug.split('-')
      .filter(Boolean)
      .map(s => s[0].toUpperCase() + s.slice(1))
      .join(' ');
  }
  return null;
}

export default async function handler(req, res) {
  const q = req.query || Object.fromEntries(new URL(req.url, 'http://x/').searchParams.entries());
  const wallet = (q.wallet || '').toLowerCase();

  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('content-type', 'application/json');

  if (!/^0x[0-9a-f]{40}$/.test(wallet)) {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: 'invalid_wallet', hint: 'expected 0x… 40-hex' }));
    return;
  }

  const apiKey = process.env.OPENSEA_API_KEY;
  if (!apiKey) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: 'not_configured', hint: 'OPENSEA_API_KEY missing' }));
    return;
  }

  const now = Date.now();
  const hit = cache.get(wallet);
  if (hit && hit.expiresAt > now) {
    res.setHeader('cache-control', 'public, max-age=300, s-maxage=300');
    res.statusCode = 200;
    res.end(JSON.stringify({ ...hit.value, cached: true }));
    return;
  }

  const byContract = new Map();
  let totalTokens = 0;
  let truncated = false;
  let next = null;

  for (let p = 0; p < MAX_PAGES; p++) {
    const qs = new URLSearchParams({ limit: String(PER_PAGE) });
    if (next) qs.set('next', next);
    const url = `${OPENSEA_BASE}/chain/${CHAIN}/account/${wallet}/nfts?${qs}`;
    const r = await osFetch(url, apiKey);
    if (!r.ok) {
      if (byContract.size === 0) {
        res.statusCode = r.status === 429 ? 429 : 502;
        res.setHeader('cache-control', 'public, max-age=15, s-maxage=15');
        res.end(JSON.stringify({ error: 'opensea_failed', status: r.status || 0 }));
        return;
      }
      // Partial data — better than nothing. Mark truncated and return what
      // we have.
      truncated = true;
      break;
    }
    const nfts = Array.isArray(r.json?.nfts) ? r.json.nfts : [];
    for (const it of nfts) {
      const contract = (it.contract || '').toLowerCase();
      if (!contract) continue;
      if (it.is_disabled) continue;  // OpenSea's own hide flag — respect it
      let group = byContract.get(contract);
      if (!group) {
        group = {
          contract,
          slug: it.collection || null,
          name: null,           // derived below after we have all tokens
          iconUrl: null,        // derived below
          ownedCount: 0,
          openseaCollectionUrl: it.collection ? `https://opensea.io/collection/${it.collection}` : null,
          tokens: [],
        };
        byContract.set(contract, group);
      }
      group.tokens.push({
        id: String(it.identifier ?? ''),
        name: it.name || null,
        imageUrl: it.display_image_url || it.image_url || null,
        animationUrl: it.display_animation_url || null,
        openseaUrl: it.opensea_url || null,
        isNsfw: !!it.is_nsfw,
      });
      group.ownedCount++;
      totalTokens++;
    }
    next = r.json?.next || null;
    if (!next) break;
    if (p === MAX_PAGES - 1 && next) truncated = true;
  }

  // Derive name + icon per group after we've gathered all tokens for it.
  for (const g of byContract.values()) {
    g.name = deriveCollectionName(g.tokens, g.slug);
    // Use the first token image with a URL as the collection thumb. Sorted
    // by owned order (which matches iteration order), so this is stable.
    g.iconUrl = g.tokens.find(t => t.imageUrl)?.imageUrl || null;
  }

  const collections = [...byContract.values()].sort((a, b) => b.ownedCount - a.ownedCount);

  const payload = {
    wallet,
    ownedTokens: totalTokens,
    collectionCount: collections.length,
    collections,
    truncated,
  };

  if (totalTokens > 0) {
    cache.set(wallet, { value: payload, expiresAt: now + TTL });
    res.setHeader('cache-control', 'public, max-age=300, s-maxage=300');
  } else {
    res.setHeader('cache-control', 'public, max-age=15, s-maxage=15');
  }
  res.statusCode = 200;
  res.end(JSON.stringify(payload));
}
