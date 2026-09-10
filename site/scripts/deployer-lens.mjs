/**
 * Deployer lens — fuses the three existing deployer endpoints into ONE
 * profile object with a rug-radar score per prior contract, then rolls
 * everything up into a reputation verdict.
 *
 * The scanner + (future) whale tracker + (future) mint card "deployer chip"
 * all pipe through this so the deployer story stays consistent across the
 * app: change reputation logic HERE, everywhere updates.
 *
 * Public:
 *   getDeployerProfile(contractAddr) -> DeployerProfile
 *
 * Where DeployerProfile is:
 *   {
 *     contract, deployer,
 *     deployTimestamp, walletAgeDays, walletFirstSeenAt, walletAgeIsExact,
 *     txCount, tokenTransferCount, coinBalanceEth,
 *     funding: { verdict, topFunder, note },
 *     priorDeploys: [{ addr, deployedAt, score, tone, verdict, error }],
 *     priorDeployStats: { total, scored, clean, mixed, rugged, dead, alive, verdict },
 *     reputation: 'first-time' | 'clean' | 'mixed' | 'burned-holders' | 'unknown',
 *     reputationLine: 'plain-english one-liner',
 *     redFlags: [ '…', '…' ],
 *     error?: 'no_creator_found' | 'endpoint_failed'
 *   }
 *
 * All three upstream endpoints are cached server-side; the per-prior-contract
 * scores are cached in the fullScore() engine's own localStorage. This
 * function adds ONE additional cache layer (localStorage
 * `grug_deployer_v1_<addr>`, 15 min TTL) so repeat scans of the same
 * contract skip the whole fan-out.
 */

import { fullScore } from '/scripts/grug-score-engine.mjs';

const CACHE_KEY_PREFIX = 'grug_deployer_v1_';
const CACHE_TTL_MS = 15 * 60 * 1000;

// How many prior contracts we score in parallel. Each fullScore() spawns
// roughly 6 endpoint calls — a concurrency of 3 keeps us under Blockscout's
// polite-usage threshold while still finishing a 10-contract deployer in
// ~3 waves.
const SCORE_CONCURRENCY = 3;

// Ceiling on prior contracts to score. deployer-history returns up to 12;
// we cap the score fan-out at 8 so a "factory" deployer with lots of clones
// doesn't turn one scan into a 40-endpoint stampede. The remaining N are
// listed in the profile but marked scored:false.
const SCORE_CAP = 8;

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
    localStorage.setItem(
      CACHE_KEY_PREFIX + addr.toLowerCase(),
      JSON.stringify({ value, expiresAt: Date.now() + CACHE_TTL_MS })
    );
  } catch (e) {}
}

async function fetchJson(url) {
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    return await r.json();
  } catch (e) { return null; }
}

// Simple concurrency-limited map. Kept inline to avoid pulling in a helper
// module for a five-line utility.
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function daysBetween(iso, now = Date.now()) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((now - t) / (1000 * 60 * 60 * 24)));
}

// Factory-contract detection. Some drops (all OpenSea SeaDrop clones on RHC,
// most Thirdweb / Manifold releases) are minted through a factory contract
// that Blockscout records as the "creator" of the clone. The factory itself
// has huge tx counts, a "Factory" label, and no siblings — reading it as a
// human deployer produces confidently-wrong answers ("first-time deployer,
// near-empty balance!"), so treat it as a distinct shape and tell the
// reader we couldn't recover the human from bytecode alone.
// Two signals mark a factory:
//   1. Blockscout has labelled the address (OpenSea SeaDrop, Thirdweb, etc.)
//   2. Chatty AND zero deploys of its own visible on the deployer-history
//      page — a real human with 500+ txs would have deployed at least one
//      other contract we can see. This lets us catch un-labelled factories
//      too without misclassifying whales.
const FACTORY_LABEL_RE = /factory/i;
const FACTORY_TX_FLOOR = 500;
function looksLikeFactory({ labelName, txCount, deployedContractCountRecent, hasMorePages }) {
  if (labelName && FACTORY_LABEL_RE.test(labelName)) return true;
  const noSiblings = (deployedContractCountRecent === 0);
  const chatty = typeof txCount === 'number' && txCount >= FACTORY_TX_FLOOR;
  // We only trust the "no siblings" leg when we've paged all the way — an
  // unpaged history could hide the deploys that would tell us this isn't
  // a factory. Better to fall through to normal reputation there.
  if (chatty && noSiblings && !hasMorePages) return true;
  return false;
}

// Turn a set of prior-contract scores into a headline reputation label.
// Logic order matters — a single rug outranks any number of clean deploys
// (the "reformed rugger" is not a shape we want to reward here).
function computeReputation({ scoredCount, cleanCount, ruggedCount, deadCount, aliveCount, totalPrior }) {
  if (totalPrior === 0) return { reputation: 'first-time', line: 'first deploy grug can see from this wallet.' };
  if (scoredCount === 0) return { reputation: 'unknown', line: `${totalPrior} prior contract${totalPrior === 1 ? '' : 's'} — grug could not score them.` };
  if (ruggedCount >= 1) {
    return {
      reputation: 'burned-holders',
      line: `${ruggedCount} of ${scoredCount} prior contract${scoredCount === 1 ? '' : 's'} scored in the red — this wallet has burned holders before.`,
    };
  }
  // No red scores. Weight dead-contract ratio next — a lot of DOA drops is
  // the "shipped it and moved on" pattern, not a rug but not confidence.
  if (deadCount >= 3 && deadCount >= scoredCount / 2) {
    return {
      reputation: 'mixed',
      line: `${deadCount} of ${scoredCount} prior contracts have zero on-chain activity — pattern of DOA drops.`,
    };
  }
  if (scoredCount >= 3 && cleanCount === scoredCount) {
    return { reputation: 'clean', line: `${scoredCount} prior contracts, all scored green.` };
  }
  return {
    reputation: 'mixed',
    line: `${scoredCount} prior contract${scoredCount === 1 ? '' : 's'} — mixed track record.`,
  };
}

// Turn the deployer + funding + wallet-age signals into a set of loud-and-
// concrete red-flag strings the outline can render as its own list. These
// intentionally overlap with what the scoring engine already reports; the
// point of the deployer panel is to say the loud parts out loud.
function collectRedFlags({ walletAgeDays, walletAgeIsExact, txCount, coinBalanceEth, funding, reputation }) {
  const flags = [];
  if (walletAgeDays !== null && walletAgeIsExact && walletAgeDays <= 7) {
    flags.push(`wallet is ${walletAgeDays} day${walletAgeDays === 1 ? '' : 's'} old.`);
  }
  if (typeof txCount === 'number' && txCount < 20) {
    flags.push(`wallet has only ${txCount} lifetime transactions.`);
  }
  if (typeof coinBalanceEth === 'number' && coinBalanceEth < 0.001) {
    flags.push('deployer wallet is near-empty.');
  }
  if (funding && funding.verdict === 'fresh_chain') {
    flags.push('deployer was funded by a fresh wallet (disposable-identity pattern).');
  }
  if (reputation === 'burned-holders') {
    flags.push('this deployer has shipped a rug before.');
  }
  return flags;
}

export async function getDeployerProfile(contractAddr) {
  const addr = (contractAddr || '').toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(addr)) {
    return { contract: contractAddr, error: 'invalid_addr' };
  }

  const cached = readCache(addr);
  if (cached) return { ...cached, cached: true };

  const [history, funding, priorRug] = await Promise.all([
    fetchJson('/api/deployer-history?addr=' + addr),
    fetchJson('/api/deployer-funding?addr=' + addr),
    fetchJson('/api/prior-rug-check?addr=' + addr),
  ]);

  // deployer-history occasionally returns no_creator_found even when the
  // OTHER two endpoints have successfully found the deployer through their
  // own Blockscout call (same code path, different call timing — Blockscout
  // is intermittently 403-ing addresses/<contract>). Fall back through the
  // three endpoints in order so a flaky-history scan still produces a
  // profile instead of hiding the panel entirely.
  const historyCreator = history?.creator || null;
  const fundingCreator = funding?.deployer || null;
  const priorRugCreator = priorRug?.deployer || null;
  const creator = historyCreator || fundingCreator || priorRugCreator;

  if (!creator) {
    return { contract: contractAddr, deployer: null, error: 'no_creator_found' };
  }
  const partial = !historyCreator;   // history missing → limited wallet metadata

  // Prior deploys: history is the richest source (timestamps + block numbers)
  // but if it failed we can still pull the addresses from prior-rug-check.
  // Merge both so a normal scan gets the full history payload and a partial
  // scan still gets the sibling contract list.
  const historyByAddr = new Map(
    (history?.deployedContracts || []).map(d => [(d.address || '').toLowerCase(), d])
  );
  const priorRugByAddr = new Map(
    (priorRug?.others || []).map(d => [(d.address || '').toLowerCase(), d])
  );
  const priorAddrsSet = new Set();
  for (const a of historyByAddr.keys()) if (a && a !== addr) priorAddrsSet.add(a);
  for (const a of priorRugByAddr.keys()) if (a && a !== addr) priorAddrsSet.add(a);
  const priorAddrs = [...priorAddrsSet];

  // Score up to SCORE_CAP prior contracts in parallel (capped concurrency).
  // Any that fail return an error object so the profile still renders.
  const toScore = priorAddrs.slice(0, SCORE_CAP);
  const scoredResults = await mapWithConcurrency(toScore, SCORE_CONCURRENCY, async (a) => {
    try {
      const r = await fullScore(a);
      if (!r || r.error) return { addr: a, error: r?.error || 'score_failed' };
      return {
        addr: a,
        score: r.score,
        tone: r.tone,
        verdict: r.verdict,
        confidence: r.confidence,
        lowConfidence: r.lowConfidence,
      };
    } catch (e) {
      return { addr: a, error: 'score_threw' };
    }
  });

  // Merge scored + un-scored into a single priorDeploys list. Timestamps
  // come from history when available (richer signal), falling back to null
  // when we're on the partial-scan path where only prior-rug-check knew
  // about the siblings.
  const scoredByAddr = new Map(scoredResults.map(r => [r.addr, r]));
  const priorDeploys = priorAddrs.map(a => {
    const h = historyByAddr.get(a) || {};
    const s = scoredByAddr.get(a) || { scored: false };
    return {
      addr: a,
      deployedAt: h.timestamp || null,
      block: h.block ?? null,
      ...s,
    };
  });

  // Reputation math — count prior scores by band. Only high-confidence
  // scores count towards clean/rugged so a low-confidence red doesn't
  // fabricate a burned-holders label out of a bad scan.
  const scoredPrior = priorDeploys.filter(p => typeof p.score === 'number' && !p.lowConfidence);
  const cleanCount = scoredPrior.filter(p => p.tone === 'green').length;
  const ruggedCount = scoredPrior.filter(p => p.tone === 'red').length;
  // Dead / alive counts come straight from prior-rug-check because that
  // endpoint knows about transfer counts. Trust its numbers over anything
  // we could re-derive client-side.
  const deadCount = priorRug?.dead ?? 0;
  const aliveCount = priorRug?.alive ?? 0;

  const isFactoryDeployed = looksLikeFactory({
    labelName: history?.labelName,
    txCount: history?.txCount,
    deployedContractCountRecent: history?.deployedContractCountRecent,
    hasMorePages: history?.hasMorePages,
  });

  let { reputation, line: reputationLine } = computeReputation({
    scoredCount: scoredPrior.length,
    cleanCount,
    ruggedCount,
    deadCount,
    aliveCount,
    totalPrior: priorAddrs.length,
  });

  // Factory-deployed override: whatever the sibling math said is meaningless
  // when the "creator" is a factory contract. Say so directly instead of
  // reporting "first-time deployer" for what is often a serial deployer's
  // fifth SeaDrop clone.
  if (isFactoryDeployed) {
    reputation = 'factory-deployed';
    const via = history?.labelName || 'a factory contract';
    reputationLine = `minted via ${via}. grug can't see the human wallet from bytecode alone — read the contract outline above as the main signal.`;
  }

  const walletFirstSeenAt = history?.firstTxTimestampSeen || null;
  const walletAgeIsExact = history ? !history.hasMorePages : false;
  const walletAgeDays = daysBetween(walletFirstSeenAt);

  const fundingSummary = funding ? {
    verdict: funding.verdict || 'unknown',
    topFunder: funding.funders?.[0]?.address || null,
    topFunderTxCount: funding.funders?.[0]?.txCount ?? null,
    topFunderValueEth: funding.funders?.[0]?.valueEth ?? null,
    note: funding.note || null,
  } : null;

  // Factory-deployed contracts skip the wallet-shape red flags — a factory
  // always has "0 balance" (funds are pulled at mint time) and looks nothing
  // like a fresh rugger's throwaway wallet even though the raw numbers can.
  const redFlags = isFactoryDeployed ? [] : collectRedFlags({
    walletAgeDays,
    walletAgeIsExact,
    txCount: history?.txCount,
    coinBalanceEth: history?.coinBalanceEth,
    funding: fundingSummary,
    reputation,
  });

  const profile = {
    contract: addr,
    deployer: creator,
    partial,
    isFactoryDeployed,
    deployTimestamp: history?.deployTimestamp || null,
    deployBlock: history?.deployBlock ?? null,
    walletAgeDays,
    walletFirstSeenAt,
    walletAgeIsExact,
    txCount: history?.txCount ?? null,
    tokenTransferCount: history?.tokenTransferCount ?? null,
    coinBalanceEth: history?.coinBalanceEth ?? null,
    labelName: history?.labelName || null,
    funding: fundingSummary,
    priorDeploys,
    priorDeployStats: {
      total: priorAddrs.length,
      scored: scoredPrior.length,
      clean: cleanCount,
      rugged: ruggedCount,
      dead: deadCount,
      alive: aliveCount,
      verdict: priorRug?.verdict || null,
    },
    reputation,
    reputationLine,
    redFlags,
  };

  writeCache(addr, profile);
  return { ...profile, cached: false };
}

// Convenience: expose the cache key prefix so tests / debugging tools can
// clear it without importing the constant elsewhere.
export const _DEPLOYER_CACHE_PREFIX = CACHE_KEY_PREFIX;
