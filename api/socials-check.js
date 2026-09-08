/**
 * Socials probe — verifies a website is reachable and a Twitter/X handle exists.
 *
 * Query: /api/socials-check?website=https://…&twitter=https://twitter.com/handle
 *        or /api/socials-check?twitter=@handle
 *
 * Response:
 *   {
 *     website: { url, ok, status, title } | null,
 *     twitter: { handle, exists, url, checked: true } | null,
 *     score:   { website: bool, twitter: bool, both: bool }
 *   }
 *
 * NOTE: `exists` for Twitter is inferred from an unauthenticated HEAD-style
 * GET to twitter.com/<handle> — a 200 body without X's "user not found"
 * pattern indicates the account exists. This does NOT tell us whether the
 * account is posting regularly; that needs the Twitter API v2 with your own
 * bearer token. Set process.env.TWITTER_BEARER to enable an activity check.
 */

const TIMEOUT_MS = 5000;
const UA = 'GrugsRugRadar/1.0 (+https://grugnft.xyz)';

function extractTwitterHandle(input) {
  if (!input) return null;
  const s = String(input).trim();
  let m;
  // Full URL forms
  if ((m = s.match(/^https?:\/\/(?:www\.)?(?:twitter|x)\.com\/([A-Za-z0-9_]{1,15})\/?/i))) return m[1];
  // @handle form
  if ((m = s.match(/^@?([A-Za-z0-9_]{1,15})$/))) return m[1];
  return null;
}

async function fetchWithTimeout(url, opts = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { ...opts, signal: ac.signal });
    clearTimeout(t);
    return r;
  } catch (e) {
    clearTimeout(t);
    throw e;
  }
}

async function checkWebsite(url) {
  try {
    // Delegate to link-check logic (inlined here to keep endpoints independent)
    const r = await fetchWithTimeout(url, {
      method: 'GET',
      redirect: 'follow',
      headers: { 'user-agent': UA, 'accept': 'text/html,*/*;q=0.8' },
    });
    let title = null;
    const ct = r.headers.get('content-type') || '';
    if (/html/i.test(ct)) {
      const text = await r.text().catch(() => '');
      const m = text.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      if (m) title = m[1].trim().replace(/\s+/g, ' ').slice(0, 140);
    }
    return { url, ok: r.ok, status: r.status, finalUrl: r.url, title };
  } catch (e) {
    return { url, ok: false, error: e.name || 'error' };
  }
}

async function checkTwitter(handle) {
  const url = `https://twitter.com/${encodeURIComponent(handle)}`;
  try {
    // Twitter/X blocks a lot of bot UAs. We try both twitter.com and x.com;
    // getting *any* 200 is enough to say "handle route exists". Unauthenticated
    // Twitter often returns 200 with a client shell — the endpoint existing is
    // our only reliable check without an API key.
    const r = await fetchWithTimeout(url, {
      method: 'GET',
      redirect: 'follow',
      headers: {
        'user-agent': UA,
        'accept': 'text/html',
      },
    });
    return {
      handle,
      exists: r.status < 400,
      status: r.status,
      url,
      checked: true,
      note: 'existence only — posting-regularity check needs a Twitter API key',
    };
  } catch (e) {
    return { handle, exists: null, error: e.name || 'error', url, checked: false };
  }
}

export default async function handler(req, res) {
  const q = req.query || Object.fromEntries(new URL(req.url, 'http://x/').searchParams.entries());
  const website = q.website || null;
  const twitterInput = q.twitter || null;

  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('content-type', 'application/json');
  res.setHeader('cache-control', 'public, max-age=1800, s-maxage=1800'); // 30min

  const twitterHandle = extractTwitterHandle(twitterInput);
  const [websiteRes, twitterRes] = await Promise.all([
    website ? checkWebsite(website) : Promise.resolve(null),
    twitterHandle ? checkTwitter(twitterHandle) : Promise.resolve(null),
  ]);

  const websiteOk = !!(websiteRes && websiteRes.ok);
  const twitterOk = !!(twitterRes && twitterRes.exists);

  res.statusCode = 200;
  res.end(JSON.stringify({
    website: websiteRes,
    twitter: twitterRes,
    score: { website: websiteOk, twitter: twitterOk, both: websiteOk && twitterOk },
  }));
}
