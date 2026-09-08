/**
 * Token metadata fetcher.
 *
 * Query: /api/metadata-fetch?uri=<tokenURI>
 *   Accepts ipfs://, ar://, https://, or data: URIs.
 *
 * Server-side so it bypasses browser CORS on public IPFS gateways.
 * Returns the parsed JSON along with an extracted socials guess.
 *
 * Response:
 *   {
 *     uri: "ipfs://…",
 *     ok: true,
 *     via: "https://cloudflare-ipfs.com/ipfs/…",
 *     json: { ... raw metadata ... },
 *     extracted: {
 *       name, description,
 *       external_url, twitter, discord, website,
 *       image
 *     }
 *   }
 */

const IPFS_GATEWAYS = [
  'https://cloudflare-ipfs.com/ipfs/',
  'https://ipfs.io/ipfs/',
  'https://dweb.link/ipfs/',
  'https://gateway.pinata.cloud/ipfs/',
];
const AR_GATEWAY = 'https://arweave.net/';
const TIMEOUT_MS = 5000;
const MAX_BYTES  = 128 * 1024; // 128KB — bigger for metadata JSON

async function fetchJson(url) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      redirect: 'follow',
      signal: ac.signal,
      headers: {
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36',
        'accept': 'application/json,*/*;q=0.8',
      },
    });
    clearTimeout(t);
    if (!r.ok) return { ok: false, status: r.status };
    // Cap read
    const reader = r.body?.getReader();
    if (!reader) return { ok: false, error: 'no_body' };
    const chunks = [];
    let total = 0;
    while (total < MAX_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value); total += value.length;
    }
    try { reader.cancel(); } catch (e) {}
    const buf = new Uint8Array(total);
    { let off = 0; for (const c of chunks) { buf.set(c, off); off += c.length; } }
    const text = new TextDecoder('utf-8', { fatal: false }).decode(buf);
    try {
      return { ok: true, json: JSON.parse(text) };
    } catch (e) {
      return { ok: false, error: 'invalid_json' };
    }
  } catch (e) {
    clearTimeout(t);
    return { ok: false, error: e.name || 'error' };
  }
}

function toGatewayUrl(uri) {
  const s = String(uri).trim();
  let m;
  if ((m = s.match(/^ipfs:\/\/(?:ipfs\/)?(.+)$/i))) return IPFS_GATEWAYS.map(g => g + m[1]);
  if ((m = s.match(/^ar:\/\/(.+)$/i))) return [AR_GATEWAY + m[1]];
  if (/^https?:\/\//i.test(s)) return [s];
  if (/^data:/i.test(s)) return [s]; // handled inline below
  return null;
}

function parseDataUri(uri) {
  // data:application/json;base64,<...> or data:application/json,<url-encoded>
  const m = uri.match(/^data:([^;,]+)(?:;([^,]+))?,(.*)$/i);
  if (!m) return null;
  const [_, mime, encoding, payload] = m;
  try {
    const text = encoding === 'base64'
      ? Buffer.from(payload, 'base64').toString('utf-8')
      : decodeURIComponent(payload);
    if (/json/i.test(mime)) return JSON.parse(text);
    return { raw: text };
  } catch (e) { return null; }
}

function extractSocials(json) {
  if (!json || typeof json !== 'object') return {};
  const out = {};
  out.name = json.name || json.collection?.name || null;
  out.description = json.description || null;
  out.external_url = json.external_url || json.external_link || json.website || null;
  out.image = json.image || json.image_url || null;

  // Twitter/Discord may appear in attributes, in the top-level fields, or in a
  // `links`/`social` object. Cover the common shapes.
  const candidates = { twitter: null, discord: null, website: out.external_url };
  const scan = (obj) => {
    if (!obj || typeof obj !== 'object') return;
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v !== 'string') continue;
      const kl = k.toLowerCase();
      if (!candidates.twitter && (kl === 'twitter' || kl === 'x') && /(twitter\.com|x\.com|^@|^[A-Za-z0-9_]+$)/i.test(v)) candidates.twitter = v;
      if (!candidates.discord && kl === 'discord' && /discord\.(gg|com)/i.test(v)) candidates.discord = v;
      if (!candidates.website && (kl === 'website' || kl === 'external_url' || kl === 'homepage') && /^https?:\/\//i.test(v)) candidates.website = v;
    }
  };
  scan(json);
  scan(json.links);
  scan(json.social);
  scan(json.socials);
  if (Array.isArray(json.attributes)) {
    for (const a of json.attributes) {
      if (!a || typeof a !== 'object') continue;
      scan({ [a.trait_type || a.type || '']: a.value });
    }
  }
  return { ...out, ...candidates };
}

export default async function handler(req, res) {
  const uri = (req.query && req.query.uri) ||
              new URL(req.url, 'http://x/').searchParams.get('uri');

  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('content-type', 'application/json');
  res.setHeader('cache-control', 'public, max-age=1800, s-maxage=1800');

  if (!uri) {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: 'missing_uri' }));
    return;
  }

  // Handle data: inline
  if (/^data:/i.test(uri)) {
    const json = parseDataUri(uri);
    res.statusCode = 200;
    res.end(JSON.stringify({
      uri, ok: !!json, via: 'inline',
      json, extracted: json ? extractSocials(json) : {},
    }));
    return;
  }

  const urls = toGatewayUrl(uri);
  if (!urls) {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: 'unsupported_scheme', uri }));
    return;
  }

  // Race the gateways — first to succeed wins
  let result = null, viaUrl = null;
  for (const u of urls) {
    const r = await fetchJson(u);
    if (r.ok) { result = r.json; viaUrl = u; break; }
  }

  if (!result) {
    res.statusCode = 200;
    res.end(JSON.stringify({ uri, ok: false, via: null, json: null, extracted: {} }));
    return;
  }

  res.statusCode = 200;
  res.end(JSON.stringify({
    uri, ok: true, via: viaUrl,
    json: result,
    extracted: extractSocials(result),
  }));
}
