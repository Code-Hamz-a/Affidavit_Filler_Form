// DocuSign eSignature: sends a finished affidavit to the custodian, then the notary, for electronic signature.
// Signs in with the JWT grant (an RSA key of the DocuSign app). All settings come from environment variables; nothing is stored.
import crypto from 'node:crypto';
import fs from 'node:fs';

const env = process.env;
const ds = {
  integrationKey: env.DOCUSIGN_INTEGRATION_KEY || '',
  userId: env.DOCUSIGN_USER_ID || '',
  accountId: env.DOCUSIGN_ACCOUNT_ID || '',
  // https://demo.docusign.net/restapi for a developer (sandbox) account; the production one is shown on Apps and Keys.
  basePath: (env.DOCUSIGN_BASE_PATH || 'https://demo.docusign.net/restapi').replace(/\/+$/, ''),
  // account-d.docusign.com (sandbox) or account.docusign.com (production)
  oauthHost: (env.DOCUSIGN_OAUTH_HOST || 'account-d.docusign.com').replace(/^https?:\/\//, '').replace(/\/+$/, ''),
  // https unless a test setup names http:// itself
  oauthBase: /^http:\/\//.test(env.DOCUSIGN_OAUTH_HOST || '') ? env.DOCUSIGN_OAUTH_HOST.replace(/\/+$/, '') : '',
  redirectUri: env.DOCUSIGN_REDIRECT_URI || ''
};

function privateKey() {
  if (env.DOCUSIGN_PRIVATE_KEY_FILE) return fs.readFileSync(env.DOCUSIGN_PRIVATE_KEY_FILE, 'utf8');
  return (env.DOCUSIGN_PRIVATE_KEY || '').replace(/\\n/g, '\n');
}

export function docusignConfigured() {
  return !!(ds.integrationKey && ds.userId && ds.accountId && (env.DOCUSIGN_PRIVATE_KEY_FILE || env.DOCUSIGN_PRIVATE_KEY));
}
export const docusignDemo = () => /demo\.docusign\.net|account-d\./.test(ds.basePath + ' ' + ds.oauthHost);

export class DocusignError extends Error {
  constructor(message, extra = {}) { super(message); Object.assign(this, extra); }
}

export function consentUrl(origin) {
  const redirect = ds.redirectUri || (origin ? origin.replace(/\/+$/, '') + '/' : '');
  return `https://${ds.oauthHost}/oauth/auth?response_type=code&scope=${encodeURIComponent('signature impersonation')}` +
    `&client_id=${encodeURIComponent(ds.integrationKey)}&redirect_uri=${encodeURIComponent(redirect)}`;
}

// ------------------------------------------------------------ access token (JWT grant), kept until it is about to expire
let token = { value: '', until: 0 };
const b64url = b => Buffer.from(b).toString('base64url');
async function accessToken(origin) {
  if (token.value && Date.now() < token.until) return token.value;
  const iat = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify({ iss: ds.integrationKey, sub: ds.userId, aud: ds.oauthHost, iat, exp: iat + 3600, scope: 'signature impersonation' }));
  let sig;
  try { sig = crypto.sign('RSA-SHA256', Buffer.from(`${head}.${body}`), privateKey()).toString('base64url'); }
  catch (e) { throw new DocusignError('The DocuSign private key on the server cannot be read. Check DOCUSIGN_PRIVATE_KEY / DOCUSIGN_PRIVATE_KEY_FILE.'); }
  const r = await fetch(`${ds.oauthBase || 'https://' + ds.oauthHost}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${body}.${sig}` })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (j.error === 'consent_required') throw new DocusignError('DocuSign needs a one-time permission for this app.', { consent: consentUrl(origin) });
    throw new DocusignError(`DocuSign sign-in failed (${j.error || r.status}). Check the DocuSign settings on the server.`);
  }
  token = { value: j.access_token, until: Date.now() + Math.max(60, (j.expires_in || 3600) - 300) * 1000 };
  return token.value;
}

// ------------------------------------------------------------ envelope
const num = v => String(Math.max(0, Math.round(Number(v) || 0)));
const cleanText = (s, n = 100) => String(s ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);

/* doc: { pdfBase64, name, subject, custodian: {name, email}, notary: {name, email},
 *        tabs: [{ role: 'custodian'|'notary', type: 'sign'|'text', label, page, x, y, w }] } (x, y from the page's top-left, in points) */
export async function sendEnvelope(doc, origin) {
  const t = await accessToken(origin);
  const tabsFor = role => {
    const mine = (doc.tabs || []).filter(x => x.role === role);
    const signHereTabs = mine.filter(x => x.type === 'sign').map(x => ({ documentId: '1', pageNumber: num(x.page), xPosition: num(x.x), yPosition: num(x.y) }));
    const textTabs = mine.filter(x => x.type === 'text').map((x, i) => ({
      documentId: '1', pageNumber: num(x.page), xPosition: num(x.x), yPosition: num(x.y), width: num(x.w || 80),
      tabLabel: cleanText(x.label || `field_${i + 1}`, 50), required: 'false', font: 'helvetica', fontSize: 'size10'
    }));
    const tabs = {};
    if (signHereTabs.length) tabs.signHereTabs = signHereTabs;
    if (textTabs.length) tabs.textTabs = textTabs;
    return tabs;
  };
  const envelope = {
    emailSubject: cleanText(doc.subject || 'Please sign: affidavit', 100),
    emailBlurb: 'Please review and sign the attached affidavit. The custodian of records signs first, then the notary.',
    documents: [{ documentId: '1', name: cleanText(doc.name || 'Affidavit.pdf', 100), fileExtension: 'pdf', documentBase64: doc.pdfBase64 }],
    recipients: {
      signers: [
        { recipientId: '1', routingOrder: '1', name: cleanText(doc.custodian.name), email: cleanText(doc.custodian.email, 254), roleName: 'Custodian', tabs: tabsFor('custodian') },
        { recipientId: '2', routingOrder: '2', name: cleanText(doc.notary.name), email: cleanText(doc.notary.email, 254), roleName: 'Notary', tabs: tabsFor('notary') }
      ],
      // the person who sent it gets the finished, signed copy by email
      ...(doc.cc && doc.cc.email ? { carbonCopies: [{ recipientId: '3', routingOrder: '3', name: cleanText(doc.cc.name), email: cleanText(doc.cc.email, 254) }] } : {})
    },
    status: 'sent'
  };
  const r = await fetch(`${ds.basePath}/v2.1/accounts/${encodeURIComponent(ds.accountId)}/envelopes`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(envelope)
  });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401) token = { value: '', until: 0 };
  if (!r.ok) throw new DocusignError(`DocuSign did not accept the envelope: ${j.message || j.errorCode || r.status}`);
  return { envelopeId: j.envelopeId, status: j.status };
}
