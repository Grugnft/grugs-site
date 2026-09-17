// Toggle handler. Reads current state from chrome.storage.local (defaulting
// to on), reflects it in the UI, and writes back on click. The content
// script listens for storage changes and shows/hides the badge live.

const toggle = document.getElementById('toggle');
const status = document.getElementById('status');

function paint(enabled) {
  toggle.classList.toggle('on', enabled);
  toggle.setAttribute('aria-checked', enabled ? 'true' : 'false');
  status.classList.toggle('on', enabled);
  status.classList.toggle('off', !enabled);
  status.textContent = enabled ? 'ON — grug sniffing' : 'OFF — grug resting';
}

(async () => {
  try {
    const st = await chrome.storage.local.get('enabled');
    paint(st.enabled !== false);
  } catch (e) {
    paint(true);
  }
})();

toggle.addEventListener('click', async () => {
  try {
    const st = await chrome.storage.local.get('enabled');
    const next = !(st.enabled !== false);
    await chrome.storage.local.set({ enabled: next });
    paint(next);
  } catch (e) {
    // If storage failed, at least reflect visually.
    const next = !toggle.classList.contains('on');
    paint(next);
  }
});
