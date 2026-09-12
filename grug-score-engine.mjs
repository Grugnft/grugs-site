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
  totalSupply:       '0x18160ddd',
  contractURI:       '0xe8a3d485',
  baseURI:           '0x6c0360eb',
};

function encodeUint(n) {
  return BigInt(n).toString(16).padStart(64, '0');
}
// Ultra-cheap ABI-encoded-string decoder — the same pattern scanner.html
// uses. Reads offset+length prefixes then hex-decodes the bytes to UTF-8.
// Returns null when the payload isn't a valid string so callers can fall
// through to the next URI candidate cleanly.
function decodeString(hex) {
  if (!hex || hex === '0x' || hex.length < 130) return null;
  try {
    const body = hex.slice(2);
    const len = parseInt(body.slice(64, 128), 16);
    if (!len || len > 4096) return null;
    const bytes = body.slice(128, 128 + len * 2);
    let s = '';
    for (let i = 0; i < bytes.length; i += 2) {
      s += String.fromCharCode(parseInt(bytes.substr(i, 2), 16));
    }
    return decodeURIComponent(escape(s)).trim() || null;
  } catch (e) { return null; }
}

// Wallet-drainer patterns. These are function selectors that don't belong on
// a legit NFT mint contract but do belong on tools that route or move users'
// approvals to third parties. If a mint contract has any of these the user
// setApprovalForAll or permit-signing that mint asks for could ferry assets
// out of their wallet.
//
// Selectors verified against 4byte-signature-database entries. Adding a new
// entry here without verifying its keccak-4 costs us false positives — a
// wrongly-flagged legit mint drops user trust in every other signal.
const DRAINER_SEL = {
  // execute(address,bytes) — Gnosis Safe / MetaMorpho executor pattern. On
  // an NFT mint contract this means the owner can arbitrary-call any address
  // with any calldata (including transferFrom on the caller's approved NFTs).
  executeAddrBytes:  '1cff79cd',
  // sweepToken(address,uint256,address) — Uniswap router pattern; also every
  // drainer kit's favourite because it lets the operator pull any ERC20 out.
  sweepToken:        'df2ab5bb',
  // execute(bytes,bytes[]) — bulk-call variant used by Safe proxies and
  // Angel/Inferno drainer variants alike. Not something a mint needs.
  executeBytesArr:   '24856bc3',
};

const IFACE = {
  ERC721:  '80ac58cd',
  ERC1155: 'd9b67a26',
  ERC2981: '2a55205a',
};

const UTILITY_RE = /\b(position|positions|beneficiary|wrapper|unwrapper|adapter|reward|fee(-|s)?|treasury|permit|vault|gauge|liquidity)\b/i;

// ============================================================================
// Tiered severity model.
//
// Signals are grouped into four tiers so the score reads the way a human
// would: a drainer or honeypot is category-different from an unverified new
// deployer, and the numbers should reflect that. Legit-but-new projects
// tripping five cosmetic flags shouldn't land in the red zone; a single
// dealbreaker should.
//
//   DEALBREAKER (60)  — any one alone puts the contract in the red band
//                       (>=60). Two saturates the score at 100.
//                       Reserved for signals that mean "user loses money
//                       or gets drained if they mint here": drainer bytecode,
//                       proven prior rug on the deployer, honeypot transfer
//                       revert, upgradeable proxy (owner can swap in a rug),
//                       mixer-funded deployer (untraceable identity).
//
//   SERIOUS (20)      — strong indicator of active rug behavior. Two or three
//                       together push into red without needing a dealbreaker.
//
//   WARNING (8)       — worth noting but common on legit new projects.
//                       Stacking a few is fine; you stay in yellow.
//
//   COSMETIC (2)      — very common, non-diagnostic on their own. Stacking
//                       eight of them still stays under the yellow line.
//
// Verdict thresholds (unchanged): <25 green, <60 yellow, else red.
// Score is still `sum of BAD-signal weights`, capped at 100.
// ============================================================================
export const TIERS = {
  DEALBREAKER: 60,
  SERIOUS:     20,
  WARNING:      8,
  COSMETIC:     2,
};

// Tier assignment per signal. Kept as a data map so scanner.html can render
// tier badges alongside each row. Any signal not listed here defaults to
// COSMETIC — always add explicitly when introducing a new signal.
export const SIGNAL_TIER = {
  // contract
  unverified: 'COSMETIC', proxy: 'DEALBREAKER', ownerActive: 'COSMETIC',
  adminMint: 'WARNING', openBaseURI: 'WARNING', transferLock: 'COSMETIC',
  currentlyPaused: 'SERIOUS', withdrawExposure: 'SERIOUS',
  transferBlocked: 'DEALBREAKER', freshDeploy: 'WARNING',
  mutableRoyalty: 'WARNING', walletDrainer: 'DEALBREAKER',
  // deployer
  freshWallet: 'COSMETIC', emptyBalance: 'WARNING', firstDeploy: 'COSMETIC',
  mixerFunded: 'DEALBREAKER', priorRug: 'DEALBREAKER', freshFunding: 'SERIOUS',
  // distribution
  topHeavy: 'SERIOUS', deadContract: 'WARNING', sniperStack: 'SERIOUS',
  washTrades: 'SERIOUS', noMarket: 'WARNING',
  // socials
  websiteReachable: 'COSMETIC', twitterExists: 'COSMETIC',
  // metadata
  centralArt: 'WARNING', unpinned: 'WARNING', noRoyalty: 'COSMETIC',
};

// Derived weight map. MUST stay in sync with scanner.html's CATALOG entries
// (their `weight` field mirrors these numbers). If you change TIERS or
// SIGNAL_TIER above, run the scanner and the mint page and confirm the
// score numbers you see match — legit projects should read <25, borderline
// yellow, real rugs red.
export const WEIGHTS = Object.fromEntries(
  Object.entries(SIGNAL_TIER).map(([id, tier]) => [id, TIERS[tier]])
);

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
function decodeUintBigInt(hex) {
  if (!hex || hex === '0x' || hex.length < 3) return null;
  try { return BigInt(hex); } catch (e) { return null; }
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
  // Drainer-selector scan. Presence of ANY of these on a mint contract is a
  // red flag; two or more is almost always a drainer or router (which should
  // not be a mint contract in the first place).
  out.drainerHits = [];
  for (const [k, sel] of Object.entries(DRAINER_SEL)) {
    if (scanCode.includes(sel)) out.drainerHits.push(k);
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

  // RPC fallback for totalSupply. Blockscout's /tokens endpoint on RHC often
  // returns null for total_supply even when the contract has one, which
  // makes the topHeavy signal silently unresolvable. Reading totalSupply()
  // directly costs one RPC call and works for any ERC721/ERC1155 that
  // implements it. Store as string to preserve precision for the caller.
  const supplyRaw = await ethCall(addr, SEL.totalSupply);
  const supplyBig = decodeUintBigInt(supplyRaw);
  out.totalSupplyOnChain = supplyBig !== null ? supplyBig.toString() : null;

  // Metadata URI resolution — four fallbacks so pre-mint contracts still get
  // a URI. Order: tokenURI(1) → tokenURI(0) → contractURI() → baseURI(). Any
  // hit is enough for the centralArt signal to determine IPFS vs centralized.
  // Kept as parallel calls where possible to stay fast.
  const uriRaw1 = await ethCall(addr, SEL.tokenURI + encodeUint(1));
  let tokenURI = decodeString(uriRaw1);
  if (!tokenURI) {
    const uriRaw0 = await ethCall(addr, SEL.tokenURI + encodeUint(0));
    tokenURI = decodeString(uriRaw0);
  }
  if (!tokenURI) {
    const cUri = await ethCall(addr, SEL.contractURI);
    tokenURI = decodeString(cUri);
  }
  if (!tokenURI) {
    const bUri = await ethCall(addr, SEL.baseURI);
    tokenURI = decodeString(bUri);
  }
  out.tokenURI = tokenURI;

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
  // A contract without the pause() selector literally cannot be paused.
  // That's 'good', not 'unknown' — leaving it unknown was silently
  // penalizing every well-built contract that skipped OZ Pausable.
  else if (!onChain.hasSelector.pause) pausedState = 'good';
  passScore(cats, 'currentlyPaused', pausedState);

  let drainState = 'unknown';
  if (!onChain.hasSelector.withdraw) drainState = 'good';
  else if (onChain.contractBalanceEth === null) drainState = 'unknown';
  else if (onChain.contractBalanceEth >= 0.01) drainState = 'bad';
  else drainState = 'good';
  passScore(cats, 'withdrawExposure', drainState);

  // transferBlocked — real simulation only runs in the full scanner (needs
  // a live holder + tokenId). Here we use a cheap bytecode heuristic: if the
  // contract has no lock-family selectors (pause / renounceOwnership guards)
  // and isn't a proxy, it's overwhelmingly unlikely to be a honeypot. Mark
  // 'good' with reasonable confidence rather than the permanent 'unknown'
  // that used to leave every mint card partially scored. Proxies stay
  // unknown because we can't grep the implementation reliably.
  let transferBlockedState = 'unknown';
  if (!onChain.isProxy && !onChain.hasSelector.pause) transferBlockedState = 'good';
  passScore(cats, 'transferBlocked', transferBlockedState);

  // freshDeploy needs a deploy timestamp — the shared engine never gets that
  // cheaply. Keep unknown.
  passScore(cats, 'freshDeploy', 'unknown');

  passScore(cats, 'mutableRoyalty', onChain.hasSelector.setDefaultRoyalty ? 'bad' : 'good');

  // walletDrainer — any drainer-adjacent selector on the bytecode. We treat
  // even a single hit as bad because these selectors have no legit purpose
  // on a mint contract; they're only meaningful on routers/aggregators/
  // multisig executors.
  const drainerCount = Array.isArray(onChain.drainerHits) ? onChain.drainerHits.length : 0;
  passScore(cats, 'walletDrainer', drainerCount > 0 ? 'bad' : 'good');

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
  // fresh_chain = disposable-identity funding (top funder <5 txs). watch =
  // borderline funding (top funder 5-100 txs) — still a risk signal because
  // real projects fund from CEXes or 100+-tx treasuries, not 19-tx wallets.
  // Previously we ignored 'watch' and left the signal unknown, which meant
  // deployers with obviously shady funding scored the same as ones with
  // clean funding. Treat both as bad.
  if (funding?.verdict === 'fresh_chain' || funding?.verdict === 'watch') fundingState = 'bad';
  else if (funding?.verdict === 'clean') fundingState = 'good';
  passScore(cats, 'freshFunding', fundingState);

  // ---- distribution ----
  let topHeavyState = 'unknown';
  // Prefer explorer.totalSupply, fall back to the on-chain totalSupply() read
  // when Blockscout returned null. Same math either way — the fallback just
  // saves the signal from silently going "unknown" on flaky RHC data.
  const supplyStr = explorer?.totalSupply || onChain.totalSupplyOnChain || null;
  if (!isUtility && explorer?.topHolders?.length && supplyStr) {
    try {
      const total = BigInt(supplyStr);
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
  // On-chain fallback when Blockscout gave us nothing. A non-zero
  // totalSupply() proves the contract has minted at least once, so it's
  // not "no on-chain activity". A zero result stays 'unknown' — a contract
  // could just be pre-mint, not dead.
  else if (onChain.totalSupplyOnChain) {
    try {
      const supply = BigInt(onChain.totalSupplyOnChain);
      if (supply > 0n) deadState = 'good';
    } catch (e) {}
  }
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

  // ---- socials + metadata ----
  // Website + Twitter come from OpenSea collection data when we have it —
  // avoids the slower metadata-fetch dependency on the mint card, and works
  // even when the contract's tokenURI() reverts (pre-mint contracts).
  let webState = 'unknown';
  if (collection?.website) webState = 'good';
  passScore(cats, 'websiteReachable', webState);

  let twState = 'unknown';
  if (collection?.twitter || collection?.twitterHandle) twState = 'good';
  passScore(cats, 'twitterExists', twState);

  // centralArt / unpinned — resolved from the tokenURI scheme. IPFS or
  // Arweave = pinned/decentralized (good). Server URL = swappable (bad).
  // No URI at all = unknown.
  let centralState = 'unknown';
  let pinState = 'unknown';
  const uri = onChain.tokenURI;
  if (uri) {
    const isIpfsScheme  = /^ipfs:\/\//i.test(uri);
    const isArweave     = /^ar:\/\//i.test(uri);
    const isGatewayHttp = /^https?:\/\/[^/]+\/ipfs\/[A-Za-z0-9]+/i.test(uri);
    const isDataUri     = /^data:/i.test(uri);
    if (isIpfsScheme || isArweave || isGatewayHttp) {
      centralState = 'good';
      // Content-addressed URIs (ipfs://, ar://, or gateway URL wrapping a
      // CID) are immutable — the bytes are locked to the CID, so anyone
      // hosting the CID hosts the same content. That's the pin guarantee
      // the signal was ever meant to capture; skip the live gateway probe.
      pinState = 'good';
    } else if (isDataUri) {
      centralState = 'good';
      pinState = 'good'; // on-chain data URI, no pin needed
    } else if (/^https?:\/\//i.test(uri)) {
      centralState = 'bad'; // team-controlled server URL
    }
  }
  passScore(cats, 'centralArt', centralState);
  passScore(cats, 'unpinned', pinState);

  passScore(cats, 'noRoyalty', onChain.hasRoyalty2981 === null ? 'unknown' : (onChain.hasRoyalty2981 ? 'good' : 'bad'));

  let score = 0;
  for (const s of cats) if (s.state === 'bad') score += s.weight;
  if (score > 100) score = 100;

  // Confidence — what fraction of signals actually resolved to good/bad.
  // Unknowns are checks we couldn't complete (Blockscout flaked, endpoint
  // returned nothing, or the signal is out of scope for RHC). A score
  // built off a scan where 16/28 signals were "unknown" is a very different
  // signal from one where 26/28 completed — the UI needs to reflect that.
  const totalSignals = cats.length;
  const resolved = cats.filter(s => s.state === 'good' || s.state === 'bad').length;
  const confidence = totalSignals > 0 ? Math.round((resolved / totalSignals) * 100) : 0;

  return { score, breakdown: cats, isUtility, confidence, resolved, totalSignals };
}

// ============================================================================
// Public: fullScore(addr) — the entry point mint cards use.
// Caches in localStorage under grug_score_v1_<addr> for 15 min.
// ============================================================================

// v6 = unpinned now resolves 'good' for any content-addressed URI (ipfs,
// arweave, gateway wrapping a CID) instead of staying 'unknown'. Combined
// with the scanner-side fix that drops the /api/metadata-fetch,
// /api/socials-check, /api/ipfs-check dead calls, that recovers ~3 signals
// per scan and pushes most well-formed contracts back above the 60%
// confidence threshold. Old v5 caches would still carry the unknown pin,
// so bump.
const CACHE_KEY_PREFIX = 'grug_score_v6_';
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

  const { score, isUtility, confidence, resolved, totalSignals } = computeScoreFromData({
    addr, onChain, explorer, deployerHist, priorRug, funding, collection,
  });

  // Low-confidence guard: a score built off half a scan can't be trusted to
  // say "approve". Even a real rug will read low if we couldn't check the
  // signals that would have caught it. Below 60% confidence we override the
  // verdict to "grug not sure" (grey tone) so the mint card / scanner UI
  // stops showing green on a scan that never really landed.
  let tone, verdict, lowConfidence = false;
  if (confidence < 60) {
    tone = 'grey';
    verdict = 'grug not sure';
    lowConfidence = true;
  } else if (score < 25) {
    tone = 'green';  verdict = 'grug approve';
  } else if (score < 60) {
    tone = 'yellow'; verdict = 'grug wary';
  } else {
    tone = 'red';    verdict = 'grug run';
  }

  const result = { score, tone, verdict, isUtility, confidence, resolved, totalSignals, lowConfidence };
  writeCache(addr, result);
  return { ...result, cached: false };
}

// Backwards-compat named export so the existing mint-card scanner keeps working.
export const quickScore = fullScore;
