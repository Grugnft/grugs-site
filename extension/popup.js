// Toggle handler + stats/recent-scans renderer.
//
// - Reads enabled/history/stats from chrome.storage.local
// - Reflects them in the popup UI on open
// - Subscribes to storage changes so live scans (from a background OpenSea
//   tab) update the popup while it stays open
//
// The content script writes { history, stats, enabled }. This script only
// reads them, plus writes back the `enabled` flag when the toggle is
// flipped. Nothing here leaves the browser.

const toggle    = document.getElementById('toggle');
const status    = document.getElementById('status');
const totalEl   = document.getElementById('stats-total');
const tonesEl   = document.getElementById('stats-tones');
const recentEl  = document.getElementById('recent-list');

const CHAIN_LABEL = {
  rhc:      { short: 'RHC', name: 'Robinhood' },
  arc:      { short: 'ARC', name: 'Arc' },
  eth:      { short: 'ETH', name: 'Ethereum' },
};

function toneShort(t) {
  if (t === 'green')  return 'g';
  if (t === 'yellow') return 'y';
  if (t === 'red')    return 'r';
  return 'u';
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => (
    { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]
  ));
}

function paintToggle(enabled) {
  toggle.classList.toggle('on', enabled);
  toggle.setAttribute('aria-checked', enabled ? 'true' : 'false');
  status.classList.toggle('on', enabled);
  status.classList.toggle('off', !enabled);
  status.textContent = enabled ? 'ON — grug sniffing' : 'OFF — grug resting';
}

function paintStats(stats) {
  const total = (stats && stats.total) || 0;
  totalEl.textContent = total.toLocaleString();

  const by = (stats && stats.byTone) || { green: 0, yellow: 0, red: 0, grey: 0 };
  const parts = [];
  if (by.red)    parts.push(`<span class="stats-tone r">${by.red}</span>`);
  if (by.yellow) parts.push(`<span class="stats-tone y">${by.yellow}</span>`);
  if (by.green)  parts.push(`<span class="stats-tone g">${by.green}</span>`);
  tonesEl.innerHTML = parts.join('');
}

function paintRecent(history) {
  const list = Array.isArray(history) ? history : [];
  if (list.length === 0) {
    recentEl.innerHTML = '<div class="recent-empty">grug not sniff nothing yet</div>';
    return;
  }
  recentEl.innerHTML = list.map(entry => {
    const t = toneShort(entry.tone);
    const chainKey = entry.chain in CHAIN_LABEL ? entry.chain : 'rhc';
    const chainLbl = CHAIN_LABEL[chainKey].short;
    // Build a canonical scanner URL so clicking a row jumps to the full report.
    const addr = String(entry.addr || '');
    const scannerUrl = `https://www.grugnft.xyz/scanner?chain=${encodeURIComponent(chainKey)}&addr=${encodeURIComponent(addr)}`;
    const name = entry.name || (addr.length >= 10 ? `${addr.slice(0,6)}…${addr.slice(-4)}` : addr) || 'unknown';
    return `
      <a class="recent-item ${t}" href="${escapeHtml(scannerUrl)}" target="_blank" rel="noopener">
        <span class="recent-score">${escapeHtml(String(entry.score ?? '—'))}</span>
        <span class="recent-name" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
        <span class="recent-chain ${chainKey}">${escapeHtml(chainLbl)}</span>
      </a>`;
  }).join('');
}

// -- initial paint --
(async () => {
  try {
    const st = await chrome.storage.local.get(['enabled', 'history', 'stats']);
    paintToggle(st.enabled !== false);
    paintStats(st.stats);
    paintRecent(st.history);
  } catch (e) {
    paintToggle(true);
    paintStats(null);
    paintRecent(null);
  }
})();

// -- toggle clicks --
toggle.addEventListener('click', async () => {
  try {
    const st = await chrome.storage.local.get('enabled');
    const next = !(st.enabled !== false);
    await chrome.storage.local.set({ enabled: next });
    paintToggle(next);
  } catch (e) {
    const next = !toggle.classList.contains('on');
    paintToggle(next);
  }
});

// -- live updates while the popup stays open --
try {
  if (chrome?.storage?.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if ('enabled' in changes) paintToggle(changes.enabled.newValue !== false);
      if ('stats'   in changes) paintStats(changes.stats.newValue);
      if ('history' in changes) paintRecent(changes.history.newValue);
    });
  }
} catch (e) {}
