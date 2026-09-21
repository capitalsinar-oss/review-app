/**
 * Review Studio → Google Sheets mirror
 * ------------------------------------
 * Paste this whole file into a Google Apps Script project bound to your sheet,
 * deploy it as a Web App, and put the /exec URL into SHEETS_WEBHOOK_URL on Render.
 * Setup steps are in README.md under "Google Sheets sync".
 *
 * Accepts either one row:      { secret, date, property, ... }
 * or a batch from a backfill:  { secret, rows: [ {...}, {...} ] }
 *
 * Rows are de-duplicated on (property_id, date), so the backfill endpoint can be
 * run as often as you like without doubling anything up.
 */

// Must match SHEETS_SECRET in the server's environment.
// Set it in the Apps Script editor under Project Settings → Script Properties,
// key: SHEETS_SECRET. Kept out of this file so the code can be shared safely.
var SHEET_NAME = 'Reviews';

var COLUMNS = [
  'date', 'property', 'property_id', 'rating',
  'outcome', 'language', 'chips', 'review', 'private_feedback'
];

function doPost(e) {
  var lock = LockService.getScriptLock();
  // Two guests submitting at the same moment must not interleave their appends.
  try {
    lock.waitLock(25000);
  } catch (err) {
    return json({ ok: false, error: 'busy' });
  }

  try {
    if (!e || !e.postData || !e.postData.contents) {
      return json({ ok: false, error: 'no body' });
    }
    var body = JSON.parse(e.postData.contents);

    var expected = PropertiesService.getScriptProperties().getProperty('SHEETS_SECRET');
    if (!expected) return json({ ok: false, error: 'SHEETS_SECRET not set in Script Properties' });
    if (body.secret !== expected) return json({ ok: false, error: 'bad secret' });

    var rows = body.rows && body.rows.length ? body.rows : [body];

    var sheet = getSheet();
    ensureHeader(sheet);

    var seen = existingKeys(sheet);
    var toAppend = [];
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (!r || !r.date) continue;
      var key = String(r.property_id || '') + '|' + String(r.date);
      if (seen[key]) continue;
      seen[key] = true;
      toAppend.push(COLUMNS.map(function (c) { return r[c] === undefined || r[c] === null ? '' : r[c]; }));
    }

    if (toAppend.length) {
      sheet
        .getRange(sheet.getLastRow() + 1, 1, toAppend.length, COLUMNS.length)
        .setValues(toAppend);
    }

    return json({ ok: true, appended: toAppend.length, skipped: rows.length - toAppend.length });
  } catch (err) {
    return json({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

// A GET on the /exec URL is handy for checking the deployment is live.
function doGet() {
  return json({ ok: true, service: 'review-studio-sheets-sync' });
}

function getSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
  }
  return sheet;
}

function ensureHeader(sheet) {
  if (sheet.getLastRow() > 0) return;
  sheet.getRange(1, 1, 1, COLUMNS.length).setValues([COLUMNS]);
  sheet.getRange(1, 1, 1, COLUMNS.length).setFontWeight('bold');
  sheet.setFrozenRows(1);
}

function existingKeys(sheet) {
  var last = sheet.getLastRow();
  var seen = {};
  if (last < 2) return seen;
  // Only the date and property_id columns are needed for the dedupe key.
  var dates = sheet.getRange(2, 1, last - 1, 1).getDisplayValues();
  var ids = sheet.getRange(2, 3, last - 1, 1).getDisplayValues();
  for (var i = 0; i < dates.length; i++) {
    seen[String(ids[i][0]) + '|' + String(dates[i][0])] = true;
  }
  return seen;
}

function json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
