/* Sign-in, activation, first-time setup, two-step and password pages. No inline scripts (strict CSP). */
(function () {
  'use strict';
  const $ = s => document.querySelector(s);

  async function api(url, body, method) {
    const res = await fetch(url, {
      method: method || (body ? 'POST' : 'GET'),
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin'
    });
    let data = {};
    try { data = await res.json(); } catch (e) { /* empty body */ }
    if (!res.ok) {
      const err = new Error(data.error || 'Something went wrong. Check your connection and try again.');
      err.status = res.status; err.data = data;
      throw err;
    }
    return data;
  }
  window.AF = { api };

  function showError(msg, field) {
    const box = $('#error');
    document.querySelectorAll('[aria-invalid]').forEach(el => el.removeAttribute('aria-invalid'));
    if (!msg) { box.hidden = true; return; }
    box.textContent = msg; box.hidden = false;
    const el = field && document.getElementById(field);
    if (el) { el.setAttribute('aria-invalid', 'true'); el.focus(); }
  }
  // Disables the button while a request runs; shows the server's message on failure.
  function onSubmit(form, run) {
    form.addEventListener('submit', async e => {
      e.preventDefault();
      const btn = form.querySelector('[type=submit]');
      showError('');
      btn.disabled = true;
      try { await run(); } catch (err) {
        showError(err.message, err.data && err.data.field);
        if (err.data && err.data.next && err.status === 401 && !$('#email')) location.href = err.data.next;
      } finally { btn.disabled = false; }
    });
  }
  const val = id => ($('#' + id) || {}).value || '';
  async function signOut(e) {
    if (e) e.preventDefault();
    try { await api('/api/logout', {}); } catch (err) { /* already signed out */ }
    location.href = '/login?signedout=1';
  }

  // Live password checklist (the server checks the same rules).
  function passwordRules(input, extra) {
    const list = $('#rules');
    if (!list) return;
    const rules = [
      ['At least 12 characters', p => p.length >= 12],
      ['Upper and lower case', p => /[a-z]/.test(p) && /[A-Z]/.test(p)],
      ['A number', p => /\d/.test(p)],
      ['A symbol (! @ # …)', p => /[^A-Za-z0-9]/.test(p)],
      ['Not your email or name', p => {
        const low = p.toLowerCase(), words = extra().filter(w => w.length >= 4);
        return p.length > 0 && !words.some(w => low.includes(w));
      }]
    ];
    const items = rules.map(([text]) => { const li = document.createElement('li'); li.textContent = text; list.appendChild(li); return li; });
    const update = () => rules.forEach(([, ok], i) => items[i].classList.toggle('ok', ok(input.value)));
    input.addEventListener('input', update);
    update();
  }
  const nameWords = () => [val('email').toLowerCase().split('@')[0], ...val('name').toLowerCase().split(/\s+/)];

  const pages = {
    login() {
      const q = new URLSearchParams(location.search), note = $('#note');
      const msg = q.has('activated') ? 'Your account is active. Sign in with your new password.'
        : q.has('expired') ? 'You were signed out after 30 minutes without activity. Sign in again.'
        : q.has('signedout') ? 'You are signed out.' : '';
      if (msg) { note.textContent = msg; note.hidden = false; }
      onSubmit($('#form'), async () => {
        const r = await api('/api/login', { email: val('email'), password: val('password'), code: $('#code-field').hidden ? '' : val('code') })
          .catch(err => { if (err.data && err.data.need === 'code') { $('#code').value = ''; } throw err; });
        if (r.need === 'code') {
          $('#code-field').hidden = false;
          $('#submit').textContent = 'Verify and sign in';
          $('#code').focus();
          return;
        }
        location.href = r.next;
      });
    },

    activate() {
      passwordRules($('#password'), nameWords);
      onSubmit($('#form'), async () => {
        if (val('password') !== val('confirm')) throw Object.assign(new Error('The two passwords are not the same.'), { data: { field: 'confirm' } });
        const r = await api('/api/activate', { email: val('email'), code: val('code'), password: val('password'), confirm: val('confirm') });
        location.href = r.next;
      });
    },

    async setup() {
      const s = await api('/api/setup');
      if (!s.needed) { $('#closed').hidden = false; return; }
      if (!s.tokenConfigured) { $('#notoken').hidden = false; return; }
      $('#open').hidden = false;
      $('#token').focus();
      passwordRules($('#password'), nameWords);
      onSubmit($('#form'), async () => {
        if (val('password') !== val('confirm')) throw Object.assign(new Error('The two passwords are not the same.'), { data: { field: 'confirm' } });
        const r = await api('/api/setup', { token: val('token'), name: val('name'), mobile: val('mobile'), email: val('email'), password: val('password'), confirm: val('confirm') });
        location.href = r.next;
      });
    },

    async twostep() {
      $('#signout').addEventListener('click', signOut);
      let info;
      try { info = await api('/api/twostep'); } catch (err) {
        if (err.status === 401) { location.href = '/login'; return; }
        $('#already-text').textContent = err.message; $('#already').hidden = false; return;
      }
      $('#form').hidden = false;
      $('#qr').src = info.qr;
      $('#secret').textContent = info.secret;
      $('#account').textContent = info.account;
      if (!info.required) $('#step-badge').textContent = 'Recommended';
      $('#code').focus();
      let next = '/';
      onSubmit($('#form'), async () => {
        const r = await api('/api/twostep', { code: val('code') });
        next = r.next;
        const box = $('#codes');
        r.backupCodes.forEach(c => { const s = document.createElement('span'); s.textContent = c; box.appendChild(s); });
        $('#form').hidden = true;
        $('#backup').hidden = false;
        $('#download').addEventListener('click', () => {
          const text = `Affidavit Filler — backup codes for ${info.account}\nEach code works once. Keep them away from your phone.\n\n${r.backupCodes.join('\n')}\n`;
          const a = document.createElement('a');
          a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
          a.download = 'Affidavit Filler backup codes.txt';
          document.body.appendChild(a); a.click(); a.remove();
          setTimeout(() => URL.revokeObjectURL(a.href), 1000);
        });
        $('#print').addEventListener('click', () => window.print());
        $('#saved').addEventListener('change', e => { $('#continue').disabled = !e.target.checked; });
        $('#continue').addEventListener('click', () => { location.href = next; });
      });
    },

    async ['change-password']() {
      $('#signout').addEventListener('click', signOut);
      const s = await api('/api/session').catch(() => null);
      if (!s) { location.href = '/login'; return; }
      if (s.stage === 'full') {
        $('#current-field').hidden = false;
        $('#why').textContent = 'Enter your current password, then choose a new one.';
        const c = $('#cancel'); c.hidden = false; c.href = s.next;
        $('#current').focus();
      }
      passwordRules($('#password'), () => [s.email.toLowerCase().split('@')[0], ...s.name.toLowerCase().split(/\s+/)]);
      onSubmit($('#form'), async () => {
        if (val('password') !== val('confirm')) throw Object.assign(new Error('The two passwords are not the same.'), { data: { field: 'confirm' } });
        const r = await api('/api/password', { current: val('current'), password: val('password'), confirm: val('confirm') });
        location.href = r.next;
      });
    }
  };

  const page = pages[document.body.dataset.page];
  if (page) Promise.resolve(page()).catch(err => { const box = $('#error'); if (box) { box.textContent = err.message; box.hidden = false; } });
})();
