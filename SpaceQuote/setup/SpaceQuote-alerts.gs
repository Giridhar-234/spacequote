/**
 * SpaceQuote owner tools (Batch 3)
 *  1. Email alert when a client enters a payment transaction ID (UTR).
 *  2. "Send to Google Sheet": copies the client list into a sheet in your own Google Drive.
 * It runs on your own Google account. Nobody else can see this script or the sheet.
 *
 * How it checks that a request is real:
 *  - The secret key must match (this only stops random robots, because the key is visible in your page).
 *  - It reads your Firestore database with the login token of the person who sent the request.
 *    Firestore's security rules then decide what that person may read:
 *    a client can read only their own record, and only the owner can read the full client list.
 *    So the email and the sheet always use real data from your database, never data from the request.
 *  - Each transaction ID is emailed only once.
 */

// Must be exactly the same as MAIL_KEY in index.html.
const SECRET_KEY = 'SQ-j4fLyxvig6o6xxwU8RviOyEj0Y2MGkLt';
const OWNER_EMAIL = 'giri200211@gmail.com';
const PROJECT_ID = 'spacequote-giri';
const DB_URL = 'https://firestore.googleapis.com/v1/projects/' + PROJECT_ID + '/databases/(default)/documents/';
const PLANS = { proj: 'Single Project', m1: 'Monthly', m3: '3 Months', pm1: 'Pro Monthly', p6: 'Pro 6 Months', p12: 'Pro Yearly', m6: '6 Months Pro', y1: 'Yearly Pro' };

function doPost(e) {
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (body.key !== SECRET_KEY) return json({ ok: false, msg: 'bad key' });
    if (body.type === 'utr') return utrAlert(body);
    if (body.type === 'sheet') return sheetExport(body);
    return json({ ok: false, msg: 'unknown request' });
  } catch (err) {
    return json({ ok: false, msg: 'error: ' + err });
  }
}

// Headers for Firestore: the sender's login token, plus the App Check token when App Check is on.
function headersFor(body) {
  const h = { Authorization: 'Bearer ' + body.token };
  if (body.ac) h['X-Firebase-AppCheck'] = body.ac;
  return h;
}

// Turns a Firestore REST value into a normal value.
function val(x) {
  if (!x) return '';
  if ('stringValue' in x) return x.stringValue;
  if ('integerValue' in x) return Number(x.integerValue);
  if ('doubleValue' in x) return x.doubleValue;
  if ('booleanValue' in x) return x.booleanValue;
  if ('nullValue' in x) return '';
  if ('timestampValue' in x) return x.timestampValue;
  if ('arrayValue' in x) return (x.arrayValue.values || []).map(val);
  if ('mapValue' in x) { const o = {}, m = x.mapValue.fields || {}; for (const k in m) o[k] = val(m[k]); return o; }
  return '';
}
function fieldsOf(doc) { const o = {}, f = doc.fields || {}; for (const k in f) o[k] = val(f[k]); return o; }

function utrAlert(body) {
  if (!/^[A-Za-z0-9]{10,40}$/.test(body.uid || '') || !body.token) return json({ ok: false, msg: 'bad request' });
  const res = UrlFetchApp.fetch(DB_URL + 'users/' + body.uid, { headers: headersFor(body), muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) return json({ ok: false, msg: 'not verified' });
  const u = fieldsOf(JSON.parse(res.getContentText()));
  const utr = String(u.utr || '');
  if (!/^\d{12}$/.test(utr)) return json({ ok: false, msg: 'no transaction ID' });

  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('utr_' + utr)) return json({ ok: true, msg: 'already sent' });
  props.setProperty('utr_' + utr, String(Date.now()));

  const what = { signup: 'a new account (' + (u.plan || '') + ')', renew: 'a renewal (' + (PLANS[u.reqPlan] || '') + ')', wm: 'watermark removal' }[u.utrFor] || 'a payment';
  const text =
    (u.name || '') + ' is waiting for your approval.\n\n' +
    'Paid: Rs ' + Number(u.utrAmt || 0).toLocaleString('en-IN') + ' for ' + what + '\n' +
    'Transaction ID (UTR): ' + utr + '\n' +
    'Business: ' + (u.company || '') + '\n' +
    'Phone: ' + (u.phone || '') + '\n' +
    'Email: ' + (u.email || '') + (u.emailVerified ? ' (confirmed)' : ' (not confirmed yet)') + '\n\n' +
    'Please check this transaction ID in your bank or UPI app before you give access.\n' +
    'Then open SpaceQuote, go to Clients, and give access.';
  MailApp.sendEmail({ to: OWNER_EMAIL, subject: 'SpaceQuote: ' + (u.name || u.email) + ' is waiting for your approval', body: text });
  return json({ ok: true });
}

function sheetExport(body) {
  if (!body.token) return json({ ok: false, msg: 'Please log in again.' });
  // Only the owner can list all clients (your Firestore rules decide this).
  let docs = [], pageToken = '';
  do {
    const url = DB_URL + 'users?pageSize=300' + (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : '');
    const res = UrlFetchApp.fetch(url, { headers: headersFor(body), muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) return json({ ok: false, msg: 'Only the owner can do this. Please log in as the owner and try again.' });
    const j = JSON.parse(res.getContentText());
    docs = docs.concat(j.documents || []);
    pageToken = j.nextPageToken || '';
  } while (pageToken);

  const now = Date.now(), d = ms => ms ? new Date(Number(ms)) : '';
  const H = ['Name', 'Business', 'Phone', 'Email', 'Email confirmed', 'Plan', 'Price (Rs)', 'Status', 'Access ends', 'Days left', 'Data kept until', 'Quotations', 'Last seen', 'Joined', 'Approved on', 'Payment ID (UTR)', 'Paid (Rs)', 'Paid for', 'Paid on', 'Payment checked', 'Coupon', 'Watermark off until', 'Renewal asked'];
  const rows = docs.map(fieldsOf).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).map(x => {
    const act = x.status === 'active' && x.expMs > now;
    const status = x.status === 'blocked' ? 'Blocked' : act ? 'Active' : x.status === 'pending' ? 'Pending' : 'Expired';
    const forTxt = x.utrFor === 'wm' ? 'Watermark removal' : x.utrFor === 'renew' ? 'Renewal' : x.utr ? 'New account' : '';
    return [x.name || '', x.company || '', String(x.phone || ''), x.email || '', x.emailVerified ? 'Yes' : 'No', x.plan || '', x.price || 0, status,
      d(x.expMs), act ? Math.ceil((x.expMs - now) / 864e5) : 0, d(x.delMs), x.qCount || 0, d(x.lastSeen), d(x.createdAt), d(x.approvedAt),
      x.utr ? String(x.utr) : '', x.utr ? (x.utrAmt || 0) : '', forTxt, d(x.utrAt), x.utr ? (x.utr === x.utrDone ? 'Yes' : 'No') : '',
      x.fwCode ? x.fwCode + ' (' + (x.fwDesc || '') + ')' : '', (x.wmUntil || 0) > now ? (x.wmUntil > 3e12 ? 'Forever' : d(x.wmUntil)) : '', x.reqPlan ? (PLANS[x.reqPlan] || x.reqPlan) : ''];
  });

  const ss = getBook_();
  const sh = ss.getSheetByName('Clients') || ss.insertSheet('Clients');
  sh.clear();
  sh.getRange(1, 1, 1, H.length).setValues([H]).setFontWeight('bold').setBackground('#0b6b60').setFontColor('#ffffff');
  if (rows.length) {
    sh.getRange(2, 1, rows.length, H.length).setValues(rows);
    [9, 11, 13, 14, 15, 19].forEach(c => sh.getRange(2, c, rows.length, 1).setNumberFormat('dd-mm-yyyy'));
    [3, 16].forEach(c => sh.getRange(2, c, rows.length, 1).setNumberFormat('@'));
  }
  sh.setFrozenRows(1);
  sh.autoResizeColumns(1, H.length);

  const log = ss.getSheetByName('Log') || ss.insertSheet('Log');
  if (log.getLastRow() === 0) log.appendRow(['Updated on', 'Clients', 'Active', 'Pending', 'Expired', 'Blocked']);
  const count = s => rows.filter(r => r[7] === s).length;
  log.appendRow([new Date(), rows.length, count('Active'), count('Pending'), count('Expired'), count('Blocked')]);
  return json({ ok: true, rows: rows.length, url: ss.getUrl() });
}

// Creates the "SpaceQuote clients" spreadsheet in your Drive the first time, then reuses it.
function getBook_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('sheetId');
  if (id) { try { return SpreadsheetApp.openById(id); } catch (e) { } }
  const ss = SpreadsheetApp.create('SpaceQuote clients');
  props.setProperty('sheetId', ss.getId());
  return ss;
}

function json(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

// Run this once from the editor to give permission to send email.
function testEmail() {
  MailApp.sendEmail(OWNER_EMAIL, 'SpaceQuote alerts test', 'If you can read this, the email alerts are ready.');
}

// Run this once from the editor to give permission to create the Google Sheet.
function testSheet() {
  const ss = getBook_();
  Logger.log('Your sheet is ready: ' + ss.getUrl());
}
