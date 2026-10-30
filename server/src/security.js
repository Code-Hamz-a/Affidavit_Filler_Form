// Passwords, tokens, activation and backup codes, two-step (TOTP) codes, and encryption of TOTP secrets.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { config, POLICY } from './config.js';

const scrypt = promisify(crypto.scrypt);
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 96 * 1024 * 1024 };

// ---------------------------------------------------------------- passwords
export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password.normalize('NFKC'), salt, 32, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPassword(password, stored) {
  const [alg, N, r, p, salt, hash] = String(stored || '').split('$');
  if (alg !== 'scrypt' || !hash) return false;
  const want = Buffer.from(hash, 'base64');
  const got = await scrypt(String(password).normalize('NFKC'), Buffer.from(salt, 'base64'), want.length,
    { N: +N, r: +r, p: +p, maxmem: SCRYPT.maxmem });
  return crypto.timingSafeEqual(want, got);
}

// Same work as a real check, so a wrong email takes as long as a wrong password.
const DUMMY = hashPassword(crypto.randomBytes(12).toString('hex'));
export async function dummyVerify(password) { await verifyPassword(password, await DUMMY); return false; }

const COMMON = new Set(['password', 'password1', 'password123', 'password1234', '123456789012', '1234567890', 'qwertyuiop',
  'qwerty123456', 'iloveyou', 'welcome123', 'welcome1234', 'letmein123', 'admin123456', 'administrator', 'changeme123',
  'abc123456789', 'football123', 'baseball123', 'monkey123456', 'sunshine1234', 'princess1234', 'trustno1234',
  'passw0rd1234', 'p@ssw0rd1234', 'p@ssword1234', 'qwerty1234567', '111111111111', '000000000000', 'aaaaaaaaaaaa',
  'affidavit123', 'affidavitfiller', 'carecapital1', 'riveroaks123', 'houston12345', 'texas1234567']);

// Returns a message when the password is not allowed, '' when it is fine.
export function passwordProblem(password, { email = '', name = '' } = {}) {
  const pw = String(password || '');
  if (pw.length < POLICY.minPassword) return `Use at least ${POLICY.minPassword} characters.`;
  if (pw.length > 200) return 'That password is too long.';
  const low = pw.toLowerCase();
  if (COMMON.has(low) || /^(.)\1+$/.test(pw) || /^(0123456789|1234567890|abcdefghij)/.test(low)) return 'That password is too common. Choose another.';
  const local = String(email).toLowerCase().split('@')[0];
  if (local.length >= 4 && low.includes(local)) return 'The password must not contain your email.';
  for (const part of String(name).toLowerCase().split(/\s+/)) if (part.length >= 4 && low.includes(part)) return 'The password must not contain your name.';
  const kinds = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter(rx => rx.test(pw)).length;
  if (kinds < 3) return 'Mix at least three of: lower case, upper case, numbers, symbols.';
  return '';
}

// ---------------------------------------------------------------- tokens and codes
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const sha256 = s => crypto.createHash('sha256').update(String(s)).digest('hex');

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I
export function newCode() {
  let s = '';
  for (let i = 0; i < 8; i++) s += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return s.slice(0, 4) + '-' + s.slice(4);
}
export const normCode = c => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
export const codeHash = c => sha256('code:' + normCode(c));

export function sameSecret(a, b) {
  const x = Buffer.from(sha256(a)), y = Buffer.from(sha256(b));
  return crypto.timingSafeEqual(x, y);
}

// Temporary password an admin can hand over: 14 characters, all character kinds.
export function newTempPassword() {
  const sets = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnopqrstuvwxyz', '23456789', '!@#$%&*?'];
  const all = sets.join('');
  const chars = sets.map(s => s[crypto.randomInt(s.length)]);
  while (chars.length < 14) chars.push(all[crypto.randomInt(all.length)]);
  for (let i = chars.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [chars[i], chars[j]] = [chars[j], chars[i]]; }
  return chars.join('');
}

// ---------------------------------------------------------------- TOTP (RFC 6238, as used by Google / Microsoft Authenticator)
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
function unbase32(s) {
  let bits = 0, value = 0; const out = [];
  for (const ch of String(s).toUpperCase().replace(/[^A-Z2-7]/g, '')) {
    value = (value << 5) | B32.indexOf(ch); bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
export const newTotpSecret = () => base32(crypto.randomBytes(20));

export function totpAt(secret, step) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac('sha1', unbase32(secret)).update(counter).digest();
  const o = h[h.length - 1] & 15;
  const n = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1e6).padStart(6, '0');
}
// Returns the time step the code belongs to (one step of clock drift either way), or 0.
// A step at or before lastStep was already used, so the same code cannot be replayed.
export function checkTotp(secret, code, lastStep = 0) {
  const c = String(code || '').replace(/\D/g, '');
  if (c.length !== 6) return 0;
  const step = Math.floor(Date.now() / 30000);
  for (const s of [step, step - 1, step + 1]) {
    if (s <= lastStep) continue;
    const want = Buffer.from(totpAt(secret, s)), got = Buffer.from(c);
    if (crypto.timingSafeEqual(want, got)) return s;
  }
  return 0;
}
export const otpauthUrl = (secret, email) =>
  `otpauth://totp/${encodeURIComponent(config.issuer + ':' + email)}?secret=${secret}&issuer=${encodeURIComponent(config.issuer)}&algorithm=SHA1&digits=6&period=30`;

export function newBackupCodes() {
  const codes = Array.from({ length: POLICY.backupCodes }, newCode);
  return { codes, hashes: codes.map(codeHash) };
}

// ---------------------------------------------------------------- encryption of TOTP secrets at rest (AES-256-GCM)
function loadKey() {
  if (config.secretKey) {
    const k = Buffer.from(config.secretKey, 'base64');
    if (k.length !== 32) throw new Error('SECRET_KEY must be 32 bytes, base64 encoded.');
    return k;
  }
  const file = path.join(config.dataDir, 'secret.key');
  if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(32).toString('base64'), { mode: 0o600 });
  return Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'base64');
}
const KEY = loadKey();
export function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const data = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), data.toString('base64')].join(':');
}
export function decrypt(blob) {
  const [v, iv, tag, data] = String(blob || '').split(':');
  if (v !== 'v1') throw new Error('Unknown secret format');
  const d = crypto.createDecipheriv('aes-256-gcm', KEY, Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
}
