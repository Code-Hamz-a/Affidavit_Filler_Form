# Deploying the Affidavit Filler server

The server adds sign-in, an admin dashboard and per-user access to the Affidavit Filler. **Patient PDFs never reach the server.** They are still read and filled in each user's browser. The server stores only:

- users, with hashed passwords and encrypted two-step secrets
- sessions
- an activity log

## What you need
- A small Linux server (VPS or company server), e.g. 1 CPU / 1 GB RAM, Ubuntu 24.04.
- **Node.js 22.13 or newer.** The server uses Node's built-in SQLite. There is no database server to install.
- A sub-domain, for example `affidavit.company.com`, with a DNS **A record** pointing to the server's IP address.
- Caddy as the web server in front. It gets and renews the HTTPS certificate (Let's Encrypt) automatically.

## 1. Install
```bash
sudo apt install -y git caddy
# Node.js 22 LTS: https://nodejs.org/en/download (or NodeSource / nvm)
sudo useradd --system --create-home --home-dir /opt/affidavit affidavit
sudo -u affidavit git clone https://github.com/Code-Hamz-a/Affidavit_Filler_Form.git /opt/affidavit/app
cd /opt/affidavit/app/server
sudo -u affidavit npm ci --omit=dev
```

## 2. Settings
```bash
sudo -u affidavit cp .env.example .env
sudo -u affidavit chmod 600 .env
sudo -u affidavit nano .env
```
Fill in:
- `SETUP_TOKEN`: a long random string. Make one with `node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"`.
- `SECRET_KEY`: make one with `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`. Keep a copy somewhere safe. Without it, the two-step secrets in a restored backup cannot be read.
- `DATA_DIR=/opt/affidavit/data`
- `TRUST_PROXY=1`
- Leave `HOST=127.0.0.1` and `PORT=3000`.

## 3. Run it as a service
`/etc/systemd/system/affidavit.service`:
```ini
[Unit]
Description=Affidavit Filler
After=network.target

[Service]
User=affidavit
WorkingDirectory=/opt/affidavit/app/server
ExecStart=/usr/bin/node --env-file=.env src/server.js
Restart=on-failure
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/affidavit/data
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```
```bash
sudo mkdir -p /opt/affidavit/data && sudo chown affidavit: /opt/affidavit/data && sudo chmod 700 /opt/affidavit/data
sudo systemctl daemon-reload && sudo systemctl enable --now affidavit
sudo journalctl -u affidavit -f      # should say: "No admin yet — open /setup …"
```

## 4. HTTPS with Caddy
`/etc/caddy/Caddyfile`:
```
affidavit.company.com {
    reverse_proxy 127.0.0.1:3000
    request_body {
        max_size 1MB
    }
}
```
```bash
sudo systemctl reload caddy
```
Open ports 80 and 443 in the firewall, and keep 3000 closed.

## 5. The first admin
1. Give the `SETUP_TOKEN` to the first admin, in person or by phone.
2. The admin opens `https://affidavit.company.com/setup`. They enter the token, their name, mobile, email and a password.
3. They scan the QR code with Google Authenticator or Microsoft Authenticator and save the 10 backup codes.
4. The setup page is now closed for good. You can remove `SETUP_TOKEN` from `.env`.
5. **Add a second admin** from the dashboard right away.

## Adding users
In the admin dashboard, press **Add user**. Choose the role and the tools the user may use. Give them the activation code (valid 24 hours) in person or by phone. They activate at `/activate` and choose their own password. Nobody can sign up without an account made by an admin.

## If every admin is locked out
On the server:
```bash
cd /opt/affidavit/app/server
sudo -u affidavit node --env-file=.env src/cli.js list-admins
sudo -u affidavit node --env-file=.env src/cli.js admin-code admin@company.com
```
This prints a new activation code. The admin's password and two-step are cleared, so they activate again and set up two-step again. Every use is written to the activity log.

## Shared hosting with cPanel (e.g. Spaceship Web Hosting)
Instead of steps 1–4 above, use cPanel's **Setup Node.js App** (CloudLinux + Passenger):
1. Upload the project (without `server/node_modules`, `server/data` and any PDFs) to a folder in the home directory, **not** in `public_html`, e.g. `/home/USER/affidavit`. Create `/home/USER/affidavit-data` for the database.
2. **Setup Node.js App → Create Application**:
   - Node.js version **22.13 or newer**. If the list stops below 22.13, this hosting cannot run the server.
   - Application mode: Production
   - Application root: `affidavit/server`
   - Application URL: the domain or sub-domain
   - Application startup file: `app.cjs`
   - Environment variables: `SETUP_TOKEN`, `SECRET_KEY`, `TRUST_PROXY=1`, `DATA_DIR=/home/USER/affidavit-data`
3. Press **Create**, then **Run NPM Install**, then **Restart**.
4. Make sure the domain has an SSL certificate (cPanel → **SSL/TLS Status** → Run AutoSSL). Sign-in only works over HTTPS.
5. Continue with **5. The first admin** below.

Recovery commands (`src/cli.js`) are run from cPanel → **Terminal**, after entering the app's environment with the command shown at the top of its Setup Node.js App page.

## Updates
```bash
cd /opt/affidavit/app && sudo -u affidavit git pull
cd server && sudo -u affidavit npm ci --omit=dev && sudo systemctl restart affidavit
```

## Backups
Back up `/opt/affidavit/data`, which holds the database and, if `SECRET_KEY` is not set, `secret.key`. Keep `SECRET_KEY` separately.

## Security in short
- **Passwords:**
  - Hashed with scrypt.
  - At least 12 characters, with common passwords refused.
  - 5 wrong tries lock the account for 15 minutes.
  - There is also a rate limit per network.
- **Two-step sign-in:**
  - Uses an authenticator app (TOTP), required for admins.
  - The admin can require it for any user.
  - Each user gets 10 one-time backup codes.
  - A code cannot be reused.
- **Sessions:**
  - The session cookie is HttpOnly, Secure and SameSite=Strict.
  - Users are signed out after 30 minutes idle and after 12 hours in any case.
  - A password reset signs the user out everywhere.
- **Activation:**
  - Activation codes are single-use, expire after 24 hours, and are cancelled after 5 wrong tries.
  - An unknown email and a wrong code give the same message.
- **Web security:**
  - Strict Content-Security-Policy, HSTS, no framing.
  - Write requests must come from the app's own pages (CSRF protection).
- **Logging:** the activity log records sign-ins, failures and every admin action, and is kept for 1 year.
- **Access per user** (records / billing / subpoenas / facility list):
  - It is applied on the tool's screen.
  - The tool runs in the browser, so this decides what a signed-in user is offered. It is not a wall around data on the server, because there is none.
  - Users without an account cannot load the tool at all.
