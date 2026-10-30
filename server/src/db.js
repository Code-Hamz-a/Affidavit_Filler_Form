// SQLite database (Node's built-in driver). Holds users, sessions and the activity log — never patient data.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
const file = path.join(config.dataDir, 'affidavit-filler.db');
export const db = new DatabaseSync(file);
try { fs.chmodSync(file, 0o600); } catch { /* Windows */ }

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  mobile TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
  access TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL CHECK (status IN ('pending', 'active')),
  password_hash TEXT,
  must_change_pw INTEGER NOT NULL DEFAULT 0,
  activation_hash TEXT,
  activation_expires INTEGER,
  activation_tries INTEGER NOT NULL DEFAULT 0,
  totp_required INTEGER NOT NULL DEFAULT 0,
  totp_secret TEXT,
  totp_last_step INTEGER NOT NULL DEFAULT 0,
  backup_codes TEXT NOT NULL DEFAULT '[]',
  failed_count INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_login_at INTEGER,
  last_seen_at INTEGER
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stage TEXT NOT NULL CHECK (stage IN ('full', 'twostep_setup', 'password_change')),
  pending_secret TEXT,
  created_at INTEGER NOT NULL,
  last_active_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  ip TEXT,
  agent TEXT
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  actor TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  ip TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS audit_at ON audit(at);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
`);

export const now = () => Date.now();

// kind: signin | failed | signout | admin | setup | account
export function audit(kind, text, actor = '', ip = '') {
  db.prepare('INSERT INTO audit (at, actor, kind, text, ip) VALUES (?, ?, ?, ?, ?)').run(now(), actor || '', kind, text, ip || '');
}

export const userById = id => db.prepare('SELECT * FROM users WHERE id = ?').get(id);
export const userByEmail = email => db.prepare('SELECT * FROM users WHERE email = ?').get(String(email || '').trim());
export const userCount = () => db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
export const adminCount = () => db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get().n;
export const accessOf = u => u.role === 'admin' ? ['records', 'billing', 'subpoena', 'settings'] : JSON.parse(u.access || '[]');

export function getMeta(key) { const r = db.prepare('SELECT value FROM meta WHERE key = ?').get(key); return r ? r.value : null; }
export function setMeta(key, value) { db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value)); }

// Old sessions and a year-old activity log are removed once an hour.
export function cleanup() {
  db.prepare('DELETE FROM sessions WHERE expires_at < ? OR last_active_at < ?').run(now(), now() - 24 * 3600 * 1000);
  db.prepare('DELETE FROM audit WHERE at < ?').run(now() - 365 * 24 * 3600 * 1000);
}
