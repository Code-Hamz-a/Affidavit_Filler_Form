// Notary tracking: one row per envelope sent for notary from the tool. Who sent it and when is written here at sending time
// (in DocuSign every envelope carries the same sender); opened / signed / finished times come from DocuSign.
// Only the request ID, people and times are kept — no patient name, no PDF.
import { db, now, getMeta, setMeta } from './db.js';
import { docusignConfigured, docusignAccount, docusignApi } from './docusign.js';

const MIN = 60 * 1000, DAY = 24 * 60 * MIN;
// DocuSign does not allow asking about the same envelope more than once in 15 minutes.
export const POLL_MS = 15 * MIN;
const FINAL = ['completed', 'voided', 'declined', 'deleted', 'missing'];

db.exec(`
CREATE TABLE IF NOT EXISTS notary_requests (
  id INTEGER PRIMARY KEY,
  envelope_id TEXT NOT NULL UNIQUE,
  account_id TEXT NOT NULL DEFAULT '',
  request_id TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT '',
  sender_name TEXT NOT NULL DEFAULT '',
  sender_email TEXT NOT NULL DEFAULT '',
  sent_at INTEGER NOT NULL,
  mode TEXT NOT NULL DEFAULT '',
  custodian_name TEXT NOT NULL DEFAULT '',
  custodian_email TEXT NOT NULL DEFAULT '',
  cust_opened_at INTEGER,
  cust_signed_at INTEGER,
  notary_name TEXT NOT NULL DEFAULT '',
  notary_email TEXT NOT NULL DEFAULT '',
  notary_opened_at INTEGER,
  notary_done_at INTEGER,
  sealed INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT '',
  ended_at INTEGER,
  ended_reason TEXT NOT NULL DEFAULT '',
  from_log INTEGER NOT NULL DEFAULT 0,
  reminded_at INTEGER,
  checked_at INTEGER NOT NULL DEFAULT 0,
  check_error TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS notary_sent ON notary_requests(sent_at);
`);

const clean = (s, n) => String(s ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);
const requestOf = subject => (String(subject || '').match(/\brequest\s+(.+)$/i) || [])[1] || '';
const time = s => { const t = Date.parse(s || ''); return Number.isNaN(t) ? null : t; };

// Called right after DocuSign took the envelope. Never allowed to break the sending itself.
export function recordSent(d) {
  try {
    db.prepare(`INSERT OR IGNORE INTO notary_requests (envelope_id, account_id, request_id, kind, sender_name, sender_email, sent_at, mode,
        custodian_name, custodian_email, notary_name, notary_email, status, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'sent', ?)`).run(
      d.envelopeId, docusignAccount(), clean(d.requestId || requestOf(d.subject), 60), d.kind, d.sender.name, d.sender.email, now(), d.notaryMode ? 'notary' : 'simple',
      clean(d.custodian.name, 100), clean(d.custodian.email, 254), clean(d.notary.name, 100), clean(d.notary.email, 254), now());
  } catch (e) { console.error('Notary tracking could not be written:', e); }
}

// Envelopes sent before this page existed: the activity log has who sent them, when, and the envelope ID. The rest comes from DocuSign;
// they are shown only once DocuSign has answered (test envelopes of another DocuSign account never are).
export function importFromLog() {
  if (getMeta('notary_imported') || !docusignConfigured()) return;
  const add = db.prepare(`INSERT OR IGNORE INTO notary_requests (envelope_id, account_id, sender_name, sender_email, sent_at, from_log) VALUES (?, ?, ?, ?, ?, 1)`);
  for (const a of db.prepare("SELECT at, actor, text FROM audit WHERE kind = 'docusign'").all()) {
    const m = a.text.match(/^(.*) sent an affidavit to DocuSign \(envelope ([0-9a-f-]{36})\)$/i);
    if (m) add.run(m[2], docusignAccount(), m[1], a.actor, a.at);
  }
  setMeta('notary_imported', now());
}

// What DocuSign says about one envelope → the columns of its row.
export function readEnvelope(env, rec) {
  const host = (rec.inPersonSigners || []).find(s => s.inPersonSigningType === 'notary' && s.notaryHost);
  const signers = (rec.signers || []).slice().sort((a, b) => Number(a.routingOrder) - Number(b.routingOrder));
  const custodian = host || signers.find(s => s.roleName === 'Custodian') || signers[0] || {};
  const notary = host ? host.notaryHost : signers.find(s => s.roleName === 'Notary') || signers[1] || {};
  const finished = p => /^(completed|signed)$/i.test(p.status || '');
  const tabs = notary.tabs || {};
  // The seal comes back as a signed "Sign here" box named …NotarySeal…
  const sealed = !!host && finished(notary) && (
    (tabs.signHereTabs || []).some(t => /notary_?seal/i.test(t.tabLabel || '') && t.status === 'signed') ||
    (tabs.notarySealTabs || []).some(t => !t.status || t.status === 'signed'));
  const status = String(env.status || '').toLowerCase();
  const ended = status === 'voided' ? time(env.voidedDateTime) : status === 'declined' ? time(env.declinedDateTime) : status === 'deleted' ? time(env.deletedDateTime) : status === 'completed' ? time(env.completedDateTime) : null;
  return {
    status, mode: host ? 'notary' : 'simple', sealed: sealed ? 1 : 0, request: clean(requestOf(env.emailSubject), 60),
    ended_at: FINAL.includes(status) ? ended || time(env.statusChangedDateTime) : null, ended_reason: clean(env.voidedReason, 200),
    custodian_name: clean(custodian.name, 100), custodian_email: clean(custodian.email, 254),
    cust_opened_at: time(custodian.deliveredDateTime), cust_signed_at: finished(custodian) ? time(custodian.signedDateTime) : null,
    notary_name: clean(notary.name, 100), notary_email: clean(notary.email, 254),
    notary_opened_at: time(notary.deliveredDateTime), notary_done_at: finished(notary) ? time(notary.signedDateTime) : null
  };
}

let running = null;
// Asks DocuSign about every request that is not finished and was not asked about in the last 15 minutes (once a day after 45 days).
export function refresh() {
  if (running || !docusignConfigured()) return;
  const due = dueRows();
  if (due.length) running = run(due).catch(e => { console.error('Notary tracking:', e); setMeta('notary_error', e.message); }).finally(() => { running = null; });
}
export const isChecking = () => !!running;

function dueRows() {
  const t = now(), holes = FINAL.map(() => '?').join(',');
  return db.prepare(`SELECT id, envelope_id FROM notary_requests WHERE account_id = ? AND status NOT IN (${holes})
    AND checked_at <= CASE WHEN sent_at < ? THEN ? ELSE ? END ORDER BY sent_at DESC LIMIT 100`).all(docusignAccount(), ...FINAL, t - 45 * DAY, t - DAY, t - POLL_MS);
}

async function run(due) {
  const t = now();
  for (const row of due) {
    // taken first, so two server processes never ask about the same envelope
    if (!db.prepare('UPDATE notary_requests SET checked_at = ? WHERE id = ? AND checked_at <= ?').run(now(), row.id, t - POLL_MS).changes) continue;
    const path = `/envelopes/${encodeURIComponent(row.envelope_id)}`;
    const env = await docusignApi('GET', path);
    if (env.status === 404 || env.body.errorCode === 'ENVELOPE_DOES_NOT_EXIST') {
      db.prepare("UPDATE notary_requests SET status = 'missing', ended_at = ? WHERE id = ?").run(now(), row.id);
      continue;
    }
    const rec = env.ok ? await docusignApi('GET', path + '/recipients?include_tabs=true') : null;
    const bad = !env.ok ? env : !rec.ok ? rec : null;
    if (bad) {
      const why = clean(bad.body.message || bad.body.errorCode || `DocuSign answered ${bad.status}`, 200);
      db.prepare('UPDATE notary_requests SET check_error = ? WHERE id = ?').run(why, row.id);
      setMeta('notary_error', why);
      if (bad.status === 401 || bad.status === 403 || bad.status === 429) return;
      continue;
    }
    const v = readEnvelope(env.body, rec.body);
    db.prepare(`UPDATE notary_requests SET status = ?, mode = ?, sealed = ?, ended_at = ?, ended_reason = ?,
        request_id = CASE WHEN request_id = '' THEN ? ELSE request_id END,
        custodian_name = COALESCE(NULLIF(?, ''), custodian_name), custodian_email = COALESCE(NULLIF(?, ''), custodian_email), cust_opened_at = ?, cust_signed_at = ?,
        notary_name = COALESCE(NULLIF(?, ''), notary_name), notary_email = COALESCE(NULLIF(?, ''), notary_email), notary_opened_at = ?, notary_done_at = ?, check_error = ''
      WHERE id = ?`).run(v.status, v.mode, v.sealed, v.ended_at, v.ended_reason, v.request, v.custodian_name, v.custodian_email, v.cust_opened_at, v.cust_signed_at,
      v.notary_name, v.notary_email, v.notary_opened_at, v.notary_done_at, row.id);
    setMeta('notary_error', '');
  }
  setMeta('notary_checked', now());
}

// cust: waiting for the custodian · not: waiting for the notary · done: notarized (seal found) · simple: signed, no seal · cancel
export function stateOf(r) {
  if (['voided', 'declined', 'deleted', 'missing'].includes(r.status)) return 'cancel';
  if (r.mode === 'notary' && r.sealed && r.notary_done_at) return 'done';
  if (r.status === 'completed') return 'simple';
  return r.cust_signed_at ? 'not' : 'cust';
}

export function list() {
  const rows = db.prepare("SELECT * FROM notary_requests WHERE account_id = ? AND NOT (from_log = 1 AND status IN ('', 'missing')) ORDER BY sent_at DESC, id DESC LIMIT 5000").all(docusignAccount());
  return rows.map(r => ({
    id: r.id, envelopeId: r.envelope_id, requestId: r.request_id, kind: r.kind, sender: r.sender_name, senderEmail: r.sender_email, sentAt: r.sent_at,
    mode: r.mode, custodian: r.custodian_name, custodianEmail: r.custodian_email, custOpened: r.cust_opened_at, custSigned: r.cust_signed_at,
    notary: r.notary_name, notaryEmail: r.notary_email, notaryOpened: r.notary_opened_at, notaryDone: r.notary_done_at,
    endedAt: r.ended_at, endedHow: stateOf(r) === 'cancel' ? r.status : '', endedReason: r.ended_reason, remindedAt: r.reminded_at, checkError: r.check_error, state: stateOf(r)
  }));
}
export const requestById = id => db.prepare('SELECT * FROM notary_requests WHERE id = ? AND account_id = ?').get(id, docusignAccount());
export const trackingInfo = () => ({ checkedAt: Number(getMeta('notary_checked')) || 0, error: getMeta('notary_error') || '', checking: isChecking() });

// DocuSign emails the request again to whoever still has to act on it.
export async function remind(r) {
  const x = await docusignApi('PUT', `/envelopes/${encodeURIComponent(r.envelope_id)}?resend_envelope=true`, {});
  if (!x.ok) return clean(x.body.message || x.body.errorCode || `DocuSign answered ${x.status}`, 200);
  db.prepare('UPDATE notary_requests SET reminded_at = ? WHERE id = ?').run(now(), r.id);
  return '';
}
