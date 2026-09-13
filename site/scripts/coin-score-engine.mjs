/**
 * Coin Score Engine — sibling to grug-score-engine.mjs, ERC-20 focused.
 *
 * The NFT engine (grug-score-engine.mjs) covers ERC-721/1155. Coins have a
 * different threat model — metadata / royalty signals are irrelevant, but
 * mint dilution, blacklists, transfer taxes, and pool concentration matter
 * a lot more. This engine keeps the same 4-tier severity scaffolding
 * (dealbreaker → cosmetic) and reuses every backend endpoint that isn't
 * NFT-specific, so mint-card and outline UI code can wire either engine
 * behind the same fullScore(addr) contract.
 *
 * Result shape (mirrors grug-score-engine):
 *   { score, verdict, tone, breakdown, confidence, resolved, totalSignals,
 *     lowConfidence, isUtility }
 */

const RPC_URL           = 'https://rpc.mainnet.chain.robinhood.com';
const ZERO_ADDR         = '0x0000000000000000000000000000000000000000';
const EIP1967_IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';

// ============================================================================
// Function-selector fingerprints for ERC-20 risk signals.
//
// Every entry is the first 4 bytes of keccak256("funcName(argTypes)") — the
// same layout used by grug-score-engine's ADMIN_SEL. Presence in bytecode is
// necessary but not sufficient for a signal to fire "bad": we combine with
// live-state reads (owner renounced? paused right now? balance > 0?) so a
// contract that exposes mint() but has renounced ownership doesn't score
// worse than one that never had mint() at all.
// ============================================================================

const ADMIN_SEL = {
  ownerMint:          '40c10f19', // mint(address,uint256) — standard OZ
  ownerMintTo:        '449a52f8', // mintTo(address,uint256) — variant
  pause:              '8456cb59', // pause()
  unpause:            '3f4ba83a', // unpause()
  renounceOwnership:  '715018a6',
  transferOwnership:  'f2fde38b',
  // Blacklist / freeze family. Different token authors spell these different
  // ways; the presence of ANY implies the owner can freeze individual
  // wallets, which is a serious rug lever.
  blacklist:          'f9f92be4', // blacklist(address)
  addToBlacklist:     'ecea1ce7', // addToBlacklist(address) — some templates
  setBlacklist:       '471572e2', // setBlacklist(address,bool)
  removeFromBlacklist:'537df3b6',
  // Fee / tax family. Meme templates keep buy/sell taxes tunable so the
  // owner can raise them mid-launch. Presence with owner not renounced =
  // "team can flip the tax to 99% at any time" — classic soft-rug.
  setFee:             '69fe0e2d', // setFee(uint256)
  setFees:            '8b4c40b0', // setFees(uint256,uint256)
  setBuyTax:          '5d098b38', // setBuyTax(uint256)
  setSellTax:         'e79d4160', // setSellTax(uint256)
  setTaxFee:          'c49b9a80', // setTaxFee(uint256)
  // Uniswap-tax template's "excludeFromFee" toggle. Presence signals
  // preferential treatment for insider wallets.
  excludeFromFee:     '437823ec',
  // Trading gate family. Meme templates deploy with trading disabled, then
  // the owner flips the switch when they've stacked their bags. If the
  // switch exists AND owner isn't renounced, the owner can turn trading
  // off again mid-run.
  enableTrading:      '8a8c523c', // enableTrading()
  setTradingEnabled:  'c9567bf9', // setTradingEnabled(bool) / openTrading()
  // Max-wallet / max-tx caps. Standard rug template: set caps low during
  // launch (looks buyer-friendly), then raise them when insider wallets
  // want to dump. Presence with an active owner is the risk.
  setMaxWallet:       '75f0a874', // setMaxWalletSize(uint256)
  setMaxTx:           '751039fc', // setMaxTxAmount(uint256) — removeLimits() alias
};

const DRAINER_SEL = {
  executeAddrBytes:   '1cff79cd', // execute(address,bytes)
  sweepToken:         'df2ab5bb', // sweepToken(address,uint256,address)
  executeBytesArr:    '24856bc3', // execute(bytes,bytes[])
};

const SEL = {
  name:               '0x06fdde03',
  symbol:             '0x95d89b41',
  decimals:           '0x313ce567',
  totalSupply:        '0x18160ddd',
  owner:              '0x8da5cb5b',
  paused:             '0x5c975abb',
  getThreshold:       '0xe75235b8', // Gnosis Safe multi-sig detection
  balanceOf:          '0x70a08231',
  // Uniswap V2 Pair selectors — used by the LP-detection probe. A holder
  // that responds to getReserves() AND whose token0()/token1() include the
  // scanned token address is definitively a V2-style liquidity pool.
  getReserves:        '0x0902f1ac',
  token0:             '0x0dfe1681',
  token1:             '0xd21220a7',
};

// Tax-getter selectors used by the tax-rate measurement. These are the
// public getters that Uniswap-tax token templates expose so their frontend
// can show the current buy/sell tax. Not every rugged token exposes them —
// the truly sneaky ones inline the fee math without a getter — but the
// common OpenZeppelin-fork and BitBoy-fork templates do, which covers most
// of what actually gets deployed. Each getter returns a uint (basis points
// or percent depending on the template).
const TAX_GETTERS = {
  buyTax:             '0x1a686502', // buyTax() — direct
  sellTax:            '0xea2f0b37', // sellTax()
  _taxFee:            '0x5342acb4', // _taxFee() — reflection-fork
  _liquidityFee:      '0x8c0b5e22', // _liquidityFee() — reflection-fork LP fee
  totalFees:          '0x13114a9d', // totalFees() — combined
  marketingFee:       '0x8ee88c53', // marketingFee()
  buyMarketingFee:    '0xf0fa5b1a', // buyMarketingFee()
  sellMarketingFee:   '0x88790a68', // sellMarketingFee()
};

// Dead-address destinations LP tokens get sent to when they are burned. Any
// of these holding more than half of the LP token supply means the LP is
// effectively burned — the tokens are unrecoverable, so nobody can pull
// liquidity out of the pool.
const BURN_ADDRS = [
  '0x0000000000000000000000000000000000000000',
  '0x000000000000000000000000000000000000dead',
  '0x0000000000000000000000000000000000000001', // some templates use 0x1
];

// Utility / infrastructure name patterns. Wrapped tokens, staking wrappers,
// gauges, positions — these legitimately concentrate supply (a wrapper holds
// the entire underlying pool by design), so topHeavy / singleHolderDominant
// should not fire against them.
const UTILITY_RE = /\b(weth|wrap|wrapped|position|vault|gauge|adapter|reward|wrapper)\b/i;

// Well-known DEX pair / router contract signatures. When one of these is
// among the top holders we EXCLUDE its balance from the concentration math
// (a legit LP pool holding 40% of supply is what liquidity is supposed to
// look like). We don't have a full RHC router registry yet — v1 uses a
// small allowlist of obvious pair-contract patterns and marks lpDetected
// as 'unknown' otherwise.
const KNOWN_LP_LABELS = /\b(pair|pool|lp|liquidity|router)\b/i;

// Known RHC-native infrastructure addresses. Robinhood Chain runs Uniswap V4:
// every pool's reserves live inside a single PoolManager singleton, so on
// V4-only chains every tradeable token has this contract as its top holder.
// Treat these addresses as LP infrastructure — exclude them from concentration
// math AND count their presence as confirmed on-chain liquidity.
const KNOWN_INFRA_ADDRS = new Set([
  '0x8366a39cc670b4001a1121b8f6a443a643e40951', // Uniswap V4 PoolManager (RHC)
]);

// ============================================================================
// Tier model (same values as grug-score-engine so the verdict bands line up).
// ============================================================================
export const TIERS = {
  DEALBREAKER: 60,
  SERIOUS:     20,
  WARNING:      8,
  COSMETIC:     2,
};

export const SIGNAL_TIER = {
  // contract
  unverified:        'SERIOUS',
  proxy:             'DEALBREAKER',
  ownerActive:       'COSMETIC',
  mintable:          'SERIOUS',
  pausable:          'WARNING',
  currentlyPaused:   'DEALBREAKER',
  blacklistable:     'SERIOUS',
  feeChangeable:     'SERIOUS',
  walletDrainer:     'DEALBREAKER',
  freshDeploy:       'WARNING',
  // NEW ERC-20 patterns
  tradingGate:       'WARNING',   // enableTrading / openTrading selector present
  maxLimitControl:   'WARNING',   // setMaxWallet / setMaxTx selectors present
  honeypotSim:       'DEALBREAKER', // simulated transfer reverted with lock keywords
  // deployer (reused from NFT engine)
  freshWallet:       'COSMETIC',
  emptyBalance:      'WARNING',
  firstDeploy:       'COSMETIC',
  mixerFunded:       'DEALBREAKER',
  priorRug:          'DEALBREAKER',
  freshFunding:      'SERIOUS',
  // distribution
  topHeavyErc20:     'SERIOUS',
  singleHolderDominant: 'SERIOUS',
  deployerHoldsBig:  'SERIOUS',   // deployer address is in top holders with >10%
  noHolders:         'WARNING',
  deadContract:      'WARNING',
  // market
  lpDetected:        'WARNING',    // no LP pair found (nothing to trade against)
  lpBurned:          'COSMETIC',   // LP tokens 50%+ at burn address (positive)
  lpUnlocked:        'DEALBREAKER', // LP tokens held by deployer/EOA — rugpull vector
  currentBuyTax:     'SERIOUS',    // current buy tax > 10%
  currentSellTax:    'SERIOUS',    // current sell tax > 10%
};

export const WEIGHTS = Object.fromEntries(
  Object.entries(SIGNAL_TIER).map(([id, tier]) => [id, TIERS[tier]])
);

// ============================================================================
// RPC helpers — identical to grug-score-engine's for consistency.
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

// ============================================================================
// On-chain reads — mirrors readOnChain in grug-score-engine.
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
  out.drainerHits = [];
  for (const [k, sel] of Object.entries(DRAINER_SEL)) {
    if (scanCode.includes(sel)) out.drainerHits.push(k);
  }

  // Parallel-fire the header reads. Name and symbol drive utility detection;
  // decimals + totalSupply drive the distribution math.
  const [nameRaw, symRaw, decRaw, supplyRaw, ownerRaw] = await Promise.all([
    ethCall(addr, SEL.name),
    ethCall(addr, SEL.symbol),
    ethCall(addr, SEL.decimals),
    ethCall(addr, SEL.totalSupply),
    ethCall(addr, SEL.owner),
  ]);
  out.name        = decodeString(nameRaw);
  out.symbol      = decodeString(symRaw);
  out.decimals    = decRaw && decRaw !== '0x' ? parseInt(decRaw, 16) : null;
  const supplyBig = decodeUintBigInt(supplyRaw);
  out.totalSupplyOnChain = supplyBig !== null ? supplyBig.toString() : null;
  out.owner          = decodeAddress(ownerRaw);
  out.ownerRenounced = out.owner === ZERO_ADDR;
  out.ownerCallable  = ownerRaw !== null;

  // Paused-live only when pause() is present.
  out.isPaused = null;
  if (out.hasSelector.pause) {
    const pausedRaw = await ethCall(addr, SEL.paused);
    out.isPaused = pausedRaw === null ? null : decodeBool(pausedRaw);
  }

  // Owner-is-contract detection. We split this two ways: `ownerIsMultiSig`
  // is the strict Gnosis Safe check (softens ownerActive against a known
  // multi-sig pattern), while `ownerIsContract` is the broader "the owner
  // has bytecode at all" check that catches bridge multisigs, DAOs,
  // timelock controllers, and every other institutional custody pattern.
  // Bridged canonical tokens (LINK, USDG, CBBTC on RHC) trip both checks
  // — their owner is a bridge or governance contract, never a plain EOA.
  out.ownerIsMultiSig = false;
  out.ownerIsContract = false;
  if (out.owner && out.owner !== ZERO_ADDR) {
    const ownerCode = await rpc('eth_getCode', [out.owner, 'latest']).catch(() => null);
    if (ownerCode && ownerCode !== '0x' && ownerCode !== '0x0') {
      out.ownerIsContract = true;
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
// Honeypot simulation. Grab a real (holder, balance) pair from the on-chain
// balanceOf reads on the top holders and simulate transfer() via eth_call
// from that holder to a dead-ish destination. Revert reasons split three
// ways:
//   1. Lock keyword (paused / blacklisted / locked / not allowed / disabled)
//      → definitive honeypot. Scores BAD.
//   2. Approval / allowance revert → standard ERC-20 permission check, means
//      transfers work fine when authorized. Scores GOOD.
//   3. Anything else → can't judge, stays UNKNOWN.
//
// We pick a small-but-nonzero transfer amount (1 unit at whatever decimals)
// so the simulation succeeds on any balance-holder without needing a full
// per-holder balance read.
// ============================================================================

// ============================================================================
// LP-pair detection. Iterate the token's top holders; for each holder that
// has bytecode, probe `getReserves()`. A successful non-empty return is a
// Uniswap V2 Pair (or a fork of it — SushiSwap, PancakeSwap templates
// all share the interface). We further verify by calling `token0()` /
// `token1()` — one of them should equal the token being scanned. This is
// registry-free: works with any DEX on RHC that ships a V2-style factory
// without us needing to hard-code its address.
//
// Returns null when nothing looks like an LP, or:
//   { pair, otherToken, reservesBig, isV2 }
// ============================================================================
async function findLpPair(tokenAddr, topHolders) {
  if (!Array.isArray(topHolders) || topHolders.length === 0) return null;
  const target = tokenAddr.toLowerCase();

  // First pass: V4-style. On Uniswap V4 chains (RHC), the PoolManager
  // singleton holds every pool's reserves — no per-pair contract exists.
  // If it shows up in top holders holding real balance, that is confirmed
  // liquidity even though we can't return a pair address.
  for (const h of topHolders.slice(0, 10)) {
    const holder = (h.address || '').toLowerCase();
    if (KNOWN_INFRA_ADDRS.has(holder)) {
      return { pair: null, otherToken: null, isV4: true, poolManager: holder };
    }
  }

  // Second pass: V2-style. Iterate top holders; probe getReserves() +
  // token0/token1. Works for any V2 fork without a router registry.
  for (const h of topHolders.slice(0, 10)) {
    const holder = (h.address || '').toLowerCase();
    if (!holder || /^0x0+$/.test(holder)) continue;
    // Skip if it's an EOA (no code); pair contracts always have code.
    const code = await rpc('eth_getCode', [holder, 'latest']).catch(() => null);
    if (!code || code === '0x' || code === '0x0') continue;
    // Probe getReserves(). A V2 pair returns three uint values packed into
    // 96 bytes (32*3). Anything else (revert, empty, wrong shape) fails.
    const rRaw = await ethCall(holder, SEL.getReserves);
    if (!rRaw || rRaw === '0x' || rRaw.length < 194) continue;
    // Confirm one of the tokens in the pair is our target. Some pool
    // contracts implement getReserves() for unrelated reasons — verifying
    // token0/token1 keeps us from mis-identifying an incidental pool.
    const [t0Raw, t1Raw] = await Promise.all([
      ethCall(holder, SEL.token0),
      ethCall(holder, SEL.token1),
    ]);
    const t0 = decodeAddress(t0Raw);
    const t1 = decodeAddress(t1Raw);
    if (t0 !== target && t1 !== target) continue;
    const otherToken = t0 === target ? t1 : t0;
    return { pair: holder, otherToken, isV2: true };
  }
  return null;
}

// LP burn / lock status. Given the pair address, read the pair's LP-token
// totalSupply and the balance held at the standard burn addresses. If more
// than 50% of LP supply is at a burn address, liquidity is permanently
// locked (nobody can pull it). We also check whether the deployer address
// holds LP tokens — that's the rug lever (deployer pulls their share of
// the liquidity, price collapses).
async function checkLpLockStatus(pairAddr, deployerAddr) {
  const supplyRaw = await ethCall(pairAddr, SEL.totalSupply);
  const supply = decodeUintBigInt(supplyRaw);
  if (!supply || supply === 0n) return { supply: null, burnedPct: null, deployerPct: null };
  const burnBalances = await Promise.all(BURN_ADDRS.map(a => {
    const data = SEL.balanceOf + a.slice(2).padStart(64, '0');
    return ethCall(pairAddr, data);
  }));
  let burnedSum = 0n;
  for (const b of burnBalances) {
    const v = decodeUintBigInt(b);
    if (v) burnedSum += v;
  }
  const burnedPct = Number((burnedSum * 10000n) / supply) / 100;
  let deployerPct = null;
  if (deployerAddr && !/^0x0+$/.test(deployerAddr)) {
    const dRaw = await ethCall(pairAddr,
      SEL.balanceOf + deployerAddr.slice(2).padStart(64, '0'));
    const d = decodeUintBigInt(dRaw);
    if (d !== null) deployerPct = Number((d * 10000n) / supply) / 100;
  }
  return { supply: supply.toString(), burnedPct, deployerPct };
}

// Tax-rate readout. Try every known Uniswap-tax getter selector; sum the
// buy-side and sell-side taxes independently. Templates differ in units
// (basis points, percent × 10, plain percent), so we're conservative and
// assume "small integers up to ~100 = percent, larger = basis points" —
// good enough for the > 10% threshold that actually matters.
async function readTaxRates(tokenAddr) {
  const results = {};
  await Promise.all(Object.entries(TAX_GETTERS).map(async ([name, sel]) => {
    const raw = await ethCall(tokenAddr, sel);
    const v = decodeUintBigInt(raw);
    if (v !== null && v < 100000n) results[name] = Number(v);
  }));
  if (Object.keys(results).length === 0) return null;
  // Heuristic: values >= 100 are almost certainly basis points (10000 = 100%).
  // Values under 100 are percent. Normalize everything to percent.
  const toPct = v => v >= 100 ? v / 100 : v;
  const buy = (results.buyTax != null ? toPct(results.buyTax) : 0) +
              (results.buyMarketingFee != null ? toPct(results.buyMarketingFee) : 0);
  const sell = (results.sellTax != null ? toPct(results.sellTax) : 0) +
               (results.sellMarketingFee != null ? toPct(results.sellMarketingFee) : 0);
  const reflection = (results._taxFee != null ? toPct(results._taxFee) : 0) +
                     (results._liquidityFee != null ? toPct(results._liquidityFee) : 0);
  const total = results.totalFees != null ? toPct(results.totalFees) : null;
  return {
    raw: results,
    buyPct: buy || null,
    sellPct: sell || null,
    reflectionPct: reflection || null,
    totalPct: total,
  };
}

async function simulateErc20Transfer(tokenAddr, fromHolder, decimals) {
  // dead address destination — some tokens revert to true zero for reasons
  // other than "paused" (compliance blocklist on address(0)), muddying the
  // signal. 0xdead is neutral.
  const dest = '0x000000000000000000000000000000000000dEaD';
  const amount = 1n; // smallest positive unit — proves transfer() executes end-to-end
  // ABI-encode transfer(address,uint256): selector a9059cbb, then dest padded,
  // then amount padded.
  const data = '0xa9059cbb' +
    dest.slice(2).toLowerCase().padStart(64, '0') +
    amount.toString(16).padStart(64, '0');
  try {
    const r = await fetch(RPC_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'eth_call',
        params: [{ to: tokenAddr, from: fromHolder, data }, 'latest'],
      }),
    });
    const j = await r.json();
    if (j.error) {
      const msg = String(j.error.message || j.error.data || '').toLowerCase();
      return { success: false, reason: msg };
    }
    return { success: true };
  } catch (e) {
    return { success: null, reason: (e.message || 'network_error').toLowerCase() };
  }
}

// ============================================================================
// Score computation — pure math over resolved data, mirrors grug-score-engine.
// ============================================================================

function passScore(cats, id, state) {
  cats.push({ id, state, weight: WEIGHTS[id] });
}

function computeScoreFromData({ addr, onChain, explorer, deployerHist, priorRug, funding, honeypot, lp, lpLock, taxes }) {
  const cats = [];
  // Utility detection expanded. The narrow name regex catches WETH / vaults /
  // gauges. The broader bridge check catches canonical bridged tokens
  // (LINK, USDG, CBBTC, etc.) whose owner is a contract (bridge multi-sig /
  // governance timelock), source is verified, and the token has a real
  // holder base. These tokens legitimately trip proxy / mintable /
  // ownerActive / topHeavy — the "rug" heuristics don't apply because the
  // trust model is the bridge, not an anonymous team.
  const nameMatchesUtility = UTILITY_RE.test(`${onChain.name || ''} ${onChain.symbol || ''} ${explorer?.tokenName || ''} ${explorer?.tokenSymbol || ''}`);
  // Bridge / institutional-custody test. We drop the holder threshold on
  // purpose: RHC is early, and canonical bridged assets (LINK, CBBTC) don't
  // yet have millions of holders here even though they do on mainnet. A
  // scam that goes to the trouble of deploying verified source + a
  // multi-sig owner is at least a well-organized one; if this ever produces
  // a false clean read we can tighten with a maintained trust list.
  const looksBridged = (
    onChain.ownerIsContract === true &&
    explorer?.verified === true
  );
  const isUtility = nameMatchesUtility || looksBridged;

  // ---- contract ----
  passScore(cats, 'unverified', explorer?.verified === false ? 'bad' : (explorer?.verified === true ? 'good' : 'unknown'));

  // Utility-token exemptions. Wrapped/bridged tokens (WETH, wrapped BTC,
  // stablecoin bridges) are legitimately proxies, legitimately have owner
  // mint (to mirror deposits), and are legitimately deployed by bridge or
  // factory contracts rather than a human deployer. Applying rug-heuristics
  // designed for launch-token contracts to a wrapped bridge asset returns
  // a false 'grug run' verdict every time — WETH would score red on any
  // sensible token-launch model. When the name/symbol matches the utility
  // pattern (weth / wrap / vault / position / gauge / ...), we mark these
  // signals as 'good' with a utility-note so the score reads the way a
  // human would rate the asset.
  passScore(cats, 'proxy', onChain.isProxy && !isUtility ? 'bad' : 'good');

  let ownerState;
  if (!onChain.ownerCallable || onChain.ownerRenounced) ownerState = 'good';
  else if (onChain.ownerIsMultiSig) ownerState = 'good';
  else if (isUtility) ownerState = 'good';
  else ownerState = 'bad';
  passScore(cats, 'ownerActive', ownerState);

  // mintable — only fires bad when mint exists AND owner isn't renounced /
  // multi-sig. Wrapped tokens have mint by design (bridge deposits mint
  // wrapped supply), so utility skips too.
  const hasMint = onChain.hasSelector.ownerMint || onChain.hasSelector.ownerMintTo;
  let mintState = 'good';
  if (hasMint && !isUtility) {
    if (!onChain.ownerCallable || onChain.ownerRenounced || onChain.ownerIsMultiSig) mintState = 'good';
    else mintState = 'bad';
  }
  passScore(cats, 'mintable', mintState);

  passScore(cats, 'pausable', onChain.hasSelector.pause && !isUtility ? 'bad' : 'good');

  // currentlyPaused — dealbreaker if a paused contract lands in front of a
  // buyer right now; otherwise good (no pause selector = can't be paused).
  let pausedState = 'good';
  if (onChain.hasSelector.pause && onChain.isPaused === true) pausedState = 'bad';
  else if (onChain.hasSelector.pause && onChain.isPaused === null) pausedState = 'unknown';
  passScore(cats, 'currentlyPaused', pausedState);

  // blacklistable / feeChangeable — freeze/tax controls on a wrapped token
  // are usually compliance-mandated (regulated stablecoin bridges), not a
  // rug lever. Utility exemption applies here too.
  const hasBlacklist = onChain.hasSelector.blacklist || onChain.hasSelector.addToBlacklist ||
                       onChain.hasSelector.setBlacklist || onChain.hasSelector.removeFromBlacklist;
  let blacklistState = 'good';
  if (hasBlacklist && !isUtility) {
    if (!onChain.ownerCallable || onChain.ownerRenounced) blacklistState = 'good';
    else blacklistState = 'bad';
  }
  passScore(cats, 'blacklistable', blacklistState);

  const hasFeeCtrl = onChain.hasSelector.setFee || onChain.hasSelector.setFees ||
                     onChain.hasSelector.setBuyTax || onChain.hasSelector.setSellTax ||
                     onChain.hasSelector.setTaxFee || onChain.hasSelector.excludeFromFee;
  let feeState = 'good';
  if (hasFeeCtrl && !isUtility) {
    if (!onChain.ownerCallable || onChain.ownerRenounced) feeState = 'good';
    else feeState = 'bad';
  }
  passScore(cats, 'feeChangeable', feeState);

  const drainerCount = Array.isArray(onChain.drainerHits) ? onChain.drainerHits.length : 0;
  passScore(cats, 'walletDrainer', drainerCount > 0 ? 'bad' : 'good');

  passScore(cats, 'freshDeploy', 'unknown'); // needs deploy timestamp — full radar page fills

  // tradingGate — enableTrading / openTrading selector in bytecode. A
  // contract with a trading gate and an active owner can turn transfers
  // back off after launch, or delay them indefinitely. Renounced owner
  // means the switch is stuck wherever it currently sits — usually "on"
  // once the token is trading — so we let it pass.
  const hasTradingGate = onChain.hasSelector.enableTrading || onChain.hasSelector.setTradingEnabled;
  let tradingState = 'good';
  if (hasTradingGate && !isUtility) {
    if (!onChain.ownerCallable || onChain.ownerRenounced || onChain.ownerIsMultiSig) tradingState = 'good';
    else tradingState = 'bad';
  }
  passScore(cats, 'tradingGate', tradingState);

  // maxLimitControl — setMaxWallet / setMaxTx selectors. Templates that
  // let the owner move these caps at any time are a classic soft-rug lever
  // (drop caps to zero and only whitelisted wallets can trade).
  const hasMaxLimit = onChain.hasSelector.setMaxWallet || onChain.hasSelector.setMaxTx;
  let maxLimitState = 'good';
  if (hasMaxLimit && !isUtility) {
    if (!onChain.ownerCallable || onChain.ownerRenounced || onChain.ownerIsMultiSig) maxLimitState = 'good';
    else maxLimitState = 'bad';
  }
  passScore(cats, 'maxLimitControl', maxLimitState);

  // honeypotSim — real transfer simulation. Result comes in via the honeypot
  // arg (the full radar page runs the sim, the shared engine leaves it null
  // and reports unknown — same shape as freshDeploy).
  let honeypotState = 'unknown';
  if (honeypot && honeypot.status) {
    if (honeypot.status === 'honeypot') honeypotState = 'bad';
    else if (honeypot.status === 'transfers_work') honeypotState = 'good';
  }
  passScore(cats, 'honeypotSim', honeypotState);

  // ---- deployer ---- (identical shape to NFT engine)
  // For utility tokens the "deployer" recorded on-chain is typically a
  // bridge or factory contract, not a human wallet. Running fresh-wallet /
  // empty-balance / first-deploy heuristics against a bridge init contract
  // always trips them (bridges have no tx history of their own, hold no
  // ETH, and each bridged asset is a "single deploy"). Skip these signals
  // and let confidence drop — an honest 'unknown' beats a false 'bad'.
  const dTxCount = (deployerHist && typeof deployerHist.txCount === 'number') ? deployerHist.txCount : null;
  passScore(cats, 'freshWallet',
    isUtility ? 'unknown' :
    dTxCount === null ? 'unknown' :
    dTxCount < 20 ? 'bad' : 'good');

  const dBal = deployerHist?.coinBalanceEth;
  passScore(cats, 'emptyBalance',
    isUtility ? 'unknown' :
    typeof dBal !== 'number' ? 'unknown' :
    dBal < 0.0001 ? 'bad' : 'good');

  let firstDeployState = 'unknown';
  if (!isUtility && deployerHist) {
    const recent = deployerHist.deployedContractCountRecent;
    if (recent >= 2) firstDeployState = 'good';
    else if (recent === 0 && !deployerHist.hasMorePages && (typeof deployerHist.txCount === 'number' && deployerHist.txCount < 20)) firstDeployState = 'bad';
  }
  passScore(cats, 'firstDeploy', firstDeployState);

  passScore(cats, 'mixerFunded', 'unknown');

  let priorRugState = 'unknown';
  if (!isUtility) {
    if (priorRug?.verdict === 'rug_pattern') priorRugState = 'bad';
    else if (priorRug?.verdict === 'clean')  priorRugState = 'good';
  }
  passScore(cats, 'priorRug', priorRugState);

  let fundingState = 'unknown';
  if (!isUtility) {
    if (funding?.verdict === 'fresh_chain' || funding?.verdict === 'watch') fundingState = 'bad';
    else if (funding?.verdict === 'clean') fundingState = 'good';
  }
  passScore(cats, 'freshFunding', fundingState);

  // ---- distribution ----
  // topHeavyErc20 and singleHolderDominant share the same holder math but
  // read different thresholds. We exclude any top holder whose label looks
  // like an LP contract from the concentration total — a Uniswap pair
  // holding 40% of supply is what makes the token tradeable, not a rug.
  let topHeavyState = 'unknown';
  let singleState = 'unknown';
  const supplyStr = explorer?.totalSupply || onChain.totalSupplyOnChain || null;
  if (!isUtility && Array.isArray(explorer?.topHolders) && explorer.topHolders.length > 0 && supplyStr) {
    try {
      const total = BigInt(supplyStr);
      if (total > 0n) {
        // Filter LP-labelled and known-infrastructure holders out of
        // concentration math. The V4 PoolManager holding 40% of supply is
        // liquidity, not concentration.
        const nonLp = explorer.topHolders.filter(h => {
          const label = h.label || '';
          const addr = (h.address || '').toLowerCase();
          if (KNOWN_LP_LABELS.test(label)) return false;
          if (KNOWN_INFRA_ADDRS.has(addr)) return false;
          return true;
        });
        const topSum = nonLp.reduce((acc, h) => acc + BigInt(h.value || '0'), 0n);
        const pctTop10 = Number((topSum * 10000n) / total) / 100;
        topHeavyState = pctTop10 > 60 ? 'bad' : 'good';

        if (nonLp.length > 0) {
          const topOne = BigInt(nonLp[0].value || '0');
          const pctTop1 = Number((topOne * 10000n) / total) / 100;
          singleState = pctTop1 > 30 ? 'bad' : 'good';
        }
      }
    } catch (e) {}
  }
  passScore(cats, 'topHeavyErc20', topHeavyState);
  passScore(cats, 'singleHolderDominant', singleState);

  // deployerHoldsBig — cross-check the deployer address (from
  // deployer-history) against the token's top holders. A deployer that
  // also holds > 10% of supply is an insider concentration flag: they can
  // dump into the LP and nuke the price. Bridged tokens are exempt (the
  // "deployer" is a bridge factory, which doesn't hold token supply).
  let deployerBigState = 'unknown';
  const deployerAddr = deployerHist?.creator ? deployerHist.creator.toLowerCase() : null;
  if (!isUtility && deployerAddr && Array.isArray(explorer?.topHolders) && supplyStr) {
    try {
      const total = BigInt(supplyStr);
      if (total > 0n) {
        const deployerRow = explorer.topHolders.find(h => (h.address || '').toLowerCase() === deployerAddr);
        if (deployerRow) {
          const held = BigInt(deployerRow.value || '0');
          const pct = Number((held * 10000n) / total) / 100;
          deployerBigState = pct > 10 ? 'bad' : 'good';
        } else {
          // Deployer isn't in top 10 → they hold at most whatever the tenth
          // holder holds. That's a positive, not a data gap.
          deployerBigState = 'good';
        }
      }
    } catch (e) {}
  }
  passScore(cats, 'deployerHoldsBig', deployerBigState);

  // noHolders — a live token with fewer than 5 holders is either brand-new
  // or nobody wants it. Only marks bad when age > 24h is known (deferred to
  // the UI page, which has deploy timestamp) — engine version stays coarse.
  let holdersState = 'unknown';
  const holdersN = explorer?.holdersCount;
  if (typeof holdersN === 'number') {
    if (holdersN >= 20) holdersState = 'good';
    else if (holdersN <= 3) holdersState = 'bad';
  }
  passScore(cats, 'noHolders', holdersState);

  // deadContract mirrors NFT engine — 0 transfers = bad, > 0 = good.
  let deadState = 'unknown';
  const cn = explorer?.contractTransferCount;
  const ftLen = Array.isArray(explorer?.firstTransfers) ? explorer.firstTransfers.length : 0;
  if (ftLen > 0) deadState = 'good';
  else if (cn === 0) deadState = 'bad';
  else if (typeof cn === 'number' && cn > 0) deadState = 'good';
  passScore(cats, 'deadContract', deadState);

  // lpDetected — did we find a UniV2-style pair among top holders? RHC
  // may run V3 pools or non-UniV2 AMMs we can't detect this way, so
  // "found" scores good but "not found" stays unknown rather than bad —
  // absence of evidence, not evidence of absence. Utility tokens skip
  // entirely (they trade via the bridge, not an AMM pair).
  let lpDetState = 'unknown';
  if (!isUtility && lp && (lp.pair || lp.isV4)) lpDetState = 'good';
  passScore(cats, 'lpDetected', lpDetState);

  // lpBurned — LP tokens held at burn addresses > 50% of pair supply.
  // Cosmetic tier because "burn" is a positive (locked liquidity), not a
  // rug. If we can't tell, it stays unknown.
  let lpBurnedState = 'unknown';
  if (lpLock && lpLock.burnedPct != null) {
    lpBurnedState = lpLock.burnedPct >= 50 ? 'good' : 'unknown';
  }
  passScore(cats, 'lpBurned', lpBurnedState);

  // lpUnlocked — deployer holds LP tokens on the pair. That's the rugpull
  // vector: deployer pulls their share of the liquidity, price collapses.
  // Threshold: any deployer holding > 5% of LP supply is a real risk.
  let lpUnlockedState = 'unknown';
  if (lpLock && lpLock.deployerPct != null && lpLock.burnedPct != null) {
    // Deployer holds real LP AND liquidity isn't burned → rug lever exists.
    if (lpLock.deployerPct > 5 && lpLock.burnedPct < 50) lpUnlockedState = 'bad';
    else lpUnlockedState = 'good';
  }
  passScore(cats, 'lpUnlocked', lpUnlockedState);

  // Tax-rate signals. Read from public getters; > 10% on either side is the
  // threshold — anything higher is a soft-rug tax (buyers get farmed).
  let buyTaxState = 'unknown';
  let sellTaxState = 'unknown';
  if (taxes) {
    if (taxes.buyPct != null) buyTaxState = taxes.buyPct > 10 ? 'bad' : 'good';
    if (taxes.sellPct != null) sellTaxState = taxes.sellPct > 10 ? 'bad' : 'good';
    // If only totalFees is exposed, apply it symmetrically as a fallback.
    if (buyTaxState === 'unknown' && sellTaxState === 'unknown' && taxes.totalPct != null) {
      const s = taxes.totalPct > 10 ? 'bad' : 'good';
      buyTaxState = s;
      sellTaxState = s;
    }
  }
  passScore(cats, 'currentBuyTax', buyTaxState);
  passScore(cats, 'currentSellTax', sellTaxState);

  let score = 0;
  for (const s of cats) if (s.state === 'bad') score += s.weight;
  if (score > 100) score = 100;

  const totalSignals = cats.length;
  const resolved = cats.filter(s => s.state === 'good' || s.state === 'bad').length;
  const confidence = totalSignals > 0 ? Math.round((resolved / totalSignals) * 100) : 0;

  return { score, breakdown: cats, isUtility, confidence, resolved, totalSignals };
}

// ============================================================================
// Public entry point + cache (mirrors grug-score-engine.fullScore).
// ============================================================================

// v3 = adds LP detection (findLpPair via getReserves() probe on top
// holders), LP-lock status (lpBurned / lpUnlocked), and current buy/sell
// tax readout via known Uniswap-tax-template getters. Bumped so v2 caches
// (which had lpDetected pinned to 'unknown') re-derive with the live data.
const CACHE_KEY_PREFIX = 'coin_score_v4_';
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

export async function fullCoinScore(addr) {
  const cached = readCache(addr);
  if (cached) return { ...cached, cached: true };

  const [onChain, explorer, deployerHist, priorRug, funding] = await Promise.all([
    readOnChain(addr),
    fetch('/api/explorer-info?addr=' + addr).then(r => r.ok ? r.json() : null).catch(() => null),
    fetch('/api/deployer-history?addr=' + addr).then(r => r.ok ? r.json() : null).catch(() => null),
    fetch('/api/prior-rug-check?addr=' + addr).then(r => r.ok ? r.json() : null).catch(() => null),
    fetch('/api/deployer-funding?addr=' + addr).then(r => r.ok ? r.json() : null).catch(() => null),
  ]);

  if (onChain.notAContract) return { error: 'not_a_contract' };

  // Second wave — all four probes need the top-holders list from explorer.
  // Run them in parallel to save latency; each is optional and any failure
  // just leaves its signal at 'unknown' rather than dropping the whole scan.
  const topHolders = Array.isArray(explorer?.topHolders) ? explorer.topHolders : [];
  const topHolder = topHolders.length > 0 ? (topHolders[0].address || null) : null;

  const [honeypot, lp, taxes] = await Promise.all([
    // Honeypot sim — needs one real holder to transfer from.
    (async () => {
      if (!topHolder || /^0x0+$/.test(topHolder)) return null;
      const sim = await simulateErc20Transfer(addr, topHolder, onChain.decimals);
      if (sim.success === true) return { status: 'transfers_work' };
      if (sim.success === false) {
        const lockRe = /paus|lock|frozen|blocked|forbidden|blacklist|not allowed|disabled|restrict|trading not enabled|not open|not started/i;
        const normalRe = /allowance|insufficient|exceed|not owner|not authorized|approval/i;
        if (lockRe.test(sim.reason || '')) return { status: 'honeypot', reason: sim.reason };
        if (normalRe.test(sim.reason || '')) return { status: 'transfers_work' };
        return { status: 'unclear', reason: sim.reason };
      }
      return null;
    })(),
    // LP-pair discovery — scan top holders for a UniV2 pair.
    (async () => {
      if (topHolders.length === 0) return null;
      const found = await findLpPair(addr, topHolders);
      // Return either the found pair or `false` explicitly so the scoring
      // code can tell "we looked and nothing was there" from "we didn't
      // look because we had no top holders" (which stays unknown).
      return found || false;
    })(),
    // Tax rate readout — fires whether or not there's an LP.
    readTaxRates(addr),
  ]);

  // LP-lock status is a dependent probe — only runs when LP is found. Keep
  // it out of the main parallel wave so we don't waste calls when there's
  // no pair, and so we can pass the deployer address which comes from
  // deployerHist (which resolved earlier).
  let lpLock = null;
  if (lp && lp.pair) {
    const deployerAddr = deployerHist?.creator || null;
    lpLock = await checkLpLockStatus(lp.pair, deployerAddr);
  }

  const { score, isUtility, confidence, resolved, totalSignals, breakdown } = computeScoreFromData({
    addr, onChain, explorer, deployerHist, priorRug, funding, honeypot, lp, lpLock, taxes,
  });

  // Utility tokens (WETH, wrapped BTC, bridge stablecoins, positions,
  // vaults, gauges) skip 6-8 signals by design because our rug heuristics
  // don't apply to wrappers. That naturally caps their confidence around
  // 45-55%. Using the same 60% threshold as launch tokens would grey out
  // every legit wrapper, which is worse than useless — treat utility
  // tokens with resolved >= 8 as scoreable, and lean the verdict on the
  // utility nature so users know why the signal count is lighter.
  const utilityScoreable = isUtility && resolved >= 8;
  let tone, verdict, lowConfidence = false;
  if (!utilityScoreable && confidence < 60) {
    tone = 'grey';
    verdict = 'grug not sure';
    lowConfidence = true;
  } else if (score < 25) {
    tone = 'green';
    verdict = isUtility ? 'grug approve — utility' : 'grug approve';
  } else if (score < 60) {
    tone = 'yellow'; verdict = 'grug wary';
  } else {
    tone = 'red';    verdict = 'grug run';
  }

  const result = {
    score, tone, verdict, isUtility, confidence, resolved, totalSignals, lowConfidence,
    breakdown,
    // Snapshot the fields the UI page uses to render its report — avoids the
    // UI needing a second pass over the same endpoints.
    raw: {
      name: onChain.name,
      symbol: onChain.symbol,
      decimals: onChain.decimals,
      totalSupply: onChain.totalSupplyOnChain,
      owner: onChain.owner,
      ownerRenounced: onChain.ownerRenounced,
      ownerIsMultiSig: onChain.ownerIsMultiSig,
      ownerIsContract: onChain.ownerIsContract,
      isProxy: onChain.isProxy,
      isPaused: onChain.isPaused,
      drainerHits: onChain.drainerHits,
      hasSelector: onChain.hasSelector,
      explorer,
      deployerHist,
      priorRug,
      funding,
      // Snapshots of the new v3 probe outputs — the UI panel uses them to
      // render the LP pair address and current tax rates alongside the
      // signal rows.
      lp,
      lpLock,
      taxes,
    },
  };
  writeCache(addr, result);
  return { ...result, cached: false };
}

// Alias so mint-card style callers can point either engine at the same name.
export const quickCoinScore = fullCoinScore;
