/* Added to the Affidavit Filler when it is served by the server: sign-in bar, per-user access, idle sign-out.
 * The tool itself works in the browser, so these are screen rules; the server makes sure only signed-in users get the tool at all. */
(function () {
  'use strict';
  const $ = s => document.querySelector(s);
  const headers = { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' };
  const post = (url, body) => fetch(url, { method: 'POST', headers, body: JSON.stringify(body || {}), credentials: 'same-origin' });
  let me = null, lastActivity = Date.now();

  async function signOut(idle) {
    try { await post('/api/logout', { idle: !!idle }); } catch (e) { /* offline */ }
    location.href = idle ? '/login?expired=1' : '/login?signedout=1';
  }

  function bar() {
    const el = document.createElement('div');
    el.className = 'af-bar';
    const who = document.createElement('span');
    who.className = 'af-who';
    who.textContent = `Signed in as ${me.name}`;
    el.append(who);
    const links = [];
    if (me.role === 'admin') links.push(['Admin dashboard', '/admin']);
    if (!me.twostep) links.push(['Turn on two-step sign-in', '/twostep']);
    links.push(['Change password', '/change-password']);
    for (const [text, href] of links) {
      const a = document.createElement('a');
      a.href = href; a.textContent = text;
      el.append(a);
    }
    const out = document.createElement('button');
    out.type = 'button'; out.textContent = 'Sign out';
    out.addEventListener('click', () => signOut(false));
    el.append(out);
    document.body.prepend(el);
  }

  const has = k => me.access.includes(k);
  function notice(text) {
    alert(text + '\n\nAsk your admin if you need this.');
  }

  function applyAccess() {
    // Records / billing: only the allowed type can be chosen.
    const radios = [...document.querySelectorAll('input[name=type]')];
    for (const r of radios) {
      const ok = has(r.value === 'billing' ? 'billing' : 'records');
      r.disabled = !ok;
      r.closest('label') && (r.closest('label').title = ok ? '' : 'Not part of your access');
    }
    const checked = radios.find(r => r.checked);
    if (checked && checked.disabled) {
      const other = radios.find(r => !r.disabled);
      if (other) { other.checked = true; other.dispatchEvent(new Event('change', { bubbles: true })); }
    }

    // The PDF cannot be made for a type or a subpoena the user has no access to (the tool may switch type when a request is read).
    document.addEventListener('click', e => {
      if (!e.target.closest('#btn-generate')) return;
      const type = (document.querySelector('input[name=type]:checked') || {}).value;
      const subpoena = /Subpoena \/ DWQ/.test(($('#req-info') || {}).textContent || '');
      let why = '';
      if (type === 'billing' && !has('billing')) why = 'Your account cannot create billing affidavits.';
      else if (type === 'records' && !has('records')) why = 'Your account cannot create records affidavits.';
      else if (subpoena && !has('subpoena')) why = 'This request is a subpoena / deposition on written questions, and your account cannot answer subpoenas.';
      if (why) { e.preventDefault(); e.stopImmediatePropagation(); notice(why); }
    }, true);

    // Facility list and standard answers: read-only without "settings" access.
    if (!has('settings')) {
      const lock = () => {
        for (const id of ['fac-add', 'fac-paste-btn', 'fac-paste-add', 'set-import']) { const b = document.getElementById(id); if (b) b.disabled = true; }
        for (const id of ['s-address', 's-noinfo', 's-retention']) { const i = document.getElementById(id); if (i) i.readOnly = true; }
        document.querySelectorAll('#fac-table input').forEach(i => { i.readOnly = true; });
        document.querySelectorAll('#fac-table [data-del]').forEach(b => { b.disabled = true; });
      };
      lock();
      const table = $('#fac-table');
      if (table) new MutationObserver(lock).observe(table, { childList: true, subtree: true });
      const box = $('#settings-box');
      if (box && !box.querySelector('.af-note')) {
        const n = document.createElement('div');
        n.className = 'af-note';
        n.textContent = 'The facility list and standard answers can only be changed by users with that access.';
        box.querySelector('summary').after(n);
      }
    }
  }

  // Activity keeps the session alive; after 30 minutes without any, the user is signed out.
  function idleWatch() {
    const mark = () => { lastActivity = Date.now(); };
    for (const ev of ['pointerdown', 'keydown', 'wheel', 'touchstart', 'mousemove']) window.addEventListener(ev, mark, { passive: true, capture: true });
    const idleMs = (me.idleMinutes || 30) * 60000;
    setInterval(async () => {
      if (Date.now() - lastActivity >= idleMs) return signOut(true);
      try {
        const r = await post('/api/ping', { active: Date.now() - lastActivity < 60000 });
        if (r.status === 401) location.href = '/login?expired=1';
      } catch (e) { /* offline for a moment */ }
    }, 60000);
  }

  fetch('/api/me', { credentials: 'same-origin' }).then(async r => {
    if (r.status === 401) { location.href = '/login?expired=1'; return; }
    me = await r.json();
    bar();
    applyAccess();
    idleWatch();
  }).catch(() => { /* server unreachable — the page stays as it is */ });
})();
