/* Admin: notary tracking. All text from the server goes in with textContent (never innerHTML). */
(function () {
  'use strict';
  const $ = s => document.querySelector(s);
  const MIN = 60000, HOUR = 60 * MIN, DAY = 24 * HOUR;
  let data = null, range = '30', filter = 'all', selected = null, again = null;

  async function api(url, body, passive) {
    const headers = { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' };
    if (passive) headers['X-Passive'] = '1';
    const res = await fetch(url, { method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
    let out = {};
    try { out = await res.json(); } catch (e) { /* empty */ }
    if (res.status === 401) { location.href = '/login?expired=1'; throw new Error('Signed out'); }
    if (!res.ok) throw new Error(out.error || 'Something went wrong. Try again.');
    return out;
  }
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
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { t.hidden = true; }, 8000);
  }

  const thisYear = new Date().getFullYear();
  const fmt = t => new Date(t).toLocaleString('en-US', { month: 'short', day: 'numeric', ...(new Date(t).getFullYear() !== thisYear ? { year: 'numeric' } : {}), hour: 'numeric', minute: '2-digit' });
  function dur(ms) {
    const m = Math.max(0, Math.round(ms / MIN));
    return m < 60 ? `${m} min` : m < 1440 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`;
  }
  const avg = list => list.length ? dur(list.reduce((a, b) => a + b, 0) / list.length) : '–';
  const LABEL = { cust: 'Waiting for custodian', not: 'Waiting for notary', done: 'Notarized', simple: 'Signed, no notary seal', cancel: 'Cancelled' };
  const ENDED = { voided: 'Cancelled (voided)', declined: 'Declined to sign', deleted: 'Deleted in DocuSign', missing: 'Not found in DocuSign' };
  const KIND = { billing: 'Billing', records: 'Records', subpoena: 'Subpoena / DWQ' };
  const RANGE = { 1: 'today', 7: 'in the last 7 days', 30: 'in the last 30 days', all: 'since the start' };
  const name = r => r.requestId || 'No request ID';
  const isOpen = r => r.state === 'cust' || r.state === 'not';
  const since = r => r.state === 'not' ? r.custSigned : r.sentAt;
  const isLate = r => isOpen(r) && data.now - since(r) > DAY;
  const endOf = r => r.state === 'done' ? r.notaryDone : r.endedAt || r.notaryDone;

  function inRange(r) {
    if (range === 'all') return true;
    if (range === '1') return new Date(r.sentAt).toDateString() === new Date(data.now).toDateString();
    return data.now - r.sentAt <= Number(range) * DAY;
  }
  const base = () => data.rows.filter(inRange);
  function shownRows() {
    const q = $('#search').value.trim().toLowerCase();
    return base().filter(r => (filter === 'all' || (filter === 'late' ? isLate(r) : filter === 'other' ? r.state === 'cancel' || r.state === 'simple' : r.state === filter)) &&
      (!q || [r.requestId, r.sender, r.custodian, r.notary, r.envelopeId].some(s => s.toLowerCase().includes(q))));
  }

  // ---------------------------------------------------------------- render
  function render() {
    // a redraw must not take the keyboard focus away from the button the admin is on
    const focus = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.k : null;
    const rows = base(), n = k => rows.filter(r => r.state === k).length;
    const late = rows.filter(isLate), done = rows.filter(r => r.state === 'done'), open = rows.filter(isOpen);
    const allOpen = data.rows.filter(isOpen).length;
    $('#nav-count').textContent = allOpen; $('#nav-count').hidden = !allOpen;
    $('#nav-count').title = `${allOpen} in progress`;

    $('#ranges').replaceChildren(...[['1', 'Today'], ['7', '7 days'], ['30', '30 days'], ['all', 'All']].map(([k, label]) =>
      h('button', { type: 'button', 'data-k': 'range' + k, 'aria-pressed': String(range === k), onclick: () => { range = k; render(); } }, label)));
    $('#demo').hidden = !data.demo || !data.configured;
    $('#problem').hidden = data.configured && !data.error;
    $('#problem').textContent = !data.configured ? 'DocuSign is not set up on this server, so statuses cannot be read.' : `The last status check had a problem: ${data.error}`;
    $('#late').hidden = !late.length;
    $('#late-n').textContent = `${late.length} ${late.length === 1 ? 'request has' : 'requests have'} been waiting`;
    $('#checked').textContent = data.checking ? 'Checking with DocuSign…'
      : data.checkedAt ? `Checked ${data.now - data.checkedAt < MIN ? 'just now' : dur(data.now - data.checkedAt) + ' ago'} · each request every ${data.pollMinutes} min` : '';

    const when = RANGE[range];
    $('#stats').replaceChildren(...[
      ['Total notarized', done.length, when[0].toUpperCase() + when.slice(1), '', 'total'],
      ['Sent for notary', rows.length, `${open.length} still in progress`],
      ['Waiting for custodian', n('cust'), 'Not signed yet', 'var(--blue-dark)'],
      ['Waiting for notary', n('not'), 'Custodian signed, notary next', 'var(--amber)'],
      ['Average time', avg(done.map(r => r.notaryDone - r.sentAt)), 'From sent to notarized']
    ].map(([label, v, sub, color, cls]) => h('div', { class: 'stat ' + (cls || '') },
      h('span', { class: 'small muted' }, label), h('span', { class: 'v', style: color ? `color:${color}` : null }, String(v)), h('span', { class: 'small muted' }, sub))));

    const CHIPS = [['all', 'All', rows.length], ['cust', LABEL.cust, n('cust')], ['not', LABEL.not, n('not')], ['done', LABEL.done, n('done')],
      ['late', 'Over 24 hours', late.length], ['other', 'Cancelled or no seal', n('cancel') + n('simple')]];
    $('#filters').replaceChildren(...CHIPS.map(([k, label, c]) => h('button', {
      type: 'button', class: 'chip', 'data-k': 'chip' + k, 'aria-pressed': String(filter === k), onclick: () => { filter = k; render(); }
    }, `${label} (${c})`)));

    const shown = shownRows();
    if (!shown.some(r => r.id === selected)) selected = shown.length ? (shown.find(isLate) || shown.find(isOpen) || shown[0]).id : null;
    $('#empty').hidden = shown.length > 0;
    $('#empty').textContent = data.rows.length ? 'No requests match. Clear the search, or pick another status or period.'
      : 'Nothing has been sent for notary yet. Requests appear here as soon as someone sends one from the tool.';
    $('#showing').textContent = `Showing ${shown.length} of ${rows.length} requests sent ${when}`;
    $('#rows').replaceChildren(...shown.map(rowEl));
    renderDetail(shown.find(r => r.id === selected));

    const groups = key => [...new Set(rows.map(r => r[key]))].filter(Boolean).sort((a, b) => a.localeCompare(b));
    const line = (cells, cls) => h('tr', { class: cls }, cells.map(c => h('td', {}, String(c))));
    $('#notaries').replaceChildren(...groups('notary').map(x => {
      const b = rows.filter(r => r.notary === x), f = b.filter(r => r.state === 'done');
      return line([x, f.length, b.filter(r => r.state === 'not').length, avg(f.filter(r => r.custSigned).map(r => r.notaryDone - r.custSigned))]);
    }), line(['Total', done.length, n('not'), ''], 'tot'));
    $('#senders').replaceChildren(...groups('sender').map(x => {
      const b = rows.filter(r => r.sender === x);
      return line([x, b.length, b.filter(r => r.state === 'done').length, b.filter(isOpen).length]);
    }), line(['Total', rows.length, done.length, open.length], 'tot'));

    if (focus) { const el = document.querySelector(`[data-k="${CSS.escape(focus)}"]`); if (el) el.focus({ preventScroll: true }); }
  }

  function timeText(r) {
    if (isOpen(r)) return `Waiting ${dur(data.now - since(r))}`;
    if (r.state === 'cancel') return ENDED[r.endedHow] || 'Cancelled';
    return endOf(r) ? `Took ${dur(endOf(r) - r.sentAt)}` : '';
  }
  function rowEl(r) {
    const dead = r.state === 'cancel';
    const cust = r.custSigned ? ['Signed ' + fmt(r.custSigned), ' ok'] : r.custOpened ? ['Opened, not signed', ''] : ['Not signed yet', ''];
    const not = r.notaryDone ? ['Finished ' + fmt(r.notaryDone), ' ok'] : dead ? ['Not finished', ''] : r.state === 'cust' ? ['After the custodian', '']
      : r.notaryOpened ? ['Opened, not finished', ''] : ['Not finished yet', ''];
    const bars = [dead ? 'r' : 'g', r.custSigned ? 'g' : dead ? '' : 'b', r.notaryDone ? (r.state === 'done' ? 'g' : 'x') : r.state === 'not' ? 'a' : ''];
    const open = () => {
      selected = r.id; render();
      if (matchMedia('(max-width: 1180px)').matches) $('#detail').scrollIntoView({ behavior: 'smooth' });
    };
    return h('tr', { class: r.id === selected ? 'sel' : null },
      h('td', {}, h('button', { type: 'button', class: 'req', 'data-k': 'row' + r.id, 'aria-pressed': String(r.id === selected), onclick: open }, name(r)), h('div', { class: 'sub' }, KIND[r.kind] || '')),
      h('td', {}, h('div', { class: 'strong' }, r.sender), h('div', { class: 'sub' }, fmt(r.sentAt))),
      h('td', {}, h('div', {}, r.custodian || '–'), h('div', { class: 'sub' + cust[1] }, cust[0])),
      h('td', {}, h('div', {}, r.notary || '–'), h('div', { class: 'sub' + not[1] }, not[0])),
      h('td', {}, h('span', { class: 'st st-' + r.state }, LABEL[r.state]),
        h('div', { class: 'bars', 'aria-hidden': 'true' }, bars.map(b => h('span', { class: b || null }))),
        h('div', { class: 'sub' + (isLate(r) ? ' bad' : '') }, timeText(r))));
  }

  function renderDetail(r) {
    const box = $('#detail');
    box.hidden = !r;
    if (!r) return;
    const who = r.state === 'not' ? r.notary : r.custodian;
    const last = r.state === 'simple' ? 'Notary signed (no seal found)' : r.mode === 'simple' ? 'Notary signed' : 'Notary finished (seal and signature)';
    const list = [['Sent for notary', `${r.sender} (from the tool)`, r.sentAt], ['Custodian opened it', r.custodian, r.custOpened], ['Custodian signed', r.custodian, r.custSigned],
      ['Notary opened it', r.notary, r.notaryOpened], [last, r.notary, r.notaryDone]];
    // a step without its own time (DocuSign does not always report "opened") is left out once a later one is known
    let steps = list.filter((s, i) => s[2] || !list.slice(i + 1).some(x => x[2]));
    if (!isOpen(r)) steps = steps.filter(s => s[2]);
    if (r.state === 'cancel') steps.push([ENDED[r.endedHow] || 'Cancelled', r.endedReason, r.endedAt, true]);
    const next = steps.findIndex(s => !s[2]);
    const summary = r.state === 'done' ? `${r.notary} notarized it ${dur(r.notaryDone - r.sentAt)} after it was sent.`
      : r.state === 'simple' ? 'Finished, but no notary seal was found. It is not counted as notarized.'
      : r.state === 'cancel' ? `${ENDED[r.endedHow] || 'Cancelled'} before it was notarized.`
      : `Now with ${who || 'the signer'}, ${r.state === 'not' ? 'the notary' : 'the custodian'}, for ${dur(data.now - since(r))}.`;
    const total = isOpen(r) ? dur(data.now - r.sentAt) + ' so far' : r.state === 'cancel' || !endOf(r) ? '–' : dur(endOf(r) - r.sentAt);
    const kv = (k, v) => h('div', {}, h('dt', {}, k), h('dd', {}, v || '–'));
    const justReminded = r.remindedAt && data.now - r.remindedAt < HOUR;
    box.replaceChildren(
      h('div', { class: 'nt-top' }, h('div', {}, h('h2', {}, name(r)), h('span', { class: 'st st-' + r.state }, LABEL[r.state])), h('p', {}, summary)),
      h('ol', { class: 'steps2', 'aria-label': 'History' }, steps.map((s, i) => h('li', { class: s[3] ? 'is-bad' : s[2] ? 'is-done' : i === next ? 'is-next' : 'is-later' },
        h('div', { class: 'dot', 'aria-hidden': 'true' }, h('i'), h('b')),
        h('div', { class: 'txt' }, h('strong', {}, s[0]), h('span', { class: 'muted' }, s[1] || ''),
          h('span', {}, s[2] ? fmt(s[2]) : i === next && i ? `Waiting ${dur(data.now - steps[i - 1][2])}` : 'Not yet'))))),
      h('dl', { class: 'nt-kv' }, kv('Total time', total), kv('Affidavit', KIND[r.kind]), kv('Sent as', r.mode === 'notary' ? 'DocuSign Notary' : 'Normal signature'),
        kv('Sent by', r.senderEmail), kv('Custodian', r.custodianEmail), kv('Notary', r.notaryEmail), r.remindedAt ? kv('Last reminder', fmt(r.remindedAt)) : null,
        kv('Envelope ID', r.envelopeId), r.checkError ? kv('Last check', r.checkError) : null),
      h('div', { class: 'nt-acts' },
        isOpen(r) ? h('button', { type: 'button', class: 'btn btn-primary', 'data-k': 'remind', disabled: justReminded, onclick: () => askRemind(r) }, justReminded ? 'Reminder sent' : 'Send a reminder') : null,
        h('a', { class: 'btn', 'data-k': 'open', href: `${data.site}/send/documents/details/${encodeURIComponent(r.envelopeId)}`, target: '_blank', rel: 'noopener noreferrer' }, 'Open in DocuSign')));
  }

  // ---------------------------------------------------------------- reminder
  let remindRow = null;
  function askRemind(r) {
    remindRow = r;
    $('#rm-error').hidden = true;
    const now = r.state === 'not' ? `${r.notary}, the notary` : r.mode === 'notary' ? `the custodian ${r.custodian}; DocuSign may email the notary too` : `${r.custodian}, the custodian`;
    $('#rm-text').textContent = `DocuSign emails ${name(r)} again to whoever still has to act on it (now ${now}).`;
    $('#dlg-remind').showModal();
  }
  $('#rm-cancel').addEventListener('click', () => $('#dlg-remind').close());
  $('#remind-form').addEventListener('submit', async e => {
    e.preventDefault();
    $('#rm-go').disabled = true; $('#rm-error').hidden = true;
    try {
      await api(`/api/admin/notary/${remindRow.id}/remind`, {});
      $('#dlg-remind').close();
      toast(`A reminder was sent for ${name(remindRow)}.`);
      await load(true);
    } catch (err) { $('#rm-error').textContent = err.message; $('#rm-error').hidden = false; } finally { $('#rm-go').disabled = false; }
  });

  // ---------------------------------------------------------------- export (a CSV file, opens in Excel)
  $('#export').addEventListener('click', () => {
    if (!data) return;
    const rows = shownRows();
    if (!rows.length) return toast('There is nothing to export in this view.');
    const pad = v => String(v).padStart(2, '0');
    const stamp = t => { if (!t) return ''; const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
    // a cell starting with = + - @ would run as a formula in Excel
    const cell = v => { let s = String(v ?? ''); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return `"${s.replace(/"/g, '""')}"`; };
    const head = ['Request ID', 'Affidavit', 'Status', 'Sent by', 'Sent by email', 'Sent', 'Custodian', 'Custodian opened', 'Custodian signed', 'Notary', 'Notary opened', 'Notary finished', 'Minutes to notarize', 'Sent as', 'Envelope ID'];
    const lines = rows.map(r => [r.requestId, KIND[r.kind] || '', r.state === 'cancel' ? ENDED[r.endedHow] || LABEL.cancel : LABEL[r.state], r.sender, r.senderEmail, stamp(r.sentAt),
      r.custodian, stamp(r.custOpened), stamp(r.custSigned), r.notary, stamp(r.notaryOpened), stamp(r.notaryDone),
      r.state === 'done' ? Math.round((r.notaryDone - r.sentAt) / MIN) : '', r.mode === 'notary' ? 'DocuSign Notary' : 'Normal signature', r.envelopeId]);
    const bom = String.fromCharCode(0xFEFF), eol = String.fromCharCode(13, 10);
    const url = URL.createObjectURL(new Blob([bom + [head, ...lines].map(l => l.map(cell).join(',')).join(eol)], { type: 'text/csv;charset=utf-8' }));
    const a = h('a', { href: url, download: `notary-tracking-${stamp(data.now).slice(0, 10)}.csv` });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  });

  // ---------------------------------------------------------------- page
  async function load(passive) {
    data = await api('/api/admin/notary', null, passive);
    render();
    clearTimeout(again);
    if (data.checking) again = setTimeout(() => load(true).catch(() => {}), 4000); // show the answers as soon as DocuSign has given them
  }
  $('#search').addEventListener('input', () => data && render());
  $('#late-show').addEventListener('click', () => { filter = 'late'; $('#search').value = ''; render(); });
  $('#signout').addEventListener('click', async () => {
    try { await api('/api/logout', {}); } catch (e) { /* already out */ }
    location.href = '/login?signedout=1';
  });
  api('/api/me').then(me => { $('#me-name').textContent = me.name; $('#me-email').textContent = me.email; }).catch(() => {});
  load().catch(err => toast(err.message));
  // These calls do not count as activity, so an unattended dashboard still times out.
  setInterval(() => { if (!document.hidden && !document.querySelector('dialog[open]')) load(true).catch(() => {}); }, 30000);
})();
