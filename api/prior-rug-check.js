/**
 * Prior-rug pattern probe.
 *
 * Query: /api/prior-rug-check?addr=0x…
 *
 * Given a contract address, finds the deployer's other contracts and pulls
 * each one's on-chain activity to detect the classic serial-rug pattern:
 * a deployer with many previous contracts, most of them ghost-town dead.
 *
 * Response:
 *   {
 *     deployer,                     // creator wallet
 *     targetContract,               // the input contract
 *     othersChecked,                // how many of the deployer's other contracts we looked at
 *     dead,                         // count of those with zero token transfers
 *     alive,                        // count with any activity
 *     verdict: "clean" | "watch" | "rug_pattern" | "unknown",
 *     others: [{ address, transfers, holders }]
 *   }
 *
 * Runs the per-contract probes in parallel, capped at 10 max — a deployer
 * with 100 contracts almost certainly a factory (Uniswap-style), where
 * this signal is meaningless anyway. 10 is a good ceiling for actual
 * NFT drop deployers.
 *
 * Cached 15 min per deployer address (the input contract's deployer). Runs
 * on top of deployer-history + a batch of /tokens calls; both are cached
 * upstream so repeats are cheap.
 */

// Function budget — this endpoint fires up to 20 Blockscout URLs per call
// (deploy discovery + per-contract probes for up to 10 sibling contracts) and
// each URL now has up to 4 retry attempts. 30s ceiling matches the other
// scanner endpoints.
export const config = { maxDuration: 30 };

const BS = 'https://robinhoodchain.blockscout.com/api/v2';
const TIMEOUT_FIRST_MS = 8000;
const TIMEOUT_RETRY_MS = 5000;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36';
const TTL = 15 * 60 * 1000;
const MAX_TO_CHECK = 10;
// 4-attempt retry schedule matches explorer-info + deployer-history.
const BACKOFFS = [500, 1500, 3000];

// Shared with other Blockscout endpoints — keyed by URL so response shapes
// stay consistent across the codebase.
const bsCache = (globalThis.__grugPriorRugBsCache ||= new Map());
const outCache = (globalThis.__grugPriorRugOutCache ||= new Map());

// Full browser-like header set — see api/explorer-info.js. Blockscout's CF
// rejects bare requests with 403.
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

// Cached, retrying wrapper. 4 attempts total; retries on transient failures
// including Cloudflare 403 / 429 (see explorer-info.js).
async function bsGet(url) {
  const now = Date.now();
  const hit = bsCache.get(url);
  if (hit && hit.expiresAt > now) return hit.value;

  const shouldRetry = r => r.value === null && (r.status === 0 || r.status === 403 || r.status === 429 || r.status >= 500);
  let result = await fetchOnce(url, TIMEOUT_FIRST_MS);
  for (let i = 0; i < BACKOFFS.length && shouldRetry(result); i++) {
    await new Promise(r => setTimeout(r, BACKOFFS[i]));
    result = await fetchOnce(url, TIMEOUT_RETRY_MS);
  }
  if (result.value !== null) bsCache.set(url, { value: result.value, expiresAt: now + TTL });
  return result.value;
}

// Given a contract address, decide whether it looks "dead" for the purposes
// of the serial-rug pattern. We only consider TOKEN contracts (ERC-20/721/
// 1155) as candidates: a deployer's non-token infrastructure contracts
// (factories, routers, fee splitters) legitimately have 0 token transfers
// and shouldn't be mistaken for abandoned drops.
//
// Returns `isDead: null` for non-token contracts so the aggregator can
// skip them entirely from the ratio.
async function checkContract(addr) {
  const [tk, counters] = await Promise.all([
    bsGet(`${BS}/tokens/${addr}`),
    bsGet(`${BS}/addresses/${addr}/counters`),
  ]);
  const isToken   = !!tk?.type;      // /tokens/{addr} 404s for non-token contracts
  const transfers = counters ? parseInt(counters.token_transfers_count || '0', 10) : null;
  const holders   = tk?.holders ? parseInt(tk.holders, 10) : null;
  return {
    address: addr,
    name:   tk?.name || null,
    symbol: tk?.symbol || null,
    type:   tk?.type || null,
    transfers,
    holders,
    isToken,
    // Dead = token contract with zero transfers and near-zero holders. Non-token
    // contracts get isDead:null so the caller can skip them from the pattern.
    isDead: isToken && transfers === 0 && (!holders || holders < 5)
      ? true
      : (isToken && transfers !== null ? false : null),
  };
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

  // Step 1: find the deployer. Blockscout stores creator_address_hash on
  // either /addresses/{addr} or /smart-contracts/{addr} depending on
  // whether the contract is verified — we try both. Inlined instead of
  // self-calling /api/deployer-history because a serverless self-call is
  // fragile (needs SELF_ORIGIN, doubles the network hops).
  const [addrInfo, sc] = await Promise.all([
    bsGet(`${BS}/addresses/${addr}`),
    bsGet(`${BS}/smart-contracts/${addr}`),
  ]);
  const deployer = (addrInfo?.creator_address_hash || sc?.creator_address_hash || '').toLowerCase() || null;
  if (!deployer) {
    const payload = {
      targetContract: addr,
      deployer: null,
      othersChecked: 0,
      dead: 0, alive: 0,
      verdict: 'unknown',
      others: [],
      note: 'deployer lookup failed. Blockscout /addresses is flaky on RHC.',
    };
    outCache.set(addr, { value: payload, expiresAt: now + 30_000 });
    res.setHeader('cache-control', 'public, max-age=30');
    res.statusCode = 200;
    res.end(JSON.stringify({ cached: false, ...payload }));
    return;
  }

  // Step 2: fetch the deployer's outgoing txs and pull out contract creations.
  const txs = await bsGet(`${BS}/addresses/${deployer}/transactions?filter=from`);
  const txItems = Array.isArray(txs?.items) ? txs.items : [];
  const otherDeploys = txItems
    .filter(t => t.created_contract || t.tx_types?.includes?.('contract_creation'))
    .map(t => (t.created_contract?.hash || '').toLowerCase())
    .filter(a => a && a !== addr);   // exclude the target
  const others = [...new Set(otherDeploys)].slice(0, MAX_TO_CHECK);

  if (others.length === 0) {
    // Nothing to compare against — first-timer, or history couldn't be paged.
    const hasMorePages = !!txs?.next_page_params;
    const payload = {
      targetContract: addr,
      deployer,
      othersChecked: 0,
      dead: 0, alive: 0,
      verdict: 'unknown',
      others: [],
      note: hasMorePages
        ? 'no other deploys on the recent tx page. older history not paged.'
        : 'this looks like the deployer\'s only contract.',
    };
    outCache.set(addr, { value: payload, expiresAt: now + TTL });
    res.setHeader('cache-control', 'public, max-age=300, s-maxage=900');
    res.statusCode = 200;
    res.end(JSON.stringify({ cached: false, ...payload }));
    return;
  }

  // Step 2: probe each other contract in parallel
  const results = await Promise.all(others.map(addr => checkContract(addr)));

  // Only token contracts count toward the rug-pattern ratio; non-token
  // infrastructure (factories, routers) is excluded via isDead === null.
  const dead    = results.filter(r => r.isDead === true).length;
  const alive   = results.filter(r => r.isDead === false).length;
  const checked = dead + alive;
  const skipped = results.length - checked;

  // Verdict thresholds. Rug pattern requires enough sample size to be
  // meaningful — 2 dead out of 2 checked is coincidence, 4 dead out of 5
  // is a pattern.
  let verdict = 'unknown';
  if (checked >= 3) {
    const deadRatio = dead / checked;
    if (deadRatio >= 0.6 && dead >= 3) verdict = 'rug_pattern';
    else if (deadRatio >= 0.4)         verdict = 'watch';
    else                                verdict = 'clean';
  }

  const payload = {
    targetContract: addr,
    deployer,
    othersChecked: checked,
    othersSkippedNonToken: skipped,
    dead,
    alive,
    verdict,
    others: results,
  };
  outCache.set(addr, { value: payload, expiresAt: now + TTL });
  res.setHeader('cache-control', 'public, max-age=300, s-maxage=900');
  res.statusCode = 200;
  res.end(JSON.stringify({ cached: false, ...payload }));
}
