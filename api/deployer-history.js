/**
 * Deployer history probe.
 *
 * Query: /api/deployer-history?addr=<contract-addr>
 *
 * Returns rich deployer info by hitting Blockscout server-side (no CORS,
 * better rate limits than browser). Used to score:
 *   - freshWallet   (tx count, wallet age)
 *   - priorRug      (deployed-contracts count and their status)
 *   - deployer_balance (rug indicator: near-empty wallet)
 *
 * Response:
 *   {
 *     creator: "0x…",
 *     creationTxHash: "0x…",
 *     deployBlock: 12345,
 *     txCount: 333,
 *     tokenTransferCount: 471,
 *     coinBalanceWei: "84730103613043",
 *     coinBalanceEth: 0.00008,
 *     deployedContractCount: 5,    // best-effort — see notes
 *     firstTxTimestamp: "2026-07-02T..."
 *   }
 */

// Function budget — see explorer-info.js for the reasoning. 4-attempt retry
// across ~6 parallel URLs needs headroom.
export const config = { maxDuration: 30 };

const BS = 'https://robinhoodchain.blockscout.com/api/v2';
// Per-attempt timeouts — first attempt gets the slow endpoint the benefit of
// the doubt, retries are tighter because if it's coming back at all it's
// usually coming back fast on attempt 2.
const TIMEOUT_FIRST_MS = 8000;
const TIMEOUT_RETRY_MS = 5000;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36';
// Backoff between attempts. 4 attempts total.
const BACKOFFS = [500, 1500, 3000];

// In-memory cache — shared across module reloads in dev via globalThis.
// The dev bridge cache-busts the api module per request, so a plain `const cache`
// would reset every call. On Vercel the module lives longer so the same
// globalThis reference just persists naturally between warm invocations.
const cache = (globalThis.__grugBsCache ||= new Map());
const TTL = 5 * 60 * 1000;

// Full browser-like header set — see api/explorer-info.js for the reasoning.
// Blockscout's Cloudflare rejects bare requests with 403; matching real-
// browser fetch metadata passes the check.
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
    // Preserve status alongside null so the caller can skip retries on 404s
    // (404 is definitive) but retry aggressively on 5xx / CF challenges.
    if (!r.ok) return { value: null, status: r.status };
    const ct = r.headers.get('content-type') || '';
    if (!/json/i.test(ct)) return { value: null, status: r.status };
    return { value: await r.json(), status: r.status };
  } catch (e) {
    clearTimeout(t);
    return { value: null, status: 0 };
  }
}

async function j(url) {
  const now = Date.now();
  const hit = cache.get(url);
  if (hit && hit.expiresAt > now) return hit.value;

  // Retry up to 3 times (4 attempts total) with growing backoff on transient
  // failures (network abort, 403 CF-check, 429 rate-limit, 5xx). Skip
  // retries on 404 — that's a real "not found", not a flake.
  const shouldRetry = r => r.value === null && (r.status === 0 || r.status === 403 || r.status === 429 || r.status >= 500);

  let result = await fetchOnce(url, TIMEOUT_FIRST_MS);
  for (let i = 0; i < BACKOFFS.length && shouldRetry(result); i++) {
    await new Promise(r => setTimeout(r, BACKOFFS[i]));
    result = await fetchOnce(url, TIMEOUT_RETRY_MS);
  }
  if (result.value !== null) cache.set(url, { value: result.value, expiresAt: now + TTL });
  return result.value;
}

async function findCreator(contract) {
  // Hit both — smart-contracts has creator for verified, addresses has creation_tx_hash reliably.
  const [sc, a] = await Promise.all([
    j(`${BS}/smart-contracts/${contract}`),
    j(`${BS}/addresses/${contract}`),
  ]);
  const creator = a?.creator_address_hash || sc?.creator_address_hash || null;
  const creationTxHash = a?.creation_tx_hash || sc?.creation_tx_hash || null;
  if (!creator) return null;
  return { creator, creationTxHash };
}

async function readDeployer(creator) {
  const [addr, counters] = await Promise.all([
    j(`${BS}/addresses/${creator}`),
    j(`${BS}/addresses/${creator}/counters`),
  ]);
  const out = {};
  if (addr) {
    out.coinBalanceWei = addr.coin_balance || null;
    out.hasTokens = !!addr.has_tokens;
    out.hasTokenTransfers = !!addr.has_token_transfers;
    out.isContract = addr.is_contract === true;
    out.labelName = addr.name || null;
  }
  if (counters) {
    out.txCount = parseInt(counters.transactions_count || '0', 10);
    out.tokenTransferCount = parseInt(counters.token_transfers_count || '0', 10);
    out.validationsCount = parseInt(counters.validations_count || '0', 10);
    out.gasUsageCount = counters.gas_usage_count || null;
  }

  // Best-effort deployed contracts count: fetch the first page of the
  // deployer's outgoing transactions and count `created_contract` hits.
  // First-page window is ~50 items — for large deployers we can't know the
  // full lifetime count without paging every page, so we only report a
  // count when it's a strong positive signal.
  const txs = await j(`${BS}/addresses/${creator}/transactions?filter=from`);
  if (txs && Array.isArray(txs.items)) {
    const items = txs.items;
    // Pick out actual contract-creation transactions on this page. Blockscout
    // v2 encodes these two different ways depending on version: `tx_types`
    // includes "contract_creation" OR `created_contract` is a populated object.
    const deploys = items.filter(t =>
      t.created_contract ||
      t.tx_types?.includes?.('contract_creation')
    );
    out.deployedContractCountRecent = deploys.length;
    out.txPageSize = items.length;
    out.hasMorePages = !!txs.next_page_params;

    // NEW: expose the addresses of the deployer's other deployed contracts,
    // capped to 12 so the response stays lean. This lets the scanner cheaply
    // spot the "serial deploy, all dead" rug pattern without another Blockscout
    // round trip. Filter out the target contract itself — we don't want the
    // scanner double-counting it against the deployer.
    out.deployedContracts = deploys
      .map(t => ({
        address: t.created_contract?.hash || null,
        timestamp: t.timestamp || null,
        block: t.block_number ?? null,
      }))
      .filter(d => d.address)
      .slice(0, 12);

    // Rough "first activity" seen on this page (may not be the true first tx
    // if the deployer has more pages — flagged via hasMorePages).
    const sorted = [...items].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    out.firstTxTimestampSeen = sorted[0]?.timestamp || null;
  } else {
    out.deployedContractCountRecent = null;
    out.firstTxTimestampSeen = null;
    out.deployedContracts = [];
  }

  return out;
}

async function readCreationTx(txHash) {
  if (!txHash) return null;
  const t = await j(`${BS}/transactions/${txHash}`);
  if (!t) return null;
  return {
    deployBlock: t.block_number,
    deployTimestamp: t.timestamp,
  };
}

export default async function handler(req, res) {
  const addr = (req.query && req.query.addr) ||
               new URL(req.url, 'http://x/').searchParams.get('addr');

  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('content-type', 'application/json');
  res.setHeader('cache-control', 'public, max-age=900, s-maxage=900'); // 15min

  if (!addr || !/^0x[0-9a-fA-F]{40}$/.test(addr)) {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: 'invalid_addr', hint: 'expected 0x… 40-hex' }));
    return;
  }

  const found = await findCreator(addr);
  if (!found) {
    // Return 200 with a sentinel so the scanner can distinguish "endpoint
    // failed" from "Blockscout has no creator for this contract" — a real
    // 404 confuses the scanner's error handling and hides the deployer
    // panel entirely when we could at least explain the situation.
    res.statusCode = 200;
    res.setHeader('cache-control', 'public, max-age=30');
    res.end(JSON.stringify({
      contract: addr,
      creator: null,
      error: 'no_creator_found',
      note: 'Blockscout /addresses and /smart-contracts both refused to say who deployed this contract. try again shortly.',
    }));
    return;
  }

  const [deployer, creationTx] = await Promise.all([
    readDeployer(found.creator),
    readCreationTx(found.creationTxHash),
  ]);

  const balanceWei = deployer.coinBalanceWei ? BigInt(deployer.coinBalanceWei) : 0n;
  const coinBalanceEth = Number(balanceWei) / 1e18;

  res.statusCode = 200;
  res.end(JSON.stringify({
    contract: addr,
    creator: found.creator,
    creationTxHash: found.creationTxHash,
    deployBlock: creationTx?.deployBlock ?? null,
    deployTimestamp: creationTx?.deployTimestamp ?? null,
    txCount: deployer.txCount ?? null,
    tokenTransferCount: deployer.tokenTransferCount ?? null,
    deployedContractCountRecent: deployer.deployedContractCountRecent ?? null,
    // Addresses of other contracts by this deployer (excluding this one),
    // up to 12. Scanner uses them to detect "serial deploy, all dead" rug
    // patterns; the mints page can use them to link related drops.
    deployedContracts: (deployer.deployedContracts || [])
      .filter(d => d.address && d.address.toLowerCase() !== addr.toLowerCase()),
    txPageSize: deployer.txPageSize ?? null,
    hasMorePages: !!deployer.hasMorePages,
    coinBalanceWei: deployer.coinBalanceWei ?? null,
    coinBalanceEth,
    labelName: deployer.labelName,
    firstTxTimestampSeen: deployer.firstTxTimestampSeen,
  }));
}
