/**
 * Deployer funding-source probe.
 *
 * Query: /api/deployer-funding?addr=<contract>
 *
 * Traces the deployer wallet's incoming ETH one hop back. Rug flow: fresh
 * wallet A funds fresh wallet B; B deploys the contract; when the rug fires
 * both are burnable identities. Real projects fund from an exchange or a
 * long-lived treasury — both of which have thick tx history.
 *
 * Response:
 *   {
 *     deployer,                    // creator wallet
 *     targetContract,
 *     funders: [{ address, valueEth, timestamp, txCount, isFresh }],
 *     verdict: "clean" | "watch" | "fresh_chain" | "unknown",
 *     note: "…"
 *   }
 *
 * Verdict logic:
 *   - No incoming txs on the visible page → unknown (mined, airdropped, or
 *     history is older than we paged)
 *   - Top funder has 100+ txs → clean (established source, likely CEX/treasury)
 *   - Top funder has under 20 txs AND funded > 0.001 ETH → watch
 *   - Top funder has under 5 txs → fresh_chain (disposable-identity pattern)
 *
 * Only meaningful for non-trivial funding amounts (> 0.001 ETH). Dust
 * airdrops and rounding transfers are filtered out.
 */

// Function budget — see explorer-info.js. 4-attempt retry loop needs room.
export const config = { maxDuration: 30 };

const BS = 'https://robinhoodchain.blockscout.com/api/v2';
const TIMEOUT_FIRST_MS = 8000;
const TIMEOUT_RETRY_MS = 5000;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36';
const TTL = 15 * 60 * 1000;
const MIN_FUNDING_ETH = 0.001;   // ignore dust
const MAX_FUNDERS_TO_CHECK = 3;  // top-N incoming transfers to profile
// 4 attempts total, matches the retry cadence of the other scanner endpoints.
const BACKOFFS = [500, 1500, 3000];

// Shared cache across Blockscout endpoints, keyed by URL.
const bsCache = (globalThis.__grugFundingBsCache ||= new Map());
const outCache = (globalThis.__grugFundingOutCache ||= new Map());

// Full browser-like header set — see api/explorer-info.js.
function browserHeaders() {
  return {
    'user-agent': UA,
    'accept': 'application/json, text/plain, */*',
    'accept-language': 'en-US,en;q=0.9',
    'accept-encoding': 'gzip, deflate, br',
    'sec-ch-ua': '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"macOS"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    'referer': 'https://robinhoodchain.blockscout.com/',
    'origin': 'https://robinhoodchain.blockscout.com',
  };
}

async function fetchOnce(url, timeoutMs) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      signal: ac.signal,
      headers: browserHeaders(),
    });
    clearTimeout(t);
    if (!r.ok) return { value: null, status: r.status };
    const ct = r.headers.get('content-type') || '';
    if (!/json/i.test(ct)) return { value: null, status: r.status };
    return { value: await r.json(), status: r.status };
  } catch (e) {
    clearTimeout(t);
    return { value: null, status: 0 };
  }
}

// 4-attempt retry with growing backoff. Retries on Cloudflare 403 / 429 in
// addition to 0 / 5xx (see explorer-info.js for the reasoning).
async function bsGet(url) {
  const now = Date.now();
  const hit = bsCache.get(url);
  if (hit && hit.expiresAt > now) return hit.value;

  const flaky = r => r.value === null && (r.status === 0 || r.status === 403 || r.status === 429 || r.status >= 500);
  let result = await fetchOnce(url, TIMEOUT_FIRST_MS);
  for (let i = 0; i < BACKOFFS.length && flaky(result); i++) {
    await new Promise(r => setTimeout(r, BACKOFFS[i]));
    result = await fetchOnce(url, TIMEOUT_RETRY_MS);
  }
  if (result.value !== null) bsCache.set(url, { value: result.value, expiresAt: now + TTL });
  return result.value;
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
  const hit = outCache.get(addr);
  if (hit && hit.expiresAt > now) {
    res.setHeader('cache-control', 'public, max-age=300, s-maxage=900');
    res.statusCode = 200;
    res.end(JSON.stringify({ cached: true, ...hit.value }));
    return;
  }

  // Step 1: find the deployer. Same two-endpoint fallback as prior-rug-check.
  const [addrInfo, sc] = await Promise.all([
    bsGet(`${BS}/addresses/${addr}`),
    bsGet(`${BS}/smart-contracts/${addr}`),
  ]);
  const deployer = (addrInfo?.creator_address_hash || sc?.creator_address_hash || '').toLowerCase() || null;
  if (!deployer) {
    const payload = {
      targetContract: addr,
      deployer: null,
      funders: [],
      verdict: 'unknown',
      note: 'deployer lookup failed. Blockscout /addresses is flaky on RHC.',
    };
    outCache.set(addr, { value: payload, expiresAt: now + 30_000 });
    res.setHeader('cache-control', 'public, max-age=30');
    res.statusCode = 200;
    res.end(JSON.stringify({ cached: false, ...payload }));
    return;
  }

  // Step 2: incoming txs. filter=to means "deployer is the recipient". First
  // page = most recent ~50 items.
  const txs = await bsGet(`${BS}/addresses/${deployer}/transactions?filter=to`);
  const items = Array.isArray(txs?.items) ? txs.items : [];

  // Extract funding transfers — non-zero ETH value, from an external address
  // (not a contract self-call), above the dust threshold.
  const funding = items
    .filter(t => {
      const valWei = t.value ? BigInt(t.value) : 0n;
      const eth = Number(valWei) / 1e18;
      const from = (t.from?.hash || '').toLowerCase();
      return eth >= MIN_FUNDING_ETH && from && from !== deployer;
    })
    .map(t => ({
      from: (t.from?.hash || '').toLowerCase(),
      valueEth: Number(BigInt(t.value || '0')) / 1e18,
      timestamp: t.timestamp || null,
      hash: t.hash || null,
    }));

  if (funding.length === 0) {
    // Nothing to profile — could be mined, airdropped, bridged, or history is
    // older than the visible page.
    const hasMore = !!txs?.next_page_params;
    const payload = {
      targetContract: addr,
      deployer,
      funders: [],
      verdict: 'unknown',
      note: hasMore
        ? 'no material funding transfers on the recent page. older history not paged.'
        : 'no incoming ETH transfers found. deployer may have been funded via bridge, mining, or contract call.',
    };
    outCache.set(addr, { value: payload, expiresAt: now + TTL });
    res.setHeader('cache-control', 'public, max-age=300, s-maxage=900');
    res.statusCode = 200;
    res.end(JSON.stringify({ cached: false, ...payload }));
    return;
  }

  // Sort by value descending — biggest funders are the most informative.
  funding.sort((a, b) => b.valueEth - a.valueEth);
  const topFunders = funding.slice(0, MAX_FUNDERS_TO_CHECK);

  // Step 3: for each top funder, pull their counters to see how established
  // they are. A fresh wallet with under 5 txs funding the deployer is the
  // classic disposable-identity pattern.
  const profiled = await Promise.all(topFunders.map(async f => {
    const counters = await bsGet(`${BS}/addresses/${f.from}/counters`);
    const txCount = counters ? parseInt(counters.transactions_count || '0', 10) : null;
    return {
      address: f.from,
      valueEth: Number(f.valueEth.toFixed(6)),
      timestamp: f.timestamp,
      txCount,
      // "Fresh" = fewer than 20 tx of history. Chosen to match the
      // freshWallet threshold on the deployer signal for consistency.
      isFresh: txCount !== null && txCount < 20,
    };
  }));

  // Verdict: look at the TOP (highest-value) funder — that's the one that
  // materially funded the deploy. Other funders may be dust/legit spend money.
  const top = profiled[0];
  let verdict = 'unknown';
  let note = null;
  if (top.txCount === null) {
    verdict = 'unknown';
    note = 'grug couldn\'t read the top funder\'s tx history from Blockscout.';
  } else if (top.txCount >= 100) {
    verdict = 'clean';
    note = `top funder (${short(top.address)}) has ${top.txCount.toLocaleString()} txs. established source.`;
  } else if (top.txCount < 5) {
    verdict = 'fresh_chain';
    note = `top funder (${short(top.address)}) has only ${top.txCount} txs. disposable-identity pattern.`;
  } else {
    verdict = 'watch';
    note = `top funder (${short(top.address)}) has ${top.txCount} txs. borderline — some history, not a lot.`;
  }

  const payload = {
    targetContract: addr,
    deployer,
    funders: profiled,
    verdict,
    note,
  };
  outCache.set(addr, { value: payload, expiresAt: now + TTL });
  res.setHeader('cache-control', 'public, max-age=300, s-maxage=900');
  res.statusCode = 200;
  res.end(JSON.stringify({ cached: false, ...payload }));
}

function short(a) {
  return a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '';
}
