/**
 * Generic URL reachability probe.
 *
 * Query: /api/link-check?url=https://example.com
 *
 * Server-side so it bypasses browser CORS and avoids leaking the user's IP
 * to arbitrary hosts. Follows redirects, honors robots-friendly UA, small
 * response size cap.
 *
 * Response:
 *   {
 *     url: "https://example.com",
 *     ok: true,
 *     status: 200,
 *     finalUrl: "https://example.com/",
 *     contentType: "text/html; charset=utf-8",
 *     title: "Example Domain"   // best-effort
 *   }
 */

const TIMEOUT_MS = 5000;
const MAX_BYTES  = 64 * 1024; // 64KB is plenty to find a <title>

const UA = 'GrugsRugRadar/1.0 (+https://grugnft.xyz)';

function isSafeUrl(u) {
  try {
    const parsed = new URL(u);
    if (!/^https?:$/.test(parsed.protocol)) return false;
    // Reject explicit private / loopback hostnames — cheap SSRF guard.
    // (This is a best-effort check; a full SSRF hardening pass would also
    // resolve DNS and reject private IP ranges.)
    const host = parsed.hostname.toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0') return false;
    if (host.endsWith('.internal') || host.endsWith('.local')) return false;
    if (/^10\./.test(host) || /^192\.168\./.test(host)) return false;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;
    return true;
  } catch (e) { return false; }
}

async function probe(url) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      headers: { 'user-agent': UA, 'accept': 'text/html,*/*;q=0.8' },
      signal: ac.signal,
    });
    clearTimeout(t);

    const contentType = r.headers.get('content-type') || '';
    let title = null;
    if (r.body && /html/i.test(contentType)) {
      // Read up to MAX_BYTES then bail
      const reader = r.body.getReader();
      const chunks = [];
      let total = 0;
      while (total < MAX_BYTES) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        total += value.length;
      }
      try { reader.cancel(); } catch (e) {}
      const text = new TextDecoder('utf-8', { fatal: false }).decode(concat(chunks));
      const m = text.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      if (m) title = m[1].trim().replace(/\s+/g, ' ').slice(0, 140);
    }

    return {
      ok: r.ok,
      status: r.status,
      finalUrl: r.url,
      contentType,
      title,
    };
  } catch (e) {
    clearTimeout(t);
    return { ok: false, error: e.name || 'error', message: e.message };
  }
}

function concat(chunks) {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

export default async function handler(req, res) {
  const url = (req.query && req.query.url) ||
              new URL(req.url, 'http://x/').searchParams.get('url');

  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('content-type', 'application/json');
  res.setHeader('cache-control', 'public, max-age=1800, s-maxage=1800'); // 30min

  if (!url || !isSafeUrl(url)) {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: 'invalid_url', hint: 'expected http(s) URL, not localhost/private' }));
    return;
  }

  const result = await probe(url);
  res.statusCode = 200;
  res.end(JSON.stringify({ url, ...result }));
}
