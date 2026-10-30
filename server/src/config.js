// Settings come from environment variables (see .env.example). Nothing secret is hard-coded.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const env = process.env;

// The tool itself (Affidavit Filler.html, js/, lib/) lives in the repository root.
export const TOOL_DIR = path.resolve(env.TOOL_DIR || path.join(here, '..', '..'));
export const PUBLIC_DIR = path.resolve(here, '..', 'public');

export const config = {
  port: Number(env.PORT) || 3000,
  // Behind a reverse proxy (Caddy / nginx) the app listens on localhost only.
  host: env.HOST || '127.0.0.1',
  dataDir: path.resolve(env.DATA_DIR || path.join(here, '..', 'data')),
  // One-time token that unlocks /setup until the first admin exists.
  setupToken: env.SETUP_TOKEN || '',
  // 32-byte key (base64) that encrypts two-step secrets in the database. Created in DATA_DIR when not set.
  secretKey: env.SECRET_KEY || '',
  // Only for testing on this computer over plain http. Never in production.
  insecureHttp: env.INSECURE_HTTP === '1',
  // Set when Caddy / nginx sits in front, so the real client IP is used for rate limits and the log.
  trustProxy: env.TRUST_PROXY === '1',
  issuer: env.APP_NAME || 'Affidavit Filler'
};

const MIN = 60 * 1000;
export const POLICY = {
  minPassword: 12,
  maxFailed: 5,            // wrong passwords before the account locks
  lockMs: 15 * MIN,
  idleMs: 30 * MIN,        // signed out after this long without activity
  sessionMs: 12 * 60 * MIN, // and after 12 hours in any case
  codeMs: 24 * 60 * MIN,   // activation codes
  maxCodeTries: 5,         // wrong activation codes before the code is cancelled
  backupCodes: 10
};

// What a user can be given. Admins always have everything.
export const ACCESS = {
  records: 'Records affidavits',
  billing: 'Billing affidavits & invoice merge',
  subpoena: 'Subpoenas / DWQ answers',
  settings: 'Edit facility list & standard answers'
};
