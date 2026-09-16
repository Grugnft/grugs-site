/**
 * Grug mint bot — the crypto layer.
 *
 * Owns everything private-key-adjacent so mint-bot.html stays a dumb view:
 *   - burner wallet lifecycle (create / load / lock / clear)
 *   - contract probing (mint function detection + price detection)
 *   - mint execution with a hard max-spend cap
 *   - post-mint cleanup (sweep NFTs to owner, refund native to funder)
 *
 * RHC-only for v1. Adding another chain is a matter of extending the CHAIN
 * table and letting the UI pick — the rest of the engine is chain-agnostic.
 *
 * Security posture:
 *   - Burner private key lives in localStorage keyed by chain. Persists
 *     across tabs and reloads so a failed mint can be recovered (refund
 *     leftover gas, sweep whatever landed) instead of dying with the tab.
 *     Never sent to a server, never logged. User clears it via "clear
 *     burner" button when they're done.
 *   - Max-spend cap is enforced BEFORE the tx is signed, so a mint contract
 *     that ratchets its price at runtime can't drain the burner.
 *   - Refund/sweep call the burner's own wallet — no server signing.
 */

import { ethers } from 'https://esm.sh/ethers@6.13.4';

// ============================================================================
// CHAIN — Robinhood Chain constants
// ============================================================================
export const RHC = Object.freeze({
  chainId: 4663,
  rpcUrl: 'https://rpc.mainnet.chain.robinhood.com',
  currency: 'ETH', // RHC uses ETH as native gas token
  explorer: 'https://robinhoodchain.blockscout.com',
});

// ============================================================================
// SEADROP — OpenSea's SeaDrop router on RHC
// ============================================================================
// Most current RHC drops route through this. Direct-mint on the NFT contract
// itself reverts — the SeaDrop router is the actual mintPublic() entrypoint.
// Router address is the same canonical SeaDrop deployment used on other L2s.
export const SEADROP = Object.freeze({
  router: '0x00005EA00Ac477B1030CE78506496e8C2dE24bf5',
  // Canonical OpenSea fee recipient; SeaDrop drops that restrict recipients
  // whitelist this one. We fall back to reading getAllowedFeeRecipients when
  // this default isn't listed for the drop.
  defaultFeeRecipient: '0x0000a26b00c1F0DF003000390027140000fAa719',
});

const SEADROP_IFACE = new ethers.Interface([
  'function getPublicDrop(address) view returns (tuple(uint80 mintPrice, uint48 startTime, uint48 endTime, uint16 maxTotalMintableByWallet, uint16 feeBps, bool restrictFeeRecipients))',
  'function getAllowedFeeRecipients(address) view returns (address[])',
  'function mintPublic(address nftContract, address feeRecipient, address minterIfNotPayer, uint256 quantity) payable',
]);

/**
 * Check whether an NFT contract is registered with the SeaDrop router.
 * Returns null if not a SeaDrop drop; otherwise the parsed public-drop
 * config plus a fee recipient we can safely pass to mintPublic.
 *
 * "Not a SeaDrop drop" is a call that reverts, returns 0x, or returns an
 * all-zero PublicDrop tuple (unregistered contracts get a zeroed struct).
 */
export async function probeSeaDrop(nftAddr) {
  const p = provider();
  let drop;
  try {
    const data = SEADROP_IFACE.encodeFunctionData('getPublicDrop', [nftAddr]);
    const raw = await p.call({ to: SEADROP.router, data });
    if (!raw || raw === '0x') return null;
    [drop] = SEADROP_IFACE.decodeFunctionResult('getPublicDrop', raw);
  } catch { return null; }

  // Unregistered contracts get a zero-tuple. A drop with any of these set
  // is a real SeaDrop registration; treat everything zero as "not SeaDrop".
  const mintPrice = BigInt(drop.mintPrice);
  const startTime = Number(drop.startTime);
  const endTime = Number(drop.endTime);
  const maxPerWallet = Number(drop.maxTotalMintableByWallet);
  const feeBps = Number(drop.feeBps);
  const restrictRecipients = !!drop.restrictFeeRecipients;
  if (mintPrice === 0n && startTime === 0 && endTime === 0 && maxPerWallet === 0 && feeBps === 0) {
    return null;
  }

  // Pick a fee recipient. If restricted, we must use one from the allowlist —
  // check the default first (fast path), fall back to the allowlist read.
  let feeRecipient = SEADROP.defaultFeeRecipient;
  if (restrictRecipients) {
    try {
      const data = SEADROP_IFACE.encodeFunctionData('getAllowedFeeRecipients', [nftAddr]);
      const raw = await p.call({ to: SEADROP.router, data });
      if (raw && raw !== '0x') {
        const [list] = SEADROP_IFACE.decodeFunctionResult('getAllowedFeeRecipients', raw);
        const hasDefault = list.some(a => a.toLowerCase() === SEADROP.defaultFeeRecipient.toLowerCase());
        if (!hasDefault && list.length > 0) feeRecipient = list[0];
      }
    } catch {}
  }

  const now = Math.floor(Date.now() / 1000);
  return {
    mintPrice, startTime, endTime, maxPerWallet, feeBps, restrictRecipients,
    feeRecipient,
    isLive: startTime <= now && now < endTime,
    startsInSec: startTime > now ? startTime - now : 0,
    endedSecAgo: endTime && endTime < now ? now - endTime : 0,
  };
}

let _provider = null;
export function provider() {
  if (_provider) return _provider;
  _provider = new ethers.JsonRpcProvider(RHC.rpcUrl, RHC.chainId, { staticNetwork: true });
  return _provider;
}

// ============================================================================
// BURNER — persisted private key (localStorage, not sessionStorage)
// ============================================================================
// Persistence choice: same wallet is reachable from any tab and survives a
// reload / crash. Critical for recovering funds after a failed mint. Keyed
// per-chain so a future multi-chain build doesn't cross-contaminate.
const KEY_STORAGE = `grug_mint_burner_pk_${RHC.chainId}`;
const LOCK_STORAGE = `grug_mint_burner_locked_${RHC.chainId}`;

function _store() {
  // Tolerant of environments (SSR, private mode with storage disabled) where
  // localStorage throws on read — callers get a null and see an empty burner.
  try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch { return null; }
}

export function burnerExists() {
  const s = _store(); if (!s) return false;
  try { return !!s.getItem(KEY_STORAGE); } catch { return false; }
}

export function isLocked() {
  const s = _store(); if (!s) return false;
  try { return s.getItem(LOCK_STORAGE) === '1'; } catch { return false; }
}

export function setLocked(v) {
  const s = _store(); if (!s) return;
  try {
    if (v) s.setItem(LOCK_STORAGE, '1');
    else s.removeItem(LOCK_STORAGE);
  } catch {}
}

export function createBurner() {
  if (isLocked()) throw new Error('burner is locked — unlock before rotating');
  const w = ethers.Wallet.createRandom();
  const s = _store();
  try { s?.setItem(KEY_STORAGE, w.privateKey); } catch {}
  return loadBurner();
}

export function loadBurner() {
  const s = _store(); if (!s) return null;
  let pk;
  try { pk = s.getItem(KEY_STORAGE); } catch { return null; }
  if (!pk) return null;
  return new ethers.Wallet(pk, provider());
}

export function clearBurner() {
  if (isLocked()) throw new Error('burner is locked — unlock before clearing');
  const s = _store();
  try { s?.removeItem(KEY_STORAGE); } catch {}
}

export function importBurner(privateKey) {
  const clean = privateKey.trim().startsWith('0x') ? privateKey.trim() : '0x' + privateKey.trim();
  const w = new ethers.Wallet(clean, provider()); // throws on invalid
  const s = _store();
  try { s?.setItem(KEY_STORAGE, w.privateKey); } catch {}
  return w;
}

export async function burnerBalance() {
  const w = loadBurner();
  if (!w) return 0n;
  return await provider().getBalance(w.address);
}

// ============================================================================
// PROBING — mint function + price detection
// ============================================================================
// Ordered by prevalence in RHC/EVM launches: bare `mint(qty)` covers the
// long tail of ERC-721A drops, publicMint/mintPublic follow the OpenSea
// SeaDrop-adjacent convention, purchase/claim show up on older contracts.
export const MINT_FN_CANDIDATES = Object.freeze([
  { sig: 'function mint(uint256 quantity) payable',       label: 'mint(qty)' },
  { sig: 'function publicMint(uint256 quantity) payable', label: 'publicMint(qty)' },
  { sig: 'function mintPublic(uint256 quantity) payable', label: 'mintPublic(qty)' },
  { sig: 'function purchase(uint256 quantity) payable',   label: 'purchase(qty)' },
  { sig: 'function claim(uint256 quantity) payable',      label: 'claim(qty)' },
  { sig: 'function mintTo(address to, uint256 quantity) payable', label: 'mintTo(addr,qty)' },
  { sig: 'function mint(address to, uint256 quantity) payable',   label: 'mint(addr,qty)' },
]);

const PRICE_FN_CANDIDATES = [
  'mintPrice', 'price', 'PRICE', 'publicPrice', 'MINT_PRICE',
  'cost', 'unitPrice', 'tokenPrice', 'salePrice', '_price',
];

/**
 * Probe common price-getter names in parallel. Fires every candidate call
 * concurrently, keeps the first non-zero result. ~10× faster than serial:
 * on RHC's ~250ms/call latency this drops probing from ~3s to ~300ms.
 */
export async function probePrice(contractAddr) {
  const p = provider();
  const results = await Promise.all(PRICE_FN_CANDIDATES.map(async (fn) => {
    try {
      const iface = new ethers.Interface([`function ${fn}() view returns (uint256)`]);
      const data = iface.encodeFunctionData(fn, []);
      const raw = await p.call({ to: contractAddr, data });
      if (!raw || raw === '0x') return null;
      const [price] = iface.decodeFunctionResult(fn, raw);
      if (price === 0n) return null;
      return { price, fn };
    } catch { return null; }
  }));
  // Preserve candidate order: first non-null wins so the "canonical" name
  // (mintPrice) is preferred over a duplicate that resolves later.
  return results.find(r => r !== null) || null;
}

/**
 * Probe sale-state getters in parallel. Returns the first hit, or null.
 */
export async function probeSaleStatus(contractAddr) {
  const p = provider();
  const candidates = [
    'saleIsActive', 'publicSaleActive', 'saleActive',
    'mintingEnabled', 'mintActive', 'isMintActive',
  ];
  const results = await Promise.all(candidates.map(async (fn) => {
    try {
      const iface = new ethers.Interface([`function ${fn}() view returns (bool)`]);
      const data = iface.encodeFunctionData(fn, []);
      const raw = await p.call({ to: contractAddr, data });
      if (!raw || raw === '0x') return null;
      const [v] = iface.decodeFunctionResult(fn, raw);
      return { fn, live: !!v };
    } catch { return null; }
  }));
  return results.find(r => r !== null) || null;
}

/**
 * Read ERC-721 name/symbol/supply in parallel. Empty fields stay null.
 * ERC-721A contracts often hide totalSupply() but expose MAX_SUPPLY() —
 * both are attempted; the UI shows whichever wins.
 */
export async function readContractMeta(contractAddr) {
  const p = provider();
  const reads = [
    { fn: 'name',        ret: 'string',  key: 'name' },
    { fn: 'symbol',      ret: 'string',  key: 'symbol' },
    { fn: 'totalSupply', ret: 'uint256', key: 'totalSupply' },
    { fn: 'maxSupply',   ret: 'uint256', key: 'maxSupply' },
    { fn: 'MAX_SUPPLY',  ret: 'uint256', key: 'maxSupply' },
    { fn: 'supplyLimit', ret: 'uint256', key: 'maxSupply' },
  ];
  const settled = await Promise.all(reads.map(async ({ fn, ret }) => {
    try {
      const iface = new ethers.Interface([`function ${fn}() view returns (${ret})`]);
      const data = iface.encodeFunctionData(fn, []);
      const raw = await p.call({ to: contractAddr, data });
      if (!raw || raw === '0x') return null;
      const [v] = iface.decodeFunctionResult(fn, raw);
      return typeof v === 'string' ? v : v.toString();
    } catch { return null; }
  }));
  // Collate: first non-null wins per key so name/symbol/totalSupply get the
  // canonical read and maxSupply picks up whichever of the 3 variants worked.
  const out = { name: null, symbol: null, totalSupply: null, maxSupply: null };
  for (let i = 0; i < reads.length; i++) {
    const { key } = reads[i];
    if (out[key] === null && settled[i] !== null) out[key] = settled[i];
  }
  return out;
}

// ============================================================================
// MINT — the actual send
// ============================================================================
/**
 * Build the (target, data, value) triple for a mint call given a route.
 * Two routes today:
 *
 *   direct   — send fnSig(args) straight to the NFT contract. Args are
 *              derived from the fnSig's param shape (1 uint256 → [qty];
 *              2 params starting with address → [minter, qty]).
 *
 *   seadrop  — call mintPublic(nft, feeRecipient, minter, qty) on the
 *              SeaDrop router. `contract` in the call config is the NFT
 *              address; the router is looked up from SEADROP.router.
 *              feeRecipient is required — pass from probeSeaDrop().
 *
 * Value is pricePerToken × quantity in every route.
 */
function buildMintCall({ route, contract, minter, quantity, pricePerToken, fnSig, feeRecipient }) {
  const qty = BigInt(quantity);
  const value = pricePerToken * qty;

  if (route === 'seadrop') {
    if (!feeRecipient) throw new Error('SeaDrop route needs feeRecipient — run probeSeaDrop first');
    const data = SEADROP_IFACE.encodeFunctionData('mintPublic', [contract, feeRecipient, minter, qty]);
    return { target: SEADROP.router, data, value };
  }

  // direct: pull fn name + params out of the sig, build args from param shape.
  if (!fnSig) throw new Error('direct route needs fnSig');
  const iface = new ethers.Interface([fnSig]);
  const fnName = fnSig.match(/function (\w+)/)[1];
  const params = fnSig.match(/function \w+\(([^)]*)\)/)[1].split(',').map(s => s.trim()).filter(Boolean);

  let args;
  if (params.length === 1 && params[0].startsWith('uint')) args = [qty];
  else if (params.length === 2 && params[0].startsWith('address')) args = [minter, qty];
  else throw new Error(`unsupported signature: ${fnSig}`);

  const data = iface.encodeFunctionData(fnName, args);
  return { target: contract, data, value };
}

/**
 * Simulate the mint via eth_call. Zero cost — catches "NotActive",
 * "InsufficientPayment", "MintQuantityExceedsMaxTokenSupplyForStage",
 * etc. before the user pays gas. Returns { ok } or { ok:false, reason }.
 */
export async function simulateMint({ from, contract, fnSig, quantity, pricePerToken, route = 'direct', feeRecipient }) {
  const p = provider();
  let call;
  try {
    call = buildMintCall({ route, contract, minter: from, quantity, pricePerToken, fnSig, feeRecipient });
  } catch (e) { return { ok: false, reason: e.message }; }

  try {
    await p.call({ to: call.target, from, data: call.data, value: call.value });
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: shortReason(e) };
  }
}

/**
 * Prepare a signed mint transaction without broadcasting it. Returns the
 * raw signed hex the RPC will accept via eth_sendRawTransaction plus the
 * derived hash and expected nonce. Used by the scheduler to pre-build the
 * tx a couple of seconds before target so T=0 is one round-trip.
 *
 * Every RPC read that shapes the tx (nonce, gas estimate, fee data) happens
 * here, not at fire time.
 */
export async function prepareMintTx({
  contract, fnSig, quantity, pricePerToken, maxSpend,
  route = 'direct', feeRecipient,
  gasBoost = 1.0,
  // Optional overrides for hot-path pre-signing when the caller has already
  // fetched these (avoids double RPC calls).
  cachedNonce, cachedFeeData, cachedGasLimit,
  // Some contracts revert estimateGas even when the tx would succeed at
  // fire time (e.g., SeaDrop's NotActive before startTime). Skip lets us
  // pre-sign anyway; use a generous fallback gasLimit.
  skipEstimate = false,
}) {
  const wallet = loadBurner();
  if (!wallet) throw new Error('no burner wallet — create one first');

  const call = buildMintCall({
    route, contract, minter: wallet.address, quantity, pricePerToken, fnSig, feeRecipient,
  });
  if (call.value > maxSpend) {
    throw new Error(`cost ${ethers.formatEther(call.value)} exceeds cap ${ethers.formatEther(maxSpend)}`);
  }

  const p = provider();
  const [nonce, feeData] = await Promise.all([
    cachedNonce != null ? Promise.resolve(cachedNonce) : p.getTransactionCount(wallet.address, 'pending'),
    cachedFeeData ? Promise.resolve(cachedFeeData) : p.getFeeData(),
  ]);

  let gasLimit = cachedGasLimit;
  if (!gasLimit) {
    if (skipEstimate) {
      // Generous fallback: SeaDrop mints run 150–250k gas, direct mints
      // often 80–150k. 400k covers both with room to spare; overpaying gas
      // doesn't cost anything (unused gas is refunded).
      gasLimit = 400_000n;
    } else {
      try {
        const est = await p.estimateGas({ from: wallet.address, to: call.target, data: call.data, value: call.value });
        gasLimit = est + est / 5n; // 20% headroom
      } catch (e) { throw new Error(`estimateGas failed: ${shortReason(e)}`); }
    }
  }

  const boostBps = BigInt(Math.round(Math.max(1, gasBoost) * 100));
  const maxFeePerGas       = feeData.maxFeePerGas ? (feeData.maxFeePerGas * boostBps) / 100n : undefined;
  const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas ? (feeData.maxPriorityFeePerGas * boostBps) / 100n : undefined;
  const gasPrice           = feeData.gasPrice ? (feeData.gasPrice * boostBps) / 100n : undefined;

  const tx = {
    to: call.target,
    data: call.data,
    value: call.value,
    gasLimit,
    chainId: RHC.chainId,
    nonce,
    ...(maxFeePerGas ? { maxFeePerGas, maxPriorityFeePerGas, type: 2 } : { gasPrice, type: 0 }),
  };

  const rawTx = await wallet.signTransaction(tx);
  const hash = ethers.keccak256(rawTx);
  return { rawTx, hash, nonce, gasLimit, value: call.value, target: call.target };
}

/**
 * Broadcast a pre-signed raw transaction and wait for its receipt.
 * Single RPC round-trip on send — the "instant" fire path.
 */
export async function broadcastRawTx(rawTx, { onProgress } = {}) {
  const p = provider();
  onProgress?.({ stage: 'broadcasting' });
  const resp = await p.broadcastTransaction(rawTx);
  onProgress?.({ stage: 'sent', hash: resp.hash });
  const receipt = await resp.wait();
  onProgress?.({ stage: 'confirmed', hash: resp.hash, block: receipt?.blockNumber, status: receipt?.status });
  return receipt;
}

/**
 * Execute the mint synchronously (build + sign + send). Kept for the
 * manual "execute mint now" button and as the fallback in the scheduler's
 * retry loop, where a fresh signature (new nonce) is needed anyway.
 */
export async function executeMint(cfg) {
  const { onProgress } = cfg;
  onProgress?.({ stage: 'estimating' });
  const prep = await prepareMintTx(cfg);
  onProgress?.({ stage: 'signing', totalCost: prep.value, gasLimit: prep.gasLimit, target: prep.target });
  return await broadcastRawTx(prep.rawTx, { onProgress });
}

// ============================================================================
// SCHEDULER — arm a mint for a future timestamp
// ============================================================================
// Use case: mint opens at 00:00 local. User arms the bot, closes their eyes,
// wakes up to an NFT. The bot pre-warms gas + fee data 30s before target,
// tight-polls simulate in the last 5s, then fires with a retry loop that
// forgives "not started yet" errors up to a bounded number of attempts.
//
// Persistence: config is saved to localStorage so a page reload rearms
// automatically (target time and mint config restored). Only one schedule
// per burner at a time — the whole point is set-and-forget.

const SCHEDULE_STORAGE = `grug_mint_schedule_${RHC.chainId}`;

export function saveSchedule(payload) {
  const s = _store(); if (!s) return;
  try { s.setItem(SCHEDULE_STORAGE, JSON.stringify(payload)); } catch {}
}
export function loadSchedule() {
  const s = _store(); if (!s) return null;
  try { return JSON.parse(s.getItem(SCHEDULE_STORAGE) || 'null'); } catch { return null; }
}
export function clearSchedule() {
  const s = _store(); if (!s) return;
  try { s.removeItem(SCHEDULE_STORAGE); } catch {}
}

/**
 * Arm a mint for a target timestamp. Returns a handle:
 *   { cancel(), getState(), targetTimeMs }
 *
 * Timeline:
 *   T-∞    ..T-30s : idle, low-frequency countdown ticks
 *   T-30s  ..T-5s  : pre-warm — fetches feeData, gas estimate, caches them
 *   T-5s   ..T     : tight simulate polling every 500ms
 *   T      onwards : fire executeMint; on retryable revert, retry every
 *                    `retryDelayMs` up to `maxAttempts` — "not started"
 *                    reverts are the whole reason this loop exists.
 *
 * `onEvent` receives {stage, ...} envelopes so the UI can log + display
 * a countdown. `mode: 'aggressive'` makes the fire attempt fire twice
 * on the first try, half a second apart, to beat a competitive bot on
 * a tight-open drop.
 */
export function armMint({ config, targetTimeMs, mode = 'normal', maxAttempts = 30, retryDelayMs = 1500, onEvent }) {
  let cancelled = false;
  let state = 'waiting';
  const timers = new Set();
  const setT = (fn, ms) => { const id = setTimeout(fn, ms); timers.add(id); return id; };
  const emit = (stage, extra = {}) => { onEvent?.({ stage, at: Date.now(), targetTimeMs, ...extra }); };

  const clearAllTimers = () => { for (const id of timers) clearTimeout(id); timers.clear(); };

  // Pre-signed tx for the instant-fire path. Populated at T-2s.
  let preSigned = null;

  const preSign = async () => {
    // Skip estimateGas because SeaDrop's mintPublic reverts pre-startTime
    // (which is basically now if we're pre-signing 2s before target).
    // The generous 400k gasLimit fallback covers all common mint contracts.
    try {
      const p = provider();
      const [nonce, feeData, block] = await Promise.all([
        p.getTransactionCount(loadBurner().address, 'pending'),
        p.getFeeData(),
        p.getBlockNumber(),
      ]);
      preSigned = await prepareMintTx({
        ...config, skipEstimate: true,
        cachedNonce: nonce, cachedFeeData: feeData,
      });
      emit('presigned', { hash: preSigned.hash, gasLimit: preSigned.gasLimit.toString(), block });
    } catch (e) {
      emit('presign-failed', { reason: e.message });
      preSigned = null;
    }
  };

  const fire = async () => {
    state = 'firing';
    emit('firing');

    // Attempt 0: fire the pre-signed tx via one broadcast round-trip.
    // In aggressive mode, also fire a second pre-signed shot in parallel
    // (same nonce → duplicate; only one wins, but doubles the chance of
    // hitting the earliest block).
    if (preSigned) {
      try {
        emit('attempt', { attempt: 0, mode: 'presigned', target: preSigned.target });
        const rapidShots = mode === 'aggressive' ? 2 : 1;
        const shots = Array.from({ length: rapidShots }, () =>
          broadcastRawTx(preSigned.rawTx, { onProgress: p => emit('progress', p) })
            .catch(e => ({ _err: e.message }))
        );
        const results = await Promise.allSettled(shots);
        const winner = results.find(r => r.status === 'fulfilled' && r.value?.status === 1);
        if (winner) { state = 'success'; emit('success', { receipt: winner.value, attempt: 0 }); clearSchedule(); return; }
        const errs = results.map(r => r.status === 'fulfilled' ? (r.value?._err || `status=${r.value?.status}`) : r.reason?.message).filter(Boolean);
        emit('retry', { attempt: 0, reason: errs[0] || 'presigned failed' });
      } catch (e) {
        emit('retry', { attempt: 0, reason: e.message });
      }
    }

    // Retry loop: rebuild + resign fresh each attempt so a consumed nonce
    // doesn't stick us. Retry delay lets the contract's startTime tick
    // over if that was the revert cause.
    for (let attempt = preSigned ? 1 : 0; attempt < maxAttempts; attempt++) {
      if (cancelled) return;
      await new Promise(r => setTimeout(r, retryDelayMs));
      if (cancelled) return;
      try {
        emit('attempt', { attempt, mode: 'fresh-sign' });
        const receipt = await executeMint({
          ...config,
          onProgress: p => emit('progress', p),
        });
        if (receipt?.status === 1) { state = 'success'; emit('success', { receipt, attempt }); clearSchedule(); return; }
        emit('retry', { attempt, reason: `status=${receipt?.status}` });
      } catch (e) {
        emit('retry', { attempt, reason: e.message });
      }
    }
    state = 'exhausted';
    emit('exhausted');
    clearSchedule();
  };

  // Countdown ticker
  const tick = () => {
    if (cancelled || state !== 'waiting') return;
    emit('tick', { msLeft: targetTimeMs - Date.now() });
    if (!cancelled && state === 'waiting') setT(tick, 1000);
  };
  setT(tick, 0);

  const msUntilTarget = targetTimeMs - Date.now();

  if (msUntilTarget <= 0) {
    // Already past — pre-sign inline then fire. No T=0 optimization needed.
    setT(async () => { await preSign(); if (!cancelled) fire(); }, 0);
  } else {
    // T-30s: warm the RPC connection so nothing is cold at fire time.
    const warmDelay = Math.max(0, msUntilTarget - 30_000);
    setT(async () => {
      if (cancelled) return;
      state = 'prewarm';
      emit('prewarm');
      try {
        const p = provider();
        await Promise.all([p.getFeeData(), p.getBlockNumber()]);
      } catch {}
    }, warmDelay);

    // T-2s: pre-sign the tx. State moves to 'ready' when done.
    const preSignDelay = Math.max(0, msUntilTarget - 2_000);
    setT(async () => {
      if (cancelled) return;
      state = 'presigning';
      emit('presigning');
      await preSign();
      if (cancelled) return;
      state = 'ready';
      emit('ready', { msLeft: targetTimeMs - Date.now() });
    }, preSignDelay);

    // T=0: broadcast. Because the tx is pre-signed, the ONLY thing that
    // happens here is a single JSON-RPC POST. Typical RHC latency ~150ms.
    setT(() => { if (!cancelled) fire(); }, msUntilTarget);
  }

  return {
    cancel: () => {
      cancelled = true;
      state = 'cancelled';
      clearAllTimers();
      clearSchedule();
      emit('cancelled');
    },
    getState: () => state,
    targetTimeMs,
  };
}

// ============================================================================
// CLEANUP — sweep NFTs to owner, refund native to funder
// ============================================================================
/**
 * Move every ERC-721 the burner holds on `contract` to `toAddress`.
 *
 * Enumeration strategy:
 *   1. tokenOfOwnerByIndex — the ERC-721Enumerable extension. Fastest when
 *      supported, one call per token.
 *   2. eth_getLogs Transfer scan — every ERC-721 emits Transfer(from, to,
 *      tokenId). We ask the RPC for Transfer(*, burner, *) minus
 *      Transfer(burner, *, *) on this contract. Works everywhere. Only
 *      scans a bounded window since a burner is fresh (all its holdings
 *      are recent by definition).
 *   3. Blockscout /addresses/<addr>/nft — final fallback for RPCs that
 *      restrict eth_getLogs windows.
 */
export async function sweepNfts({ contract, toAddress, onProgress }) {
  const wallet = loadBurner();
  if (!wallet) throw new Error('no burner wallet');

  const iface = new ethers.Interface([
    'function balanceOf(address) view returns (uint256)',
    'function tokenOfOwnerByIndex(address,uint256) view returns (uint256)',
    'function safeTransferFrom(address,address,uint256)',
  ]);
  const c = new ethers.Contract(contract, iface, wallet);

  let balance;
  try { balance = await c.balanceOf(wallet.address); }
  catch (e) { throw new Error(`balanceOf failed: ${shortReason(e)}`); }
  const total = Number(balance);
  onProgress?.({ stage: 'balance', count: total });
  if (total === 0) return { swept: 0, txs: [] };

  // Pre-fetch tokenIds if the contract isn't enumerable, so we don't wait
  // on a fallback partway through the transfer loop.
  let heldIds = null;
  try {
    await c.tokenOfOwnerByIndex(wallet.address, 0); // enumerable probe
  } catch {
    onProgress?.({ stage: 'discovery', note: 'contract non-enumerable — scanning Transfer logs' });
    heldIds = await discoverOwnedTokenIds(contract, wallet.address);
    if (heldIds.length === 0) {
      // Last resort: give Blockscout a shot before erroring.
      const bs = await blockscoutOwnedTokens(contract, wallet.address);
      heldIds = bs.map(String);
    }
    if (heldIds.length < total) {
      onProgress?.({ stage: 'discovery', note: `found ${heldIds.length}/${total} — may be missing recent mints; retrying in 3s` });
      await new Promise(r => setTimeout(r, 3000));
      const retry = await discoverOwnedTokenIds(contract, wallet.address);
      if (retry.length > heldIds.length) heldIds = retry;
    }
    if (heldIds.length === 0) throw new Error(`can't enumerate tokens on this contract`);
  }

  const txs = [];
  for (let i = 0; i < total; i++) {
    let tokenId;
    if (heldIds) {
      if (i >= heldIds.length) break;
      tokenId = BigInt(heldIds[i]);
    } else {
      // Enumerable path — after each transfer index 0 slides to the next held token.
      tokenId = await c.tokenOfOwnerByIndex(wallet.address, 0);
    }
    onProgress?.({ stage: 'transferring', tokenId: tokenId.toString(), i: i + 1, total });
    const tx = await c.safeTransferFrom(wallet.address, toAddress, tokenId);
    await tx.wait();
    txs.push({ tokenId: tokenId.toString(), hash: tx.hash });
    onProgress?.({ stage: 'transferred', tokenId: tokenId.toString(), hash: tx.hash });
  }
  return { swept: txs.length, txs };
}

/**
 * Discover the tokenIds an owner holds on a contract by diffing Transfer
 * events (incoming − outgoing). Works on any ERC-721 regardless of
 * enumerable-extension support.
 *
 * Bounded scan window: burners are fresh — all their holdings arrived in
 * recent blocks — so we cover ~last 500k blocks by default, chunked so a
 * strict RPC (some public nodes cap at 10k blocks per call) still succeeds.
 */
async function discoverOwnedTokenIds(contract, owner, { lookback = 500000, chunk = 10000 } = {}) {
  const p = provider();
  const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
  const paddedOwner = '0x' + owner.slice(2).toLowerCase().padStart(64, '0');
  const latest = await p.getBlockNumber();
  const fromBlock = Math.max(0, latest - lookback);

  const heldIds = new Set();
  // Chunk both directions to stay within any RPC's per-call block window.
  for (let start = fromBlock; start <= latest; start += chunk) {
    const end = Math.min(start + chunk - 1, latest);
    try {
      const inLogs = await p.getLogs({
        address: contract, topics: [TRANSFER_TOPIC, null, paddedOwner],
        fromBlock: start, toBlock: end,
      });
      for (const log of inLogs) heldIds.add(BigInt(log.topics[3]).toString());
      const outLogs = await p.getLogs({
        address: contract, topics: [TRANSFER_TOPIC, paddedOwner, null],
        fromBlock: start, toBlock: end,
      });
      for (const log of outLogs) heldIds.delete(BigInt(log.topics[3]).toString());
    } catch {
      // If a chunk fails (RPC hiccup, index gap), continue — a partial
      // result is still useful and the caller can retry.
    }
  }
  return [...heldIds];
}

/**
 * Send the burner's remaining native balance back to `toAddress`,
 * leaving exactly enough for the gas of this refund tx.
 */
export async function refundNative({ toAddress, onProgress }) {
  const wallet = loadBurner();
  if (!wallet) throw new Error('no burner wallet');
  const p = provider();

  const balance = await p.getBalance(wallet.address);
  if (balance === 0n) throw new Error('burner is empty');

  const feeData = await p.getFeeData();
  const gasLimit = 21000n;
  // Use the higher of the two possible fee shapes to be safe.
  const perGas = feeData.maxFeePerGas || feeData.gasPrice || 0n;
  if (perGas === 0n) throw new Error('could not read gas price');
  const gasCost = perGas * gasLimit;
  if (balance <= gasCost) throw new Error(`balance ${ethers.formatEther(balance)} <= gas cost ${ethers.formatEther(gasCost)}`);

  const value = balance - gasCost;
  onProgress?.({ stage: 'sending', value });
  const tx = await wallet.sendTransaction({
    to: toAddress,
    value,
    gasLimit,
    chainId: RHC.chainId,
    ...(feeData.maxFeePerGas
      ? { maxFeePerGas: feeData.maxFeePerGas, maxPriorityFeePerGas: feeData.maxPriorityFeePerGas }
      : { gasPrice: feeData.gasPrice }),
  });
  const receipt = await tx.wait();
  onProgress?.({ stage: 'confirmed', hash: tx.hash, block: receipt?.blockNumber });
  return { hash: tx.hash, value };
}

// ============================================================================
// Helpers
// ============================================================================
function shortReason(e) {
  if (!e) return 'unknown';
  const raw = e.reason || e.shortMessage || e.info?.error?.message || e.message || String(e);
  // Ethers wraps everything three deep — surface just the useful bit.
  const m = String(raw).match(/reverted with reason string ['"]([^'"]+)['"]/);
  if (m) return m[1];
  return String(raw).slice(0, 200);
}

async function blockscoutOwnedTokens(contract, owner) {
  try {
    const url = `${RHC.explorer}/api/v2/addresses/${owner}/nft?type=ERC-721`;
    const r = await fetch(url);
    if (!r.ok) return [];
    const j = await r.json();
    const items = (j.items || []).filter(x =>
      (x.token?.address || '').toLowerCase() === contract.toLowerCase());
    return items.map(x => x.id || x.token_id).filter(Boolean);
  } catch { return []; }
}

// Re-export ethers so the UI page can use formatEther/parseEther/isAddress
// without a second import statement.
export { ethers };
