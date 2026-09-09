/**
 * Batched Blockscout contract probe.
 *
 * Why it exists: the scanner used to call five separate Blockscout endpoints
 * directly from the browser. Blockscout's public tier is behind Cloudflare,
 * flakes with 500s / bot challenges, and the browser CORS story is uneven —
 * so the same contract scored 20 sometimes and stayed on "?" other times.
 * All flakiness collected here: retry + short cache + browser-UA header.
 *
 * Query:
 *   /api/explorer-info?addr=0x…
 *
 * Response (single JSON object, all fields nullable — never throws on
 * partial failure so the client can still render a partial report):
 *   {
 *     verified, proxyType, compilerVersion, explorerName,
 *     tokenName, tokenSymbol, tokenType, totalSupply, holdersCount,
 *     topHolders: [{ address, value }, ...],
 *     creator, creationTx,
 *     contractTransferCount, contractTxCount,
 *     firstTransfers: [{ from, to, timestamp, block }, ...],
 *     firstBlock,
 *   }
 *
 * Cached 5 min per address in globalThis so dev-server hot reloads don't
 * blow the cache. Same server-side retry logic as api/deployer-history.
 */

// Vercel function budget — 4-attempt retry loop can burn 20s+ per URL if
// Blockscout goes fully dark, and Promise.all across 6 URLs runs them in
// parallel so the slowest one dominates. 30s gives room for one very bad
// upstream day without dumping half the response.
export const config = { maxDuration: 30 };

const BS = 'https://robinhoodchain.blockscout.com/api/v2';
// Per-attempt timeout. First attempt gets full 8s (RHC's /smart-contracts is
// slow), retries get 5s (if it's going to answer, it usually answers quickly
// on the second try).
const TIMEOUT_FIRST_MS = 8000;
const TIMEOUT_RETRY_MS = 5000;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36';
const TTL = 5 * 60 * 1000;
// Backoff sleeps BETWEEN attempts (attempt 1 → 500ms → attempt 2 → 1500ms →
// attempt 3 → 3000ms → attempt 4). Total worst-case = 4×5s + 5s = 25s under
// the 30s function budget.
const BACKOFFS = [500, 1500, 3000];

const cache = (globalThis.__grugExplorerInfoCache ||= new Map());
// IMPORTANT: use a distinct globalThis key from api/deployer-history.js. That
// endpoint stores { value, expiresAt } (raw JSON), while this endpoint needs
// { result: { status, value, error }, expiresAt } so it can distinguish a
// 404 from a network abort. Sharing the same cache would cross-corrupt: a
// hit written by one shape reads as undefined in the other, and callers
// that treated undefined as "miss" would work, but callers that unwrapped
// the wrong shape would throw. Keep them isolated.
const bsCache = (globalThis.__grugExplorerBsCache ||= new Map());

async function fetchOnce(url, timeoutMs) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      signal: ac.signal,
      headers: { 'user-agent': UA, 'accept': 'application/json,*/*;q=0.8' },
    });
    clearTimeout(t);
    if (!r.ok) return { status: r.status, value: null, error: `http_${r.status}` };
    // Cloudflare challenge sometimes returns HTML with 200 — reject non-JSON.
    const ct = r.headers.get('content-type') || '';
    if (!/json/i.test(ct)) return { status: r.status, value: null, error: 'html_body' };
    return { status: r.status, value: await r.json() };
  } catch (e) {
    clearTimeout(t);
    return { status: 0, value: null, error: e.name || 'fetch_error' };
  }
}

// Returns { value, status }. Retries up to 3 times (4 attempts total) on
// transient failures with growing backoff (500ms → 1500ms → 3000ms). Status
// is preserved so callers can distinguish "not found (404)" from "flaky
// (0/5xx)". Blockscout on RHC is stable under 200/404 responses but flakes
// hard under load — 4 attempts turns that into a clean read most of the time.
async function j(url) {
  const now = Date.now();
  const hit = bsCache.get(url);
  if (hit && hit.expiresAt > now) return hit.result;

  const shouldRetry = r => r.value === null && (r.status === 0 || r.status >= 500);

  let result = await fetchOnce(url, TIMEOUT_FIRST_MS);
  for (let i = 0; i < BACKOFFS.length && shouldRetry(result); i++) {
    await new Promise(r => setTimeout(r, BACKOFFS[i]));
    result = await fetchOnce(url, TIMEOUT_RETRY_MS);
  }
  if (result.value !== null) {
    bsCache.set(url, { result, expiresAt: now + TTL });
  }
  return result;
}

export default async function handler(req, res) {
  const q = req.query || Object.fromEntries(new URL(req.url, 'http://x/').searchParams.entries());
  const addr = (q.addr || '').toLowerCase();

  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('content-type', 'application/json');

  if (!/^0x[0-9a-f]{40}$/.test(addr)) {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: 'invalid_addr' }));
    return;
  }

  const now = Date.now();
  const hit = cache.get(addr);
  if (hit && hit.expiresAt > now) {
    res.setHeader('cache-control', 'public, max-age=60, s-maxage=300');
    res.statusCode = 200;
    res.end(JSON.stringify({ cached: true, ...hit.value }));
    return;
  }

  // Fire all six probes in parallel — each independently retried by j().
  const [sc, tk, holders, addrInfo, counters, transfers] = await Promise.all([
    j(`${BS}/smart-contracts/${addr}`),
    j(`${BS}/tokens/${addr}`),
    j(`${BS}/tokens/${addr}/holders`),
    j(`${BS}/addresses/${addr}`),
    j(`${BS}/addresses/${addr}/counters`),
    // First 50 token transfers to spot early-block sniper concentration
    j(`${BS}/tokens/${addr}/transfers`),
  ]);

  // For the verified flag we care about explicit true, explicit false (404 =
  // "not a verified contract on this explorer"), and null (upstream failed).
  let verified = null;
  if (sc.value) {
    verified = !!sc.value.is_verified;
  } else if (sc.status === 404) {
    verified = false;
  }
  // else leave as null — scanner will show as "?" instead of falsely marking bad

  const out = {
    // contract verification / proxy
    verified,
    proxyType: sc.value?.proxy_type ?? null,
    compilerVersion: sc.value?.compiler_version ?? null,
    explorerName: sc.value?.name ?? null,

    // token
    tokenName: tk.value?.name ?? null,
    tokenSymbol: tk.value?.symbol ?? null,
    tokenType: tk.value?.type ?? null,
    totalSupply: tk.value?.total_supply ?? null,
    holdersCount: tk.value?.holders ? parseInt(tk.value.holders, 10) : null,

    // top holders (up to 10)
    topHolders: Array.isArray(holders.value?.items)
      ? holders.value.items.slice(0, 10).map(h => ({
          address: h.address?.hash || h.address_hash || null,
          value: h.value || '0',
        }))
      : null,

    // creator / creation
    creator: addrInfo.value?.creator_address_hash || sc.value?.creator_address_hash || null,
    creationTx: addrInfo.value?.creation_tx_hash || sc.value?.creation_tx_hash || null,

    // activity counters
    contractTransferCount: counters.value ? parseInt(counters.value.token_transfers_count || '0', 10) : null,
    contractTxCount: counters.value ? parseInt(counters.value.transactions_count || '0', 10) : null,

    // First N transfers — the raw material for sniper-stack detection.
    // We keep it small (up to 30) so the response stays lean.
    firstTransfers: Array.isArray(transfers.value?.items)
      ? transfers.value.items.slice(0, 30).map(t => ({
          from: t.from?.hash || null,
          to: t.to?.hash || null,
          timestamp: t.timestamp || null,
          block: t.block_number ?? null,
          // NFT transfers carry the tokenId two different ways depending on
          // Blockscout version — `total.token_id` for newer, `token_id` for
          // older. Include whichever comes back so the scanner can pick a
          // real (holder, tokenId) pair for the honeypot-simulation check.
          tokenId: t.total?.token_id ?? t.token_id ?? null,
        }))
      : null,

    upstream: {
      smartContracts: { status: sc.status, error: sc.error || null },
      tokens: { status: tk.status, error: tk.error || null },
      holders: { status: holders.status, error: holders.error || null },
      addresses: { status: addrInfo.status, error: addrInfo.error || null },
      counters: { status: counters.status, error: counters.error || null },
      transfers: { status: transfers.status, error: transfers.error || null },
    },
  };

  // Don't lock in a partial-failure result for a full 5 minutes. If the
  // critical smart-contracts endpoint (used for the verified flag) failed
  // this round, cache the response briefly so we retry upstream sooner.
  const isFullResult = sc.value !== null || sc.status === 404;
  const ttl = isFullResult ? TTL : 30 * 1000; // 30s for partial
  cache.set(addr, { value: out, expiresAt: now + ttl });
  res.setHeader('cache-control',
    isFullResult ? 'public, max-age=60, s-maxage=300'
                 : 'public, max-age=15, s-maxage=30');
  res.statusCode = 200;
  res.end(JSON.stringify({ cached: false, ...out }));
}
