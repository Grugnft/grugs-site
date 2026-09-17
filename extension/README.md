# Grug's Rug Radar — Chrome Extension

Read-only floating badge on OpenSea. Shows Grug's rug-radar verdict for the
NFT contract on the current page.

## What it does

Runs on `opensea.io`. When the URL points at an NFT item on a chain we
support (Robinhood Chain or Arc Chain), it fires **one** HTTPS request to
`grugnft.xyz/api/rug-score` and renders a floating badge in the top-right
corner with the score, verdict, and a link to the full report.

## What it does not do

- Never touches your wallet. Zero calls to `window.ethereum`, MetaMask, or
  any wallet library.
- Never reads or writes your cookies, localStorage, or any DOM data beyond
  the URL of the OpenSea page you are on.
- Never runs on any site other than `opensea.io`.
- Never sends any request except `GET grugnft.xyz/api/rug-score?...` with
  the contract address and chain slug.

## Installing (unpacked)

1. Clone this folder to your machine.
2. Open `chrome://extensions` in Chrome.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked**, pick this `extension/` folder.
5. Browse `opensea.io/assets/robinhood/0x…` or
   `opensea.io/assets/arc/0x…` — the badge appears in the top-right.

## Chrome Web Store

Same folder, packaged as a `.zip` and submitted to the Web Store. Requires
one-time $5 developer fee. Typical review time: 1–2 weeks.

## Permissions used

- `host_permissions: https://opensea.io/*` — so the content script can run
  on OpenSea pages.
- `host_permissions: https://www.grugnft.xyz/*` — so the badge can call
  the score API.

That's the whole permission list. No `activeTab`, no `<all_urls>`, no
`storage`, no `identity`, no `webRequest`.

## Files

```
manifest.json    Extension manifest (v3)
content.js       All the logic — URL parser, API call, badge renderer
overlay.css      Placeholder — badge styles live inline in a shadow root
icons/           16 / 48 / 128 PNG icons
```
