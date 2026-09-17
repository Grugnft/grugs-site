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
