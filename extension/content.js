/**
 * Grug's Rug Radar — OpenSea content script.
 *
 * Runs on every opensea.io page. When the URL points at an NFT contract on
 * a chain we support (Robinhood or Arc), fires ONE request to
 * grugnft.xyz/api/rug-score and injects a floating badge with the verdict.
 *
 * WHAT THIS SCRIPT DOES NOT DO:
 *   - never touches window.ethereum, MetaMask, or any wallet API
 *   - never reads cookies, localStorage, or DOM data outside the URL
 *   - never sends anything except the contract address + chain slug
 *   - never runs on any origin other than opensea.io
 *
 * Everything's stateless. Refresh clears any badge.
 */

const API_BASE = 'https://www.grugnft.xyz';

// OpenSea chain slug → grug chain id. Anything not in this map means we
// don't have a rug-radar backend for that chain, so we stay silent (no
// badge). Add new chains here in the same order as chains.mjs.
const CHAIN_MAP = {
  'robinhood': 'rhc',
  'arc':       'arc',
};

// Cache in-memory per page load. OpenSea is a heavy SPA — the user might
// bounce between item pages a lot; hitting /api/rug-score every time is
// wasteful and slow. 5-min TTL matches the server-side edge cache.
const CACHE = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000;

// Track the badge we injected so URL changes replace it in place instead of
// stacking three of them.
let BADGE_HOST = null;
let CURRENT_KEY = null;

/**
 * Parse the URL for (chain, contract). Handles a few OpenSea shapes:
 *   /assets/{chain}/{contract}/{tokenId}          — item page
 *   /assets/{chain}/{contract}                    — collection group (rare)
 *   /item/{chain}/{contract}/{tokenId}            — some SEO redirects
 * Returns null when the URL doesn't reference a contract on a chain we
 * support, so the caller can silently skip.
 */
function parseUrl(url) {
  try {
    const u = new URL(url);
    if (u.hostname !== 'opensea.io') return null;
    const parts = u.pathname.split('/').filter(Boolean);
    // /assets/<chain>/<contract>/<tokenId?>
    // /item/<chain>/<contract>/<tokenId?>
    if ((parts[0] === 'assets' || parts[0] === 'item') && parts.length >= 3) {
      const chainSlug = parts[1].toLowerCase();
      const contract  = (parts[2] || '').toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(contract)) return null;
      const chainId = CHAIN_MAP[chainSlug];
      if (!chainId) return null;
      return { chainId, contract, chainSlug };
    }
    return null;
  } catch (e) {
    return null;
  }
}

async function fetchScore(chainId, contract) {
  const key = `${chainId}|${contract}`;
  const cached = CACHE.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.data;

  const url = `${API_BASE}/api/rug-score?addr=${contract}&chain=${chainId}`;
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`grug api HTTP ${r.status}`);
  const data = await r.json();
  CACHE.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
  return data;
}

function toneClass(tone) {
  if (tone === 'green')  return 'grug-green';
  if (tone === 'yellow') return 'grug-yellow';
  if (tone === 'red')    return 'grug-red';
  return 'grug-grey';
}

function shadowStyles() {
  // Injected into the shadow root so OpenSea's CSS can't leak into the badge.
  return `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: 'Courier New', ui-monospace, monospace; }
    .card {
      position: fixed; top: 16px; right: 16px; z-index: 2147483647;
      min-width: 240px; max-width: 320px;
      background: #1A140F; color: #E7DDCF;
      border: 2px solid #3a2f24;
      padding: 12px 14px 12px;
      box-shadow: 0 6px 24px rgba(0,0,0,0.4);
      font-size: 13px; letter-spacing: 0.4px;
    }
    .card.grug-green  { border-color: #7A9A5A; }
    .card.grug-yellow { border-color: #E8B33A; }
    .card.grug-red    { border-color: #C55C4B; }
    .card.grug-grey   { border-color: #8A7C6E; }
    .head { display:flex; align-items:center; gap:8px; margin-bottom:8px; }
    .badge {
      font-size: 10px; letter-spacing: 1.5px;
      background: #7A9A5A; color: #1A140F;
      padding: 2px 6px; font-weight: bold;
    }
    .close {
      margin-left: auto; cursor: pointer; opacity: 0.6;
      background: none; border: none; color: inherit;
      font-family: inherit; font-size: 14px;
    }
    .close:hover { opacity: 1; }
    .verdict { font-size: 16px; margin: 4px 0; letter-spacing: 1px; }
    .verdict.grug-green  { color: #7A9A5A; }
    .verdict.grug-yellow { color: #E8B33A; }
    .verdict.grug-red    { color: #C55C4B; }
    .verdict.grug-grey   { color: #B0A498; }
    .score { font-size: 13px; opacity: 0.85; }
    .score b { color: #E7DDCF; }
    .sub { font-size: 11px; opacity: 0.65; margin-top: 4px; }
    .cta {
      display: block; text-align: center; margin-top: 10px;
      padding: 8px 10px; background: #241A12;
      color: #7A9A5A; text-decoration: none;
      border: 1px solid #3a2f24;
      font-size: 11px; letter-spacing: 1.5px;
    }
    .cta:hover { background: #2c2016; color: #E7DDCF; }
    .cta:visited { color: #7A9A5A; }
    .loading { opacity: 0.65; font-size: 12px; }
    .safety {
      margin-top: 8px; font-size: 9px; opacity: 0.45;
      border-top: 1px solid #241A12; padding-top: 6px;
    }
  `;
}

function renderLoading(host) {
  host.shadowRoot.innerHTML = `<style>${shadowStyles()}</style>
    <div class="card grug-grey">
      <div class="head">
        <span class="badge">RUG RADAR</span>
        <button class="close" title="close">×</button>
      </div>
      <div class="loading">grug sniffing contract…</div>
    </div>`;
  host.shadowRoot.querySelector('.close').addEventListener('click', () => host.remove());
}

function renderResult(host, data) {
  const cls = toneClass(data.tone);
  const short = data.addr ? `${data.addr.slice(0, 6)}…${data.addr.slice(-4)}` : '';
  const chainLbl = data.chain === 'arc' ? 'Arc' : 'RHC';

  if (!data.ok) {
    host.shadowRoot.innerHTML = `<style>${shadowStyles()}</style>
      <div class="card grug-grey">
        <div class="head">
          <span class="badge">RUG RADAR</span>
          <button class="close" title="close">×</button>
        </div>
        <div class="verdict grug-grey">grug not sure</div>
        <div class="sub">${data.error === 'not_a_contract' ? 'address is not a contract' : 'grug scan failed. try opening the full report.'}</div>
        <a class="cta" target="_blank" rel="noopener" href="${data.scannerUrl || (API_BASE + '/scanner')}">open full report →</a>
      </div>`;
    host.shadowRoot.querySelector('.close').addEventListener('click', () => host.remove());
    return;
  }

  host.shadowRoot.innerHTML = `<style>${shadowStyles()}</style>
    <div class="card ${cls}">
      <div class="head">
        <span class="badge">RUG RADAR · ${chainLbl}</span>
        <button class="close" title="close">×</button>
      </div>
      <div class="verdict ${cls}">${data.verdict}</div>
      <div class="score"><b>${data.score}</b> / 100 risk · CONF ${data.confidence}% (${data.resolved}/${data.totalSignals})</div>
      <div class="sub">${escapeHtml(data.name || short)}${data.symbol ? ' · $' + escapeHtml(data.symbol) : ''}</div>
      <a class="cta" target="_blank" rel="noopener" href="${escapeAttr(data.scannerUrl)}">open full report →</a>
      <div class="safety">read-only · no wallet · no data collected</div>
    </div>`;
  host.shadowRoot.querySelector('.close').addEventListener('click', () => host.remove());
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => (
    { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]
  ));
}
function escapeAttr(s) { return escapeHtml(s); }

function ensureBadgeHost() {
  if (BADGE_HOST && document.body.contains(BADGE_HOST)) return BADGE_HOST;
  const host = document.createElement('div');
  host.id = 'grug-rug-radar-host';
  host.attachShadow({ mode: 'open' });
  document.body.appendChild(host);
  BADGE_HOST = host;
  return host;
}

async function runOnCurrentUrl() {
  const parsed = parseUrl(location.href);
  if (!parsed) {
    // Not a contract page → remove any existing badge.
    if (BADGE_HOST && document.body.contains(BADGE_HOST)) BADGE_HOST.remove();
    BADGE_HOST = null;
    CURRENT_KEY = null;
    return;
  }
  const key = `${parsed.chainId}|${parsed.contract}`;
  if (key === CURRENT_KEY && BADGE_HOST && document.body.contains(BADGE_HOST)) return; // same page
  CURRENT_KEY = key;

  const host = ensureBadgeHost();
  renderLoading(host);
  try {
    const data = await fetchScore(parsed.chainId, parsed.contract);
    // If the URL changed while we were fetching, throw the result away.
    const stillParsed = parseUrl(location.href);
    if (!stillParsed || `${stillParsed.chainId}|${stillParsed.contract}` !== key) return;
    renderResult(host, data);
  } catch (e) {
    renderResult(host, { ok: false, addr: parsed.contract, chain: parsed.chainId, error: 'fetch_failed' });
  }
}

// OpenSea is an SPA: pushState / replaceState / popstate. Hook all three so
// the badge updates when the user clicks around without a real navigation.
function hookHistory() {
  const wrap = (name) => {
    const orig = history[name];
    history[name] = function () {
      const rv = orig.apply(this, arguments);
      queueMicrotask(runOnCurrentUrl);
      return rv;
    };
  };
  wrap('pushState');
  wrap('replaceState');
  window.addEventListener('popstate', runOnCurrentUrl);
}

hookHistory();
runOnCurrentUrl();
