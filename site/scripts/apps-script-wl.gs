/**
 * Grugs WL webhook + global counters — Google Apps Script backing store.
 * Deploy as: Web app, execute as Me, access Anyone.
 *
 * SHEETS EXPECTED:
 * 1) "wl" (or the sheet name from SHEET_NAME below) with header row 1:
 *      A: first_seen  B: last_seen  C: wallet
 *      D: smashes     E: browser_os F: submits
 *
 * 2) "counters" — a small key/value sheet for globals. Header row 1:
 *      A: key   B: value
 *    Row 2: A2 = "total_smashes"  B2 = 0
 *    (The script creates row 2 the first time it runs if missing.)
 *
 * Actions:
 * - POST { action: "register", wallet, smashes, userAgent }  → upsert wl row
 * - POST { action: "bumpSmashes", delta: N }                 → increment total_smashes
 * - GET  ?action=check&wallet=…                              → returns wl status
 * - GET  ?action=stats                                       → returns { totalSmashes, totalWallets }
 */

const SHEET_NAME = 'Sheet1';        // WL sheet — change if your tab is named differently
const COUNTERS_SHEET = 'counters';  // small key/value sheet

function _ss() { return SpreadsheetApp.getActiveSpreadsheet(); }
function _wlSheet() {
  return _ss().getSheetByName(SHEET_NAME) || _ss().getSheets()[0];
}
function _countersSheet() {
  let sheet = _ss().getSheetByName(COUNTERS_SHEET);
  if (!sheet) {
    sheet = _ss().insertSheet(COUNTERS_SHEET);
    sheet.getRange(1, 1, 1, 2).setValues([['key', 'value']]);
    sheet.getRange(2, 1, 1, 2).setValues([['total_smashes', 0]]);
  }
  return sheet;
}
function _getCounter(key) {
  const sheet = _countersSheet();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return 0;
  const vals = sheet.getRange(2, 1, lastRow - 1, 2).getValues();
  for (let i = 0; i < vals.length; i++) {
    if (vals[i][0] === key) return Number(vals[i][1]) || 0;
  }
  return 0;
}
function _bumpCounter(key, delta) {
  const sheet = _countersSheet();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    sheet.appendRow([key, delta]);
    return delta;
  }
  const vals = sheet.getRange(2, 1, lastRow - 1, 2).getValues();
  for (let i = 0; i < vals.length; i++) {
    if (vals[i][0] === key) {
      const row = i + 2;
      const cur = Number(vals[i][1]) || 0;
      const next = cur + delta;
      sheet.getRange(row, 2).setValue(next);
      return next;
    }
  }
  // Key not found → add it
  sheet.appendRow([key, delta]);
  return delta;
}

function _findWlRow(sheet, wallet) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return -1;
  const values = sheet.getRange(2, 3, lastRow - 1, 1).getValues(); // column C: wallet
  const w = (wallet || '').toLowerCase();
  for (let i = 0; i < values.length; i++) {
    if ((values[i][0] || '').toString().toLowerCase() === w) return i + 2;
  }
  return -1;
}

function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    const action = (data.action || 'register').toString();

    if (action === 'bumpSmashes') {
      const delta = Math.max(0, Math.min(1000, Number(data.delta) || 0));
      if (delta === 0) return _json({ ok: true, totalSmashes: _getCounter('total_smashes') });
      const total = _bumpCounter('total_smashes', delta);
      return _json({ ok: true, totalSmashes: total, delta: delta });
    }

    if (action === 'register') {
      const wallet = (data.wallet || '').toString().toLowerCase();
      if (!wallet || !/^0x[0-9a-f]{40}$/.test(wallet)) {
        return _json({ ok: false, error: 'invalid wallet' });
      }
      const smashes = Number(data.smashes) || 0;
      const ua = (data.userAgent || '').toString().slice(0, 40);
      const now = new Date();
      const sheet = _wlSheet();
      const row = _findWlRow(sheet, wallet);
      if (row === -1) {
        sheet.appendRow([now, now, wallet, smashes, ua, 1]);
        return _json({ ok: true, upserted: 'new', wallet, smashes });
      } else {
        const existing = sheet.getRange(row, 4).getValue();
        const submits = Number(sheet.getRange(row, 6).getValue() || 0) + 1;
        const bestSmashes = Math.max(Number(existing) || 0, smashes);
        sheet.getRange(row, 2).setValue(now);
        sheet.getRange(row, 4).setValue(bestSmashes);
        sheet.getRange(row, 5).setValue(ua);
        sheet.getRange(row, 6).setValue(submits);
        return _json({ ok: true, upserted: 'update', wallet, smashes: bestSmashes, submits });
      }
    }

    return _json({ ok: false, error: 'unknown action: ' + action });
  } catch (err) {
    return _json({ ok: false, error: String(err) });
  }
}

function doGet(e) {
  const action = ((e && e.parameter && e.parameter.action) || 'check').toString();

  if (action === 'stats') {
    const sheet = _wlSheet();
    const lastRow = sheet.getLastRow();
    const totalWallets = Math.max(0, lastRow - 1);
    const totalSmashes = _getCounter('total_smashes');
    // Also derive the WL-registered wallet smash sum as a sanity number
    let walletSmashesSum = 0;
    if (lastRow >= 2) {
      const smashCol = sheet.getRange(2, 4, lastRow - 1, 1).getValues();
      for (let i = 0; i < smashCol.length; i++) {
        walletSmashesSum += Number(smashCol[i][0]) || 0;
      }
    }
    return _json({
      ok: true,
      totalSmashes: totalSmashes,
      totalWallets: totalWallets,
      walletSmashesSum: walletSmashesSum,
    });
  }

  // Default: wallet WL status check
  const wallet = ((e && e.parameter && e.parameter.wallet) || '').toString().toLowerCase();
  if (!wallet) return _json({ ok: false, error: 'no wallet' });
  const sheet = _wlSheet();
  const row = _findWlRow(sheet, wallet);
  if (row === -1) return _json({ ok: true, registered: false, smashes: 0 });
  const smashes = Number(sheet.getRange(row, 4).getValue()) || 0;
  const submits = Number(sheet.getRange(row, 6).getValue()) || 0;
  const firstSeen = sheet.getRange(row, 1).getValue();
  return _json({
    ok: true,
    registered: true,
    smashes: smashes,
    submits: submits,
    registeredAtMs: firstSeen instanceof Date ? firstSeen.getTime() : Date.now(),
  });
}

function _json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
