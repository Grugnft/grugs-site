/**
 * Rug Radar score — server-side one-shot endpoint.
 *
 * Query:  /api/rug-score?addr=0x…&chain=rhc|arc
 * Response (single JSON, always 200):
 *   {
 *     ok: boolean,
 *     addr, chain,
 *     score: number,               // 0–100 (higher = riskier)
 *     tone:  'green'|'yellow'|'red'|'grey',
 *     verdict: string,             // "grug approve" | "grug wary" | "grug run" | "grug not sure"
 *     confidence: number,          // 0–100 (fraction of *applicable* signals that resolved)
 *     resolved, totalSignals,      // for the "13/16 checks" caption
 *     lowConfidence: boolean,
 *     name, symbol, tokenType,     // display only, best-effort
 *     scannerUrl: string           // deep link to the full scanner report
 *   }
 *
 * Why this exists: the Chrome extension (site/../extension/) needs one HTTPS
 * call per OpenSea page. Bundling the whole engine into the extension would
 * mean re-shipping 6 endpoint fetches from `opensea.io`, which then costs
 * users a lot of cross-origin overhead. A single cached endpoint here is
 * cheaper on their machine + cache-friendly at the Vercel edge.
 *
 * Runs the *same* signal logic the website uses — imports
 * `computeScoreFromData` + `readOnChain` from the shared engine and calls
 * the sibling explorer/OpenSea endpoints by absolute URL. Any signal
 * improvement anywhere ripples here automatically.
 *
 * Cached 15 min per (addr, chain) at both the in-memory layer and via
 * `cache-control: s-maxage=900` for the CDN. The extension can hammer this
 * on every SPA page change without shipping a real request each time.
 */

import {
  readOnChain,
  computeScoreFromData,
} from '../site/scripts/grug-score-engine.mjs';
import { getChain } from '../site/scripts/chains.mjs';
import { verifyMessage } from 'ethers';

const GRUGS_CONTRACT   = '0x71b125F8cD4ebb8180ffA072fCbd5409Ee392517';
const GRUGS_RPC        = 'https://rpc.mainnet.chain.robinhood.com';
const UNLOCK_MIN_GRUGS = 10;
const UNLOCK_DURATION_MS = 7 * 24 * 60 * 60 * 1000;
const BALANCE_OF_SEL   = '0x70a08231';

// The engine's fetch base is the browser's page origin ('/api/...'). Here
// we synthesize an absolute base from the incoming request so the sibling
// endpoints resolve. Vercel serves the deployment host in x-forwarded-host.
function absoluteBase(req) {
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'www.grugnft.xyz';
  const proto = req.headers['x-forwarded-proto'] || 'https';
  return `${proto}://${host}`;
}

async function fetchJson(url, timeoutMs = 12000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ac.signal });
    clearTimeout(t);
    if (!r.ok) return null;
    return await r.json();
  } catch (e) {
    clearTimeout(t);
    return null;
  }
}

// Vercel function budget — one score builds ~6 upstream fetches. 30s
// matches the rest of the scanner endpoint budget so a really bad
// Blockscout day doesn't 502 the extension.
export const config = { maxDuration: 30 };

const TTL = 15 * 60 * 1000;
const cache = (globalThis.__grugRugScoreCache ||= new Map());

export default async function handler(req, res) {
  res.setHeader('content-type', 'application/json');
  // Extension calls this from opensea.io — CORS must be permissive.
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }

  const q = req.query || Object.fromEntries(new URL(req.url, 'http://x/').searchParams.entries());

  // ---- extension unlock verify path ----
  // Extension calls: /api/rug-score?action=verify-unlock&code=<base64url>
  // Decodes {address, expires, signature}, verifies signature was signed by
  // address, and checks address still holds >= UNLOCK_MIN_GRUGS on RHC.
  if (q.action === 'verify-unlock') {
    try {
      const result = await verifyUnlock(String(q.code || ''));
      res.statusCode = 200;
      res.end(JSON.stringify(result));
    } catch (e) {
      res.statusCode = 200;
      res.end(JSON.stringify({ ok: false, error: 'verify_failed', message: e.message || 'verify failed' }));
    }
    return;
  }

  const addr    = (q.addr || '').toLowerCase();
  const chainId = (q.chain || 'rhc').toLowerCase();

  if (!/^0x[0-9a-f]{40}$/.test(addr)) {
    res.statusCode = 400;
    res.end(JSON.stringify({ ok: false, error: 'invalid_addr' }));
    return;
  }
  const chain = getChain(chainId);
  if (!chain) {
    res.statusCode = 400;
    res.end(JSON.stringify({ ok: false, error: 'unknown_chain' }));
    return;
  }

  const cacheKey = `${chain.id}|${addr}`;
  const now = Date.now();
  const hit = cache.get(cacheKey);
  if (hit && hit.expiresAt > now) {
    res.setHeader('cache-control', 'public, max-age=60, s-maxage=900');
    res.statusCode = 200;
    res.end(JSON.stringify({ ...hit.value, cached: true }));
    return;
  }

  const base = absoluteBase(req);
  const qs = `?addr=${addr}&chain=${chain.id}`;

  let onChain, explorer, deployerHist, priorRug, funding, collection;
  try {
    [onChain, explorer, deployerHist, priorRug, funding, collection] = await Promise.all([
      readOnChain(addr, chain),
      fetchJson(`${base}/api/explorer-info${qs}`),
      fetchJson(`${base}/api/deployer-history${qs}`),
      fetchJson(`${base}/api/prior-rug-check${qs}`),
      fetchJson(`${base}/api/deployer-funding${qs}`),
      fetchJson(`${base}/api/collection-detail?contract=${addr}&chain=${chain.id}`),
    ]);
  } catch (e) {
    res.statusCode = 200;
    res.end(JSON.stringify({ ok: false, error: 'read_failed', message: e.message || 'read failed' }));
    return;
  }

  if (onChain.notAContract) {
    const payload = { ok: false, error: 'not_a_contract', addr, chain: chain.id };
    cache.set(cacheKey, { value: payload, expiresAt: now + TTL });
    res.setHeader('cache-control', 'public, max-age=300, s-maxage=900');
    res.statusCode = 200;
    res.end(JSON.stringify(payload));
    return;
  }

  const { score, confidence, resolved, totalSignals } = computeScoreFromData({
    addr, chain, onChain, explorer, deployerHist, priorRug, funding, collection,
  });

  let tone, verdict, lowConfidence = false;
  if (confidence < 60) {
    tone = 'grey';    verdict = 'grug not sure'; lowConfidence = true;
  } else if (score < 25) {
    tone = 'green';   verdict = 'grug approve';
  } else if (score < 60) {
    tone = 'yellow';  verdict = 'grug wary';
  } else {
    tone = 'red';     verdict = 'grug run';
  }

  const payload = {
    ok: true,
    addr, chain: chain.id,
    score, tone, verdict,
    confidence, resolved, totalSignals, lowConfidence,
    name:   collection?.name || explorer?.tokenName || null,
    symbol: explorer?.tokenSymbol || null,
    tokenType: explorer?.tokenType || null,
    scannerUrl: `https://www.grugnft.xyz/scanner?chain=${chain.id}&addr=${addr}`,
  };

  cache.set(cacheKey, { value: payload, expiresAt: now + TTL });
  res.setHeader('cache-control', 'public, max-age=60, s-maxage=900');
  res.statusCode = 200;
  res.end(JSON.stringify(payload));
}

// ============================================================================
// Chrome extension unlock verification.
//
// Flow: the site's /extension-unlock page asks the user to sign a message,
// packs {address, expires, signature} into a base64url code, and the user
// pastes that code into the extension popup. The extension then calls this
// endpoint to (1) prove the signature came from `address` (ecrecover), and
// (2) confirm the address still holds >= UNLOCK_MIN_GRUGS. Both must pass.
// ============================================================================
function unlockMessage(address, expires) {
  return `Grug Rug Radar unlock\n\nWallet: ${address}\nExpires: ${expires}`;
}

async function grugsBalance(address) {
  // balanceOf(address) on the Grugs contract, RHC RPC.
  const paddedAddr = address.toLowerCase().replace(/^0x/, '').padStart(64, '0');
  const data = BALANCE_OF_SEL + paddedAddr;
  const body = {
    jsonrpc: '2.0', id: 1, method: 'eth_call',
    params: [{ to: GRUGS_CONTRACT, data }, 'latest'],
  };
  const r = await fetch(GRUGS_RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await r.json();
  if (!json.result || json.result === '0x') return 0;
  return parseInt(json.result, 16);
}

async function verifyUnlock(code) {
  if (!code) return { ok: false, error: 'no_code' };

  let decoded;
  try {
    const b64 = code.replace(/-/g, '+').replace(/_/g, '/');
    decoded = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  } catch {
    return { ok: false, error: 'malformed_code' };
  }

  const { address, expires, signature } = decoded || {};
  if (!/^0x[0-9a-fA-F]{40}$/.test(address || '')) return { ok: false, error: 'bad_address' };
  if (typeof expires !== 'number' || expires < Date.now())     return { ok: false, error: 'expired' };
  if (typeof signature !== 'string' || !signature.startsWith('0x')) return { ok: false, error: 'bad_signature' };

  // 1. ecrecover: signature must have been made by `address`.
  let recovered;
  try {
    recovered = verifyMessage(unlockMessage(address, expires), signature);
  } catch {
    return { ok: false, error: 'signature_verify_failed' };
  }
  if (recovered.toLowerCase() !== address.toLowerCase()) {
    return { ok: false, error: 'signature_mismatch' };
  }

  // 2. balance check: address must still hold >= UNLOCK_MIN_GRUGS.
  let bal = 0;
  try {
    bal = await grugsBalance(address);
  } catch {
    return { ok: false, error: 'balance_check_failed' };
  }
  if (bal < UNLOCK_MIN_GRUGS) {
    return { ok: false, error: 'insufficient_balance', held: bal, required: UNLOCK_MIN_GRUGS };
  }

  return { ok: true, address: address.toLowerCase(), expires, held: bal };
}

export { unlockMessage, UNLOCK_MIN_GRUGS, UNLOCK_DURATION_MS };
