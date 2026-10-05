/* Affidavit Filler — UI. All processing happens locally in the browser. */
(async function () {
  'use strict';
  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];
  const pdfjsLib = window.pdfjsLib;
  await AE.init(window.PDFLib);

  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const val = id => $('#' + id).value.trim();
  const type = () => $('input[name=type]:checked').value;
  const busy = (on, text) => { $('#busy').classList.toggle('on', !!on); if (text) $('#busy-text').textContent = text; };

  // ------------------------------------------------------------ settings
  const SETTINGS_KEY = 'affidavitFiller.settings';
  const SEED_FACILITIES = [
    'Advanced Diagnostics DBA Chopra Imaging', 'Advanced Dallas Hospital & Clinics', 'River Oaks Hospital and Clinics',
    'AD Hospital East', 'Advanced Medical Group', 'City Ambulance Services C/O CareCapital LLC',
    'Advanced Odessa Hospital and Clinics', 'Edward Lee, MD c/o Care Capital', 'Integrity Healthcare Service c/o Care Capital',
    'Advanced Surgeons & Physicians Network', 'Psychiatry of Texas c/o CareCapital', 'Dynamic Anesthesia Providers c/o CareCapital',
    'Texas Medical Rehabilitation and Pain Center c/o CareCapital', 'Fort Bend Neurology c/o CareCapital',
    'M. Radwan Al-Sabbagh, MD., PA c/o Care Capital', 'RMC Pharmacy', "Zippo's Healthcare Services c/o Care Capital",
    'Center For Scoliosis & Advanced Spine Surgery PLLC c/o Care Capital', 'AD Pharmacy', 'Charles Garcia, MD c/o CareCapital'
  ];
  const newProfile = name => ({ name, affName: AE.affidavitName(name), custodian: '', county: '' });
  let settings = {
    custodian: '', title: 'Custodian of Records', county: 'Harris', state: 'Texas', profiles: null,
    // Standard subpoena answers (from the user's own filled Lexitas DWQ)
    address: '1911 Bagby St Houston Tx 77002',
    noInfo: "I don't have that information, I am the custodian of record",
    retention: '7 yrs retention'
  };
  try { Object.assign(settings, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}')); } catch (e) { /* first run */ }
  if (!Array.isArray(settings.profiles)) settings.profiles = SEED_FACILITIES.map(newProfile);
  delete settings.facilities; delete settings.facility; // older versions
  if (!settings.stateLong) { settings.state = AE.stateLong(settings.state) || 'Texas'; settings.stateLong = true; }
  const saveSettings = () => { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) { /* storage blocked */ } };

  const SETTING_FIELDS = {
    's-custodian': 'custodian', 's-title': 'title', 's-county': 'county', 's-state': 'state',
    's-address': 'address', 's-noinfo': 'noInfo', 's-retention': 'retention'
  };
  for (const [id, key] of Object.entries(SETTING_FIELDS)) {
    const el = $('#' + id);
    el.value = settings[key] || '';
    el.addEventListener('input', () => { settings[key] = el.value.trim(); saveSettings(); settingsSummary(); refresh(); });
  }
  function settingsSummary() {
    $('#settings-summary').textContent = `— ${settings.profiles.length} facilities · ` +
      (settings.custodian ? `${settings.custodian}, ${settings.county} County, ${settings.state}` : 'enter the custodian name');
    $('#s-custodian').classList.toggle('missing', !settings.custodian);
    $('#fac-count').textContent = settings.profiles.length;
  }
  function facilityList() {
    $('#facility-list').innerHTML = [...new Set(settings.profiles.flatMap(p => [p.affName, p.name]).filter(Boolean))]
      .map(f => `<option value="${esc(f)}">`).join('');
  }

  // Facility table: name as it appears in requests, name printed on the affidavit, own custodian / county (blank = default).
  function renderProfiles() {
    $('#fac-table tbody').innerHTML = settings.profiles.map((p, i) => `<tr>
      <td><input type="text" data-i="${i}" data-k="name" value="${esc(p.name)}" title="${esc(p.name)}"></td>
      <td><input type="text" data-i="${i}" data-k="affName" value="${esc(p.affName)}"></td>
      <td><input type="text" data-i="${i}" data-k="custodian" value="${esc(p.custodian)}" placeholder="default"></td>
      <td><input type="text" data-i="${i}" data-k="county" value="${esc(p.county)}" placeholder="default" style="width:70px"></td>
      <td><button class="icon" data-del="${i}" title="Remove facility">✕</button></td></tr>`).join('');
    $$('#fac-table input').forEach(inp => inp.addEventListener('input', () => {
      const p = settings.profiles[+inp.dataset.i];
      if (inp.dataset.k === 'name' && p.affName === AE.affidavitName(p.name)) {
        p.affName = AE.affidavitName(inp.value.trim());
        inp.closest('tr').querySelector('[data-k=affName]').value = p.affName;
      }
      p[inp.dataset.k] = inp.value.trim();
      saveSettings(); facilityList(); refresh();
    }));
    $$('#fac-table [data-del]').forEach(b => b.addEventListener('click', () => {
      const p = settings.profiles[+b.dataset.del];
      if (!confirm(`Remove “${p.name}” from your facilities?`)) return;
      settings.profiles.splice(+b.dataset.del, 1);
      saveSettings(); renderProfiles(); facilityList(); settingsSummary(); refresh();
    }));
  }
  function addProfiles(names) {
    let added = 0;
    for (const n of names.map(s => s.trim()).filter(Boolean)) {
      if (settings.profiles.some(p => AE.normName(p.name) === AE.normName(n))) continue;
      settings.profiles.push(newProfile(n)); added++;
    }
    saveSettings(); renderProfiles(); facilityList(); settingsSummary();
    return added;
  }
  $('#fac-add').addEventListener('click', () => {
    settings.profiles.push(newProfile(''));
    renderProfiles(); settingsSummary();
    const inputs = $$('#fac-table [data-k=name]');
    inputs[inputs.length - 1].focus();
  });
  $('#fac-paste-btn').addEventListener('click', () => { const b = $('#fac-paste-box'); b.style.display = b.style.display === 'none' ? '' : 'none'; });
  $('#fac-paste-add').addEventListener('click', () => {
    const n = addProfiles($('#fac-paste').value.split(/\r?\n/));
    $('#fac-paste').value = '';
    $('#fac-paste-box').style.display = 'none';
    alert(`${n} new facilit${n === 1 ? 'y' : 'ies'} added.`);
  });
  // Export / import settings so colleagues get the same facilities and subpoena answers (no patient data inside).
  $('#set-export').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify({ app: 'Affidavit Filler', exported: new Date().toISOString(), settings }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = 'Affidavit Filler settings.json';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  $('#set-import').addEventListener('click', () => $('#set-file').click());
  $('#set-file').addEventListener('change', async () => {
    const file = $('#set-file').files[0];
    $('#set-file').value = '';
    if (!file) return;
    let incoming;
    try { incoming = JSON.parse(await file.text()).settings; } catch (e) { incoming = null; }
    if (!incoming || !Array.isArray(incoming.profiles)) return alert('This is not an Affidavit Filler settings file.');
    const keepMine = settings.custodian && incoming.custodian && settings.custodian !== incoming.custodian &&
      confirm(`Keep your own custodian name “${settings.custodian}”?\n\nOK = keep mine · Cancel = use “${incoming.custodian}”`);
    // Facilities: add the new ones, keep yours. Remembered answers: add theirs, yours win on conflicts.
    const mine = new Set(settings.profiles.map(p => AE.normName(p.name)));
    const added = incoming.profiles.filter(p => p.name && !mine.has(AE.normName(p.name)));
    settings.profiles.push(...added);
    settings.answers = { ...(incoming.answers || {}), ...(settings.answers || {}) };
    for (const k of ['title', 'county', 'state', 'address', 'noInfo', 'retention']) if (incoming[k]) settings[k] = incoming[k];
    if (!keepMine && incoming.custodian) settings.custodian = incoming.custodian;
    saveSettings();
    for (const [id, key] of Object.entries(SETTING_FIELDS)) $('#' + id).value = settings[key] || '';
    renderProfiles(); facilityList(); settingsSummary(); refresh();
    alert(`Settings imported: ${added.length} new facilit${added.length === 1 ? 'y' : 'ies'}, ${Object.keys(incoming.answers || {}).length} remembered answer(s).`);
  });

  const activeProfile = () => { const m = AE.matchFacility(val('f-facility'), settings.profiles); return m ? m.profile : null; };

  renderProfiles(); settingsSummary(); facilityList();
  if (!settings.custodian) $('#settings-box').open = true;

  // ------------------------------------------------------------ state
  let S;
  function resetState() {
    S = { req: null, affPages: new Set(), blanks: [], customs: [], atts: [], manual: {}, sel: null, adding: false, lastUrl: null, nextId: 1 };
  }
  resetState();


  // Fields marked data-auto are filled by the tool until the user types in them.
  $$('[data-auto]').forEach(el => el.addEventListener('input', () => { S.manual[el.id] = true; el.classList.remove('auto'); refresh(); }));
  function setAuto(id, v) {
    const el = $('#' + id);
    if (S.manual[id]) return;
    el.value = v ?? '';
    el.classList.toggle('auto', !!el.value);
  }

  // Normalises typed dates to MM/DD/YYYY (keeps words such as "Present").
  function normDate(id) {
    const el = $('#' + id);
    const d = AE.parseDate(el.value);
    if (d) el.value = AE.fmtDate(d);
  }
  $('#f-dob').addEventListener('input', () => { delete $('#f-dob').dataset.src; $('#dob-src').textContent = ''; });
  ['f-dob', 'f-from', 'f-to'].forEach(id => $('#' + id).addEventListener('change', () => { normDate(id); refresh(); }));

  const today = new Date();
  $('#f-sworn-date').value = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  $('#f-fill-sworn').checked = true;

  // ------------------------------------------------------------ drop zones
  function wireDrop(zoneId, inputId, handler) {
    const zone = $('#' + zoneId), input = $('#' + inputId);
    zone.addEventListener('click', () => input.click());
    input.addEventListener('change', () => { if (input.files.length) handler([...input.files]); input.value = ''; });
    zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('over'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('over'));
    zone.addEventListener('drop', e => { e.preventDefault(); zone.classList.remove('over'); if (e.dataTransfer.files.length) handler([...e.dataTransfer.files]); });
  }
  wireDrop('drop-req', 'in-req', files => loadRequest(files[0]));
  wireDrop('drop-att', 'in-att', files => addAttachments(files));

  // ------------------------------------------------------------ request
  async function loadRequest(file) {
    if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') return alert('Please choose a PDF file for the request.');
    busy(true, 'Reading request…');
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const r = await AE.readPdf(pdfjsLib, bytes, { onProgress: (p, n) => busy(true, `Reading request… page ${p}/${n}`) });
      const ocrCount = await ocrScannedPages(r);
      const info = AE.parseRequest(r.pages);
      const blanks = AE.findBlanks(r.pages);
      if (S.req && S.req.doc) S.req.doc.destroy();
      S.req = { name: file.name, bytes, doc: r.doc, pages: r.pages, info };
      S.manual = {};
      S.customs = [];
      S.affPages = new Set(r.pages.filter(p => AE.isAffidavitPage(p)).map(p => p.num));
      S.blanks = blanks.filter(b => b.pageHasAffidavit && S.affPages.has(b.page)).map(b => ({
        ...b, uid: 'b' + (S.nextId++),
        include: !AE.SKIP_KINDS.has(b.kind) && !b.prefilled,
        autoInclude: true, override: null
      }));

      $$('input[name=type]').forEach(r => { r.checked = r.value === info.type; });
      $('#type-detected').textContent = `(detected: ${info.type})`;

      // Authorization / release form (read only): patient, DOB and the releasing facility.
      const authPages = r.pages.filter(p => !S.affPages.has(p.num));
      const auth = AE.parseAuth(authPages);
      const sameName = (a, b) => {
        const t = s => AE.normName(s).split(' ').filter(w => w.length > 1 && !/^(jr|sr|ii|iii|iv)$/.test(w)).sort().join(' ');
        return t(a) === t(b);
      };
      S.req.authNotes = [];
      if (info.patient && auth.patient && !sameName(info.patient, auth.patient))
        S.req.authNotes.push(`Patient name differs: request says “${info.patient}”, authorization (page ${auth.page}) says “${auth.patient}”.`);
      if (info.dob && auth.dob && info.dob !== auth.dob)
        S.req.authNotes.push(`Date of birth differs: request says ${info.dob}, authorization says ${auth.dob}.`);
      const fromAuth = [!info.patient && auth.patient && 'patient', !info.dob && auth.dob && 'DOB'].filter(Boolean);
      setAuto('f-patient', info.patient || auth.patient || '');
      setAuto('f-dob', info.dob || auth.dob || '');

      // Facility: the name written in the affidavit, then the one the authorization releases from, then the letter.
      const inAffidavit = info.facility && AE.matchFacility(info.facility, settings.profiles);
      const inAuth = (auth.facility && AE.matchFacility(auth.facility, settings.profiles)) ||
        (auth.page && AE.matchFacility(AE.fullText(r.pages.filter(p => p.num === auth.page)), settings.profiles));
      if (!inAffidavit && inAuth) fromAuth.push('facility');
      const m = inAffidavit || inAuth || AE.matchFacility(AE.fullText(r.pages.slice(0, 1)), settings.profiles) || AE.matchFacility(AE.fullText(r.pages), settings.profiles);
      setAuto('f-facility', m ? (m.profile.affName || AE.affidavitName(m.profile.name)) : (info.facility || ''));
      setAuto('f-from', info.reqFrom || '');
      setAuto('f-to', info.reqTo || 'Present');
      $('#from-src').textContent = info.reqFrom ? '(from request)' : '';
      $('#to-src').textContent = '';
      const affBlanks = S.blanks;
      $('#f-standard').checked = affBlanks.length === 0;
      $('#f-keep').value = 'all';
      $('#more-amts').open = !!info.subpoena; // subpoena questions ask for the payment breakdown

      const found = [(info.patient || auth.patient) && 'patient', (info.dob || auth.dob) && 'DOB', info.reqFrom && 'DOS range', (m || info.facility) && 'facility'].filter(Boolean);
      $('#req-info').innerHTML = `<b>${esc(file.name)}</b> · ${r.numPages} page(s) · ${affBlanks.length} affidavit blank(s) found` +
        (info.subpoena ? ' · <span class="badge b-mute">Subpoena / DWQ</span>' : '') +
        (ocrCount ? ` · <span class="badge b-warn" title="Scanned pages were read with OCR — check the values">${ocrCount} scanned page(s) read with OCR</span>` : '') +
        (found.length ? ` · read: ${found.join(', ')}` : '') +
        (fromAuth.length ? ` · <span class="badge b-ok">from authorization (page ${auth.page || '?'}): ${fromAuth.join(', ')}</span>` : '') +
        (affBlanks.length ? '' : `<br><span class="badge b-warn">No fill-in blanks found (scanned or no affidavit) — use “Add text” on the preview or the standard affidavit page.</span>`);
      $('#req-range').textContent = info.reqFrom ? `Requested: ${info.reqFrom} to ${info.reqTo || '?'}${info.doi ? ` · Date of injury ${info.doi}` : ''}` : '';

      analyzeAttachments(true);
      renderBlanksTable();
      await renderPreview();
      refresh();
    } catch (e) {
      console.error(e);
      alert('Could not read this PDF: ' + e.message);
    } finally { busy(false); }
  }

  // Scanned pages (only a picture, no text) are read with the built-in OCR so their blanks can be found.
  async function ocrScannedPages(r) {
    const scanned = r.pages.filter(p => p.items.length < 5);
    if (!scanned.length) return 0;
    for (let k = 0; k < scanned.length; k++) {
      const p = scanned[k];
      busy(true, `Scanned PDF — reading the text (OCR), page ${k + 1} of ${scanned.length}…` + (k === 0 ? ' (first page takes a few seconds longer)' : ''));
      await new Promise(res => setTimeout(res, 30)); // let the message show
      const page = await r.doc.getPage(p.num);
      const vp = page.getViewport({ scale: 2.6 });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(vp.width); canvas.height = Math.ceil(vp.height);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      let words;
      try { words = await window.OCR.readCanvas(canvas); }
      catch (e) { console.error(e); alert('OCR could not read the scanned pages: ' + e.message); return 0; }
      p.items = words.map(wd => {
        const [xa, ya] = vp.convertToPdfPoint(wd.left, wd.lineBottom);
        const [xb, yb] = vp.convertToPdfPoint(wd.left + wd.width, wd.lineTop);
        const lineH = Math.abs(yb - ya);
        return { str: wd.text, x: Math.min(xa, xb), y: Math.min(ya, yb) + lineH * 0.2, w: Math.abs(xb - xa), h: Math.min(Math.max(lineH * 0.8, 6), 16), font: 'ocr' };
      });
      p.ocr = true;
      p._lines = null;
    }
    return scanned.length;
  }

  // ------------------------------------------------------------ attachments
  async function addAttachments(files) {
    busy(true, 'Reading files…');
    try {
      for (const file of files) {
        const ext = (file.name.split('.').pop() || '').toLowerCase();
        const bytes = new Uint8Array(await file.arrayBuffer());
        const att = { id: S.nextId++, name: file.name, bytes, pages: [], pageCount: 1 };
        if (ext === 'pdf' || file.type === 'application/pdf') {
          att.kind = 'pdf';
          try {
            const r = await AE.readPdf(pdfjsLib, bytes, { fonts: false, onProgress: (p, n) => busy(true, `Reading ${file.name}… page ${p}/${n}`) });
            // Drop CareCapital cover letters — only the invoices / records themselves are merged.
            const covers = r.pages.filter(p => AE.isCareCapitalCover(p));
            att.pages = r.pages.filter(p => !covers.includes(p));
            att.keep = att.pages.map(p => p.num - 1);
            att.removed = covers.map(p => p.num);
            att.pageCount = att.pages.length; r.doc.destroy();
            if (!att.pages.length) { alert(`${file.name}: this file is only a CareCapital cover letter — nothing to merge.`); continue; }
          } catch (e) { alert(`Could not read ${file.name}: ${e.message}`); continue; }
        } else if (['jpg', 'jpeg'].includes(ext)) att.kind = 'jpg';
        else if (ext === 'png') att.kind = 'png';
        else { alert(`${file.name}: only PDF, JPG and PNG files can be attached.`); continue; }
        S.atts.push(att);
      }
      analyzeAttachments(false);
      refresh();
    } finally { busy(false); }
  }

  // Splits invoices into claims and parses each one (DOS + totals). Keeps any values typed by the user.
  function analyzeAttachments(recheckOnly) {
    const ctx = { patient: val('f-patient'), dob: val('f-dob') };
    for (const a of S.atts) {
      a.nameOk = a.kind === 'pdf' ? AE.mentionsPatient(a.pages, ctx.patient) : null;
      if (!a.units) {
        const groups = a.kind === 'pdf' ? AE.splitClaims(a.pages) : [[]];
        a.units = groups.map((g, i) => {
          const inv = g.length ? AE.parseInvoice(g, ctx) : { dates: [], notes: ['Image — enter DOS and amount by hand.'] };
          return {
            uid: `${a.id}.${i}`, pages: g.length ? g.map(p => p.num - 1) : null, group: g, inv,
            from: AE.fmtDate(inv.from), to: AE.fmtDate(inv.to), total: inv.total != null ? AE.fmtMoney(inv.total) : ''
          };
        });
      } else if (recheckOnly) {
        // Patient/DOB changed — only redo the name/DOB checks, keep typed DOS and totals.
        for (const u of a.units) {
          if (!u.group || !u.group.length) continue;
          const inv = AE.parseInvoice(u.group, ctx);
          u.inv.nameOk = inv.nameOk; u.inv.dobOk = inv.dobOk;
        }
      }
    }
    renderAttachments();
  }

  function orderedUnits() {
    const units = S.atts.flatMap(a => a.units.map(u => ({ a, u })));
    if (type() === 'billing' && $('#f-sort').checked) {
      units.sort((x, y) => (AE.parseDate(x.u.from) || 8.64e15) - (AE.parseDate(y.u.from) || 8.64e15));
    }
    return units;
  }

  function renderAttachments() {
    const billing = type() === 'billing';
    $('#att-title').textContent = billing ? 'Invoices / itemized bills to attach' : 'Medical records to attach';
    $('#inv-box').style.display = billing && S.atts.length ? '' : 'none';

    $('#att-list').innerHTML = S.atts.map((a, i) => {
      const chk = a.nameOk === true ? '<span class="badge b-ok">name ✓</span>'
        : a.nameOk === false ? '<span class="badge b-err" title="Patient last name not found in this file">name not found</span>'
        : '<span class="badge b-mute" title="Scanned/image — check the patient by eye">no text</span>';
      return `<div class="file">
        <span class="name" title="${esc(a.name)}">${i + 1}. ${esc(a.name)}</span>
        <span class="badge b-mute">${a.pageCount} pg</span>${chk}${a.removed && a.removed.length ? `<span class="badge b-mute" title="CareCapital cover letter (page ${a.removed.join(', ')}) left out">CareCapital page removed</span>` : ''}
        <button class="icon" data-mv="${a.id}" data-d="-1" title="Move up">▲</button>
        <button class="icon" data-mv="${a.id}" data-d="1" title="Move down">▼</button>
        <button class="icon" data-rm="${a.id}" title="Remove">✕</button></div>`;
    }).join('') || '<div class="hint">No files yet.</div>';

    $$('#att-list [data-mv]').forEach(b => b.onclick = () => {
      const i = S.atts.findIndex(a => a.id === +b.dataset.mv), j = i + +b.dataset.d;
      if (j < 0 || j >= S.atts.length) return;
      [S.atts[i], S.atts[j]] = [S.atts[j], S.atts[i]];
      renderAttachments(); refresh();
    });
    $$('#att-list [data-rm]').forEach(b => b.onclick = () => {
      S.atts = S.atts.filter(a => a.id !== +b.dataset.rm);
      renderAttachments(); refresh();
    });

    if (!billing) return;
    const tb = $('#inv-table tbody');
    tb.innerHTML = orderedUnits().map(({ a, u }, i) => {
      const inv = u.inv;
      const badges = [
        inv.format ? `<span class="badge b-mute">${esc(inv.format)}</span>` : '',
        inv.nameOk === false ? '<span class="badge b-err">name ✗</span>' : inv.nameOk ? '<span class="badge b-ok">name ✓</span>' : '',
        inv.dobOk === false ? '<span class="badge b-err">DOB ✗</span>' : inv.dobOk ? '<span class="badge b-ok">DOB ✓</span>' : ''
      ].join(' ');
      const pg = u.pages ? (u.pages.length > 1 ? `p${u.pages[0] + 1}-${u.pages[u.pages.length - 1] + 1}` : `p${u.pages[0] + 1}`) : '';
      const note = (inv.notes || []).join(' ');
      return `<tr data-u="${u.uid}">
        <td>${i + 1}</td>
        <td title="${esc(a.name + (note ? ' — ' + note : ''))}" style="max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(a.name)} <span class="muted">${pg}</span></td>
        <td><input type="text" data-k="from" value="${esc(u.from)}" placeholder="MM/DD/YYYY" style="width:92px"></td>
        <td><input type="text" data-k="to" value="${esc(u.to)}" placeholder="MM/DD/YYYY" style="width:92px"></td>
        <td><input type="text" data-k="total" value="${esc(u.total)}" style="width:82px"></td>
        <td>${badges}${note ? ` <span class="badge b-warn" title="${esc(note)}">!</span>` : ''}</td></tr>`;
    }).join('');
    $$('#inv-table input').forEach(inp => inp.addEventListener('change', () => {
      const uid = inp.closest('tr').dataset.u;
      const u = S.atts.flatMap(a => a.units).find(x => x.uid === uid);
      let v = inp.value.trim();
      if (inp.dataset.k !== 'total') { const d = AE.parseDate(v); if (d) v = AE.fmtDate(d); }
      else if (AE.parseMoney(v) != null) v = AE.fmtMoney(AE.parseMoney(v));
      u[inp.dataset.k] = v; inp.value = v;
      renderAttachments(); refresh();
    }));
  }
  $('#f-sort').addEventListener('change', () => { renderAttachments(); refresh(); });
  $$('input[name=type]').forEach(r => r.addEventListener('change', () => { renderAttachments(); refresh(); }));

  // ------------------------------------------------------------ derived values
  function invoiceSummary() {
    const units = S.atts.flatMap(a => a.units);
    const froms = units.map(u => AE.parseDate(u.from)).filter(Boolean);
    const tos = units.map(u => AE.parseDate(u.to) || AE.parseDate(u.from)).filter(Boolean);
    const totals = units.map(u => AE.parseMoney(u.total));
    return {
      first: froms.length ? new Date(Math.min(...froms)) : null,
      last: tos.length ? new Date(Math.max(...tos)) : null,
      total: totals.some(t => t != null) ? totals.reduce((s, t) => s + (t || 0), 0) : null,
      missingTotal: totals.some(t => t == null)
    };
  }

  function caseData() {
    const prof = activeProfile();
    const sd = $('#f-sworn-date').value ? new Date($('#f-sworn-date').value + 'T12:00:00') : new Date();
    return {
      custodian: (prof && prof.custodian) || settings.custodian, title: settings.title,
      address: settings.address, noInfo: settings.noInfo, retention: settings.retention,
      county: (prof && prof.county) || settings.county, state: settings.state,
      facility: AE.affidavitName(val('f-facility')), patient: val('f-patient'), dob: val('f-dob'),
      dosFrom: val('f-from'), dosTo: val('f-to'),
      pages: val('f-pages') || null,
      total: AE.parseMoney(val('f-total')), writeoff: AE.parseMoney(val('f-writeoff')) || 0,
      paid: AE.parseMoney(val('f-paid')) || 0, balance: AE.parseMoney(val('f-balance')),
      insPaid: AE.parseMoney(val('f-ins-paid')) || 0, medPaid: AE.parseMoney(val('f-med-paid')) || 0,
      ptPaid: AE.parseMoney(val('f-pt-paid')) || 0, adjust: AE.parseMoney(val('f-adjust')) || 0,
      lien: AE.parseMoney(val('f-lien')),
      fillSworn: $('#f-fill-sworn').checked, swornDate: sd
    };
  }

  function blankValue(b) {
    if (b.override != null) return b.override;
    if (b.kind === 'answer') return recallAnswer(b);
    const v = AE.valueFor(b.kind, caseData());
    return b.dwq && /^amt_/.test(b.kind) && v && !b.dollarPrinted ? '$' + v : v;
  }

  // ------------------------------------------------------------ remembered subpoena answers
  // Key = the question with patient and facility names taken out, so the same form question matches next time.
  function answerKey(b) {
    let q = ' ' + AE.normName(b.question || '') + ' ';
    const prof = activeProfile();
    const names = [val('f-facility'), S.req && S.req.info.facility, ...(prof ? AE.facilityAliases(prof.name) : [])]
      .map(AE.normName).filter(Boolean).sort((a, c) => c.length - a.length);
    for (const n of names) q = q.split(' ' + n + ' ').join(' {f} ');
    const pat = AE.normName(val('f-patient'));
    if (pat) q = q.split(' ' + pat + ' ').join(' {p} ');
    return q.replace(/\s+/g, ' ').trim().slice(0, 200);
  }
  const swap = (text, from, to) => from ? text.split(from).join(to) : text;
  function recallAnswer(b) {
    const saved = (settings.answers || {})[answerKey(b)];
    if (!saved) return '';
    return swap(swap(saved, '{patient}', val('f-patient')), '{facility}', val('f-facility'));
  }
  function rememberAnswer(b, value) {
    settings.answers = settings.answers || {};
    let v = value.trim();
    if (val('f-patient')) v = swap(v, val('f-patient'), '{patient}');
    if (val('f-facility')) v = swap(v, val('f-facility'), '{facility}');
    if (v) settings.answers[answerKey(b)] = v; else delete settings.answers[answerKey(b)];
    saveSettings();
  }

  // Recomputes automatic fields, blank values, preview labels and warnings.
  function refresh() {
    const billing = type() === 'billing';
    const recPages = S.atts.reduce((s, a) => s + a.pageCount, 0);
    setAuto('f-pages', S.atts.length ? String(recPages) : '');

    if (billing) {
      const sm = invoiceSummary();
      $('#sum-first').textContent = sm.first ? AE.fmtDate(sm.first) : '—';
      $('#sum-last').textContent = sm.last ? AE.fmtDate(sm.last) : '—';
      $('#sum-total').textContent = sm.total != null ? '$' + AE.fmtMoney(sm.total) : '—';
      if (sm.first) { setAuto('f-from', AE.fmtDate(sm.first)); $('#from-src').textContent = S.manual['f-from'] ? '' : '(first invoice)'; }
      if (sm.last) { setAuto('f-to', AE.fmtDate(sm.last)); $('#to-src').textContent = S.manual['f-to'] ? '' : '(last invoice)'; }
      if (sm.total != null) setAuto('f-total', AE.fmtMoney(sm.total));
      const invDob = S.atts.flatMap(a => a.units).map(u => u.inv.dob).find(Boolean);
      if (invDob && !S.manual['f-dob'] && (!val('f-dob') || $('#f-dob').dataset.src === 'invoice')) {
        $('#f-dob').value = invDob; $('#f-dob').classList.add('auto'); $('#f-dob').dataset.src = 'invoice';
        $('#dob-src').textContent = '(from invoice — confirm)';
      }
      // Paid to date = insurance + Medicare/Medicaid + patient; balance = total - written off - adjustments - paid.
      const m = id => AE.parseMoney(val(id)) || 0;
      setAuto('f-paid', AE.fmtMoney(m('f-ins-paid') + m('f-med-paid') + m('f-pt-paid')));
      const t = AE.parseMoney(val('f-total'));
      if (t != null) setAuto('f-balance', AE.fmtMoney(t - m('f-writeoff') - m('f-adjust') - m('f-paid')));
    } else if (S.req) {
      // Records: DOS comes from the request letter (the user can overwrite it).
      setAuto('f-from', S.req.info.reqFrom || '');
      setAuto('f-to', S.req.info.reqTo || 'Present');
      $('#from-src').textContent = S.req.info.reqFrom && !S.manual['f-from'] ? '(from request)' : '';
      $('#to-src').textContent = '';
    }

    if (S.atts.length) {
      const invPatient = S.atts.flatMap(a => a.units || []).map(u => u.inv && u.inv.patient).find(Boolean);
      if (invPatient && !val('f-patient') && !S.manual['f-patient']) {
        setAuto('f-patient', invPatient); analyzeAttachments(true);
      }
      if (!val('f-facility') && !S.manual['f-facility']) {
        const m = S.atts.map(a => a.pages && a.pages.length ? AE.matchFacility(AE.fullText(a.pages), settings.profiles) : null)
          .filter(Boolean).sort((x, y) => y.score - x.score)[0];
        if (m) setAuto('f-facility', m.profile.affName || AE.affidavitName(m.profile.name));
      }
    }
    setAuto('f-filename', AE.fileName(val('f-patient'), type()));
    const prof = activeProfile(), cd = caseData();
    $('#fac-profile').textContent = !val('f-facility') ? 'Pick the facility from the list (type to search).'
      : prof ? `Facility profile: ${prof.name} · custodian ${cd.custodian || '—'} · ${cd.county} County`
      : 'Not in your facility list — default custodian and county are used.';

    // blank values; a wrong value already written on a DOS/pages/amount blank is corrected automatically
    for (const b of S.blanks) {
      const v = blankValue(b);
      b.wrong = !!(b.prefilled && AE.CORRECTABLE.has(b.kind) && v.trim() && !AE.sameValue(b.kind, b.prefilled, v));
      if (b.prefilled && b.autoInclude) b.include = b.wrong;
      const row = document.querySelector(`#blanks-table tr[data-b="${b.uid}"]`);
      if (!row) continue;
      const inp = row.querySelector('input[type=text]');
      if (b.override == null && document.activeElement !== inp) inp.value = v;
      const cb = row.querySelector('input[type=checkbox]');
      if (cb) cb.checked = b.include;
      const pf = row.querySelector('.pf');
      if (pf) {
        pf.className = 'pf badge ' + (b.wrong ? 'b-err' : 'b-warn');
        pf.textContent = b.wrong ? `has “${b.prefilled}” — wrong${b.include ? ', will correct' : ''}` : `already has “${b.prefilled}”`;
      }
      row.classList.toggle('off', !b.include);
    }
    updateOverlays();
    renderMessages();
  }
  ['f-writeoff', 'f-paid', 'f-ins-paid', 'f-med-paid', 'f-pt-paid', 'f-adjust', 'f-lien'].forEach(id => $('#' + id).addEventListener('input', refresh));
  ['f-sworn-date', 'f-fill-sworn', 'f-keep', 'f-standard'].forEach(id => $('#' + id).addEventListener('change', refresh));
  ['f-patient', 'f-dob'].forEach(id => $('#' + id).addEventListener('change', () => { analyzeAttachments(true); refresh(); }));

  // ------------------------------------------------------------ blanks table
  function renderBlanksTable() {
    const rows = [...S.blanks, ...S.customs].sort((a, b) => a.page - b.page || b.y - a.y || a.x - b.x);
    $('#blanks-empty').style.display = rows.length ? 'none' : '';
    $('#blanks-table').style.display = rows.length ? '' : 'none';
    const kindOpts = sel => Object.entries(AE.KINDS).filter(([k]) => k !== 'custom')
      .map(([k, l]) => `<option value="${k}" ${k === sel ? 'selected' : ''}>${esc(l)}</option>`).join('');
    $('#blanks-table tbody').innerHTML = rows.map(b => {
      const isCustom = b.kind === 'custom';
      const ctx = `…${b.prefix ? b.prefix.slice(-40) : ''} ____ ${b.suffix ? b.suffix.slice(0, 40) : ''}…`;
      return `<tr data-b="${b.uid}" title="${esc(isCustom ? 'Custom text' : ctx)}">
        <td>${b.page}</td>
        <td>${isCustom ? '<span class="muted">Custom text</span>' : `<select data-kind style="max-width:170px">${kindOpts(b.kind)}</select>`}
          ${b.question ? `<div class="q" title="${esc(b.question)}">${esc(b.question.length > 95 ? b.question.slice(0, 95) + '…' : b.question)}</div>` : ''}
          ${b.prefilled ? `<br><span class="pf badge b-warn" title="Something is already written on this blank. Ticked = cover it and write the new value.">already has “${esc(b.prefilled)}”</span>` : ''}</td>
        <td><input type="text" value="${esc(isCustom ? b.override || '' : blankValue(b))}" placeholder="${isCustom ? 'type text' : ''}"></td>
        <td>${isCustom ? `<button class="icon" data-del title="Remove">✕</button>` : `<input type="checkbox" ${b.include ? 'checked' : ''}>`}</td></tr>`;
    }).join('');

    $$('#blanks-table tbody tr').forEach(tr => {
      const b = findBlank(tr.dataset.b);
      const inp = tr.querySelector('input[type=text]');
      inp.addEventListener('input', () => { b.override = inp.value; if (b.kind !== 'custom' && inp.value.trim()) { b.include = true; b.autoInclude = false; } refresh(); });
      inp.addEventListener('focus', () => select(b.uid, false));
      if (b.kind === 'answer') inp.addEventListener('change', () => rememberAnswer(b, inp.value));
      const sel = tr.querySelector('select[data-kind]');
      if (sel) sel.addEventListener('change', () => {
        b.kind = sel.value; b.override = null;
        b.include = !AE.SKIP_KINDS.has(b.kind) && !b.prefilled; b.autoInclude = true;
        renderBlanksTable(); refresh();
      });
      const cb = tr.querySelector('input[type=checkbox]');
      if (cb) cb.addEventListener('change', () => { b.include = cb.checked; b.autoInclude = false; refresh(); });
      const del = tr.querySelector('[data-del]');
      if (del) del.addEventListener('click', () => { S.customs = S.customs.filter(c => c !== b); renderBlanksTable(); renderOverlays(); refresh(); });
    });
  }
  const findBlank = uid => S.blanks.find(b => b.uid === uid) || S.customs.find(b => b.uid === uid);

  function select(uid, focusInput) {
    S.sel = uid;
    $$('#blanks-table tr').forEach(tr => tr.classList.toggle('hl', tr.dataset.b === uid));
    $$('.ov').forEach(o => o.classList.toggle('sel', o.dataset.b === uid));
    const tr = document.querySelector(`#blanks-table tr[data-b="${uid}"]`);
    if (focusInput && tr) { tr.scrollIntoView({ block: 'center', behavior: 'smooth' }); tr.querySelector('input[type=text]').focus(); }
    const ov = document.querySelector(`.ov[data-b="${uid}"]`);
    if (!focusInput && ov) ov.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  // ------------------------------------------------------------ preview
  const pageViews = new Map(); // page num -> { wrap, viewport, scale }
  async function renderPreview() {
    const box = $('#preview');
    pageViews.clear();
    if (!S.req) { box.innerHTML = '<div class="empty-preview">The affidavit page(s) will appear here.</div>'; return; }
    const affPages = [...S.affPages];
    let nums = $('#pv-all').checked || !affPages.length ? S.req.pages.map(p => p.num) : affPages;
    box.innerHTML = '';
    const width = Math.max(420, box.clientWidth || 640);
    for (const n of nums) {
      const page = await S.req.doc.getPage(n);
      const base = page.getViewport({ scale: 1 });
      const scale = width / base.width;
      const vp = page.getViewport({ scale: scale * (window.devicePixelRatio || 1) });
      const cssVp = page.getViewport({ scale });
      const wrap = document.createElement('div');
      wrap.className = 'pagewrap';
      wrap.style.width = cssVp.width + 'px';
      wrap.innerHTML = `<span class="plabel">Page ${n}${S.affPages.has(n) ? '' : ' — not an affidavit page, nothing is written here'}</span>`;
      const canvas = document.createElement('canvas');
      canvas.width = vp.width; canvas.height = vp.height;
      wrap.appendChild(canvas);
      box.appendChild(wrap);
      await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
      pageViews.set(n, { wrap, vp: cssVp });
      wrap.addEventListener('click', e => {
        if (!S.adding || e.target.closest('.ov')) return;
        if (!S.affPages.has(n)) { alert('Only the affidavit page(s) can be edited. Authorization forms and other pages are left exactly as they are.'); return; }
        const r = wrap.getBoundingClientRect();
        const [px, py] = cssVp.convertToPdfPoint(e.clientX - r.left, e.clientY - r.top);
        const c = { uid: 'c' + (S.nextId++), kind: 'custom', page: n, x: px, y: py - 3, w: 220, h: 12, include: true, override: '', pageHasAffidavit: true, prefix: '', suffix: '' };
        S.customs.push(c);
        setAdding(false);
        renderBlanksTable(); renderOverlays(); refresh();
        select(c.uid, true);
      });
    }
    renderOverlays();
  }
  $('#pv-all').addEventListener('change', renderPreview);
  let resizeT;
  window.addEventListener('resize', () => { clearTimeout(resizeT); resizeT = setTimeout(() => S.req && renderPreview(), 300); });

  function setAdding(on) {
    S.adding = on;
    $('#btn-add').classList.toggle('primary', on);
    $('#btn-add').textContent = on ? 'Click on the page…' : 'Add text';
    $$('.pagewrap').forEach(w => w.classList.toggle('adding', on));
  }
  $('#btn-add').addEventListener('click', () => { if (!S.req) return alert('Load a request PDF first.'); setAdding(!S.adding); });

  function renderOverlays() {
    $$('.ov').forEach(o => o.remove());
    for (const b of [...S.blanks, ...S.customs]) {
      const pv = pageViews.get(b.page);
      if (!pv) continue;
      const p1 = pv.vp.convertToViewportPoint(b.x, b.y + b.h * 0.95);
      const p2 = pv.vp.convertToViewportPoint(b.x + b.w, b.y - 2.5);
      const ov = document.createElement('div');
      ov.className = 'ov';
      ov.dataset.b = b.uid;
      ov.dataset.scale = pv.vp.scale;
      Object.assign(ov.style, {
        left: Math.min(p1[0], p2[0]) + 'px', top: Math.min(p1[1], p2[1]) + 'px',
        width: Math.abs(p2[0] - p1[0]) + 'px', height: Math.abs(p2[1] - p1[1]) + 'px',
        fontSize: (Math.min(11, b.h * 0.9) * pv.vp.scale) + 'px'
      });
      ov.addEventListener('click', e => { e.stopPropagation(); select(b.uid, true); });
      pv.wrap.appendChild(ov);
    }
    updateOverlays();
  }
  function updateOverlays() {
    for (const ov of $$('.ov')) {
      const b = findBlank(ov.dataset.b);
      if (!b) continue;
      const v = b.kind === 'custom' ? (b.override || '') : blankValue(b);
      ov.textContent = b.include ? v : '';
      // Same sizing as the PDF: up to 11pt, shrunk (down to 6pt) until the value fits the blank.
      let size = Math.min(11, Math.max(6, b.h * 0.9));
      while (size > 6 && AE.textW(v.trim(), size) > b.w - 2) size -= 0.5;
      ov.style.fontSize = (size * (+ov.dataset.scale || 1)) + 'px';
      ov.className = 'ov ' + (!b.include ? 'skip' : v.trim() ? 'fill' : 'empty') + (S.sel === b.uid ? ' sel' : '');
      ov.title = `${AE.KINDS[b.kind] || b.kind}${v ? ': ' + v : ''}`;
    }
  }

  // ------------------------------------------------------------ validation
  function problems() {
    const errs = [], warns = [];
    const d = caseData();
    const billing = type() === 'billing';
    // No request and no standard page = just merge the uploaded files; only the patient name (file name) is needed.
    const mergeOnly = !S.req && !$('#f-standard').checked;
    const req = mergeOnly ? { 'f-patient': 'Patient name' }
      : { 'f-patient': 'Patient name', 'f-dob': 'Date of birth', 'f-facility': 'Facility', 'f-from': 'DOS from' };
    ['f-dob', 'f-facility', 'f-from'].forEach(id => $('#' + id).classList.remove('missing'));
    for (const [id, label] of Object.entries(req)) {
      const miss = !val(id);
      $('#' + id).classList.toggle('missing', miss);
      if (miss) errs.push({ text: `Enter the ${label}.`, focus: id });
    }
    if (val('f-dob') && !AE.parseDate(val('f-dob'))) errs.push({ text: 'Date of birth is not a valid date (MM/DD/YYYY).', focus: 'f-dob' });
    if (val('f-from') && !AE.parseDate(val('f-from'))) errs.push({ text: 'DOS from is not a valid date (MM/DD/YYYY).', focus: 'f-from' });
    if (!d.custodian && !mergeOnly) errs.push({ text: 'Enter the custodian name in Settings.', focus: 's-custodian' });
    if (S.req && S.req.authNotes) S.req.authNotes.forEach(n => warns.push(n + ' Check that this is the right patient.'));
    if (val('f-facility') && !activeProfile()) warns.push(`“${val('f-facility')}” is not in your facility list — the default custodian is used (it is added to the list when you create the PDF).`);
    if (mergeOnly && !S.atts.length) errs.push({ text: 'Load the request PDF, or add the records / invoices to merge.' });
    else if (mergeOnly) warns.push('No request PDF — the PDF will only contain the merged records / invoices (no affidavit).');
    else if (!S.atts.length) warns.push(`No ${billing ? 'invoices' : 'records'} attached yet — they are merged in after the affidavit.`);

    for (const a of S.atts) {
      if (a.nameOk === false && !(billing && a.units.some(u => u.inv.nameOk != null)))
        warns.push(`“${a.name}”: patient name “${d.patient}” not found in this file — make sure it is the right patient.`);
    }
    if (billing) {
      for (const { a, u } of orderedUnits()) {
        const which = `Invoice ${u.from || ''} (${a.name})`;
        if (u.inv.nameOk === false) warns.push(`${which}: patient name “${d.patient}” not found on the invoice.`);
        if (u.inv.dobOk === false) warns.push(`${which}: date of birth does not match (invoice says ${u.inv.dob}).`);
        if (!u.from) warns.push(`${which}: no DOS — type it in the invoice table.`);
        if (!u.total) warns.push(`${which}: no total — type it in the invoice table.`);
        const rf = S.req && AE.parseDate(S.req.info.reqFrom), uf = AE.parseDate(u.from);
        if (rf && uf && uf < rf) warns.push(`Invoice DOS ${u.from} is before the requested start date ${S.req.info.reqFrom}.`);
      }
      const t = AE.parseMoney(val('f-total')), bal = AE.parseMoney(val('f-balance'));
      if (t != null && bal != null && Math.abs(t - (d.writeoff || 0) - (d.adjust || 0) - (d.paid || 0) - bal) > 0.005)
        warns.push('Amounts do not add up: total − written off − adjustments − paid should equal the balance.');
      const sm = invoiceSummary();
      if (sm.first && AE.parseDate(val('f-from')) && AE.fmtDate(sm.first) !== AE.fmtDate(AE.parseDate(val('f-from'))))
        warns.push(`DOS from (${val('f-from')}) is not the first invoice DOS (${AE.fmtDate(sm.first)}).`);
    }
    const unanswered = S.blanks.filter(b => b.include && b.kind === 'answer' && !blankValue(b).trim());
    if (unanswered.length) warns.push(`${unanswered.length} subpoena question(s) need your answer (red). Your answers are remembered for the next subpoena with the same questions.`);
    const emptyIncluded = S.blanks.filter(b => b.include && b.kind !== 'answer' && !blankValue(b).trim());
    if (emptyIncluded.length) warns.push(`${emptyIncluded.length} blank(s) ticked to fill are still empty (red on the preview).`);
    for (const b of S.blanks.filter(x => x.wrong)) {
      warns.push(b.include
        ? `Page ${b.page} ${AE.KINDS[b.kind]}: affidavit says “${b.prefilled}” — will be corrected to “${blankValue(b)}”.`
        : `Page ${b.page} ${AE.KINDS[b.kind]}: affidavit says “${b.prefilled}” but should be “${blankValue(b)}” (tick Fill to correct).`);
    }
    const unknown = S.blanks.filter(b => b.kind === 'unknown' && !b.include);
    if (unknown.length) warns.push(`${unknown.length} blank(s) not recognised — pick a field for them in step 4 if they need a value.`);
    return { errs, warns };
  }
  // What goes into the final PDF, in order: request pages, standard page, then every record / invoice.
  function outputPlan() {
    const billing = type() === 'billing';
    const keep = $('#f-keep').value;
    let keepPages = null;
    if (S.req && keep === 'affidavit') {
      keepPages = [...S.affPages].sort((a, c) => a - c);
    } else if (S.req && keep === 'none') keepPages = [];
    const attachments = billing
      ? orderedUnits().map(({ a, u }) => ({ bytes: a.bytes, kind: a.kind, pages: u.pages || undefined,
        label: `Invoice ${u.from || '(no DOS)'} — ${a.name}`, count: u.pages ? u.pages.length : 1 }))
      : S.atts.map(a => ({ bytes: a.bytes, kind: a.kind, pages: a.keep, label: a.name, count: a.pageCount }));
    return {
      keepPages, attachments,
      reqPages: S.req ? (keepPages || S.req.pages.map(p => p.num)) : [],
      standard: $('#f-standard').checked, stdAt: S.req && keep === 'all' ? 1 : 0
    };
  }
  function renderMessages() {
    const { errs, warns } = problems();
    $('#msgs').innerHTML = errs.map(e => `<div class="err">${esc(e.text)}</div>`).join('') +
      warns.map(w => `<div class="warn">${esc(w)}</div>`).join('') +
      (!errs.length && !warns.length && (S.req || S.atts.length) ? '<div class="ok">Everything looks good.</div>' : '');
  }

  // ------------------------------------------------------------ generate
  $('#btn-generate').addEventListener('click', async () => {
    const { errs, warns } = problems();
    if (errs.length) {
      renderMessages();
      if (errs[0].focus) { const el = $('#' + errs[0].focus); if (errs[0].focus.startsWith('s-')) $('#settings-box').open = true; el.focus(); el.scrollIntoView({ block: 'center' }); }
      return;
    }
    const serious = warns.filter(w => /not found on|not found in|does not match|before the requested|differs:/.test(w));
    if (serious.length && !confirm('Please check before creating the PDF:\n\n• ' + serious.join('\n• ') + '\n\nCreate the PDF anyway?')) return;

    busy(true, 'Creating PDF…');
    try {
      const d = caseData();
      const billing = type() === 'billing';
      const fills = [...S.blanks.filter(b => b.include), ...S.customs].filter(b => S.affPages.has(b.page)).map(b => ({
        page: b.page, x: b.x, y: b.y, w: b.w, h: b.h, cover: b.prefilled ? b.prefilledBox : null,
        value: b.kind === 'custom' ? (b.override || '') : blankValue(b),
        align: /^(pages|notary_day|notary_year2|notary_year4)$/.test(b.kind) ? 'center' : 'left'
      }));
      const plan = outputPlan();
      const keepPages = plan.keepPages, attachments = plan.attachments;
      const standard = plan.standard ? { type: billing ? 'billing' : 'records', data: d, insertAt: plan.stdAt } : null;

      // white-out annotations on the affidavit pages we write on (see AE.buildPdf)
      const filledPages = new Set(fills.filter(f => (f.value || '').trim()).map(f => f.page));
      const whiteouts = S.req ? S.req.pages.filter(p => filledPages.has(p.num)).flatMap(p => (p.whiteouts || []).map(w => ({ ...w, page: p.num }))) : [];
      const bytes = await AE.buildPdf({ requestBytes: S.req ? S.req.bytes.slice(0) : null, keepPages, fills, attachments, standard, whiteouts });
      let name = val('f-filename') || AE.fileName(d.patient, type());
      if (!/\.pdf$/i.test(name)) name += '.pdf';
      name = name.replace(/[\\/:*?"<>|]+/g, '');
      const blob = new Blob([bytes], { type: 'application/pdf' });
      if (S.lastUrl) URL.revokeObjectURL(S.lastUrl);
      S.lastUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = S.lastUrl; a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      $('#btn-open').disabled = false;
      const outPages = await window.PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true }).then(x => x.getPageCount());
      $('#out-info').textContent = `Saved “${name}” · ${outPages} pages · ${(bytes.length / 1024 / 1024).toFixed(2)} MB`;
      // remember facilities that are not in the list yet
      const fac = val('f-facility');
      if (fac && !activeProfile()) addProfiles([fac]);
    } catch (e) {
      console.error(e);
      alert('Could not create the PDF: ' + e.message);
    } finally { busy(false); }
  });
  $('#btn-open').addEventListener('click', () => { if (S.lastUrl) window.open(S.lastUrl, '_blank'); });

  $('#btn-reset').addEventListener('click', () => {
    if ((S.req || S.atts.length) && !confirm('Clear this request and start a new one?')) return;
    if (S.req && S.req.doc) S.req.doc.destroy();
    if (S.lastUrl) URL.revokeObjectURL(S.lastUrl);
    resetState();
    ['f-patient', 'f-dob', 'f-facility', 'f-from', 'f-to', 'f-pages', 'f-total', 'f-balance', 'f-filename'].forEach(id => { $('#' + id).value = ''; $('#' + id).classList.remove('auto', 'missing'); });
    ['f-writeoff', 'f-paid', 'f-ins-paid', 'f-med-paid', 'f-pt-paid', 'f-adjust'].forEach(id => { $('#' + id).value = '0.00'; });
    $('#f-lien').value = '';
    $('#req-info').innerHTML = ''; $('#req-range').textContent = ''; $('#type-detected').textContent = '';
    $('#from-src').textContent = ''; $('#to-src').textContent = ''; $('#dob-src').textContent = ''; delete $('#f-dob').dataset.src;
    $('#f-standard').checked = false; $('#btn-open').disabled = true; $('#out-info').textContent = '';
    $$('input[name=type]').forEach(r => { r.checked = r.value === 'records'; });
    renderAttachments(); renderBlanksTable(); renderPreview(); refresh();
    setAdding(false);
  });

  renderAttachments();
  refresh();
  const ready = $('#app-ready');
  ready.textContent = '● Ready'; ready.className = 'ok';
})().catch(e => {
  console.error(e);
  const ready = document.getElementById('app-ready');
  if (ready) { ready.textContent = '● Not working'; ready.className = 'bad'; }
  alert('Affidavit Filler failed to start: ' + e.message);
});
