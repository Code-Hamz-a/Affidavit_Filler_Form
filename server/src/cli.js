// Server commands for when nobody can sign in as admin (lost password and phone).
//   node src/cli.js admin-code <email> [--name "Full Name"] [--mobile "+1 713 555 0100"]
//   node src/cli.js list-admins
// Needs access to the server itself, so it is as safe as the server login. Every use is written to the activity log.
import { POLICY } from './config.js';
import { db, now, audit, userByEmail } from './db.js';
import { newCode, codeHash } from './security.js';

const [cmd, email, ...rest] = process.argv.slice(2);
const opt = name => { const i = rest.indexOf('--' + name); return i >= 0 ? rest[i + 1] : undefined; };

if (cmd === 'list-admins') {
  for (const u of db.prepare("SELECT name, email, status, totp_secret IS NOT NULL AS twostep, locked_until FROM users WHERE role = 'admin'").all()) {
    console.log(`${u.name} <${u.email}> · ${u.status}${u.twostep ? ' · two-step on' : ''}${u.locked_until > now() ? ' · LOCKED' : ''}`);
  }
} else if (cmd === 'admin-code' && email) {
  const code = newCode(), expires = now() + POLICY.codeMs;
  const u = userByEmail(email);
  if (u) {
    if (u.role !== 'admin' && !rest.includes('--make-admin')) {
      console.error(`${u.email} is not an admin. Add --make-admin to make them one.`);
      process.exit(1);
    }
    // Start over: no password, no two-step, a fresh activation code.
    db.prepare(`UPDATE users SET role = 'admin', status = 'pending', password_hash = NULL, must_change_pw = 0, totp_secret = NULL,
      totp_last_step = 0, backup_codes = '[]', failed_count = 0, locked_until = 0, activation_hash = ?, activation_expires = ?,
      activation_tries = 0 WHERE id = ?`).run(codeHash(code), expires, u.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
    audit('setup', `Recovery from the server command line: ${u.name} reset — new activation code issued`, 'server');
  } else {
    const name = opt('name');
    if (!name) { console.error('No user with this email. To create a new admin add --name "Full Name" (and --mobile).'); process.exit(1); }
    db.prepare(`INSERT INTO users (name, email, mobile, role, access, status, activation_hash, activation_expires, totp_required, created_at)
      VALUES (?, ?, ?, 'admin', '[]', 'pending', ?, ?, 1, ?)`).run(name, email.toLowerCase(), opt('mobile') || '', codeHash(code), expires, now());
    audit('setup', `Recovery from the server command line: new admin ${name} created`, 'server');
  }
  console.log(`Activation code for ${email}: ${code}`);
  console.log(`Valid until ${new Date(expires).toLocaleString()}. Open /activate, then sign in and set up two-step again.`);
} else {
  console.log('Usage:\n  node src/cli.js admin-code <email> [--name "Full Name"] [--mobile "+1 ..."] [--make-admin]\n  node src/cli.js list-admins');
  process.exit(cmd ? 1 : 0);
}
