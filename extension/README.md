# Grug's Rug Radar — Chrome Extension

Read-only floating badge on OpenSea. Shows Grug's rug-radar verdict for
the NFT contract on the current page.

## What it does

Runs on `opensea.io`. When the URL points at an NFT contract on a chain
we support, it fires **one** HTTPS request to `grugnft.xyz/api/rug-score`
and renders a floating badge in the top-right corner with the score,
verdict, chain, name and a link to the full report.

Supported URL shapes:

- `opensea.io/collection/{slug}` — slug resolved via
  `grugnft.xyz/api/collection-by-slug`
- `opensea.io/assets/{chain}/{contract}[/{tokenId}]`
- `opensea.io/item/{chain}/{contract}[/{tokenId}]`

Supported chains: **Robinhood (RHC)**, **Arc**, **Ethereum**.

## What it does not do

- Never touches your wallet. Zero calls to `window.ethereum`, MetaMask,
  or any wallet library.
- Never reads or writes your cookies, `localStorage`, or any DOM data
  beyond the URL of the OpenSea page you are on.
- Never runs on any site other than `opensea.io`.
- Never sends any request except `GET grugnft.xyz/api/rug-score?…` and
  `GET grugnft.xyz/api/collection-by-slug?…` with the contract address
  and chain slug.
- Never uploads history, stats, or the on/off toggle. Everything in
  `chrome.storage.local` stays on your device.

## Popup

Click the toolbar icon to open the popup. It shows:

- **On/off toggle** — hides the badge without uninstalling
- **Supported chains** — RHC / ARC / ETH chips
- **Contracts sniffed** — lifetime counter + red/yellow/green breakdown
- **Recent sniffs** — the last 8 scans (name, score, chain), each row a
  shortcut to the full report

## Installing (unpacked)

1. Clone this folder to your machine.
2. Open `chrome://extensions` in Chrome.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked**, pick this `extension/` folder.
5. Browse to any OpenSea collection or asset — the badge appears in the
   top-right of the page.

To reload after an update: click ↻ on the extension's card in
`chrome://extensions`, then refresh the OpenSea tab.

## Chrome Web Store

Same folder, packaged as a `.zip` and submitted to the Web Store.
Requires one-time $5 developer fee. Typical review time: 1–2 weeks.

## Permissions used

- `host_permissions: https://opensea.io/*` — so the content script can
  run on OpenSea pages.
- `host_permissions: https://www.grugnft.xyz/*` — so the badge can call
  the score API.
- `permissions: storage` — for the on/off toggle, scan counter, and
  local recent-scans list. All device-local.

That's the whole list. No `activeTab`, no `<all_urls>`, no `identity`,
no `webRequest`.

## Files

```
manifest.json    Extension manifest (v3), version 1.4.0
content.js       URL parser, SPA nav detection, badge renderer, storage writes
popup.html       Popup shell (brand, toggle, stats, recent, actions)
popup.js         Popup logic — reads storage, paints stats/recent, writes toggle
overlay.css      Placeholder — badge styles live inline in a shadow root
icons/           16 / 48 / 128 PNG icons
```

## Changelog

**1.4.0** — Scan history + counter in popup. Chain-tinted badge accent
(RHC torch, Arc moss, ETH blue). Tone caption under score
("safe-ish / watch out / run / unclear"). Confidence/signal count line.
Sniffing three-dot loading animation. Better error copy on unsupported
chain / fetch failure.

**1.3.0** — Ethereum mainnet support. New badge visuals (score ring, cave
texture, animated fill). Rebuilt popup with brand row, chain chips, and
action buttons. Fresh icons. DEBUG logging off in shipped builds.

**1.2.0** — SPA navigation detection overhaul (pushState wrap, Navigation
API, title observer, click delegation, 500ms URL polling). Manual rescan
button on the badge. Hooks install synchronously before storage read.

**1.1.x** — On/off toggle popup. Collection-page support via
`/api/collection-by-slug`.

**1.0.0** — Initial release. Read-only asset-page scanning.
