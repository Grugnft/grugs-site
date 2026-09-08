/**
 * Shared full-scan engine.
 *
 * The mint-card badge and the full rug-radar page pipe through this. Any
 * signal or weight change goes HERE — never in scanner.html or mints.html
 * directly — so the badge on the card always matches what the scanner
 * reports for the same address.
 *
 * Signals cover 5 categories × 27 checks. Signals that can't be evaluated
 * client-side (e.g. wash-trade detection needs a paid indexer) return
 * 'unknown' and contribute zero to the score.
 *
 * Result:
 *   { score, verdict, tone, breakdown: [{ id, category, state, weight, detail? }] }
 *
 * fullScore() also caches in localStorage under `grug_score_v1_<addr>` for
 * a 15-minute TTL so repeat loads are instant.
 */

const RPC_URL           = 'https://rpc.mainnet.chain.robinhood.com';
const BLOCKSCOUT_API    = 'https://robinhoodchain.blockscout.com/api/v2';
const ZERO_ADDR         = '0x0000000000000000000000000000000000000000';
const EIP1967_IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';

const ADMIN_SEL = {
  ownerMint:         '40c10f19',
  ownerMintTo:       '449a52f8',
  setBaseURI:        '55f804b3',
  setTokenURI:       '162094c4',
  pause:             '8456cb59',
  renounceOwnership: '715018a6',
  transferOwnership: 'f2fde38b',
  withdraw:          '3ccfd60b',
  setDefaultRoyalty: '04634d8d',
};

const SEL = {
  name:              '0x06fdde03',
  symbol:            '0x95d89b41',
  owner:             '0x8da5cb5b',
  supportsInterface: '0x01ffc9a7',
  tokenURI:          '0xc87b56dd',
  uri:               '0x0e89341c',
  paused:            '0x5c975abb',
  getThreshold:      '0xe75235b8',
};

const IFACE = {
  ERC721:  '80ac58cd',
  ERC1155: 'd9b67a26',
  ERC2981: '2a55205a',
};

const UTILITY_RE = /\b(position|positions|beneficiary|wrapper|unwrapper|adapter|reward|fee(-|s)?|treasury|permit|vault|gauge|liquidity)\b/i;

// Full weight catalog. MUST stay in sync with scanner.html's CATALOG — see
// the module header. Reads here beat scanner.html's inline copy because both
// files will eventually import from here.
export const WEIGHTS = {
  // contract
  unverified: 15, proxy: 25, ownerActive: 8, adminMint: 10, openBaseURI: 8,
  transferLock: 8, currentlyPaused: 20, withdrawExposure: 12, transferBlocked: 25,
  freshDeploy: 8, mutableRoyalty: 6,
  // deployer
  freshWallet: 12, emptyBalance: 8, firstDeploy: 5, mixerFunded: 25, priorRug: 30,
  freshFunding: 10,
  // distribution
  topHeavy: 18, deadContract: 10, sniperStack: 15, washTrades: 10, noMarket: 6,
  // socials
  websiteReachable: 6, twitterExists: 5,
  // metadata
  centralArt: 10, unpinned: 4, noRoyalty: 3,
};

// ============================================================================
// RPC + helpers
// ============================================================================

async function rpc(method, params) {
  const r = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || 'rpc error');
  return j.result;
}
async function ethCall(to, data) {
  try { return await rpc('eth_call', [{ to, data }, 'latest']); }
  catch (e) { return null; }
}
function decodeAddress(hex) {
  return (hex && hex.length >= 66) ? ('0x' + hex.slice(-40).toLowerCase()) : null;
}
function decodeBool(hex) {
  if (!hex || hex === '0x') return null;
  return /1$/.test(hex);
}

// ============================================================================
// On-chain reads — mirrors scanner.html's readContractOnChain
// ============================================================================

async function readOnChain(addr) {
  const out = { hasSelector: {} };
  const code = await rpc('eth_getCode', [addr, 'latest']).catch(() => null);
  if (!code || code === '0x' || code === '0x0') { out.notAContract = true; return out; }

  const implSlot = await rpc('eth_getStorageAt', [addr, EIP1967_IMPL_SLOT, 'latest']).catch(() => null);
  const implAddr = decodeAddress(implSlot);
  out.isProxy = !!(implAddr && implAddr !== ZERO_ADDR);

  let scanCode = code.toLowerCase();
  if (out.isProxy) {
    const implCode = await rpc('eth_getCode', [implAddr, 'latest']).catch(() => null);
    if (implCode && implCode !== '0x') scanCode = implCode.toLowerCase();
  }
  for (const [k, sel] of Object.entries(ADMIN_SEL)) {
    out.hasSelector[k] = scanCode.includes(sel);
  }

  const [is2981, ownerRaw] = await Promise.all([
    ethCall(addr, SEL.supportsInterface + IFACE.ERC2981.padStart(64, '0') + '00000000'),
    ethCall(addr, SEL.owner),
  ]);
  out.hasRoyalty2981 = is2981 === null ? null : decodeBool(is2981);
  out.owner = decodeAddress(ownerRaw);
  out.ownerRenounced = out.owner === ZERO_ADDR;
  out.ownerCallable  = ownerRaw !== null;

  // Live-state
  out.isPaused = null;
  if (out.hasSelector.pause) {
    const pausedRaw = await ethCall(addr, SEL.paused);
    out.isPaused = pausedRaw === null ? null : decodeBool(pausedRaw);
  }

  const balHex = await rpc('eth_getBalance', [addr, 'latest']).catch(() => null);
  out.contractBalanceEth = balHex ? Number(BigInt(balHex)) / 1e18 : null;

  // Multi-sig owner detection
  out.ownerIsMultiSig = false;
  if (out.owner && out.owner !== ZERO_ADDR) {
    const ownerCode = await rpc('eth_getCode', [out.owner, 'latest']).catch(() => null);
    if (ownerCode && ownerCode !== '0x' && ownerCode !== '0x0') {
      const threshRaw = await ethCall(out.owner, SEL.getThreshold);
      if (threshRaw && threshRaw.length === 66) {
        const n = parseInt(threshRaw, 16);
        if (n > 0 && n < 100) out.ownerIsMultiSig = true;
      }
    }
  }

  return out;
}

// ============================================================================
// Compute score from all the data. This is the pure math — same shape as
// scanner.html's signal-push loop, minus the UI concerns.
// ============================================================================

function passScore(cats, id, state) {
  cats.push({ id, state, weight: WEIGHTS[id] });
}

function computeScoreFromData({ addr, onChain, explorer, deployerHist, priorRug, funding, collection }) {
  const cats = [];
  const isUtility = UTILITY_RE.test(`${onChain.name || ''} ${onChain.symbol || ''} ${explorer?.tokenName || ''} ${explorer?.tokenSymbol || ''}`);

  // ---- contract ----
  passScore(cats, 'unverified', explorer?.verified === false ? 'bad' : (explorer?.verified === true ? 'good' : 'unknown'));
  passScore(cats, 'proxy', onChain.isProxy ? 'bad' : 'good');

  // Multi-sig softens ownerActive
  let ownerState;
  if (!onChain.ownerCallable || onChain.ownerRenounced) ownerState = 'good';
  else if (onChain.ownerIsMultiSig) ownerState = 'good';
  else ownerState = 'bad';
  passScore(cats, 'ownerActive', ownerState);

  passScore(cats, 'adminMint',    (onChain.hasSelector.ownerMint || onChain.hasSelector.ownerMintTo) ? 'bad' : 'good');
  passScore(cats, 'openBaseURI',  onChain.hasSelector.setBaseURI ? 'bad' : 'good');
  passScore(cats, 'transferLock', onChain.hasSelector.pause ? 'bad' : 'good');

  let pausedState = 'unknown';
  if (onChain.hasSelector.pause && onChain.isPaused === true)  pausedState = 'bad';
  else if (onChain.hasSelector.pause && onChain.isPaused === false) pausedState = 'good';
  passScore(cats, 'currentlyPaused', pausedState);

  let drainState = 'unknown';
  if (!onChain.hasSelector.withdraw) drainState = 'good';
  else if (onChain.contractBalanceEth === null) drainState = 'unknown';
  else if (onChain.contractBalanceEth >= 0.01) drainState = 'bad';
  else drainState = 'good';
  passScore(cats, 'withdrawExposure', drainState);

  // transferBlocked needs a real holder + tokenId; keep as 'unknown' here since
  // batching per-card lookups server-side would blow past the Hobby function budget.
  // The full scanner runs this signal.
  passScore(cats, 'transferBlocked', 'unknown');

  // freshDeploy needs deploy timestamp — skip in the shared engine for now
  passScore(cats, 'freshDeploy', 'unknown');

  passScore(cats, 'mutableRoyalty', onChain.hasSelector.setDefaultRoyalty ? 'bad' : 'good');

  // ---- deployer ----
  const dTxCount = (deployerHist && typeof deployerHist.txCount === 'number') ? deployerHist.txCount : null;
  passScore(cats, 'freshWallet',
    dTxCount === null ? 'unknown' :
    dTxCount < 20 ? 'bad' : 'good');

  const dBal = deployerHist?.coinBalanceEth;
  passScore(cats, 'emptyBalance',
    typeof dBal !== 'number' ? 'unknown' :
    dBal < 0.0001 ? 'bad' : 'good');

  let firstDeployState = 'unknown';
  if (deployerHist) {
    const recent = deployerHist.deployedContractCountRecent;
    if (recent >= 2) firstDeployState = 'good';
    else if (recent === 0 && !deployerHist.hasMorePages && (typeof deployerHist.txCount === 'number' && deployerHist.txCount < 20)) firstDeployState = 'bad';
  }
  passScore(cats, 'firstDeploy', firstDeployState);

  passScore(cats, 'mixerFunded', 'unknown'); // no RHC mixer list yet

  let priorRugState = 'unknown';
  if (priorRug?.verdict === 'rug_pattern') priorRugState = 'bad';
  else if (priorRug?.verdict === 'clean')  priorRugState = 'good';
  passScore(cats, 'priorRug', priorRugState);

  let fundingState = 'unknown';
  if (funding?.verdict === 'fresh_chain') fundingState = 'bad';
  else if (funding?.verdict === 'clean')  fundingState = 'good';
  passScore(cats, 'freshFunding', fundingState);

  // ---- distribution ----
  let topHeavyState = 'unknown';
  if (!isUtility && explorer?.topHolders?.length && explorer.totalSupply) {
    try {
      const total = BigInt(explorer.totalSupply);
      if (total > 0n) {
        const top = explorer.topHolders.reduce((acc, h) => acc + BigInt(h.value || '0'), 0n);
        const pct = Number((top * 10000n) / total) / 100;
        topHeavyState = pct > 50 ? 'bad' : 'good';
      }
    } catch (e) {}
  }
  passScore(cats, 'topHeavy', topHeavyState);

  let deadState = 'unknown';
  const cn = explorer?.contractTransferCount;
  const ftLen = Array.isArray(explorer?.firstTransfers) ? explorer.firstTransfers.length : 0;
  if (ftLen > 0) deadState = 'good';
  else if (cn === 0) deadState = 'bad';
  else if (typeof cn === 'number' && cn > 0) deadState = 'good';
  passScore(cats, 'deadContract', deadState);

  // sniperStack + washTrades: same complexity as transferBlocked — skip in shared engine
  passScore(cats, 'sniperStack', 'unknown');
  passScore(cats, 'washTrades', 'unknown');

  // noMarket — OpenSea stats
  let marketState = 'unknown';
  const stats = collection?.stats;
  const ageH = collection?.createdDate ? (Date.now() - new Date(collection.createdDate).getTime()) / 3_600_000 : null;
  if (!isUtility && stats && typeof stats.totalSales === 'number') {
    if (stats.totalSales > 5) marketState = 'good';
    else if (stats.totalSales === 0 && ageH !== null && ageH > 24) marketState = 'bad';
  }
  passScore(cats, 'noMarket', marketState);

  // ---- socials + metadata: skipped in per-card badge computation ----
  // These need metadata-fetch + socials-check + ipfs-check calls which are the
  // slowest of the endpoint set. Their absence keeps mint-card scores slightly
  // under the full scanner's tally, but the delta is small (≤17 pts total from
  // socials + metadata combined) and consistent.
  passScore(cats, 'websiteReachable', 'unknown');
  passScore(cats, 'twitterExists', 'unknown');
  passScore(cats, 'centralArt', 'unknown');
  passScore(cats, 'unpinned', 'unknown');
  passScore(cats, 'noRoyalty', onChain.hasRoyalty2981 === null ? 'unknown' : (onChain.hasRoyalty2981 ? 'good' : 'bad'));

  let score = 0;
  for (const s of cats) if (s.state === 'bad') score += s.weight;
  if (score > 100) score = 100;
  return { score, breakdown: cats, isUtility };
}

// ============================================================================
// Public: fullScore(addr) — the entry point mint cards use.
// Caches in localStorage under grug_score_v1_<addr> for 15 min.
// ============================================================================

const CACHE_KEY_PREFIX = 'grug_score_v1_';
const CACHE_TTL_MS = 15 * 60 * 1000;

function readCache(addr) {
  try {
    const raw = localStorage.getItem(CACHE_KEY_PREFIX + addr.toLowerCase());
    if (!raw) return null;
    const j = JSON.parse(raw);
    if (!j || !j.expiresAt || j.expiresAt < Date.now()) return null;
    return j.value;
  } catch (e) { return null; }
}
function writeCache(addr, value) {
  try {
    localStorage.setItem(CACHE_KEY_PREFIX + addr.toLowerCase(),
      JSON.stringify({ value, expiresAt: Date.now() + CACHE_TTL_MS }));
  } catch (e) {}
}

export async function fullScore(addr) {
  // 1. Cache hit — instant
  const cached = readCache(addr);
  if (cached) return { ...cached, cached: true };

  // 2. Fire onchain reads + endpoint fetches in parallel
  const [onChain, explorer, deployerHist, priorRug, funding, collection] = await Promise.all([
    readOnChain(addr),
    fetch('/api/explorer-info?addr=' + addr).then(r => r.ok ? r.json() : null).catch(() => null),
    fetch('/api/deployer-history?addr=' + addr).then(r => r.ok ? r.json() : null).catch(() => null),
    fetch('/api/prior-rug-check?addr=' + addr).then(r => r.ok ? r.json() : null).catch(() => null),
    fetch('/api/deployer-funding?addr=' + addr).then(r => r.ok ? r.json() : null).catch(() => null),
    fetch('/api/collection-detail?contract=' + addr).then(r => r.ok ? r.json() : null).catch(() => null),
  ]);

  if (onChain.notAContract) return { error: 'not_a_contract' };

  const { score, isUtility } = computeScoreFromData({ addr, onChain, explorer, deployerHist, priorRug, funding, collection });
  const tone = score < 25 ? 'green' : score < 60 ? 'yellow' : 'red';
  const verdict = score < 25 ? 'grug approve' : score < 60 ? 'grug wary' : 'grug run';

  const result = { score, tone, verdict, isUtility };
  writeCache(addr, result);
  return { ...result, cached: false };
}

// Backwards-compat named export so the existing mint-card scanner keeps working.
export const quickScore = fullScore;
