/**
 * ETH/USD spot price for cross-currency portfolio sort.
 *
 * Query: /api/eth-price
 *
 * Uses Coingecko's public /simple/price endpoint (no key required at low
 * volume). Response is cached in memory for 30 min — sort ordering is
 * insensitive to sub-percent moves, and the portfolio floor sort is the
 * only current consumer.
 *
 * Response: { usd: <number>, source: 'coingecko' | 'fallback', ttlMs }
 * Fallback: if Coingecko is unreachable we return a stale-safe hardcoded
 * value so the sort still runs — the currency labels in the UI stay honest
 * even when the ratio drifts.
 */

export const config = { maxDuration: 10 };

const TIMEOUT_MS = 5000;
const TTL = 30 * 60 * 1000;
const FALLBACK_USD = 2200;   // updated periodically; only used if Coingecko is down

const cache = (globalThis.__grugEthPriceCache ||= { value: null, expiresAt: 0 });

async function fetchOnce(url) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      signal: ac.signal,
      headers: {
        'accept': 'application/json',
        'user-agent': 'GrugsRugRadar/1.0 (+https://grugnft.xyz)',
      },
    });
    clearTimeout(t);
    if (!r.ok) return null;
    return await r.json();
  } catch (e) {
    clearTimeout(t);
    return null;
  }
}

export default async function handler(req, res) {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('content-type', 'application/json');

  const now = Date.now();
  if (cache.value && cache.expiresAt > now) {
    res.setHeader('cache-control', 'public, max-age=1800, s-maxage=1800');
    res.statusCode = 200;
    res.end(JSON.stringify({ ...cache.value, cached: true, ttlMs: cache.expiresAt - now }));
    return;
  }

  const j = await fetchOnce('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd');
  const usd = typeof j?.ethereum?.usd === 'number' ? j.ethereum.usd : null;
  const value = usd
    ? { usd, source: 'coingecko' }
    : { usd: FALLBACK_USD, source: 'fallback' };
  cache.value = value;
  cache.expiresAt = now + TTL;
  res.setHeader('cache-control', 'public, max-age=1800, s-maxage=1800');
  res.statusCode = 200;
  res.end(JSON.stringify({ ...value, ttlMs: TTL }));
}
