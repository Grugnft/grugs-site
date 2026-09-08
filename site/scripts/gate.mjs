/**
 * Rug Radar gate — "hold 5 Grugs to use the radar."
 *
 * Zero dependencies. Reads window.ethereum (MetaMask / Rainbow / Coinbase /
 * any injected wallet), queries balanceOf on the Grugs contract via the RHC
 * RPC, gates the scanner behind >= REQUIRED_BALANCE.
 *
 * Client-side gating is a *friction gate*, not a security wall. A technical
 * user can bypass it by reading the source. That's expected — the goal is
 * for 99% of visitors to respect the requirement, not perfect enforcement.
 * If cryptographic gating is needed later, add SIWE with a server-side
 * balance check that mints a session JWT.
 *
 * Pre-mint state (GATE_ENABLED=false): module loads, does nothing visible.
 * Flip GATE_ENABLED to true on mint day to activate.
 */

// ============================================================================
// CONFIG — the four knobs
// ============================================================================
const CONFIG = {
  // Flip to true on mint day to turn the gate on. Everything else can stay.
  GATE_ENABLED: false,

  // Set once the Grugs contract is deployed. A zero address means "not deployed
  // yet" — the gate will show a "coming soon" screen when GATE_ENABLED is true
  // but the contract isn't set, instead of a broken balanceOf call.
  GRUGS_CONTRACT: '0x0000000000000000000000000000000000000000',

  // Minimum Grugs the wallet must hold to unlock.
  REQUIRED_BALANCE: 5,

  // How long a successful check stays valid before re-verifying, in hours.
  // 24h is standard — long enough that daily users don't reconnect, short
  // enough that a user who sold their Grugs loses access within a day.
  SESSION_HOURS: 24,

  // Robinhood Chain RPC — same one the scanner uses.
  RPC_URL: 'https://rpc.mainnet.chain.robinhood.com',
  CHAIN_ID: 4663,
};

// ERC-721 balanceOf(address) selector.
const BALANCE_OF_SEL = '0x70a08231';

const STORAGE_KEY = 'grug_gate_session';

// ============================================================================
// SESSION — persist a passed check for CONFIG.SESSION_HOURS
// ============================================================================
function readSession() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (!s || !s.wallet || !s.expiresAt) return null;
    if (Date.now() > s.expiresAt) return null;
    return s;
  } catch (e) { return null; }
}

function writeSession(wallet, balance) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      wallet: wallet.toLowerCase(),
      balance,
      expiresAt: Date.now() + CONFIG.SESSION_HOURS * 3600 * 1000,
    }));
  } catch (e) {}
}

function clearSession() {
  try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
}

// ============================================================================
// WALLET — vanilla window.ethereum (MetaMask, Rainbow, Coinbase, etc.)
// ============================================================================
function hasWallet() {
  return typeof window !== 'undefined' && !!window.ethereum;
}

async function requestAccount() {
  const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
  if (!accounts || !accounts.length) throw new Error('no_account');
  return accounts[0];
}

// Read balanceOf(wallet) from the Grugs contract via a plain eth_call on the
// RHC RPC — deliberately not via window.ethereum so the wallet's chain doesn't
// need to be switched to RHC just to check a balance.
async function readBalance(wallet) {
  const paddedAddr = wallet.toLowerCase().replace(/^0x/, '').padStart(64, '0');
  const data = BALANCE_OF_SEL + paddedAddr;
  const body = {
    jsonrpc: '2.0',
    id: 1,
    method: 'eth_call',
    params: [{ to: CONFIG.GRUGS_CONTRACT, data }, 'latest'],
  };
  const r = await fetch(CONFIG.RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || 'rpc_error');
  if (!j.result || j.result === '0x') return 0;
  return parseInt(j.result, 16);
}

// ============================================================================
// UI — the overlay that shows when the gate is closed
// ============================================================================
function ensureStyles() {
  if (document.getElementById('gate-styles')) return;
  const style = document.createElement('style');
  style.id = 'gate-styles';
  style.textContent = `
    #gate-overlay {
      position: fixed; inset: 0;
      background: rgba(26, 20, 15, 0.96);
      backdrop-filter: blur(6px);
      z-index: 9999;
      display: flex; align-items: center; justify-content: center;
      padding: 20px;
    }
    #gate-overlay .gate-card {
      max-width: 460px; width: 100%;
      background: var(--stone-2, #241A12);
      border: 2px solid var(--wall-2, #3a2e22);
      padding: 32px 28px;
      text-align: center;
      font-family: 'VT323', monospace;
    }
    #gate-overlay .gate-icon {
      font-family: 'Press Start 2P', monospace;
      font-size: 28px; letter-spacing: 4px;
      color: var(--torch, #d9873a);
      margin-bottom: 20px;
    }
    #gate-overlay .gate-title {
      font-family: 'Press Start 2P', monospace;
      font-size: 14px; letter-spacing: 2px;
      color: var(--bone, #e8dcc4);
      margin: 0 0 12px;
    }
    #gate-overlay .gate-sub {
      font-size: 18px; line-height: 1.4;
      color: var(--bone-dim, #a89a7e);
      margin: 0 0 24px;
    }
    #gate-overlay .gate-status {
      font-family: 'Press Start 2P', monospace;
      font-size: 10px; letter-spacing: 1.5px;
      color: var(--bone-dim, #a89a7e);
      background: var(--stone, #1A140F);
      border: 1px dashed var(--wall-2, #3a2e22);
      padding: 12px;
      margin: 0 0 20px;
      word-break: break-all;
    }
    #gate-overlay .gate-status.err { color: var(--danger, #c94a4a); border-color: var(--danger, #c94a4a); }
    #gate-overlay .gate-btn {
      font-family: 'Press Start 2P', monospace;
      font-size: 12px; letter-spacing: 2px;
      background: var(--torch, #d9873a);
      color: var(--stone, #1A140F);
      border: none;
      padding: 14px 22px;
      cursor: pointer;
      width: 100%;
      transition: background 0.15s;
    }
    #gate-overlay .gate-btn:hover { background: var(--torch-hot, #f0a04b); }
    #gate-overlay .gate-btn:disabled { opacity: 0.5; cursor: not-allowed; }
    #gate-overlay .gate-secondary {
      display: block;
      font-family: 'Press Start 2P', monospace;
      font-size: 9px; letter-spacing: 1px;
      color: var(--bone-dim, #a89a7e);
      text-decoration: underline;
      margin-top: 16px;
    }
  `;
  document.head.appendChild(style);
}

function renderOverlay(state) {
  ensureStyles();

  // The message the user sees depends on where in the flow they are:
  //   - no wallet installed → nudge them to install one
  //   - contract not deployed yet → "coming soon"
  //   - wallet connected but under-holding → "you hold N, need 5"
  //   - error state → surface it
  const contractSet = CONFIG.GRUGS_CONTRACT !== '0x0000000000000000000000000000000000000000';
  let title, sub, statusHtml, btnLabel, btnAction, statusErr = false;

  if (!contractSet) {
    title = 'GATE COMING SOON';
    sub = `rug radar unlocks when the grugs mint. hold ${CONFIG.REQUIRED_BALANCE} grugs to open the radar for your wallet.`;
    statusHtml = 'mint not live yet';
    btnLabel = 'TELL ME WHEN';
    btnAction = 'twitter';
  } else if (!hasWallet()) {
    title = 'NO WALLET FOUND';
    sub = `install a browser wallet (metamask, rainbow, coinbase) and hold ${CONFIG.REQUIRED_BALANCE} grugs to unlock rug radar.`;
    statusHtml = 'window.ethereum not detected';
    statusErr = true;
    btnLabel = 'GET METAMASK';
    btnAction = 'metamask';
  } else if (state.phase === 'idle') {
    title = 'GRUGS ONLY';
    sub = `hold ${CONFIG.REQUIRED_BALANCE} grugs in your wallet to use the radar. connect below to check.`;
    statusHtml = 'not connected';
    btnLabel = 'CONNECT WALLET';
    btnAction = 'connect';
  } else if (state.phase === 'checking') {
    title = 'CHECKING…';
    sub = 'grug counting your grugs.';
    statusHtml = state.wallet ? shortAddr(state.wallet) : 'connecting';
    btnLabel = 'CHECKING…';
    btnAction = 'none';
  } else if (state.phase === 'insufficient') {
    title = `NEED ${CONFIG.REQUIRED_BALANCE - state.balance} MORE`;
    sub = `you hold ${state.balance} grug${state.balance === 1 ? '' : 's'}. the radar wakes at ${CONFIG.REQUIRED_BALANCE}.`;
    statusHtml = `${shortAddr(state.wallet)} · ${state.balance} grugs`;
    btnLabel = 'BUY GRUGS';
    btnAction = 'secondary';
  } else if (state.phase === 'error') {
    title = 'CHECK FAILED';
    sub = state.reason || 'grug could not read balance from the chain. try again in a moment.';
    statusHtml = state.detail || 'unknown error';
    statusErr = true;
    btnLabel = 'RETRY';
    btnAction = 'connect';
  }

  let overlay = document.getElementById('gate-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'gate-overlay';
    document.body.appendChild(overlay);
  }
  overlay.innerHTML = `
    <div class="gate-card" role="dialog" aria-modal="true" aria-labelledby="gate-title">
      <div class="gate-icon">RADAR</div>
      <h2 class="gate-title" id="gate-title">${title}</h2>
      <p class="gate-sub">${sub}</p>
      <div class="gate-status ${statusErr ? 'err' : ''}">${statusHtml}</div>
      <button class="gate-btn" id="gate-action" ${btnAction === 'none' ? 'disabled' : ''}>${btnLabel}</button>
      <a class="gate-secondary" href="/mints.html">← back to mint radar</a>
    </div>
  `;

  const actionBtn = overlay.querySelector('#gate-action');
  if (actionBtn && btnAction !== 'none') {
    actionBtn.addEventListener('click', () => handleAction(btnAction));
  }
}

function shortAddr(a) {
  return a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '';
}

function hideOverlay() {
  const overlay = document.getElementById('gate-overlay');
  if (overlay) overlay.remove();
}

// ============================================================================
// FLOW — the state machine that drives the overlay
// ============================================================================
const state = { phase: 'idle', wallet: null, balance: 0, reason: null, detail: null };

async function handleAction(action) {
  if (action === 'connect') {
    try {
      state.phase = 'checking';
      renderOverlay(state);
      const wallet = await requestAccount();
      state.wallet = wallet;
      renderOverlay(state);
      const balance = await readBalance(wallet);
      state.balance = balance;
      if (balance >= CONFIG.REQUIRED_BALANCE) {
        writeSession(wallet, balance);
        hideOverlay();
      } else {
        state.phase = 'insufficient';
        renderOverlay(state);
      }
    } catch (e) {
      state.phase = 'error';
      state.reason = e.message === 'no_account'
        ? 'no wallet account approved. click connect again and approve.'
        : e.message === 'User rejected the request.'
        ? 'you rejected the connect prompt.'
        : 'grug could not read your grug balance from the chain.';
      state.detail = e.message || 'unknown';
      renderOverlay(state);
    }
    return;
  }
  if (action === 'secondary') {
    // Once secondary markets exist, point this at the actual OpenSea/other
    // marketplace URL. Placeholder for now.
    window.open('/mints.html', '_blank');
    return;
  }
  if (action === 'twitter') {
    window.open('https://x.com/GrugNFT', '_blank');
    return;
  }
  if (action === 'metamask') {
    window.open('https://metamask.io/download/', '_blank');
    return;
  }
}

// ============================================================================
// ENTRY — runs on module import
// ============================================================================
export async function initGate() {
  if (!CONFIG.GATE_ENABLED) return; // pre-mint: gate disabled, scanner runs as-is

  // Existing session? Silent pass-through.
  const session = readSession();
  if (session) return;

  // Otherwise show the overlay and wait for user action.
  state.phase = 'idle';
  renderOverlay(state);
}

// Expose disconnect for a future "disconnect wallet" UI. Not wired to a button
// yet but keeps the intent visible in the module surface.
export function disconnect() {
  clearSession();
  window.location.reload();
}

// Auto-init on DOMContentLoaded so scanner.html doesn't need a wiring script.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initGate);
} else {
  initGate();
}
