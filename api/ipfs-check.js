/**
 * IPFS pin / reachability probe.
 *
 * Query: /api/ipfs-check?uri=ipfs://<cid>[/path]
 *   or   /api/ipfs-check?uri=https://<gateway>/ipfs/<cid>[/path]
 *
 * Response:
 *   {
 *     cid: "bafy…",
 *     pinned: true|false,        // reachable on any public gateway
 *     reachableCount: 2,
 *     gatewaysChecked: 5,
 *     hitGateways: ["cloudflare-ipfs.com", "ipfs.io"]
 *   }
 *
 * Runs server-side so it bypasses browser CORS on public IPFS gateways.
 * Compatible with Vercel's Node runtime (default export) and this repo's
 * scripts/dev-server.mjs bridge for local development.
 */

const GATEWAYS = [
  'https://cloudflare-ipfs.com/ipfs/',
  'https://ipfs.io/ipfs/',
  'https://dweb.link/ipfs/',
  'https://gateway.pinata.cloud/ipfs/',
  'https://nftstorage.link/ipfs/',
];

function extractCid(uri) {
  if (!uri) return null;
  const s = String(uri).trim();
  let m;
  if ((m = s.match(/^ipfs:\/\/(?:ipfs\/)?([^/]+)(\/.*)?$/i))) return { cid: m[1], rest: m[2] || '' };
  if ((m = s.match(/^https?:\/\/[^/]+\/ipfs\/([^/]+)(\/.*)?$/i))) return { cid: m[1], rest: m[2] || '' };
  return null;
}

async function tryGateway(base, cid, rest, timeoutMs = 5000) {
  const url = base + cid + rest;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: 'GET',
      headers: {
        'Range': 'bytes=0-0',
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36',
      },
      redirect: 'follow',
      signal: ac.signal,
    });
    clearTimeout(t);
    return { ok: r.ok || r.status === 206, status: r.status, url };
  } catch (e) {
    clearTimeout(t);
    return { ok: false, error: e.name || 'error', url };
  }
}

export default async function handler(req, res) {
  // Params accessible from both Vercel's req.query and our dev bridge
  const uri = (req.query && req.query.uri) ||
              (new URL(req.url, 'http://x/')).searchParams.get('uri');

  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('content-type', 'application/json');
  res.setHeader('cache-control', 'public, max-age=1800, s-maxage=1800'); // 30min

  const parsed = extractCid(uri);
  if (!parsed) {
    res.statusCode = 400;
    res.end(JSON.stringify({
      error: 'invalid_uri',
      hint: 'expected ipfs://<cid>[/path] or a public gateway URL',
    }));
    return;
  }

  const results = await Promise.all(
    GATEWAYS.map(g => tryGateway(g, parsed.cid, parsed.rest))
  );
  const hits = results.filter(r => r.ok);

  res.statusCode = 200;
  res.end(JSON.stringify({
    cid: parsed.cid,
    pinned: hits.length > 0,
    reachableCount: hits.length,
    gatewaysChecked: GATEWAYS.length,
    hitGateways: hits.map(h => new URL(h.url).host),
  }));
}
