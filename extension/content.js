/**
 * Grug's Rug Radar — OpenSea content script.
 *
 * Runs on every opensea.io page. When the URL points at an NFT contract on
 * a chain we support (Robinhood or Arc), fires ONE request to
 * grugnft.xyz/api/rug-score and injects a floating badge with the verdict.
 *
 * SUPPORTED URL SHAPES:
 *   /collection/{slug}                         — resolved via /api/collection-by-slug
 *   /assets/{chain}/{contract}/{tokenId}       — direct match
 *   /assets/{chain}/{contract}
 *   /item/{chain}/{contract}/{tokenId}         — legacy shape some SEO paths use
 *
 * SAFETY NOTES:
 *   - never touches window.ethereum, MetaMask, or any wallet API
 *   - never reads cookies, localStorage, or DOM data outside the URL
 *   - never runs on any origin other than opensea.io
 *   - `chrome.storage.local` is used ONLY to persist an on/off toggle
 *     ({ enabled: boolean }). No PII, no addresses, no history.
 */

const API_BASE = 'https://www.grugnft.xyz';

// Toggle to true when debugging in DevTools — every nav event and API call
// gets a labelled console.debug. Off in shipped builds to keep users'
// consoles clean; flip on temporarily to diagnose stuck detection.
const DEBUG = false;
function log(...args) { if (DEBUG) console.debug('[Grug\'s Rug Radar]', ...args); }

// OpenSea chain slug → grug chain id. When we hit a chain not in this map
// (Base, Polygon, ...) the badge stays silent. Add new chains here in the
// same order as chains.mjs when we expand support.
const CHAIN_MAP = {
  'robinhood': 'rhc',
  'arc':       'arc',
  'ethereum':  'eth',
};

// In-memory response cache. 5-min TTL matches the server-side edge cache.
const CACHE = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000;

// Track the badge we injected so URL changes replace it in place instead of
// stacking three of them.
let BADGE_HOST = null;
let CURRENT_KEY = null;
let ENABLED = true; // Reflects chrome.storage.local.enabled — see loadEnabled()

// Reflects chrome.storage.local.unlock ({ address, expires }). See loadUnlock().
// When unlocked === false the extension renders a "hold 10 grugs to unlock"
// chip instead of the full badge on every supported page.
let UNLOCKED = false;
let UNLOCK_ADDR = null;
let UNLOCK_EXPIRES = 0;
const UNLOCK_URL = `${API_BASE}/extension-unlock`;

function isUnlocked() {
  return UNLOCKED && UNLOCK_EXPIRES > Date.now();
}

/**
 * Parse the URL for one of the supported shapes. Returns:
 *   { mode: 'asset', chainId, contract }              — direct match
 *   { mode: 'collection', slug }                      — needs slug→contract lookup
 *   null                                              — unsupported page
 */
function parseUrl(url) {
  try {
    const u = new URL(url);
    if (u.hostname !== 'opensea.io') return null;
    const parts = u.pathname.split('/').filter(Boolean);

    // /collection/{slug}
    if (parts[0] === 'collection' && parts[1]) {
      const slug = parts[1].toLowerCase();
      if (!/^[a-z0-9\-_]+$/.test(slug)) return null;
      return { mode: 'collection', slug };
    }

    // /assets/<chain>/<contract>/<tokenId?>
    // /item/<chain>/<contract>/<tokenId?>
    if ((parts[0] === 'assets' || parts[0] === 'item') && parts.length >= 3) {
      const chainSlug = parts[1].toLowerCase();
      const contract  = (parts[2] || '').toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(contract)) return null;
      const chainId = CHAIN_MAP[chainSlug];
      if (!chainId) return null;
      return { mode: 'asset', chainId, contract, chainSlug };
    }

    return null;
  } catch (e) {
    return null;
  }
}

async function fetchScore(chainId, contract) {
  const key = `score|${chainId}|${contract}`;
  const cached = CACHE.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.data;

  const url = `${API_BASE}/api/rug-score?addr=${contract}&chain=${chainId}`;
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`grug api HTTP ${r.status}`);
  const data = await r.json();
  CACHE.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
  return data;
}

async function resolveSlug(slug) {
  const key = `slug|${slug}`;
  const cached = CACHE.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.data;

  const r = await fetch(`${API_BASE}/api/collection-by-slug?slug=${encodeURIComponent(slug)}`, { cache: 'no-store' });
  if (!r.ok) throw new Error(`slug lookup HTTP ${r.status}`);
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
  return `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: ui-monospace, Menlo, 'Courier New', monospace; }
    @keyframes grug-slide-in {
      from { opacity: 0; transform: translateY(-8px); }
      to   { opacity: 1; transform: translateY(0); }
    }
    @keyframes grug-flicker {
      0%, 100% { opacity: 0.9; }
      50%      { opacity: 0.55; }
    }
    .card {
      position: fixed; top: 18px; right: 18px; z-index: 2147483647;
      min-width: 268px; max-width: 336px;
      background:
        radial-gradient(ellipse 400px 200px at 50% 100%, rgba(232,95,59,0.10) 0%, transparent 70%),
        #1E1712;
      color: #F0E5D2;
      border: 1px solid #33261C;
      border-top: 3px solid #45341E;
      border-radius: 8px;
      padding: 14px 16px;
      box-shadow: 0 12px 32px rgba(0,0,0,0.5), 0 2px 0 rgba(0,0,0,0.35);
      font-size: 13px; letter-spacing: 0.3px;
      animation: grug-slide-in 220ms ease-out;
      overflow: hidden;
    }
    .card::before {
      content: ""; position: absolute; inset: 0;
      pointer-events: none; opacity: 0.6;
      background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='120' height='120'><circle cx='12' cy='34' r='0.6' fill='%23FFE9C2' opacity='0.09'/><circle cx='68' cy='18' r='0.5' fill='%23FFE9C2' opacity='0.07'/><circle cx='102' cy='60' r='0.5' fill='%23FFE9C2' opacity='0.08'/><circle cx='34' cy='98' r='0.5' fill='%23FFE9C2' opacity='0.07'/><circle cx='96' cy='90' r='0.6' fill='%23FFE9C2' opacity='0.08'/><circle cx='50' cy='56' r='0.4' fill='%23FFE9C2' opacity='0.06'/></svg>");
      background-size: 120px 120px;
      mix-blend-mode: overlay;
    }
    .card.grug-green  { border-top-color: #8AB565; }
    .card.grug-yellow { border-top-color: #EBB958; }
    .card.grug-red    { border-top-color: #E85F3B; }
    .card.grug-grey   { border-top-color: #6E6152; }

    .head {
      position: relative;
      display: flex; align-items: center; gap: 8px;
      margin-bottom: 10px;
    }
    .badge {
      font-family: 'Menlo', ui-monospace, monospace;
      font-weight: 700;
      font-size: 9.5px; letter-spacing: 2px;
      background: rgba(232,161,71,0.18);
      color: #E8A147;
      border: 1px solid rgba(232,161,71,0.45);
      padding: 3px 8px;
      border-radius: 3px;
    }
    .badge .chain {
      display: inline-block; margin-left: 6px;
      padding-left: 6px; border-left: 1px solid rgba(232,161,71,0.35);
      color: #A89A82;
    }
    .close, .rescan {
      cursor: pointer; opacity: 0.55;
      background: none; border: none; color: inherit;
      font-family: inherit; padding: 2px 4px;
      transition: opacity 0.12s, color 0.12s;
    }
    .close { margin-left: auto; font-size: 18px; line-height: 1; }
    .rescan { font-size: 14px; letter-spacing: 1px; margin-left: auto; }
    .close:hover, .rescan:hover { opacity: 1; color: #E8A147; }

    .verdict-row {
      position: relative;
      display: flex; align-items: center; gap: 12px;
      margin: 6px 0 10px;
    }
    .score-ring {
      position: relative;
      width: 52px; height: 52px; flex-shrink: 0;
    }
    .score-ring svg { width: 100%; height: 100%; }
    .score-ring .track { stroke: #33261C; stroke-width: 5; fill: none; }
    .score-ring .fill  { stroke-width: 5; fill: none; stroke-linecap: round; transform: rotate(-90deg); transform-origin: 50% 50%; transition: stroke-dashoffset 700ms cubic-bezier(0.22, 1, 0.36, 1); }
    .score-ring .num {
      position: absolute; inset: 0;
      display: flex; align-items: center; justify-content: center;
      font-family: 'Menlo', ui-monospace, monospace;
      font-size: 16px; font-weight: 700;
      color: #F0E5D2;
    }
    .verdict-body { flex: 1; min-width: 0; }
    .verdict {
      font-family: 'Menlo', ui-monospace, monospace;
      font-size: 15px; letter-spacing: 0.5px; font-weight: 700;
      margin: 0 0 2px;
      line-height: 1.2;
    }
    .verdict.grug-green  { color: #8AB565; }
    .verdict.grug-yellow { color: #EBB958; }
    .verdict.grug-red    { color: #E85F3B; }
    .verdict.grug-grey   { color: #A89A82; }
    .score-ring.grug-green  .fill { stroke: #8AB565; }
    .score-ring.grug-yellow .fill { stroke: #EBB958; }
    .score-ring.grug-red    .fill { stroke: #E85F3B; }
    .score-ring.grug-grey   .fill { stroke: #6E6152; }

    .meta {
      font-size: 11px; color: #A89A82;
      letter-spacing: 0.3px;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .meta b { color: #F0E5D2; font-weight: 500; }
    .tone-caption {
      font-size: 11px; font-weight: 700;
      letter-spacing: 1.5px;
      text-transform: uppercase;
    }
    .tone-caption.grug-green  { color: #8AB565; }
    .tone-caption.grug-yellow { color: #EBB958; }
    .tone-caption.grug-red    { color: #E85F3B; }
    .tone-caption.grug-grey   { color: #A89A82; }
    .conf-line {
      margin-top: 3px;
      font-size: 9.5px; letter-spacing: 1.5px;
      color: #6E6152;
      text-transform: uppercase;
    }

    .name {
      position: relative;
      font-size: 12px; color: #F0E5D2;
      margin: 6px 0 4px;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .sub { position: relative; font-size: 11px; color: #A89A82; }

    .cta {
      position: relative;
      display: block; text-align: center; margin-top: 12px;
      padding: 9px 12px;
      background: #E8A147;
      color: #1A140F !important;
      text-decoration: none;
      border: 1px solid #E8A147;
      border-radius: 4px;
      font-size: 10.5px; letter-spacing: 2px; font-weight: 700;
      transition: background 0.12s, color 0.12s, border-color 0.12s;
      box-shadow: 0 1px 0 rgba(0,0,0,0.3);
    }
    .cta:hover {
      background: rgba(232,161,71,0.14);
      color: #E8A147 !important;
    }

    .loading {
      position: relative;
      font-size: 12px; color: #A89A82;
      display: flex; align-items: center; gap: 10px;
      padding: 6px 0;
    }
    /* Three staggered dots — cavemen sniffing single-file. */
    .loading .sniff {
      display: inline-flex; gap: 4px; flex-shrink: 0;
    }
    .loading .sniff span {
      display: inline-block;
      width: 6px; height: 6px; background: #E8A147; border-radius: 50%;
      opacity: 0.35;
      animation: grug-sniff 1.2s ease-in-out infinite;
    }
    .loading .sniff span:nth-child(2) { animation-delay: 0.18s; }
    .loading .sniff span:nth-child(3) { animation-delay: 0.36s; }
    @keyframes grug-sniff {
      0%, 100% { opacity: 0.25; transform: translateY(0); }
      40%      { opacity: 1;    transform: translateY(-2px); }
    }

    .safety {
      position: relative;
      margin-top: 10px; padding-top: 8px;
      font-size: 9px; color: #6E6152;
      letter-spacing: 1.5px;
      border-top: 1px solid rgba(51,38,28,0.7);
      text-align: center;
    }
    @media (prefers-reduced-motion: reduce) {
      .card { animation: none; }
      .loading::before { animation: none; opacity: 0.6; }
    }
  `;
}

// Compute the score ring's stroke offset given a 0..100 score.
// Circumference (r=22) = 2πr ≈ 138.23
function ringDashOffset(score) {
  const C = 138.23;
  const pct = Math.max(0, Math.min(100, Number(score) || 0));
  return (C * (1 - pct / 100)).toFixed(2);
}

function chainLabel(chainId) {
  if (chainId === 'arc') return 'Arc';
  if (chainId === 'eth') return 'Ethereum';
  return 'RHC';
}

// Per-chain accent color, used to tint the chain pill on the badge so a
// glance identifies the network. Matches the popup's chain chip palette.
function chainAccent(chainId) {
  if (chainId === 'arc') return '#8AB565';  // moss
  if (chainId === 'eth') return '#7A93D4';  // eth-blue
  return '#E8A147';                          // torch (RHC + default)
}

// One-word grug-tone caption shown under the score number.
function toneCaption(tone) {
  if (tone === 'green')  return 'safe-ish';
  if (tone === 'yellow') return 'watch out';
  if (tone === 'red')    return 'run';
  return 'unclear';
}

// -------- Storage: scan history + counter -------------------------------
// Small, capped, local-only. Never uploaded, never sent anywhere.
// Keeps up to HISTORY_MAX successful scans so the popup can show recent
// activity, and a lifetime counter broken down by tone.
const HISTORY_MAX = 8;

async function recordScan(entry) {
  if (!chrome?.storage?.local) return;
  try {
    const st = await chrome.storage.local.get(['history', 'stats']);
    const now = Date.now();

    // Deduplicate consecutive scans of the same contract within 5 minutes —
    // otherwise SPA re-renders spam the history with duplicates.
    let history = Array.isArray(st.history) ? st.history : [];
    const same = history[0] && history[0].chain === entry.chain
              && history[0].addr === entry.addr;
    if (same && (now - history[0].ts) < 5 * 60 * 1000) {
      history[0] = { ...entry, ts: now };
    } else {
      history.unshift({ ...entry, ts: now });
      if (history.length > HISTORY_MAX) history = history.slice(0, HISTORY_MAX);
    }

    const stats = st.stats && typeof st.stats === 'object'
      ? { ...st.stats }
      : { total: 0, byTone: { green: 0, yellow: 0, red: 0, grey: 0 } };
    if (!stats.byTone) stats.byTone = { green: 0, yellow: 0, red: 0, grey: 0 };
    if (!same) {
      stats.total = (stats.total || 0) + 1;
      const t = entry.tone && stats.byTone[entry.tone] != null ? entry.tone : 'grey';
      stats.byTone[t] = (stats.byTone[t] || 0) + 1;
    }

    await chrome.storage.local.set({ history, stats });
  } catch (e) {
    log('recordScan failed', e);
  }
}

function renderLocked(host) {
  host.shadowRoot.innerHTML = `<style>${shadowStyles()}</style>
    <div class="card grug-grey">
      <div class="head">
        <span class="badge">RUG RADAR · LOCKED</span>
        <button class="close" title="close">×</button>
      </div>
      <div class="verdict grug-grey">grug locked</div>
      <div class="sub">hold 10 grugs on robinhood chain to unlock. 7-day session. free.</div>
      <a class="cta" target="_blank" rel="noopener" href="${escapeAttr(UNLOCK_URL)}">UNLOCK NOW →</a>
    </div>`;
  host.shadowRoot.querySelector('.close').addEventListener('click', () => host.remove());
}

function renderLoading(host, msg = 'grug sniffing contract') {
  host.shadowRoot.innerHTML = `<style>${shadowStyles()}</style>
    <div class="card grug-grey">
      <div class="head">
        <span class="badge">RUG RADAR</span>
        <button class="close" title="close">×</button>
      </div>
      <div class="loading">
        <span class="sniff"><span></span><span></span><span></span></span>
        <span>${escapeHtml(msg)}</span>
      </div>
    </div>`;
  host.shadowRoot.querySelector('.close').addEventListener('click', () => host.remove());
}

function renderResult(host, data, ctx) {
  const cls = toneClass(data.tone);
  const short = data.addr ? `${data.addr.slice(0, 6)}…${data.addr.slice(-4)}` : '';
  const chainLbl = chainLabel(data.chain);

  if (!data.ok) {
    const msg =
      data.error === 'not_a_contract'   ? 'address is not a contract'
    : data.error === 'unknown_collection' ? 'grug not know this collection yet'
    : data.error === 'unsupported_chain'  ? 'grug sniff RHC · Arc · ETH · this one different'
    : data.error === 'fetch_failed'       ? 'grug lost signal. try opening the full report.'
    :                                       'grug scan failed. try opening the full report.';
    host.shadowRoot.innerHTML = `<style>${shadowStyles()}</style>
      <div class="card grug-grey">
        <div class="head">
          <span class="badge">RUG RADAR</span>
          <button class="close" title="close">×</button>
        </div>
        <div class="verdict grug-grey">grug not sure</div>
        <div class="sub">${escapeHtml(msg)}</div>
        <a class="cta" target="_blank" rel="noopener" href="${escapeAttr(data.scannerUrl || (API_BASE + '/scanner'))}">OPEN FULL REPORT →</a>
      </div>`;
    host.shadowRoot.querySelector('.close').addEventListener('click', () => host.remove());
    return;
  }

  const offset = ringDashOffset(data.score);
  const displayName = data.name || (ctx && ctx.name) || short;
  const caption = toneCaption(data.tone);
  const chainAcc = chainAccent(data.chain);

  host.shadowRoot.innerHTML = `<style>${shadowStyles()}</style>
    <div class="card ${cls}">
      <div class="head">
        <span class="badge">RUG RADAR<span class="chain" style="color:${chainAcc};border-left-color:${chainAcc}66;">${escapeHtml(chainLbl)}</span></span>
        <button class="rescan" title="rescan this page">↻</button>
        <button class="close" title="close">×</button>
      </div>

      <div class="verdict-row">
        <div class="score-ring ${cls}">
          <svg viewBox="0 0 50 50">
            <circle class="track" cx="25" cy="25" r="22"/>
            <circle class="fill"  cx="25" cy="25" r="22"
                    stroke-dasharray="138.23"
                    stroke-dashoffset="138.23"
                    data-target-offset="${offset}"/>
          </svg>
          <div class="num">${escapeHtml(String(data.score))}</div>
        </div>
        <div class="verdict-body">
          <div class="verdict ${cls}">${escapeHtml(data.verdict)}</div>
          <div class="meta">
            <b>/100</b> risk · <span class="tone-caption ${cls}">${escapeHtml(caption)}</span>
          </div>
          <div class="conf-line">CONF ${escapeHtml(String(data.confidence))}% · ${escapeHtml(String(data.resolved))}/${escapeHtml(String(data.totalSignals))} SIGNALS</div>
        </div>
      </div>

      <div class="name">${escapeHtml(displayName)}${data.symbol ? ' · $' + escapeHtml(data.symbol) : ''}</div>
      <div class="sub">${escapeHtml(short)}</div>

      <a class="cta" target="_blank" rel="noopener" href="${escapeAttr(data.scannerUrl)}">OPEN FULL REPORT →</a>
      <div class="safety">READ-ONLY · NO WALLET · NO DATA COLLECTED</div>
    </div>`;
  host.shadowRoot.querySelector('.close').addEventListener('click', () => host.remove());
  host.shadowRoot.querySelector('.rescan').addEventListener('click', () => {
    log('user clicked rescan');
    runOnCurrentUrl(true);
  });
  // Animate the score ring from empty → target after paint.
  requestAnimationFrame(() => {
    const fill = host.shadowRoot.querySelector('.score-ring .fill');
    if (fill && fill.dataset.targetOffset) {
      fill.style.strokeDashoffset = fill.dataset.targetOffset;
    }
  });
  // Persist to history so the popup can surface recent activity.
  recordScan({
    name: displayName,
    symbol: data.symbol || '',
    chain: data.chain,
    addr: data.addr,
    score: data.score,
    tone: data.tone,
    verdict: data.verdict,
  });
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

function removeBadge() {
  if (BADGE_HOST && document.body.contains(BADGE_HOST)) BADGE_HOST.remove();
  BADGE_HOST = null;
  CURRENT_KEY = null;
}

// forceRerun = true bypasses the CURRENT_KEY dedupe. Used by the manual
// "rescan" button on the badge — some pages have flaky detection and a
// user-triggered retry should always work.
async function runOnCurrentUrl(forceRerun = false) {
  log('runOnCurrentUrl', location.href, 'force=', forceRerun);

  if (!ENABLED) { log('disabled → remove'); removeBadge(); return; }

  const parsed = parseUrl(location.href);
  if (!parsed) { log('URL not a supported page → remove'); removeBadge(); return; }

  const host = ensureBadgeHost();

  // Gate: without a valid unlock, show the lock chip instead of a score.
  if (!isUnlocked()) {
    log('locked → render unlock chip');
    CURRENT_KEY = 'locked';
    renderLocked(host);
    return;
  }

  if (parsed.mode === 'asset') {
    const key = `asset|${parsed.chainId}|${parsed.contract}`;
    if (!forceRerun && key === CURRENT_KEY) { log('same asset key, skip'); return; }
    CURRENT_KEY = key;
    log('scoring asset', parsed.chainId, parsed.contract);
    renderLoading(host);
    try {
      const data = await fetchScore(parsed.chainId, parsed.contract);
      const still = parseUrl(location.href);
      if (!still || still.mode !== 'asset'
          || `asset|${still.chainId}|${still.contract}` !== key) { log('URL changed mid-fetch, drop'); return; }
      renderResult(host, data);
      log('rendered asset result', data.verdict, data.score);
    } catch (e) {
      log('asset fetch failed', e);
      renderResult(host, { ok: false, addr: parsed.contract, chain: parsed.chainId, error: 'fetch_failed' });
    }
    return;
  }

  if (parsed.mode === 'collection') {
    const key = `collection|${parsed.slug}`;
    if (!forceRerun && key === CURRENT_KEY) { log('same collection key, skip'); return; }
    CURRENT_KEY = key;
    log('resolving collection slug', parsed.slug);
    renderLoading(host, 'grug looking up collection…');
    try {
      const info = await resolveSlug(parsed.slug);
      const still = parseUrl(location.href);
      if (!still || still.mode !== 'collection' || still.slug !== parsed.slug) { log('URL changed mid-lookup, drop'); return; }

      if (!info.ok || !info.contract) {
        log('slug not found', parsed.slug);
        renderResult(host, { ok: false, error: 'unknown_collection', scannerUrl: `${API_BASE}/scanner` });
        return;
      }
      if (!info.chain) {
        log('unsupported chain', info.openseaChain);
        renderResult(host, { ok: false, addr: info.contract, error: 'unsupported_chain', scannerUrl: `${API_BASE}/scanner` });
        return;
      }

      log('scoring collection', info.chain, info.contract, info.name);
      const data = await fetchScore(info.chain, info.contract);
      const still2 = parseUrl(location.href);
      if (!still2 || still2.mode !== 'collection' || still2.slug !== parsed.slug) { log('URL changed mid-score, drop'); return; }
      renderResult(host, data, { name: info.name });
      log('rendered collection result', data.verdict, data.score);
    } catch (e) {
      log('collection fetch failed', e);
      renderResult(host, { ok: false, error: 'fetch_failed', scannerUrl: `${API_BASE}/scanner` });
    }
    return;
  }

  removeBadge();
}

/**
 * Read the on/off toggle from chrome.storage.local. Defaults to enabled.
 * The popup writes { enabled: true|false } here.
 */
async function loadEnabled() {
  try {
    const st = await chrome.storage.local.get('enabled');
    ENABLED = st.enabled !== false; // default = true
  } catch (e) {
    ENABLED = true;
  }
}

/**
 * Read the unlock record from chrome.storage.local. The popup writes
 * { unlock: { address, expires } } after the user pastes a valid code and
 * the backend verifies both the signature and the 10-grug balance.
 */
async function loadUnlock() {
  try {
    const st = await chrome.storage.local.get('unlock');
    const u = st.unlock;
    if (u && typeof u.expires === 'number' && u.expires > Date.now() && u.address) {
      UNLOCKED = true;
      UNLOCK_ADDR = u.address;
      UNLOCK_EXPIRES = u.expires;
    } else {
      UNLOCKED = false;
      UNLOCK_ADDR = null;
      UNLOCK_EXPIRES = 0;
    }
  } catch (e) {
    UNLOCKED = false;
  }
}

// Listen for toggle + unlock changes from the popup. When either flips, we
// re-render whatever the current URL calls for.
if (chrome?.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if ('enabled' in changes) {
      ENABLED = changes.enabled.newValue !== false;
      if (!ENABLED) { removeBadge(); return; }
    }
    if ('unlock' in changes) {
      const u = changes.unlock.newValue;
      if (u && typeof u.expires === 'number' && u.expires > Date.now() && u.address) {
        UNLOCKED = true;
        UNLOCK_ADDR = u.address;
        UNLOCK_EXPIRES = u.expires;
      } else {
        UNLOCKED = false;
        UNLOCK_ADDR = null;
        UNLOCK_EXPIRES = 0;
      }
      CURRENT_KEY = null; // force re-render
    }
    runOnCurrentUrl(true);
  });
}

// OpenSea is a heavy React SPA — three different signals may fire when the
// URL changes, and none is guaranteed to reach us:
//   1. pushState / replaceState — hooked but only catches nav that happens
//      AFTER our script installs the wrap. OpenSea's own bundle sometimes
//      caches the original methods before we get a chance.
//   2. popstate — back / forward buttons.
//   3. `navigation` API (Chrome 102+) — the modern canonical event; fires on
//      every route change including ones that skip pushState.
//   4. Title mutations — OpenSea updates <title> on every route change; a
//      MutationObserver on <title> gives us a signal even when the history
//      APIs are inaccessible.
//   5. URL polling — final belt-and-braces fallback. Cheap (~one URL string
//      compare per second) and catches anything the events above miss.
// We enable all five so the badge updates reliably no matter which pattern
// OpenSea uses on a given deploy.
function hookNavigation() {
  // 1. + 2. pushState / replaceState / popstate
  try {
    const wrap = (name) => {
      const orig = history[name];
      if (typeof orig !== 'function') return;
      history[name] = function () {
        const rv = orig.apply(this, arguments);
        log('nav via history.' + name);
        queueMicrotask(runOnCurrentUrl);
        return rv;
      };
    };
    wrap('pushState');
    wrap('replaceState');
    window.addEventListener('popstate', () => { log('nav via popstate'); runOnCurrentUrl(); });
  } catch (e) {}

  // 3. Modern Navigation API — catches route changes even when a framework
  // uses techniques other than plain pushState.
  try {
    if (typeof navigation !== 'undefined' && navigation.addEventListener) {
      navigation.addEventListener('navigate', () => { log('nav via navigation API'); queueMicrotask(runOnCurrentUrl); });
    }
  } catch (e) {}

  // 4. Title mutation observer. OpenSea updates the tab title on every route
  // change ("Arc's Punks | OpenSea" → "Grugs | OpenSea"), so a change to
  // <title> is a very reliable proxy for "URL just changed".
  try {
    const titleEl = document.querySelector('head > title');
    if (titleEl) {
      const mo = new MutationObserver(() => { log('nav via title change → "' + document.title + '"'); queueMicrotask(runOnCurrentUrl); });
      mo.observe(titleEl, { childList: true, characterData: true, subtree: true });
    }
  } catch (e) {}

  // 5. Click delegation — most OpenSea navigations start from an anchor click.
  // We inspect the anchor's href immediately and re-poll shortly after so the
  // check runs against the URL that click actually navigated to.
  try {
    document.addEventListener('click', (ev) => {
      const a = ev.target && ev.target.closest && ev.target.closest('a[href]');
      if (!a) return;
      // Any click on an internal link — schedule a re-check.
      setTimeout(() => { log('nav via click delegation'); runOnCurrentUrl(); }, 100);
      setTimeout(runOnCurrentUrl, 400);
    }, true);
  } catch (e) {}

  // 6. URL polling. Bumped from 1s to 500ms so the user rarely sees stale
  // content. Costs a single string compare per tick — negligible even on
  // OpenSea's heavy collection grids.
  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      log('nav via URL polling: ' + lastUrl + ' → ' + location.href);
      lastUrl = location.href;
      runOnCurrentUrl();
    }
  }, 500);
}

// Start the nav hooks IMMEDIATELY (don't wait for the storage read). If we
// wait for chrome.storage.local to answer before hookNavigation() runs, the
// very first SPA nav after page load can slip past our history wraps —
// which is exactly the "have to refresh" symptom the user reported.
hookNavigation();
(async () => {
  await Promise.all([loadEnabled(), loadUnlock()]);
  log('extension loaded, enabled=', ENABLED, 'unlocked=', isUnlocked());
  runOnCurrentUrl();
})();
