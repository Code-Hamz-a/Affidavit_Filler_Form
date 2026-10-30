// Affidavit Filler server: sign-in, admin dashboard, access control. Serves the tool only to signed-in users.
// Patient PDFs are processed in the browser and never reach this server.
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import QRCode from 'qrcode';
import { config, POLICY, ACCESS, TOOL_DIR, PUBLIC_DIR } from './config.js';
import { db, now, audit, userById, userByEmail, userCount, adminCount, accessOf, setMeta, cleanup } from './db.js';
import * as sec from './security.js';

const MIN = 60 * 1000;
const COOKIE = config.insecureHttp ? 'af_sid' : '__Host-af_sid';
const app = express();
app.disable('x-powered-by');
if (config.trustProxy) app.set('trust proxy', 1);

// ------------------------------------------------------------ security headers
// The tool needs WebAssembly (OCR) and its own inline styles; everything else is same-origin only.
const CSP = [
  "default-src 'self'", "script-src 'self' 'wasm-unsafe-eval'", "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:", "font-src 'self'", "connect-src 'self' data: blob:", "worker-src 'self' blob:",
  "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'"
].join('; ');
app.use((req, res, next) => {
  res.set({
    'Content-Security-Policy': CSP,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin'
  });
  if (!config.insecureHttp) res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});

// ------------------------------------------------------------ helpers
const hits = new Map();
// Simple in-memory rate limit: at most `max` calls per key in `windowMs`.
function allow(key, max, windowMs) {
  const t = now();
  let h = hits.get(key);
  if (!h || h.reset < t) { h = { n: 0, reset: t + windowMs }; hits.set(key, h); }
  return ++h.n <= max;
}
setInterval(() => {
  const t = now();
  for (const [k, h] of hits) if (h.reset < t) hits.delete(k);
  cleanup();
}, 10 * MIN).unref();

const str = (v, max = 200) => String(v ?? '').trim().slice(0, max);
const ipOf = req => req.ip || '';
const fail = (res, status, error, extra = {}) => res.status(status).json({ error, ...extra });
const minutesLeft = t => Math.max(1, Math.ceil((t - now()) / MIN));
const EMAIL_RX = /^[^\s@<>()]{1,64}@[^\s@<>()]{1,190}\.[A-Za-z]{2,}$/;
const MOBILE_RX = /^\+?[\d\s().-]{7,20}$/;

function readCookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return '';
}
const cookieAttrs = `Path=/; HttpOnly; SameSite=Strict${config.insecureHttp ? '' : '; Secure'}`;
const setSessionCookie = (res, token) => res.append('Set-Cookie', `${COOKIE}=${token}; ${cookieAttrs}; Max-Age=${POLICY.sessionMs / 1000}`);
const clearSessionCookie = res => res.append('Set-Cookie', `${COOKIE}=; ${cookieAttrs}; Max-Age=0`);

function validUserFields(b) {
  const name = str(b.name, 100), email = str(b.email, 254).toLowerCase(), mobile = str(b.mobile, 20);
  if (name.length < 2) return { error: 'Enter the full name.', field: 'name' };
  if (!EMAIL_RX.test(email)) return { error: 'Enter a valid work email.', field: 'email' };
  if (!MOBILE_RX.test(mobile) || (mobile.match(/\d/g) || []).length < 7) return { error: 'Enter a valid mobile number.', field: 'mobile' };
  return { name, email, mobile };
}
const cleanAccess = a => [...new Set((Array.isArray(a) ? a : []).filter(k => Object.hasOwn(ACCESS, k)))];
const accessLabel = (role, list) => role === 'admin' ? 'all tools + admin' : list.map(k => ACCESS[k]).join(', ') || 'none';

// ------------------------------------------------------------ sessions
// Stages: a session first has to change a temporary password, then turn on two-step, before it is "full".
function nextStage(u) {
  if (u.must_change_pw) return 'password_change';
  if ((u.role === 'admin' || u.totp_required) && !u.totp_secret) return 'twostep_setup';
  return 'full';
}
function stageUrl(stage, u) {
  if (stage === 'password_change') return '/change-password';
  if (stage === 'twostep_setup') return '/twostep';
  return u && u.role === 'admin' ? '/admin' : '/app/';
}
function createSession(req, res, u, stage) {
  const token = sec.randomToken();
  const t = now();
  db.prepare(`INSERT INTO sessions (token_hash, user_id, stage, created_at, last_active_at, expires_at, ip, agent)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(sec.sha256(token), u.id, stage, t, t, t + POLICY.sessionMs, ipOf(req), str(req.get('user-agent'), 200));
  setSessionCookie(res, token);
}
const endSessions = (userId, exceptHash = '') => db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?').run(userId, exceptHash);

app.use((req, res, next) => {
  req.sess = null; req.user = null;
  const token = readCookie(req, COOKIE);
  if (!token) return next();
  const th = sec.sha256(token);
  const s = db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(th);
  if (!s) return next();
  const t = now();
  const u = userById(s.user_id);
  const idle = s.last_active_at + POLICY.idleMs < t;
  if (s.expires_at < t || idle || !u || u.status !== 'active') {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(th);
    if (u && idle) audit('signout', `${u.name} was signed out automatically after ${POLICY.idleMs / MIN} minutes idle`, u.email);
    return next();
  }
  req.sess = s; req.user = u; req.tokenHash = th;
  // Activity keeps the session alive; the tool's heartbeat and the dashboard's auto-refresh do not count.
  if (req.path !== '/api/ping' && !req.get('x-passive')) {
    db.prepare('UPDATE sessions SET last_active_at = ? WHERE token_hash = ?').run(t, th);
    db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(t, u.id);
  }
  next();
});

const needStage = (...stages) => (req, res, next) => {
  if (req.sess && stages.includes(req.sess.stage)) return next();
  if (req.originalUrl.startsWith('/api/')) return fail(res, 401, 'Please sign in again.', { next: req.sess ? stageUrl(req.sess.stage, req.user) : '/login' });
  res.redirect(303, req.sess ? stageUrl(req.sess.stage, req.user) : '/login');
};
const needAdmin = (req, res, next) => req.user.role === 'admin' ? next() : fail(res, 403, 'Only admins can do this.');

// ------------------------------------------------------------ CSRF: API writes must come from our own pages
app.use('/api', (req, res, next) => {
  if (req.method === 'GET') return next();
  if (req.get('x-requested-with') !== 'fetch') return fail(res, 403, 'Request blocked.');
  const origin = req.get('origin');
  if (origin) {
    let host = '';
    try { host = new URL(origin).host; } catch { /* bad origin */ }
    if (host !== req.get('host')) return fail(res, 403, 'Request blocked.');
  }
  next();
});
app.use(express.json({ limit: '20kb' }));

// ------------------------------------------------------------ pages
const sendPage = name => (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(PUBLIC_DIR, name + '.html'));
};
app.use('/assets', express.static(path.join(PUBLIC_DIR, 'assets'), { index: false, dotfiles: 'deny', maxAge: '1h' }));

app.get('/favicon.ico', (req, res) => res.status(204).end());
app.get('/robots.txt', (req, res) => res.type('text').send('User-agent: *\nDisallow: /\n'));
app.get('/', (req, res) => {
  if (!userCount()) return res.redirect(303, '/setup');
  res.redirect(303, req.sess ? stageUrl(req.sess.stage, req.user) : '/login');
});
app.get('/login', (req, res, next) => req.sess && req.sess.stage === 'full' ? res.redirect(303, stageUrl('full', req.user)) : next(), sendPage('login'));
app.get('/activate', sendPage('activate'));
app.get('/setup', sendPage('setup'));
app.get('/twostep', needStage('twostep_setup', 'full'), sendPage('twostep'));
app.get('/change-password', needStage('password_change', 'full'), sendPage('change-password'));
app.get('/admin', needStage('full'), (req, res, next) => req.user.role === 'admin' ? next() : res.redirect(303, '/app/'), sendPage('admin'));

// The tool, with the sign-in bar and access rules added.
let toolCache = { mtime: 0, html: '' };
function toolHtml() {
  const file = path.join(TOOL_DIR, 'Affidavit Filler.html');
  const { mtimeMs } = fs.statSync(file);
  if (mtimeMs !== toolCache.mtime) {
    const html = fs.readFileSync(file, 'utf8')
      .replace('</head>', '<link rel="stylesheet" href="/assets/tool.css">\n</head>')
      .replace('</body>', '<script src="/assets/tool-guard.js"></script>\n</body>');
    toolCache = { mtime: mtimeMs, html };
  }
  return toolCache.html;
}
// "/app" and "/app/" are the same route to Express; only the one without the slash is sent on (the tool's links are relative).
app.get('/app', (req, res, next) => req.originalUrl.split('?')[0] === '/app' ? res.redirect(301, '/app/') : next());
app.get('/app/', needStage('full'), (req, res) => { res.set('Cache-Control', 'no-store').type('html').send(toolHtml()); });
for (const dir of ['js', 'lib']) {
  app.use(`/app/${dir}`, needStage('full'), express.static(path.join(TOOL_DIR, dir), { index: false, dotfiles: 'deny' }));
}

// ------------------------------------------------------------ first admin (one-time setup page)
app.get('/api/setup', (req, res) => res.json({ needed: userCount() === 0, tokenConfigured: config.setupToken.length >= 16 }));

app.post('/api/setup', async (req, res) => {
  const ip = ipOf(req), b = req.body || {};
  if (userCount() > 0) return fail(res, 410, 'Setup is already complete. Sign in instead.', { next: '/login' });
  if (config.setupToken.length < 16) return fail(res, 503, 'The server has no setup token yet. Ask the person who deployed it to set SETUP_TOKEN (at least 16 characters).');
  if (!allow('setup:' + ip, 10, 15 * MIN)) return fail(res, 429, 'Too many tries. Wait 15 minutes.');
  if (!sec.sameSecret(str(b.token, 300), config.setupToken)) {
    audit('failed', 'Setup page: wrong setup token', '', ip);
    return fail(res, 401, 'The setup token is not right.', { field: 'token' });
  }
  const f = validUserFields(b);
  if (f.error) return fail(res, 400, f.error, { field: f.field });
  if (String(b.password ?? '') !== String(b.confirm ?? '')) return fail(res, 400, 'The two passwords are not the same.', { field: 'confirm' });
  const problem = sec.passwordProblem(b.password, f);
  if (problem) return fail(res, 400, problem, { field: 'password' });
  const hash = await sec.hashPassword(String(b.password));
  if (userCount() > 0) return fail(res, 410, 'Setup is already complete. Sign in instead.', { next: '/login' });
  const r = db.prepare(`INSERT INTO users (name, email, mobile, role, access, status, password_hash, totp_required, created_at)
    VALUES (?, ?, ?, 'admin', '[]', 'active', ?, 1, ?)`).run(f.name, f.email, f.mobile, hash, now());
  setMeta('setup_done', new Date().toISOString());
  const u = userById(Number(r.lastInsertRowid));
  audit('setup', `First admin ${u.name} created on the setup page — setup is now closed`, u.email, ip);
  createSession(req, res, u, 'twostep_setup');
  res.json({ next: '/twostep' });
});

// ------------------------------------------------------------ sign in / out
function wrongTry(u, ip, why) {
  const failed = u.failed_count + 1;
  if (failed >= POLICY.maxFailed) {
    db.prepare('UPDATE users SET failed_count = 0, locked_until = ? WHERE id = ?').run(now() + POLICY.lockMs, u.id);
    audit('failed', `${u.name}: ${why} — account locked for ${POLICY.lockMs / MIN} minutes`, u.email, ip);
  } else {
    db.prepare('UPDATE users SET failed_count = ? WHERE id = ?').run(failed, u.id);
    audit('failed', `${u.name}: ${why} (${failed} of ${POLICY.maxFailed})`, u.email, ip);
  }
}
// Two-step: a 6-digit code from the app, or one of the backup codes (each works once).
function secondFactor(u, code) {
  if (/^\d{3}\s?\d{3}$/.test(code)) {
    const step = sec.checkTotp(sec.decrypt(u.totp_secret), code, u.totp_last_step);
    if (step) { db.prepare('UPDATE users SET totp_last_step = ? WHERE id = ?').run(step, u.id); return 'app'; }
    return null;
  }
  const list = JSON.parse(u.backup_codes || '[]');
  const i = list.indexOf(sec.codeHash(code));
  if (i < 0) return null;
  list.splice(i, 1);
  db.prepare('UPDATE users SET backup_codes = ? WHERE id = ?').run(JSON.stringify(list), u.id);
  audit('account', `${u.name} used a backup code (${list.length} left)`, u.email);
  return 'backup';
}

app.post('/api/login', async (req, res) => {
  const ip = ipOf(req), b = req.body || {};
  if (!allow('login:' + ip, 30, 15 * MIN)) return fail(res, 429, 'Too many sign-in attempts from this network. Wait 15 minutes.');
  const email = str(b.email, 254), password = String(b.password ?? '').slice(0, 200), code = str(b.code, 20);
  const u = email ? userByEmail(email) : null;
  if (u && u.locked_until > now()) {
    return fail(res, 423, `This account is locked after too many wrong tries. Try again in ${minutesLeft(u.locked_until)} minute(s), or ask your admin to unlock it.`);
  }
  const ok = u && u.status === 'active' && u.password_hash ? await sec.verifyPassword(password, u.password_hash) : await sec.dummyVerify(password);
  const generic = `Wrong email or password. After ${POLICY.maxFailed} wrong tries the account is locked for ${POLICY.lockMs / MIN} minutes.`;
  if (!ok) {
    if (u && u.status === 'active') wrongTry(u, ip, 'wrong password');
    return fail(res, 401, generic);
  }
  let how = '';
  if (u.totp_secret) {
    if (!code) return res.json({ need: 'code' });
    how = secondFactor(u, code);
    if (!how) {
      wrongTry(userById(u.id), ip, 'wrong two-step code');
      return fail(res, 401, 'That code is not right. Use the newest 6-digit code from your authenticator app, or a backup code.', { need: 'code' });
    }
  }
  db.prepare('UPDATE users SET failed_count = 0, locked_until = 0, last_login_at = ? WHERE id = ?').run(now(), u.id);
  const fresh = userById(u.id);
  const stage = nextStage(fresh);
  createSession(req, res, fresh, stage);
  audit('signin', `${fresh.name} signed in${how === 'app' ? ' with two-step code' : how === 'backup' ? ' with a backup code' : ''}`, fresh.email, ip);
  res.json({ next: stageUrl(stage, fresh) });
});

app.post('/api/logout', (req, res) => {
  if (req.sess) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(req.tokenHash);
    audit('signout', `${req.user.name} signed out${req.body && req.body.idle ? ' (idle)' : ''}`, req.user.email, ipOf(req));
  }
  clearSessionCookie(res);
  res.json({ next: '/login' });
});

// ------------------------------------------------------------ account activation (the only "sign-up")
app.post('/api/activate', async (req, res) => {
  const ip = ipOf(req), b = req.body || {};
  if (!allow('activate:' + ip, 20, 15 * MIN)) return fail(res, 429, 'Too many tries. Wait 15 minutes.');
  const email = str(b.email, 254), code = str(b.code, 40), password = String(b.password ?? '').slice(0, 200);
  if (password !== String(b.confirm ?? '')) return fail(res, 400, 'The two passwords are not the same.', { field: 'confirm' });
  const u = email ? userByEmail(email) : null;
  const valid = u && u.status === 'pending' && u.activation_hash && u.activation_expires > now() &&
    sec.sameSecret(sec.codeHash(code), u.activation_hash);
  if (!valid) {
    if (u && u.status === 'pending' && u.activation_hash) {
      const tries = u.activation_tries + 1;
      if (tries >= POLICY.maxCodeTries) {
        db.prepare('UPDATE users SET activation_hash = NULL, activation_tries = 0 WHERE id = ?').run(u.id);
        audit('failed', `${u.name}: ${tries} wrong activation codes — the code was cancelled, the admin must give a new one`, u.email, ip);
      } else {
        db.prepare('UPDATE users SET activation_tries = ? WHERE id = ?').run(tries, u.id);
        audit('failed', `${u.name}: wrong activation code (${tries} of ${POLICY.maxCodeTries})`, u.email, ip);
      }
    }
    // The same answer whether the email is unknown or the code is wrong.
    return fail(res, 401, 'This email or code was not accepted. Accounts are created by an administrator — ask your admin to add you and give you a code.');
  }
  const problem = sec.passwordProblem(password, u);
  if (problem) return fail(res, 400, problem, { field: 'password' });
  db.prepare(`UPDATE users SET password_hash = ?, status = 'active', must_change_pw = 0, activation_hash = NULL,
    activation_expires = NULL, activation_tries = 0 WHERE id = ?`).run(await sec.hashPassword(password), u.id);
  audit('account', `${u.name} activated their account`, u.email, ip);
  res.json({ next: '/login?activated=1' });
});

// ------------------------------------------------------------ two-step sign-in (authenticator app)
app.get('/api/session', (req, res) => {
  if (!req.sess) return fail(res, 401, 'Please sign in.', { next: '/login' });
  res.json({ stage: req.sess.stage, name: req.user.name, email: req.user.email, role: req.user.role, next: stageUrl(req.sess.stage, req.user) });
});

app.get('/api/twostep', needStage('twostep_setup', 'full'), async (req, res) => {
  if (req.user.totp_secret) return fail(res, 409, 'Two-step sign-in is already on for your account. If you lost your phone, ask an admin to reset it.');
  let secret = req.sess.pending_secret ? sec.decrypt(req.sess.pending_secret) : '';
  if (!secret) {
    secret = sec.newTotpSecret();
    db.prepare('UPDATE sessions SET pending_secret = ? WHERE token_hash = ?').run(sec.encrypt(secret), req.tokenHash);
  }
  const qr = await QRCode.toDataURL(sec.otpauthUrl(secret, req.user.email), { margin: 1, width: 240, errorCorrectionLevel: 'M' });
  res.json({ qr, secret: secret.match(/.{1,4}/g).join(' '), account: `${config.issuer} (${req.user.email})`, required: req.sess.stage === 'twostep_setup' });
});

app.post('/api/twostep', needStage('twostep_setup', 'full'), (req, res) => {
  const u = req.user;
  if (u.totp_secret) return fail(res, 409, 'Two-step sign-in is already on for your account.');
  if (!req.sess.pending_secret) return fail(res, 400, 'Reload the page to get a new QR code.');
  if (!allow('totp:' + u.id, 10, 15 * MIN)) return fail(res, 429, 'Too many tries. Wait 15 minutes.');
  const secret = sec.decrypt(req.sess.pending_secret);
  const step = sec.checkTotp(secret, str(req.body && req.body.code, 20), 0);
  if (!step) return fail(res, 400, 'That code is not right. Make sure the time on your phone is set automatically, then type the newest code.', { field: 'code' });
  const { codes, hashes } = sec.newBackupCodes();
  db.prepare('UPDATE users SET totp_secret = ?, totp_last_step = ?, backup_codes = ? WHERE id = ?').run(sec.encrypt(secret), step, JSON.stringify(hashes), u.id);
  db.prepare("UPDATE sessions SET stage = 'full', pending_secret = NULL WHERE token_hash = ?").run(req.tokenHash);
  audit('account', `${u.name} turned on two-step sign-in`, u.email, ipOf(req));
  res.json({ backupCodes: codes, next: stageUrl('full', u) });
});

// ------------------------------------------------------------ change own password
app.post('/api/password', needStage('password_change', 'full'), async (req, res) => {
  const u = req.user, b = req.body || {};
  if (!allow('password:' + u.id, 10, 15 * MIN)) return fail(res, 429, 'Too many tries. Wait 15 minutes.');
  const password = String(b.password ?? '').slice(0, 200);
  if (password !== String(b.confirm ?? '')) return fail(res, 400, 'The two passwords are not the same.', { field: 'confirm' });
  if (req.sess.stage === 'full' && !(await sec.verifyPassword(String(b.current ?? ''), u.password_hash))) {
    return fail(res, 400, 'Your current password is not right.', { field: 'current' });
  }
  if (await sec.verifyPassword(password, u.password_hash)) return fail(res, 400, 'Choose a new password, not the current one.', { field: 'password' });
  const problem = sec.passwordProblem(password, u);
  if (problem) return fail(res, 400, problem, { field: 'password' });
  db.prepare('UPDATE users SET password_hash = ?, must_change_pw = 0 WHERE id = ?').run(await sec.hashPassword(password), u.id);
  endSessions(u.id, req.tokenHash); // signed out on every other device
  const fresh = userById(u.id);
  const stage = nextStage(fresh);
  db.prepare('UPDATE sessions SET stage = ? WHERE token_hash = ?').run(stage, req.tokenHash);
  audit('account', `${u.name} changed their password`, u.email, ipOf(req));
  res.json({ next: stageUrl(stage, fresh) });
});

// ------------------------------------------------------------ the signed-in user (read by the tool)
app.get('/api/me', needStage('full'), (req, res) => {
  const u = req.user;
  res.json({ name: u.name, email: u.email, role: u.role, access: accessOf(u), twostep: !!u.totp_secret, idleMinutes: POLICY.idleMs / MIN });
});
app.post('/api/ping', needStage('full'), (req, res) => {
  if (req.body && req.body.active) {
    const t = now();
    db.prepare('UPDATE sessions SET last_active_at = ? WHERE token_hash = ?').run(t, req.tokenHash);
    db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(t, req.user.id);
  }
  res.json({ ok: true });
});

// ------------------------------------------------------------ admin
const admin = express.Router();
admin.use(needStage('full'), needAdmin);
const actor = req => [req.user.email, ipOf(req)];
const target = (req, res) => {
  const u = userById(Number(req.params.id));
  if (!u) { fail(res, 404, 'This user no longer exists.'); return null; }
  return u;
};
const notSelf = (req, res, u, what) => {
  if (u.id !== req.user.id) return true;
  fail(res, 400, `You cannot ${what} your own account here.`);
  return false;
};

admin.get('/users', (req, res) => {
  const t = now();
  const online = new Map(db.prepare(`SELECT user_id, MAX(last_active_at) AS at FROM sessions
    WHERE stage = 'full' AND expires_at > ? AND last_active_at > ? GROUP BY user_id`).all(t, t - POLICY.idleMs).map(r => [r.user_id, r.at]));
  const users = db.prepare("SELECT * FROM users ORDER BY role = 'admin' DESC, name COLLATE NOCASE").all().map(u => ({
    id: u.id, name: u.name, email: u.email, mobile: u.mobile, role: u.role, access: accessOf(u), status: u.status,
    lockedUntil: u.locked_until > t ? u.locked_until : 0, failed: u.failed_count,
    twostep: !!u.totp_secret, twostepRequired: u.role === 'admin' || !!u.totp_required, backupLeft: JSON.parse(u.backup_codes || '[]').length,
    codeExpires: u.status === 'pending' && u.activation_hash ? u.activation_expires : null,
    mustChange: !!u.must_change_pw, lastLogin: u.last_login_at, lastActive: online.get(u.id) || null, isYou: u.id === req.user.id
  }));
  res.json({ users, now: t, idleMs: POLICY.idleMs, access: ACCESS, policy: POLICY });
});

admin.post('/users', async (req, res) => {
  const b = req.body || {};
  const f = validUserFields(b);
  if (f.error) return fail(res, 400, f.error, { field: f.field });
  const role = b.role === 'admin' ? 'admin' : 'user';
  const access = role === 'admin' ? [] : cleanAccess(b.access);
  if (role === 'user' && !access.length) return fail(res, 400, 'Tick at least one tool this user may use.', { field: 'access' });
  if (userByEmail(f.email)) return fail(res, 409, 'A user with this email already exists.', { field: 'email' });
  const t = now();
  let code = null, temp = null, hash = null;
  if (b.method === 'password') {
    temp = b.password ? String(b.password).slice(0, 200) : sec.newTempPassword();
    const problem = sec.passwordProblem(temp, f);
    if (problem) return fail(res, 400, problem, { field: 'password' });
    hash = await sec.hashPassword(temp);
  } else code = sec.newCode();
  const r = db.prepare(`INSERT INTO users (name, email, mobile, role, access, status, password_hash, must_change_pw,
      activation_hash, activation_expires, totp_required, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    f.name, f.email, f.mobile, role, JSON.stringify(access), code ? 'pending' : 'active', hash, code ? 0 : 1,
    code ? sec.codeHash(code) : null, code ? t + POLICY.codeMs : null, b.twostepRequired ? 1 : 0, t);
  audit('admin', `${req.user.name} added ${f.name} (${role}) · access: ${accessLabel(role, access)} · ${code ? 'activation code' : 'temporary password'}`, ...actor(req));
  res.json({ id: Number(r.lastInsertRowid), code, password: b.password ? null : temp, codeExpires: code ? t + POLICY.codeMs : null });
});

admin.patch('/users/:id', (req, res) => {
  const u = target(req, res); if (!u) return;
  const b = req.body || {};
  const name = b.name === undefined ? u.name : str(b.name, 100);
  const mobile = b.mobile === undefined ? u.mobile : str(b.mobile, 20);
  const role = b.role === undefined ? u.role : (b.role === 'admin' ? 'admin' : 'user');
  const access = role === 'admin' ? [] : (b.access === undefined ? JSON.parse(u.access) : cleanAccess(b.access));
  const twostepRequired = b.twostepRequired === undefined ? !!u.totp_required : !!b.twostepRequired;
  if (name.length < 2) return fail(res, 400, 'Enter the full name.', { field: 'name' });
  if (!MOBILE_RX.test(mobile)) return fail(res, 400, 'Enter a valid mobile number.', { field: 'mobile' });
  if (role === 'user' && !access.length) return fail(res, 400, 'Tick at least one tool this user may use.', { field: 'access' });
  if (u.role === 'admin' && role === 'user') {
    if (u.id === req.user.id) return fail(res, 400, 'You cannot remove your own admin role.');
    if (adminCount() <= 1) return fail(res, 400, 'This is the last admin. Make someone else an admin first.');
  }
  db.prepare('UPDATE users SET name = ?, mobile = ?, role = ?, access = ?, totp_required = ? WHERE id = ?')
    .run(name, mobile, role, JSON.stringify(access), twostepRequired ? 1 : 0, u.id);
  audit('admin', `${req.user.name} updated ${name}: ${role} · access: ${accessLabel(role, access)}${twostepRequired ? ' · two-step required' : ''}`, ...actor(req));
  res.json({ ok: true });
});

admin.post('/users/:id/password', async (req, res) => {
  const u = target(req, res); if (!u) return;
  if (!notSelf(req, res, u, 'reset the password of')) return;
  const b = req.body || {};
  const temp = b.password ? String(b.password).slice(0, 200) : sec.newTempPassword();
  const problem = sec.passwordProblem(temp, u);
  if (problem) return fail(res, 400, problem, { field: 'password' });
  db.prepare(`UPDATE users SET password_hash = ?, must_change_pw = 1, status = 'active', failed_count = 0, locked_until = 0,
    activation_hash = NULL, activation_expires = NULL, activation_tries = 0 WHERE id = ?`).run(await sec.hashPassword(temp), u.id);
  if (b.signOut !== false) endSessions(u.id);
  audit('admin', `${req.user.name} reset the password for ${u.name}${b.signOut !== false ? ' and signed them out everywhere' : ''}`, ...actor(req));
  res.json({ password: b.password ? null : temp });
});

admin.post('/users/:id/code', (req, res) => {
  const u = target(req, res); if (!u) return;
  if (u.status !== 'pending') return fail(res, 400, 'This user has already activated their account. Use “Reset password” instead.');
  const code = sec.newCode(), expires = now() + POLICY.codeMs;
  db.prepare('UPDATE users SET activation_hash = ?, activation_expires = ?, activation_tries = 0 WHERE id = ?').run(sec.codeHash(code), expires, u.id);
  audit('admin', `${req.user.name} made a new activation code for ${u.name}`, ...actor(req));
  res.json({ code, codeExpires: expires });
});

admin.post('/users/:id/unlock', (req, res) => {
  const u = target(req, res); if (!u) return;
  db.prepare('UPDATE users SET failed_count = 0, locked_until = 0 WHERE id = ?').run(u.id);
  audit('admin', `${req.user.name} unlocked ${u.name}`, ...actor(req));
  res.json({ ok: true });
});

admin.post('/users/:id/signout', (req, res) => {
  const u = target(req, res); if (!u) return;
  if (!notSelf(req, res, u, 'sign out')) return;
  endSessions(u.id);
  audit('admin', `${req.user.name} signed ${u.name} out of every device`, ...actor(req));
  res.json({ ok: true });
});

admin.post('/users/:id/reset-twostep', (req, res) => {
  const u = target(req, res); if (!u) return;
  if (!notSelf(req, res, u, 'reset two-step for')) return;
  db.prepare("UPDATE users SET totp_secret = NULL, totp_last_step = 0, backup_codes = '[]' WHERE id = ?").run(u.id);
  endSessions(u.id);
  audit('admin', `${req.user.name} reset two-step sign-in for ${u.name} (lost phone) — they set it up again at next sign-in`, ...actor(req));
  res.json({ ok: true });
});

admin.delete('/users/:id', (req, res) => {
  const u = target(req, res); if (!u) return;
  if (!notSelf(req, res, u, 'delete')) return;
  if (str(req.body && req.body.confirm, 254).toLowerCase() !== u.email.toLowerCase()) return fail(res, 400, 'Type the user’s email exactly to confirm.', { field: 'confirm' });
  if (u.role === 'admin' && adminCount() <= 1) return fail(res, 400, 'The last admin cannot be deleted.');
  db.prepare('DELETE FROM users WHERE id = ?').run(u.id);
  audit('admin', `${req.user.name} deleted ${u.name} (${u.email})`, ...actor(req));
  res.json({ ok: true });
});

admin.get('/activity', (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 500);
  res.json({ events: db.prepare('SELECT at, actor, kind, text, ip FROM audit ORDER BY id DESC LIMIT ?').all(limit) });
});

app.use('/api/admin', admin);

// ------------------------------------------------------------ errors
app.use((req, res) => req.originalUrl.startsWith('/api/') ? fail(res, 404, 'Not found.') : res.status(404).type('text').send('Not found.'));
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err.type === 'entity.parse.failed' || err.type === 'entity.too.large') return fail(res, 400, 'Bad request.');
  console.error(new Date().toISOString(), err);
  if (req.originalUrl.startsWith('/api/')) return fail(res, 500, 'Something went wrong on the server. Try again.');
  res.status(500).type('text').send('Something went wrong on the server.');
});

app.listen(config.port, config.host, () => {
  console.log(`Affidavit Filler server on http://${config.host}:${config.port}`);
  if (config.insecureHttp) console.log('WARNING: INSECURE_HTTP=1 — plain http, only for testing on this computer.');
  if (!userCount()) {
    console.log(config.setupToken.length >= 16
      ? 'No admin yet — open /setup and enter the SETUP_TOKEN to create the first admin.'
      : 'No admin yet — set SETUP_TOKEN (at least 16 characters) and restart, then open /setup.');
  }
});
