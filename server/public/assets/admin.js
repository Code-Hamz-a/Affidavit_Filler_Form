/* Admin dashboard: users, access, who is online, activity log. All user text goes in with textContent (never innerHTML). */
(function () {
  'use strict';
  const $ = s => document.querySelector(s);
  const MIN = 60000;
  let data = null, filter = 'all', eventLimit = 30, current = null;

  async function api(url, body, method, passive) {
    const headers = { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' };
    if (passive) headers['X-Passive'] = '1';
    const res = await fetch(url, { method: method || (body ? 'POST' : 'GET'), headers, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
    let out = {};
    try { out = await res.json(); } catch (e) { /* empty */ }
    if (res.status === 401) { location.href = '/login?expired=1'; throw new Error('Signed out'); }
    if (!res.ok) { const err = new Error(out.error || 'Something went wrong. Try again.'); err.data = out; throw err; }
    return out;
  }

  // h('span', {class: 'x'}, 'text', child) — builds elements without innerHTML.
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid);
    return el;
  }
  const SVG = {
    edit: 'M4 20h4L19 9l-4-4L4 16z',
    key: 'M11 12l9-9M17 6l3 3|c8,15,4',
    code: 'M4 7h16v10H4zM8 12h.01M12 12h.01M16 12h.01',
    out: 'M9 4H5v16h4M16 8l4 4-4 4M20 12H10',
    unlock: 'M4 11h16v10H4zM8 11V7a4 4 0 0 1 7.5-2',
    phone: 'M8 3h8v18H8zM11 18h2M5 8l-2 2 2 2M19 8l2 2-2 2',
    trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3'
  };
  function icon(name) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('width', '17'); svg.setAttribute('height', '17'); svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round'); svg.setAttribute('aria-hidden', 'true');
    for (const part of SVG[name].split('|')) {
      if (part.startsWith('c')) {
        const [cx, cy, r] = part.slice(1).split(',');
        const c = document.createElementNS(ns, 'circle'); c.setAttribute('cx', cx); c.setAttribute('cy', cy); c.setAttribute('r', r); svg.append(c);
      } else { const p = document.createElementNS(ns, 'path'); p.setAttribute('d', part); svg.append(p); }
    }
    return svg;
  }
  const iconBtn = (name, label, onclick, danger) => h('button', { type: 'button', class: 'btn btn-icon' + (danger ? ' danger' : ''), 'aria-label': label, title: label, onclick }, icon(name));

  const fmtTime = t => new Date(t).toLocaleString([], { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
  const clock = t => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  function ago(t) {
    const m = Math.round((Date.now() - t) / MIN);
    return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : fmtTime(t);
  }
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { t.hidden = true; }, 6000);
  }

  // ---------------------------------------------------------------- status of a user
  function statusOf(u) {
    const now = data.now;
    if (u.lockedUntil) return { cls: 'st-locked', key: 'locked', text: 'Locked', sub: `Too many wrong tries · unlocks ${clock(u.lockedUntil)}` };
    if (u.status === 'pending') {
      const sub = !u.codeExpires ? 'No valid code — make a new one'
        : u.codeExpires < now ? 'Code expired — make a new one'
        : `Code expires in ${Math.max(1, Math.round((u.codeExpires - now) / (60 * MIN)))} h`;
      return { cls: 'st-pending', key: 'pending', text: 'Waiting for activation', sub };
    }
    const extra = [u.mustChange && 'must change password', u.twostepRequired && !u.twostep && 'two-step not set up yet'].filter(Boolean).join(' · ');
    if (u.lastActive) {
      const idle = Math.round((now - u.lastActive) / MIN);
      return { cls: 'st-online', key: 'online', text: 'Online now', sub: (idle < 2 ? 'Active' : `Idle ${idle} min · signed out at ${data.idleMs / MIN}`) + (extra ? ' · ' + extra : '') };
    }
    return { cls: 'st-offline', key: 'offline', text: 'Offline', sub: (u.lastLogin ? `Last sign-in ${fmtTime(u.lastLogin)}` : 'Never signed in') + (extra ? ' · ' + extra : '') };
  }

  // ---------------------------------------------------------------- render
  function render() {
    const users = data.users.map(u => ({ ...u, st: statusOf(u) }));
    const count = k => users.filter(u => u.st.key === k).length;
    const admins = users.filter(u => u.role === 'admin').length;
    $('#one-admin').hidden = admins !== 1;

    $('#stats').replaceChildren(...[
      ['Users', users.length, `${admins} admin${admins === 1 ? '' : 's'} · ${users.length - admins} user${users.length - admins === 1 ? '' : 's'}`, ''],
      ['Online now', count('online'), `Active in the last ${data.idleMs / MIN} min`, 'var(--green)'],
      ['Waiting for activation', count('pending'), 'Created, code not used yet', 'var(--amber)'],
      ['Locked', count('locked'), 'Too many wrong tries', 'var(--red)']
    ].map(([label, v, sub, color]) => h('div', { class: 'stat' },
      h('span', { class: 'small muted' }, label), h('span', { class: 'v', style: color ? `color:${color}` : null }, String(v)), h('span', { class: 'small muted' }, sub))));

    const FILTERS = [['all', 'All', users.length], ['online', 'Online', count('online')], ['pending', 'Waiting', count('pending')], ['locked', 'Locked', count('locked')], ['admin', 'Admins', admins]];
    $('#filters').replaceChildren(...FILTERS.map(([k, label, n]) => h('button', {
      type: 'button', class: 'chip', 'aria-pressed': String(filter === k), onclick: () => { filter = k; render(); }
    }, `${label} (${n})`)));

    const q = $('#search').value.trim().toLowerCase();
    const shown = users.filter(u => (filter === 'all' || (filter === 'admin' ? u.role === 'admin' : u.st.key === filter)) &&
      (!q || [u.name, u.email, u.mobile].some(s => s.toLowerCase().includes(q))));
    $('#empty').hidden = shown.length > 0;
    $('#rows').replaceChildren(...shown.map(u => {
      const initials = u.name.split(/\s+/).filter(Boolean).slice(0, 2).map(p => p[0].toUpperCase()).join('');
      const acts = [iconBtn('edit', `Edit ${u.name}`, () => openUser(u))];
      if (!u.isYou) {
        if (u.status === 'pending') acts.push(iconBtn('code', `New activation code for ${u.name}`, () => newCode(u)));
        acts.push(iconBtn('key', `Reset password for ${u.name}`, () => openReset(u)));
        if (u.lockedUntil) acts.push(iconBtn('unlock', `Unlock ${u.name}`, () => confirmDo(`Unlock ${u.name}?`, 'They can try to sign in again straight away.', `/api/admin/users/${u.id}/unlock`, `${u.name} is unlocked.`)));
        if (u.lastActive) acts.push(iconBtn('out', `Sign ${u.name} out now`, () => confirmDo(`Sign ${u.name} out?`, 'They are signed out on every device and must sign in again.', `/api/admin/users/${u.id}/signout`, `${u.name} was signed out.`)));
        if (u.twostep) acts.push(iconBtn('phone', `Reset two-step for ${u.name}`, () => confirmDo(`Reset two-step sign-in for ${u.name}?`, 'Use this when they lost their phone. Their authenticator app and backup codes stop working; they set it up again at their next sign-in.', `/api/admin/users/${u.id}/reset-twostep`, `Two-step was reset for ${u.name}.`)));
        acts.push(iconBtn('trash', `Delete ${u.name}`, () => openDelete(u), true));
      }
      return h('tr', {},
        h('td', {}, h('div', { class: 'who' }, h('span', { class: 'avatar', 'aria-hidden': 'true' }, initials),
          h('div', {}, h('div', { class: 'name' }, u.name + (u.isYou ? ' (you)' : '')), h('div', { class: 'sub' }, u.email), h('div', { class: 'sub' }, u.mobile)))),
        h('td', {}, h('span', { class: 'role' + (u.role === 'admin' ? ' admin' : '') }, u.role === 'admin' ? 'Admin' : 'User')),
        h('td', {}, h('div', { class: 'tags' }, u.role === 'admin' ? h('span', { class: 'tag' }, 'All tools + users') : u.access.map(k => h('span', { class: 'tag' }, data.access[k] || k)))),
        h('td', {}, h('div', { class: 'status ' + u.st.cls }, h('span', { class: 's' }, u.st.text), h('span', { class: 'sub' }, u.st.sub))),
        h('td', {}, h('div', { class: 'row-actions' }, acts)));
    }));

    const p = data.policy;
    $('#policy').replaceChildren(...[
      ['Self sign-up', 'Off — admins create accounts'],
      ['Password', `${p.minPassword}+ characters, not a common one`],
      ['Wrong-password lock', `${p.maxFailed} tries → ${p.lockMs / MIN} min`],
      ['Idle sign-out', `${p.idleMs / MIN} minutes`],
      ['Longest session', `${p.sessionMs / (60 * MIN)} hours`],
      ['Two-step code', 'Required for admins'],
      ['Activation code expires', `${p.codeMs / (60 * MIN)} hours`]
    ].map(([k, v]) => h('div', { class: 'kv' }, h('span', {}, k), h('b', {}, v))));
  }

  const KIND = { signin: 'Sign-in', failed: 'Failed', signout: 'Sign-out', admin: 'Admin', setup: 'Setup', account: 'Account' };
  async function loadEvents(passive) {
    const { events } = await api(`/api/admin/activity?limit=${eventLimit}`, null, 'GET', passive);
    $('#events').replaceChildren(...(events.length ? events.map(e => h('div', { class: 'ev' },
      h('time', { datetime: new Date(e.at).toISOString(), title: e.ip ? `IP ${e.ip}` : null }, ago(e.at)),
      h('span', { class: 'k k-' + e.kind }, KIND[e.kind] || e.kind),
      h('span', {}, e.text))) : [h('p', { class: 'muted small' }, 'Nothing yet.')]));
    $('#more-events').hidden = events.length < eventLimit || eventLimit >= 500;
  }

  async function load(passive) {
    data = await api('/api/admin/users', null, 'GET', passive);
    render();
    await loadEvents(passive);
  }

  // ---------------------------------------------------------------- dialogs
  document.querySelectorAll('dialog [data-close]').forEach(b => b.addEventListener('click', () => b.closest('dialog').close()));
  function dialogError(id, err) {
    const box = $(id);
    document.querySelectorAll('dialog [aria-invalid]').forEach(el => el.removeAttribute('aria-invalid'));
    if (!err) { box.hidden = true; return; }
    box.textContent = err.message; box.hidden = false;
    const field = err.data && err.data.field;
    const el = field && (document.getElementById('u-' + field) || document.getElementById('r-' + field) || document.getElementById('d-' + field));
    if (el) { el.setAttribute('aria-invalid', 'true'); el.focus(); }
  }
  // Runs a dialog's save; keeps the dialog open and shows the message when the server refuses.
  function onDialogSubmit(form, errBox, run) {
    form.addEventListener('submit', async e => {
      e.preventDefault();
      const btn = form.querySelector('[type=submit]');
      dialogError(errBox, null);
      btn.disabled = true;
      try { await run(); } catch (err) { dialogError(errBox, err); } finally { btn.disabled = false; }
    });
  }

  function showSecret(title, text, label, value, note) {
    $('#s-title').textContent = title;
    $('#s-text').textContent = text;
    $('#s-label').textContent = label;
    $('#s-value').textContent = value;
    $('#s-note').textContent = note;
    $('#s-copy').textContent = 'Copy';
    $('#dlg-secret').showModal();
  }
  $('#s-copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('#s-value').textContent); $('#s-copy').textContent = 'Copied'; } catch (e) { $('#s-copy').textContent = 'Select and copy it'; }
  });

  // add / edit user
  const accessBox = $('#u-access');
  function buildAccess() {
    if (accessBox.querySelector('input')) return;
    for (const [k, label] of Object.entries(data.access)) {
      accessBox.append(h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'u-acc', value: k }), label));
    }
  }
  function syncRole() {
    const admin = document.querySelector('[name=u-role]:checked').value === 'admin';
    accessBox.querySelectorAll('input').forEach(i => { i.disabled = admin; if (admin) i.checked = true; });
    $('#u-2fa-row').hidden = admin;
  }
  document.querySelectorAll('[name=u-role]').forEach(r => r.addEventListener('change', syncRole));
  document.querySelectorAll('[name=u-method]').forEach(r => r.addEventListener('change', () => {
    $('#u-pw-field').hidden = document.querySelector('[name=u-method]:checked').value !== 'password';
  }));

  function openUser(u) {
    current = u || null;
    buildAccess();
    dialogError('#u-error', null);
    $('#u-title').textContent = u ? `Edit ${u.name}` : 'Add user';
    $('#u-sub').textContent = u ? 'The email cannot be changed. To use another email, add a new user.' : 'The user can sign in only after activating with the code you give them.';
    $('#u-name').value = u ? u.name : '';
    $('#u-email').value = u ? u.email : '';
    $('#u-email').readOnly = !!u;
    $('#u-mobile').value = u ? u.mobile : '';
    document.querySelector(`[name=u-role][value=${u && u.role === 'admin' ? 'admin' : 'user'}]`).checked = true;
    accessBox.querySelectorAll('input').forEach(i => { i.checked = u ? u.access.includes(i.value) : i.value === 'records'; });
    $('#u-method').hidden = !!u;
    document.querySelector('[name=u-method][value=code]').checked = true;
    $('#u-pw-field').hidden = true;
    $('#u-password').value = '';
    $('#u-2fa').checked = !!(u && u.twostepRequired);
    $('#u-save').textContent = u ? 'Save changes' : 'Create user';
    syncRole();
    $('#dlg-user').showModal();
    $('#u-name').focus();
  }
  $('#add-user').addEventListener('click', () => openUser(null));
  onDialogSubmit($('#user-form'), '#u-error', async () => {
    const role = document.querySelector('[name=u-role]:checked').value;
    const body = {
      name: $('#u-name').value, mobile: $('#u-mobile').value, role,
      access: [...accessBox.querySelectorAll('input:checked')].map(i => i.value),
      twostepRequired: $('#u-2fa').checked
    };
    if (current) {
      await api(`/api/admin/users/${current.id}`, body, 'PATCH');
      $('#dlg-user').close();
      toast(`${body.name} was updated.`);
    } else {
      body.email = $('#u-email').value;
      body.method = document.querySelector('[name=u-method]:checked').value;
      body.password = body.method === 'password' ? $('#u-password').value : '';
      const r = await api('/api/admin/users', body);
      $('#dlg-user').close();
      if (r.code) {
        showSecret('User created — give them this code', `${body.name} opens ${location.origin}/activate, enters their email and this code, and chooses a password.`,
          'Activation code — shown only now', r.code, `Valid until ${fmtTime(r.codeExpires)}. Give it in person or by phone, not by email together with the link.`);
      } else if (r.password) {
        showSecret('User created — give them this password', `${body.name} signs in at ${location.origin}/login and must choose their own password straight away.`,
          'Temporary password — shown only now', r.password, 'Give it in person or by phone.');
      } else toast(`${body.name} was created with the temporary password you typed.`);
    }
    await load();
  });

  async function newCode(u) {
    try {
      const r = await api(`/api/admin/users/${u.id}/code`, {});
      showSecret(`New activation code for ${u.name}`, `The old code no longer works. ${u.name} opens ${location.origin}/activate.`, 'Activation code — shown only now', r.code, `Valid until ${fmtTime(r.codeExpires)}.`);
      await load();
    } catch (err) { toast(err.message); }
  }

  // reset password
  function openReset(u) {
    current = u;
    dialogError('#r-error', null);
    $('#r-title').textContent = `Reset password — ${u.name}`;
    $('#r-password').value = '';
    $('#r-signout').checked = true;
    $('#dlg-reset').showModal();
  }
  onDialogSubmit($('#reset-form'), '#r-error', async () => {
    const r = await api(`/api/admin/users/${current.id}/password`, { password: $('#r-password').value, signOut: $('#r-signout').checked });
    $('#dlg-reset').close();
    if (r.password) showSecret(`New password for ${current.name}`, `${current.name} signs in with it and must choose their own password straight away.`, 'Temporary password — shown only now', r.password, 'Give it in person or by phone.');
    else toast(`The password for ${current.name} was changed.`);
    await load();
  });

  // delete
  function openDelete(u) {
    current = u;
    dialogError('#d-error', null);
    $('#d-title').textContent = `Delete ${u.name}?`;
    $('#d-email').textContent = u.email;
    $('#d-confirm').value = '';
    $('#d-go').disabled = true;
    $('#dlg-delete').showModal();
    $('#d-confirm').focus();
  }
  $('#d-confirm').addEventListener('input', () => { $('#d-go').disabled = $('#d-confirm').value.trim().toLowerCase() !== current.email.toLowerCase(); });
  onDialogSubmit($('#delete-form'), '#d-error', async () => {
    await api(`/api/admin/users/${current.id}`, { confirm: $('#d-confirm').value }, 'DELETE');
    $('#dlg-delete').close();
    toast(`${current.name} was deleted.`);
    await load();
  });

  // simple confirmations
  let pending = null;
  function confirmDo(title, text, url, done) {
    pending = { url, done };
    dialogError('#c-error', null);
    $('#c-title').textContent = title;
    $('#c-text').textContent = text;
    $('#dlg-confirm').showModal();
  }
  onDialogSubmit($('#confirm-form'), '#c-error', async () => {
    await api(pending.url, {});
    $('#dlg-confirm').close();
    toast(pending.done);
    await load();
  });

  // ---------------------------------------------------------------- page
  $('#search').addEventListener('input', () => data && render());
  $('#more-events').addEventListener('click', () => { eventLimit = 200; loadEvents(); });
  $('#signout').addEventListener('click', async () => {
    try { await api('/api/logout', {}); } catch (e) { /* already out */ }
    location.href = '/login?signedout=1';
  });
  api('/api/me').then(me => { $('#me-name').textContent = me.name; $('#me-email').textContent = me.email; }).catch(() => {});
  load().catch(err => toast(err.message));
  // Refresh who is online every 30 seconds. These calls do not count as activity, so an unattended dashboard still times out.
  setInterval(() => { if (!document.hidden && !document.querySelector('dialog[open]')) load(true).catch(() => {}); }, 30000);
})();
