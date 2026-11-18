/*
 * Itemized Billing page: upload UB-04 / CMS-1500 invoices → CareCapital Billing Summary PDF ("REQ#_CODE_BR_LAST,FIRST.pdf").
 * Everything stays in this browser tab — nothing is uploaded or saved.
 */
(async function () {
  'use strict';
  const $ = s => document.querySelector(s);
  const val = id => ($('#' + id).value || '').trim();
  const S = { files: [], lines: [], mode: 'cpt', manual: new Set(), bytes: null, seq: 0, renderSeq: 0 };
  const FIELDS = ['f-reqid', 'f-patient', 'f-account', 'f-dob', 'f-phone', 'f-guarantor', 'f-address', 'f-facility', 'f-provider', 'f-plan', 'f-doi', 'f-diagnosis', 'f-description'];

  // facility list for the Facility box
  $('#fac-list').innerHTML = (window.FACILITY_DIRECTORY || []).map(f => `<option value="${esc(f[0])}">`).join('');

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function busy(on, msg) { $('#busy').classList.toggle('on', !!on); if (msg) $('#busy-text').textContent = msg; }
  const tick = () => new Promise(r => setTimeout(r, 30));

  // A value read from the invoice goes in only while the user has not typed in that box.
  function setAuto(id, v) {
    if (S.manual.has(id) || !v) return;
    const el = $('#' + id);
    if (el.value.trim() && el.value.trim() !== v && !el.classList.contains('auto')) return;
    el.value = v; el.classList.add('auto');
  }
  for (const id of FIELDS) {
    $('#' + id).addEventListener('input', () => { S.manual.add(id); $('#' + id).classList.remove('auto'); refresh(); });
  }

  // ---------------------------------------------------------------- files
  const drop = $('#drop'), input = $('#in-files');
  drop.addEventListener('click', () => input.click());
  drop.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
  drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('over'); addFiles([...e.dataTransfer.files]); });
  input.addEventListener('change', () => { addFiles([...input.files]); input.value = ''; });

  // Renders a page and reads its words with the built-in OCR (the red / grey claim form is whitened first,
  // so only the typed values are read). Words come back as text items in PDF points.
  async function ocrItems(doc, num) {
    const page = await doc.getPage(num);
    const vp = page.getViewport({ scale: 3.5 });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(vp.width); canvas.height = Math.ceil(vp.height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    const im = ctx.getImageData(0, 0, canvas.width, canvas.height), d = im.data;
    for (let i = 0; i < d.length; i += 4) {
      const v = Math.max(d[i], d[i + 1], d[i + 2]);
      d[i] = d[i + 1] = d[i + 2] = Math.max(0, Math.min(255, (v - 60) * 255 / 90));
    }
    ctx.putImageData(im, 0, 0);
    const words = await window.OCR.readCanvas(canvas);
    return words.map(wd => {
      const [xa, ya] = vp.convertToPdfPoint(wd.left, wd.lineBottom);
      const [xb, yb] = vp.convertToPdfPoint(wd.left + wd.width, wd.lineTop);
      const lineH = Math.abs(yb - ya);
      return { str: wd.text, x: Math.min(xa, xb), y: Math.min(ya, yb) + lineH * 0.2, w: Math.abs(xb - xa), h: Math.min(Math.max(lineH * 0.8, 6), 16), font: 'ocr' };
    });
  }

  async function addFiles(list) {
    const pdfs = list.filter(f => /\.pdf$/i.test(f.name) || f.type === 'application/pdf');
    if (!pdfs.length) { alert('Please choose the invoice as a PDF file.'); return; }
    try {
      for (const file of pdfs) {
        busy(true, `Reading ${file.name}…`); await tick();
        const rec = { id: ++S.seq, name: file.name, format: '', count: 0, ocr: 0, notes: [] };
        S.files.push(rec);
        try {
          const bytes = new Uint8Array(await file.arrayBuffer());
          const r = await AE.readPdf(pdfjsLib, bytes, {});
          // scanned pages, and invoices whose text is a scrambled font, are read with the OCR
          const need = r.pages.filter(p => AE.isScanPage(p) || AE.readableShare([p]) < 0.6);
          for (let k = 0; k < need.length; k++) {
            busy(true, `${file.name}: reading page ${need[k].num} with OCR (${k + 1} of ${need.length})…` + (k === 0 ? ' The first page takes a few seconds longer.' : ''));
            await tick();
            need[k].items = await ocrItems(r.doc, need[k].num);
            need[k]._lines = null; need[k].ocr = true;
          }
          rec.ocr = need.length;
          r.doc.destroy();
          const inv = IB.parseInvoice(r.pages);
          rec.format = inv.format; rec.count = inv.lines.length; rec.notes = inv.notes;
          const sum = Math.round(inv.lines.reduce((s, l) => s + (l.charge || 0), 0) * 100) / 100;
          if (inv.invoiceTotal != null && inv.lines.length && Math.abs(inv.invoiceTotal - sum) > 0.009)
            rec.notes.push(`Lines found add up to $${AE.fmtMoney(sum)}, the invoice total is $${AE.fmtMoney(inv.invoiceTotal)} — check for a missing line.`);
          for (const l of inv.lines) S.lines.push({ id: ++S.seq, file: rec.id, dos: IB.fmtDate(l.dos), proc: IB.procText(l), charge: l.charge != null ? AE.fmtMoney(l.charge) : '', desc: l.desc || '', check: !!l.check });
          const unsure = inv.lines.filter(l => l.check).length;
          if (unsure) rec.notes.push(`${unsure} line${unsure > 1 ? 's' : ''} could not be read clearly (yellow) — check the code and charge against the invoice.`);
          setAuto('f-reqid', AE.requestId(file.name)); setAuto('f-patient', inv.patient); setAuto('f-dob', inv.dob); setAuto('f-account', inv.account);
          setAuto('f-address', inv.address); setAuto('f-phone', inv.phone); setAuto('f-facility', inv.facility);
          setAuto('f-doi', inv.doi);
        } catch (e) {
          console.error(e);
          rec.format = 'error'; rec.notes.push('Could not read this PDF: ' + e.message);
        }
      }
    } finally { busy(false); }
    sortLines();
    renderFiles(); renderLines(); refresh();
  }

  function sortLines() {
    const t = l => { const d = AE.parseDate(l.dos); return d ? d.getTime() : Infinity; };
    S.lines.sort((a, b) => t(a) - t(b));
  }

  function renderFiles() {
    $('#files').innerHTML = S.files.map(f => {
      const fmt = f.format === 'error' ? '<span class="badge b-err">Not read</span>'
        : `<span class="badge ${f.format === 'Other' ? 'b-warn' : 'b-mute'}">${esc(f.format === 'Other' ? 'Not a UB-04 / CMS-1500' : f.format)}</span>`;
      const cnt = f.format === 'error' ? '' : `<span class="badge ${f.count ? 'b-ok' : 'b-err'}">${f.count} line${f.count === 1 ? '' : 's'}</span>`;
      const ocr = f.ocr ? `<span class="badge b-mute" title="Read with OCR — check the values">OCR</span>` : '';
      return `<div class="file"><span class="name" title="${esc(f.name)}">${esc(f.name)}</span>${fmt}${ocr}${cnt}<button class="icon" data-del-file="${f.id}" title="Remove this file and its lines">✕</button></div>`;
    }).join('');
  }
  $('#files').addEventListener('click', e => {
    const b = e.target.closest('[data-del-file]'); if (!b) return;
    const id = +b.dataset.delFile;
    S.files = S.files.filter(f => f.id !== id);
    S.lines = S.lines.filter(l => l.file !== id);
    renderFiles(); renderLines(); refresh();
  });

  // ---------------------------------------------------------------- lines
  function renderLines() {
    const tb = $('#lines');
    if (!S.lines.length) { tb.innerHTML = `<tr><td colspan="6" class="empty-lines">No lines yet — upload an invoice or press “+ Add line”.</td></tr>`; return; }
    tb.innerHTML = S.lines.map((l, i) => `<tr data-id="${l.id}"${l.check ? ' class="check" title="Read with OCR — check this line"' : ''}>
      <td class="num">${i + 1}</td>
      <td><input type="text" data-k="dos" value="${esc(l.dos)}" placeholder="M/D/YYYY" aria-label="Date of service"></td>
      <td><input type="text" data-k="proc" value="${esc(l.proc)}" placeholder="99213" aria-label="Procedure (CPT)"></td>
      <td class="money"><input type="text" data-k="charge" value="${esc(l.charge)}" placeholder="0.00" aria-label="Charge"></td>
      <td class="desc" title="${esc(l.desc)}">${esc(l.desc)}</td>
      <td><button class="icon" data-del="${l.id}" title="Remove this line">✕</button></td></tr>`).join('');
    markLines();
  }
  function markLines() {
    for (const tr of $('#lines').querySelectorAll('tr[data-id]')) {
      const l = S.lines.find(x => x.id === +tr.dataset.id); if (!l) continue;
      tr.querySelector('[data-k=dos]').classList.toggle('missing', !AE.parseDate(l.dos));
      tr.querySelector('[data-k=proc]').classList.toggle('missing', !l.proc.trim());
      tr.querySelector('[data-k=charge]').classList.toggle('missing', AE.parseMoney(l.charge) == null);
    }
  }
  $('#lines').addEventListener('input', e => {
    const k = e.target.dataset.k; if (!k) return;
    const l = S.lines.find(x => x.id === +e.target.closest('tr').dataset.id); if (!l) return;
    l[k] = e.target.value; l.check = false; e.target.closest('tr').classList.remove('check');
    markLines(); refresh();
  });
  $('#lines').addEventListener('change', e => {
    const k = e.target.dataset.k; if (!k) return;
    const l = S.lines.find(x => x.id === +e.target.closest('tr').dataset.id); if (!l) return;
    if (k === 'charge') { const v = AE.parseMoney(l.charge); if (v != null) l.charge = e.target.value = AE.fmtMoney(v); }
    if (k === 'dos') { const d = AE.parseDate(l.dos); if (d) l.dos = e.target.value = IB.fmtDate(d); }
    markLines(); refresh();
  });
  $('#lines').addEventListener('click', e => {
    const b = e.target.closest('[data-del]'); if (!b) return;
    S.lines = S.lines.filter(l => l.id !== +b.dataset.del);
    renderLines(); refresh();
  });
  $('#add-line').addEventListener('click', () => {
    const last = S.lines[S.lines.length - 1];
    S.lines.push({ id: ++S.seq, file: 0, dos: last ? last.dos : '', proc: '', charge: '', desc: '' });
    renderLines(); refresh();
    const ins = $('#lines').querySelectorAll('tr:last-child input');
    (ins[last ? 1 : 0] || ins[0]).focus();
  });

  for (const m of ['cpt', 'date']) $('#mode-' + m).addEventListener('click', () => {
    S.mode = m;
    $('#mode-cpt').classList.toggle('on', m === 'cpt'); $('#mode-date').classList.toggle('on', m === 'date');
    refresh();
  });

  // ---------------------------------------------------------------- output
  function data() {
    const lines = S.lines.map(l => ({ dos: AE.parseDate(l.dos), proc: l.proc.trim(), charge: AE.parseMoney(l.charge) || 0 }));
    const rows = IB.rows(lines, S.mode);
    const dateOrNa = s => { const d = AE.parseDate(s); return d ? IB.fmtDate(d) : s; };
    return {
      patient: val('f-patient'), account: val('f-account'), dob: val('f-dob'), phone: val('f-phone'),
      guarantor: val('f-guarantor') || val('f-patient'), guarantorAddress: val('f-address'),
      facility: val('f-facility'), provider: val('f-provider'), plan: val('f-plan'), doi: dateOrNa(val('f-doi')),
      diagnosis: val('f-diagnosis'), description: val('f-description'), rows
    };
  }

  let timer = null;
  const outName = () => IB.fileName(val('f-patient'), val('f-reqid'), val('f-facility'));

  function refresh() {
    const total = S.lines.reduce((s, l) => s + (AE.parseMoney(l.charge) || 0), 0);
    $('#total').textContent = '$' + AE.fmtMoney(Math.round(total * 100) / 100);
    $('#fname').textContent = outName();
    $('#f-reqid').classList.toggle('missing', !val('f-reqid') && (S.files.length > 0 || S.lines.length > 0));
    $('#f-patient').classList.toggle('missing', !val('f-patient') && (S.files.length > 0 || S.lines.length > 0));
    $('#f-facility').classList.toggle('missing', !val('f-facility') && (S.files.length > 0 || S.lines.length > 0));
    const msgs = [];
    for (const f of S.files) for (const n of f.notes) msgs.push(['warn', `${f.name}: ${n}`]);
    const bad = S.lines.filter(l => !AE.parseDate(l.dos) || !l.proc.trim() || AE.parseMoney(l.charge) == null).length;
    if (bad) msgs.push(['err', `${bad} line${bad > 1 ? 's need' : ' needs'} a date, a CPT code and a charge (red boxes).`]);
    const dates = S.lines.map(l => AE.parseDate(l.dos)).filter(Boolean);
    const dob = AE.parseDate(val('f-dob'));
    if (dob && dates.some(d => d.getTime() === dob.getTime())) msgs.push(['warn', 'A date of service is the same as the DOB — please check.']);
    $('#msgs').innerHTML = msgs.map(([c, t]) => `<div class="${c}">${esc(t)}</div>`).join('');
    clearTimeout(timer);
    timer = setTimeout(renderPreview, 250);
  }

  async function renderPreview() {
    const my = ++S.renderSeq;
    const has = S.lines.length > 0 || val('f-patient');
    if (!has) {
      S.bytes = null; $('#btn-download').disabled = true;
      $('#pages').innerHTML = '<div class="empty-lines">Upload an invoice — the Billing Summary shows here.</div>';
      return;
    }
    try {
      const bytes = await IB.buildPdf(window.PDFLib, data());
      if (my !== S.renderSeq) return;
      S.bytes = bytes;
      $('#btn-download').disabled = false;
      const doc = await pdfjsLib.getDocument({ data: bytes.slice(0), isEvalSupported: false }).promise;
      const canvases = [];
      for (let p = 1; p <= doc.numPages; p++) {
        const page = await doc.getPage(p);
        const vp = page.getViewport({ scale: 2 });
        const c = document.createElement('canvas');
        c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
        await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
        if (my !== S.renderSeq) { doc.destroy(); return; }
        canvases.push(c);
      }
      doc.destroy();
      const box = $('#pages'); box.innerHTML = ''; canvases.forEach(c => box.appendChild(c));
    } catch (e) {
      console.error(e);
      $('#pages').innerHTML = `<div class="empty-lines">Could not draw the PDF: ${esc(e.message)}</div>`;
    }
  }

  $('#btn-download').addEventListener('click', async () => {
    clearTimeout(timer);
    await renderPreview();
    if (!S.bytes) return;
    if (!val('f-patient') && !confirm('The patient name is empty — download anyway?')) return;
    const url = URL.createObjectURL(new Blob([S.bytes], { type: 'application/pdf' }));
    const a = document.createElement('a');
    a.href = url; a.download = outName();
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  });

  $('#btn-reset').addEventListener('click', () => {
    if ((S.lines.length || S.files.length) && !confirm('Clear this invoice and start a new one?')) return;
    S.files = []; S.lines = []; S.manual.clear(); S.bytes = null;
    for (const id of FIELDS) { const el = $('#' + id); el.value = ''; el.classList.remove('auto', 'missing'); }
    renderFiles(); renderLines(); refresh();
  });

  renderLines(); refresh();
  const ready = $('#app-ready'); ready.textContent = '● Ready'; ready.className = 'ok';
})();
