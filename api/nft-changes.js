/**
 * NFT Trencher `/changes` proxy.
 *
 * Query: /api/nft-changes?since=<iso|unix-seconds|unix-ms>
 *
 * Upstream: GET https://neverfuckingtrade.com/api/v1/changes?since=…
 *   Returns the mints whose name / links / stages / status / supply / flags
 *   have changed after `since`, plus the ids of any mints that left the
 *   board. Docs quirk: after a Trencher restart, every mint counts as
 *   changed at that moment — take the whole /mints list once and go on
 *   from its `built` when that happens (we don't need to handle that here;
 *   the caller compares against its stored `built` and moves on).
 *
 * Rate limit: 120 req/min per key. Our cache is 60s on success so this
 * costs at most 1 upstream call/min per unique `since` value.
 *
 * If NFT_API_TOKEN isn't set: returns { configured: false } so the mints
 * page gracefully skips the "new since last visit" feature.
 */

const NFT_BASE    = process.env.NFT_API_BASE || 'https://neverfuckingtrade.com/api/v1';
const NFT_CHANGES = process.env.NFT_API_CHANGES_PATH || '/changes';

const TIMEOUT_MS = 8000;
const TTL_OK     = 60 * 1000;   // 60s — changes are meant to be polled fresh-ish

const cache = (globalThis.__grugNftChangesCache ||= new Map());

async function fetchOnce(url, token) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      signal: ac.signal,
      headers: {
        'x-api-key':     token,
        'authorization': 'Bearer ' + token,
        'accept':        'application/json',
        'user-agent':    'GrugsRugRadar/1.0 (+https://grugnft.xyz)',
      },
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

async function fetchWithRetry(url, token) {
  let r = await fetchOnce(url, token);
  const flaky = x => x.value === null && (x.status === 0 || x.status >= 500);
  if (flaky(r)) {
    await new Promise(res => setTimeout(res, 500));
    r = await fetchOnce(url, token);
  }
  return r;
}

export default async function handler(req, res) {
  const q = req.query || Object.fromEntries(new URL(req.url, 'http://x/').searchParams.entries());
  const since = q.since || '';

  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('content-type', 'application/json');

  const token = process.env.NFT_API_TOKEN;
  if (!token) {
    res.statusCode = 200;
    res.end(JSON.stringify({ configured: false, changed: [], removed: [] }));
    return;
  }

  const cacheKey = `since=${since}`;
  const now = Date.now();
  const hit = cache.get(cacheKey);
  if (hit && hit.expiresAt > now) {
    res.setHeader('cache-control', 'public, max-age=30');
    res.statusCode = 200;
    res.end(JSON.stringify({ configured: true, cached: true, ...hit.value }));
    return;
  }

  // Trencher's `since` parameter accepts iso, unix seconds, or unix ms — we
  // pass through whatever the client gave us verbatim. `chain=robinhood` on the
  // upstream side ensures we only ever ask about the chain we care about.
  const params = new URLSearchParams({ chain: 'robinhood' });
  if (since) params.set('since', since);
  const url = `${NFT_BASE}${NFT_CHANGES}?${params.toString()}`;
  const r = await fetchWithRetry(url, token);

  if (!r.value) {
    if (r.status === 401) {
      res.statusCode = 200;
      res.end(JSON.stringify({
        configured: true,
        error: 'auth_failed',
        status: r.status,
        changed: [], removed: [],
      }));
      return;
    }
    res.setHeader('cache-control', 'public, max-age=30');
    res.statusCode = 200;
    res.end(JSON.stringify({
      configured: true,
      error: 'upstream_unreachable',
      status: r.status,
      changed: [], removed: [],
    }));
    return;
  }

  // Upstream shape: { v, built, since, changed: [full mint objects], removed: [{id, at}] }
  // We keep only the identifying bits — full mint metadata comes from /mints. This
  // keeps the response small (a busy day of 40 changes stays well under 4KB).
  const changed = Array.isArray(r.value.changed) ? r.value.changed : [];
  const removed = Array.isArray(r.value.removed) ? r.value.removed : [];

  const payload = {
    built: r.value.built || null,
    since: r.value.since || since || null,
    changedIds: changed.map(m => ({
      id: m.id || null,
      contract: m.contract ? String(m.contract).toLowerCase() : null,
      chain: m.chain || null,
      name: m.name || null,
      updatedAt: m.updated_at || null,
    })).filter(x => x.contract),
    removedIds: removed.map(r => r.id).filter(Boolean),
    changedCount: changed.length,
    removedCount: removed.length,
  };

  cache.set(cacheKey, { value: payload, expiresAt: now + TTL_OK });
  res.setHeader('cache-control', 'public, max-age=30, s-maxage=60');
  res.statusCode = 200;
  res.end(JSON.stringify({ configured: true, cached: false, ...payload }));
}
