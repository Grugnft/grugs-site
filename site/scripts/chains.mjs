/**
 * Chain registry for Rug Radar and friends.
 *
 * Every tool (scanner, coin radar, mint bot, portfolio) reads from here so a
 * new chain only requires one entry — not five hardcoded RPC constants
 * spread across engines and endpoints.
 *
 * `availableSignals` is the set of grug-score signal IDs whose *upstream data*
 * we can actually gather on that chain. On Arc the Blockscout explorer sits
 * behind Cloudflare with no server-side workaround, so any signal that
 * relied on explorer data (top-holder concentration, prior-rug pattern,
 * verified flag, deployer funding, deployer history) is dropped from the
 * denominator instead of counting against confidence. This keeps the
 * verdict trustworthy on Arc — a green there means every check that CAN
 * run passed, not "half the checks flaked and we're guessing".
 */

export const CHAINS = {
  rhc: {
    id: 'rhc',
    chainId: 4663,
    name: 'Robinhood Chain',
    shortName: 'RHC',
    rpc: 'https://rpc.mainnet.chain.robinhood.com',
    explorerBase: 'https://robinhoodchain.blockscout.com',
    explorerApi: 'https://robinhoodchain.blockscout.com/api/v2',
    explorerReachable: true,
    openseaChain: 'robinhood',
    nativeSymbol: 'ETH',
    nativeDecimals: 18,
    // Every signal id below is one grug-score signal. Everything else the
    // engine emits gets dropped on this chain (marks state='n/a', excluded
    // from denominator).
    availableSignals: new Set([
      // contract — on-chain + explorer
      'unverified','proxy','ownerActive','adminMint','openBaseURI',
      'transferLock','currentlyPaused','withdrawExposure','transferBlocked',
      'freshDeploy','mutableRoyalty','walletDrainer',
      // deployer — explorer
      'freshWallet','emptyBalance','firstDeploy','mixerFunded','priorRug','freshFunding',
      // distribution — explorer + on-chain
      'topHeavy','deadContract','sniperStack','washTrades','noMarket',
      // socials + metadata — OpenSea + on-chain
      'websiteReachable','twitterExists','centralArt','unpinned','noRoyalty',
    ]),
  },
  arc: {
    id: 'arc',
    chainId: 5042,
    name: 'Arc Chain',
    shortName: 'ARC',
    rpc: 'https://rpc.mainnet.arc.io',
    explorerBase: 'https://explorer.arc.io',
    explorerApi: 'https://explorer.arc.io/api/v2',
    // CF-locked; we still show links to the UI but don't try to hit the API.
    explorerReachable: false,
    openseaChain: 'arc',
    // Arc pays gas in USDC. On-chain accounting is 18-decimal wei-style
    // (verified via eth_gasPrice returning 20 gwei-scale numbers) so the
    // existing formatEther works — just relabel the symbol for the UI.
    nativeSymbol: 'USDC',
    nativeDecimals: 18,
    availableSignals: new Set([
      // On-chain (RPC works)
      'proxy','ownerActive','adminMint','openBaseURI','transferLock',
      'currentlyPaused','withdrawExposure','transferBlocked','mutableRoyalty',
      'walletDrainer',
      // OpenSea (chain slug is 'arc')
      'noMarket','websiteReachable','twitterExists',
      // Metadata (on-chain tokenURI)
      'centralArt','unpinned','noRoyalty',
    ]),
  },
};

export const DEFAULT_CHAIN = 'rhc';

export function getChain(id) {
  const c = CHAINS[(id || '').toLowerCase()];
  if (!c) return CHAINS[DEFAULT_CHAIN];
  return c;
}

/** Signal IDs disabled on the given chain — engine marks these 'n/a'. */
export function disabledSignals(chainId, allSignalIds) {
  const chain = getChain(chainId);
  return allSignalIds.filter(id => !chain.availableSignals.has(id));
}

/** For the mint bot / anywhere that formats a wei amount as a native-token
 *  string. Wraps ethers.formatEther-style logic but with the chain's decimals
 *  and returns "<value> <symbol>". */
export function formatNative(wei, chainId) {
  const chain = getChain(chainId);
  const bi = typeof wei === 'bigint' ? wei : BigInt(wei || 0);
  const divisor = 10n ** BigInt(chain.nativeDecimals);
  const whole = bi / divisor;
  const frac = bi % divisor;
  const fracStr = frac.toString().padStart(chain.nativeDecimals, '0').replace(/0+$/, '');
  const num = fracStr ? `${whole}.${fracStr}` : `${whole}`;
  return `${num} ${chain.nativeSymbol}`;
}
