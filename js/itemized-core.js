/*
 * Itemized Billing (CareCapital) — reads the service lines of a UB-04 or CMS-1500 invoice and draws the
 * CareCapital "Billing Summary" page. Runs fully offline (browser or Node). Uses the Affidavit engine (AE)
 * for PDF text lines, dates and money.
 *
 *  IB.parseInvoice(pages)  → { format, patient, dob, account, address, phone, facility, doi, lines: [...] }
 *  IB.rows(lines, mode)    → table rows ('cpt' = one line per CPT, 'date' = one line per date of service)
 *  IB.buildPdf(PDFLib, d)  → Uint8Array of the Billing Summary PDF
 */
(function (root) {
  'use strict';
  const AE = root.AE || (typeof require === 'function' ? require('./engine.js') : null);
  const IB = {};

  // ------------------------------------------------------------ tokens
  // A line's items split into words, each with its own x (so "CUEVAS, JULIO" in one item is two words).
  function tokens(line) {
    const out = [];
    for (const it of line.items) {
      const s = it.str, n = s.length || 1;
      const rx = /\S+/g; let m;
      while ((m = rx.exec(s))) out.push({ s: m[0], x: it.x + it.w * m.index / n, x2: it.x + it.w * (m.index + m[0].length) / n });
    }
    return out;
  }

  const DATE1 = /^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2}|\d{4})$/;
  // A date at toks[i]: "02/11/2026", "021126" (UB-04), "02112026", or "02 11 26" in three boxes (CMS-1500)
  function dateAt(t, i) {
    const s = t[i] && t[i].s;
    if (!s) return null;
    let d;
    if (DATE1.test(s) || /^\d{6}$/.test(s) || /^\d{8}$/.test(s)) { d = AE.parseDate(s); if (d) return { i, n: 1, d }; }
    if (/^\d{2}$/.test(s) && t[i + 2] && /^\d{2}$/.test(t[i + 1].s) && /^(\d{2}|\d{4})$/.test(t[i + 2].s)) {
      d = AE.parseDate(`${s}/${t[i + 1].s}/${t[i + 2].s}`);
      if (d) return { i, n: 3, d };
    }
    return null;
  }
  function firstDate(t, from) {
    for (let i = from || 0; i < t.length; i++) { const d = dateAt(t, i); if (d) return d; }
    return null;
  }
  // CPT / HCPCS: 99204, G0463, 0275T — with modifiers glued on ("9920595", "99205-95") or as their own words.
  const CODE = /^([A-Z]\d{4}|\d{4}[A-Z]|\d{5})(?:-?([A-Z0-9]{2}))?(?:-?([A-Z0-9]{2}))?$/;
  function code(s) {
    if (!s) return null;
    s = s.replace(/[.,;:]$/, '');
    if (/^[A-Z][0-9O]{4}/.test(s)) s = s[0] + s.slice(1, 5).replace(/O/g, '0') + s.slice(5); // OCR: "GO463"
    const m = s.match(CODE);
    if (!m) return null;
    return { code: m[1], mods: [m[2], m[3]].filter(Boolean) };
  }
  const MOD = /^[A-Z0-9]{2}$/;
  const INT = /^\d[\d,]*$/;
  const DEC = /^\(?-?\$?-?\d[\d,]*\.\d{2}\)?$/;
  // The charge at or after toks[k]: "1,100.00", "$525.00", or dollars and cents in two boxes ("1100 00").
  // The first plain number of a UB-04 line is the units ("1 43 66" = 1 unit, $43.66).
  function moneyFrom(t, k, unitsFirst) {
    for (let pass = unitsFirst ? 0 : 1; pass < 2; pass++) {
      let i = k, units = null;
      if (pass === 0) {
        if (t[i] && /^\d{1,3}$/.test(t[i].s) && t.slice(i + 1).some(x => INT.test(x.s) || DEC.test(x.s))) { units = +t[i].s; i++; } else continue;
      }
      for (; i < t.length; i++) {
        const s = t[i].s;
        if (DEC.test(s)) {
          if (/-|\(/.test(s)) return { neg: true };
          return { v: AE.parseMoney(s.replace(/[()]/g, '')), units, end: i + 1 };
        }
        if (INT.test(s) && t[i + 1] && /^\d{2}$/.test(t[i + 1].s)) return { v: AE.parseMoney(s) + (+t[i + 1].s) / 100, units, end: i + 2 };
        if (INT.test(s) && pass === 1 && i === k && !t[i + 1]) return { v: AE.parseMoney(s), units, end: i + 1 }; // "1250" alone at line end
      }
    }
    return null;
  }

  // One service line → { dos, code, mods, rev, desc, units, charge } or null
  function serviceLine(line, W) {
    const t = tokens(line);
    if (!t.length) return null;
    const text = t.map(x => x.s).join(' ');
    if (/^(\d{1,2}\s+)?0001\b/.test(text) || /\bTOTALS?\b|\bPAGE\s+\d+\s+OF\b|BALANCE|PAYMENT|ADJUSTMENT|\bPAID\b/i.test(text)) return null;
    const d = firstDate(t, 0);
    if (!d) return null;
    let start = 0;
    if (t[0] && /^\d{1,2}$/.test(t[0].s) && d.i > 0) start = 1; // printed row number "3 0460 …"
    const before = t.slice(start, d.i);
    let res = null;
    if (!before.length || before.every(x => /^\d{1,2}$/.test(x.s))) {
      // CMS-1500 box 24: from, (to), place of service, (EMG), CPT, modifiers, pointer, charge, units
      let k = d.i + d.n;
      const d2 = dateAt(t, k); if (d2) k += d2.n;
      let c = null;
      for (let j = k; j < Math.min(t.length, k + 4); j++) { c = code(t[j].s); if (c && !/^\d{2}$/.test(t[j].s)) { k = j + 1; break; } c = null; }
      if (!c) {
        // From and to dates are there but the code is unreadable (OCR) — keep the line so it can be fixed by hand
        if (!d2) return null;
        if (t[k] && /^\d{2}$/.test(t[k].s)) k++; // place of service
        const raw = t[k] ? t[k].s : '';
        const m = moneyFrom(t, k + 1, false);
        return { dos: d.d, code: raw, mods: [], rev: '', desc: '', units: null, charge: m && !m.neg ? m.v : null, check: true };
      }
      while (t[k] && MOD.test(t[k].s) && c.mods.length < 4 && !(/^\d{2}$/.test(t[k].s) && t[k + 1] && !/^[A-Z0-9]{1,4}$/.test(t[k + 1].s))) {
        // a two-digit word right before the cents is not a modifier ("… A 43 66 1")
        if (/^\d{2}$/.test(t[k].s) && t[k + 1] && /^\d{2}$/.test(t[k + 1].s) && !(t[k + 2] && /^\d{2}$/.test(t[k + 2].s))) break;
        if (/^[A-L]{1,4}$/.test(t[k].s) && c.mods.length) break;
        c.mods.push(t[k].s); k++;
      }
      if (t[k] && /^([A-L]{1,4}|[1-4]{1,4})$/.test(t[k].s)) k++; // diagnosis pointer
      const m = moneyFrom(t, k, false);
      if (!m || m.neg || !(m.v > 0)) return null;
      res = { dos: d.d, code: c.code, mods: c.mods, rev: '', desc: '', units: (t[m.end] && /^\d{1,3}$/.test(t[m.end].s)) ? +t[m.end].s : null, charge: m.v };
    } else {
      // UB-04 field 42–47 (rev code, description, HCPCS + modifiers, date, units, charge) or an itemized statement line
      let rev = '', descFrom = 0;
      if (before[0] && /^0\d{3}$/.test(before[0].s)) { rev = before[0].s; descFrom = 1; }
      let ci = -1, c = null;
      for (let j = before.length - 1; j >= descFrom; j--) {
        const cc = code(before[j].s);
        if (cc && !(MOD.test(before[j].s))) { ci = j; c = cc; break; }
      }
      // modifiers written as their own words between the code and the date ("76857 TC 041525")
      if (c) for (let j = ci + 1; j < before.length; j++) if (MOD.test(before[j].s)) c.mods.push(before[j].s);
      const desc = before.slice(descFrom, ci >= 0 ? ci : before.length).map(x => x.s).join(' ')
        .replace(/\s+-\s*$/, '').replace(/(\w)\s(?=eatment)/i, '$1').trim();
      if (!c && !rev && !/[A-Za-z]{3}/.test(desc)) return null;
      let k = d.i + d.n;
      const d2 = dateAt(t, k); if (d2) k += d2.n; // statement: date of service, posting date
      // an itemized statement repeats the code after the dates
      if (t[k] && code(t[k].s) && c && code(t[k].s).code === c.code) k++;
      const m = moneyFrom(t, k, true);
      if (!m || m.neg || !(m.v > 0)) return null;
      res = { dos: d.d, code: c ? c.code : '', mods: c ? c.mods : [], rev, desc, units: m.units, charge: m.v };
    }
    return res;
  }

  // ------------------------------------------------------------ header fields
  const STATE2 = /^(A[LKZR]|C[AOT]|D[EC]|FL|GA|HI|I[ADLN]|K[SY]|LA|M[ADEINOST]|N[CDEHJMVY]|O[HKR]|PA|RI|S[CD]|T[NX]|UT|V[AT]|W[AIVY])$/;
  const NAME_RX = /^([A-Z][A-Z'\-]+(?: [A-Z][A-Z'\-]+){0,2}), ?([A-Z][A-Z'\-]+(?: [A-Z][A-Z'.\-]*){0,3})$/;
  const tc = s => s.toLowerCase().replace(/\b([a-z])/g, c => c.toUpperCase()).replace(/\b(Ii|Iii|Iv)\b/g, m => m.toUpperCase());
  const titleAddr = s => tc(s).replace(/\b(Ne|Nw|Se|Sw|Po|Fm|Cr)\b/g, m => m.toUpperCase()).replace(/\b([A-Z][a-z])\s+(\d{5})/g, (m, st, z) => st.toUpperCase() + ' ' + z);

  // Patient name "LAST, FIRST M" from the upper part of the form (UB-04 field 8b, CMS-1500 box 2)
  // the words of one box: form labels ("b", "8") dropped, cut where a wide gap starts the next box
  function cluster(t, maxGap) {
    t = t.filter(x => !/^[a-z]$/.test(x.s));
    while (t.length && /^\d{1,2}[a-z]?$/.test(t[0].s)) t = t.slice(1);
    const out = [];
    for (const x of t) { if (out.length && x.x - out[out.length - 1].x2 > (maxGap || 30)) break; out.push(x); }
    return out;
  }
  function findPatient(p, lines) {
    for (const l of lines) {
      if (l.y < p.height * 0.62) break;
      const t = cluster(tokens(l).filter(x => x.x < p.width * 0.42));
      const s = t.map(x => x.s).join(' ').replace(/\s+,/g, ',');
      const m = s.match(NAME_RX);
      if (!m) continue;
      if (STATE2.test(m[2].split(' ')[0]) && (m[2].split(' ').length === 1 || /^\d/.test(m[2].split(' ')[1] || ''))) continue; // "DALLAS, TX"
      if (/HOSPITAL|CLINIC|MEDICAL|CENTER|HEALTH|LLC|INC|PLLC|INSURANCE|GROUP|SERVICES/.test(s)) continue;
      return { line: l, name: s, xEnd: Math.max(...t.map(x => x.x2)) };
    }
    return null;
  }

  function directoryMatch(all) {
    const dir = root.FACILITY_DIRECTORY || [];
    const norm = s => String(s || '').toUpperCase().replace(/C\/O CARE ?CAPITAL/g, ' ').replace(/[^A-Z0-9 ]+/g, ' ')
      .replace(/\b(LLC|PLLC|PA|INC|LLP|LTD|PC|DBA|THE)\b/g, ' ').replace(/\s+/g, ' ').trim();
    const text = ' ' + norm(all) + ' ';
    let best = null;
    const GENERIC = /^(HOSPITAL|HOSPITALS|CLINIC|CLINICS|PHARMACY|MEDICAL|MEDICINE|CENTER|CENTERS|HEALTH|HEALTHCARE|SURGERY|SURGICAL|IMAGING|SERVICES|GROUP|CARE|CAPITAL|AND|OF|TEXAS|HOUSTON|DALLAS|ASSOCIATES|PHYSICIANS|NETWORK|SPINE|PAIN)$/;
    for (const [name, addr] of dir) {
      const n = norm(name);
      let score = 0;
      if (n.length >= 6 && text.includes(' ' + n + ' ')) score = n.length + 100;
      // a name cut short or garbled on the form: the facility's street address plus one of its own (non-generic) name words
      const street = String(addr || '').toUpperCase().match(/^(\d{3,6})\s+([A-Z0-9]+)/);
      const ownWord = n.split(' ').some(w => w.length >= 3 && !GENERIC.test(w) && text.includes(' ' + w + ' '));
      if (!score && street && ownWord && text.includes(` ${street[1]} ${street[2]} `)) score = 50;
      if (score && (!best || score > best.score)) best = { name, score };
    }
    return best && best.name;
  }

  IB.parseInvoice = function (pages) {
    const inv = AE.parseInvoice(pages, {});
    const all = AE.fullText(pages);
    const res = { format: inv.format, invoiceTotal: inv.total, dob: inv.dob || '', patient: '', account: '', address: '', phone: '', facility: '', doi: '', lines: [], notes: [] };
    for (const p of pages) {
      const lines = AE.pageLines(p);
      for (const l of lines) { const s = serviceLine(l, p.width); if (s) { s.page = p.num; res.lines.push(s); } }
      if (res.patient) continue;
      const pt = findPatient(p, lines);
      if (!pt) continue;
      res.patient = AE.personName(pt.name);
      if (!res.dob) {
        // CMS-1500 box 3 is on the name's line: "DOE, JOHN A 05 30 1980M" (OCR may glue the sex on)
        const m = pt.line.text.match(/\b(\d{2})\s(\d{2})\s(\d{4})(?!\d)/);
        const dd = m && AE.parseDate(`${m[1]}/${m[2]}/${m[3]}`);
        if (dd) res.dob = AE.fmtDate(dd);
      }
      const below = lines.filter(l => l.y < pt.line.y - 1 && l.y > pt.line.y - 90);
      const above = lines.filter(l => l.y > pt.line.y + 1 && l.y < pt.line.y + 20);
      const rightOf = (l, x) => tokens(l).filter(t => t.x > x).map(t => t.s);
      if (res.format === 'UB-04') {
        // field 9: street on the line above (9a), city / state / zip to the right of the name (9b–9d)
        const x0 = Math.max(pt.xEnd + 10, p.width * 0.33);
        const near = lines.filter(l => Math.abs(l.y - pt.line.y) <= 4).flatMap(l => tokens(l).filter(t => t.x > x0)).sort((a, b) => a.x - b.x);
        const city = near.filter(x => !/^[a-z]$/.test(x.s)).map(x => x.s).join(' ');
        const csz = city.match(/([A-Z][A-Z .'\-]*?)\s+([A-Z]{2})\s+(\d{5})(?:-?\d{4})?\b/);
        let street = '';
        for (const l of above.sort((a, b) => a.y - b.y)) {
          const w = rightOf(l, p.width * 0.33).join(' ').replace(/^.*?PATIENT ADDRESS\s*/i, '').replace(/^a\s+/, '');
          const m = w.match(/^\d+\s+[A-Z0-9][A-Z0-9 .#'\-]*?(?=\s+[a-z]\s|\s{2,}|$)/);
          if (m) { street = m[0].trim(); break; }
        }
        if (csz) res.address = [street && titleAddr(street), `${tc(csz[1])}, ${csz[2]} ${csz[3]}`].filter(Boolean).join(', ');
      } else {
        // CMS-1500 box 5: street, city + state, zip + phone under the name
        let street = '', cs = '', zip = '';
        for (const l of below.sort((a, b) => b.y - a.y)) {
          const w = tokens(l).filter(t => t.x < p.width * 0.42).map(t => t.s).join(' ');
          if (!street && /^\d+\s+[A-Z]/.test(w)) { street = w; continue; }
          if (street && !cs && /^[A-Z][A-Z .'\-]+\s+[A-Z]{2}$/.test(w)) { cs = w; continue; }
          if (street && !zip) {
            const z = w.match(/^(\d{5})(?:-?\d{4})?\b(.*)$/);
            if (z) {
              zip = z[1];
              const ph = z[2].match(/\(?(\d{3})\)?\s*(\d{3})[\s-]?(\d{4})/);
              if (ph) res.phone = `(${ph[1]}) ${ph[2]}-${ph[3]}`;
              break;
            }
          }
        }
        if (street) {
          const m = cs.match(/^(.*\S)\s+([A-Z]{2})$/);
          res.address = [titleAddr(street), m ? `${tc(m[1])}, ${m[2]}${zip ? ' ' + zip : ''}` : zip].filter(Boolean).join(', ');
        }
      }
    }
    // Patient account number: UB-04 field 3a (top right), CMS-1500 box 26 (after the federal tax ID)
    if (res.format === 'UB-04') {
      const top = pages[0] && AE.pageLines(pages[0]).filter(l => l.y > pages[0].height * 0.93);
      for (const l of top || []) {
        const c = tokens(l).filter(t => t.x > pages[0].width * 0.6 && t.x < pages[0].width * 0.93 && /^[A-Z0-9][A-Z0-9\-]{4,}$/.test(t.s) && /\d/.test(t.s) && !AE.parseDate(t.s));
        if (c.length) { res.account = c[0].s; break; }
      }
      // field 31–34 occurrence codes: 01–06 accident, 11 onset → date of injury
      const oc = all.match(/(?:^|\s)(?:a\s+)?(0[1-6]|11)\s+(\d{6})(?=\s|$)/m);
      const od = oc && AE.parseDate(oc[2]);
      if (od) res.doi = AE.fmtDate(od);
    } else {
      const m = all.match(/\b\d{2}-?\d{7}\s+(?:X\s+)?([A-Z0-9][A-Z0-9\-]{3,})\b/);
      if (m) res.account = m[1];
      const di = all.match(/\b(\d{2}) (\d{2}) (\d{2}|\d{4})\s+(?:QUAL\.?\s*)?431\b/);
      const dd = di && AE.parseDate(`${di[1]}/${di[2]}/${di[3]}`);
      if (dd) res.doi = AE.fmtDate(dd);
    }
    res.facility = directoryMatch(all) || '';
    res.lines.sort((a, b) => a.dos - b.dos || a.page - b.page);
    if (!res.lines.length) res.notes.push(all.trim() ? 'No service lines found — add them by hand.' : 'No text on this file — add the lines by hand.');
    return res;
  };

  // ------------------------------------------------------------ table rows
  IB.fmtDate = d => d ? `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}` : '';
  IB.money = v => '$' + AE.fmtMoney(v || 0);
  IB.procText = l => l.proc != null ? l.proc : l.code ? l.code + (l.mods && l.mods.length ? '-' + l.mods.join('-') : '') : (l.rev ? 'Rev ' + l.rev : '');
  // lines: [{ dos: Date, code, mods, rev, charge }] → [{ dos: 'M/D/YYYY', proc, charge }]
  IB.rows = function (lines, mode) {
    const ok = lines.filter(l => l.dos || l.charge);
    if (mode !== 'date') return ok.map(l => ({ dos: IB.fmtDate(l.dos), proc: IB.procText(l), charge: l.charge || 0 }));
    const by = new Map();
    for (const l of ok) {
      const k = IB.fmtDate(l.dos);
      if (!by.has(k)) by.set(k, { dos: k, procs: [], charge: 0, t: l.dos ? l.dos.getTime() : Infinity });
      const r = by.get(k);
      const p = IB.procText(l);
      if (p && !r.procs.includes(p)) r.procs.push(p);
      r.charge = Math.round((r.charge + (l.charge || 0)) * 100) / 100;
    }
    return [...by.values()].sort((a, b) => a.t - b.t).map(r => ({ dos: r.dos, proc: r.procs.join(', '), charge: r.charge }));
  };

  // ------------------------------------------------------------ PDF
  // Letter page, laid out like CARECAPITAL SUMMARY TEMPLATE (points from the top-left).
  const COLS = [
    ['Facility', 45.1], ['Attending Provider', 183.6], ['Procedure', 232.5], ['Date of Service', 284.1], ['Description', 327.2],
    ['Diagnosis Code', 366.5], ['Plan', 439.9], ['Date of Injury', 472.1], ['Charges', 515.3]
  ];
  const TABLE_R = 561.6;
  IB.COMPANY = ['CARECAPITAL, LLC', 'PO BOX 301103', 'HOUSTON, TX 77230', '(713) 795-1164'];

  // d: { patient, account, dob, phone, guarantor, guarantorAddress, facility, provider, plan, doi, diagnosis, description, rows: [{dos, proc, charge}] }
  IB.buildPdf = async function (PDFLib, d) {
    const { PDFDocument, StandardFonts, rgb } = PDFLib;
    const doc = await PDFDocument.create();
    doc.setTitle(`${d.patient || 'Patient'} - Billing Summary`);
    doc.setProducer('Itemized Billing (offline)'); doc.setCreator('Itemized Billing');
    const F = await doc.embedFont(StandardFonts.Helvetica), B = await doc.embedFont(StandardFonts.HelveticaBold);
    const PURPLE = rgb(220 / 255, 209 / 255, 224 / 255), INK = rgb(0.1, 0.1, 0.12), GRID = rgb(0.2, 0.2, 0.2);
    const W = 612, H = 792, BOTTOM = 48;
    // Helvetica (WinAnsi) has no curly quotes / dashes from pasted text — use plain ones
    const safe = s => String(s == null ? '' : s).replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-')
      .replace(/[^\x20-\x7E -ÿ\n]/g, '?');
    let page;
    const text = (s, x, top, size, font, color) => page.drawText(safe(s), { x, y: H - top - size, size, font: font || F, color: color || INK });
    const rect = (x, top, w, h, fill, border) => page.drawRectangle({ x, y: H - top - h, width: w, height: h, color: fill || undefined, borderColor: border || undefined, borderWidth: border ? 0.6 : 0 });
    const hline = (x1, x2, top, t) => page.drawLine({ start: { x: x1, y: H - top }, end: { x: x2, y: H - top }, thickness: t || 0.6, color: GRID });
    const vline = (x, t1, t2) => page.drawLine({ start: { x, y: H - t1 }, end: { x, y: H - t2 }, thickness: 0.6, color: GRID });
    // word-wrap inside a cell
    const wrap = (s, font, size, width) => {
      const out = [];
      for (const para of safe(s).split('\n')) {
        let cur = '';
        for (const w of para.split(/(?<=[ ,])/)) {
          const next = cur + w;
          if (cur && font.widthOfTextAtSize(next.trimEnd(), size) > width) { out.push(cur.trimEnd()); cur = w.trimStart(); }
          else cur = next;
        }
        out.push(cur.trimEnd());
      }
      return out;
    };
    const fs = 5.8, lh = 7;

    function head() {
      page = doc.addPage([W, H]);
      text('CARECAPITAL', 55, 57, 9.5);
      text('& RECORD SERVICES', 55, 69, 9.5);
      IB.COMPANY.forEach((s, i) => text(s, 55, 86 + i * 7.3, 4.8, F));
      // guarantor / patient band
      rect(45, 116.5, 517, 11, PURPLE);
      text('GUARANTOR NAME AND ADDRESS', 47, 119.3, 5);
      text('PATIENT #', 328, 119.3, 5);
      text('PATIENT NAME', 398, 119.3, 5);
      text(d.guarantor || d.patient || '', 55, 131.5, 6.8);
      text(d.account || '', 328, 131.5, 6.8);
      text(d.patient || '', 398, 131.5, 6.8);
      wrap(d.guarantorAddress || '', F, 6.8, 260).slice(0, 2).forEach((s, i) => text(s, 55, 150 + i * 8.5, 6.8));
      rect(327, 148, 235, 11, PURPLE);
      text('DOB', 330, 150.8, 5);
      text('HOME TELEPHONE', 398, 150.8, 5);
      text(d.dob || '', 330, 162.5, 6.8);
      text(d.phone || '', 398, 162.5, 6.8);
      text('Billing Summary', 51.5, 168.5, 8.6);
      hline(46, 374, 179.5, 0.6);
    }
    function colHead(top) {
      const h = 19;
      rect(45.1, top, TABLE_R - 45.1, h, null, GRID);
      COLS.forEach(([name, x], i) => {
        const x2 = i + 1 < COLS.length ? COLS[i + 1][1] : TABLE_R;
        if (i) vline(x, top, top + h);
        const w = F.widthOfTextAtSize(name, 4.9);
        text(name, x + (x2 - x - w) / 2, top + 7.2, 4.9);
      });
      return top + h;
    }
    // every invoice on this page is CareCapital's: "Integrity Healthcare Services c/o Care Capital"
    const fac = d.facility && !/care\s*capital/i.test(d.facility) ? d.facility + ' c/o Care Capital' : (d.facility || '');
    const cells = r => [fac, d.provider || 'N/A', r.proc || '', r.dos || '', d.description || 'N/A', d.diagnosis || 'N/A', d.plan || 'N/A', d.doi || 'N/A', r.charge != null && r.charge !== '' ? IB.money(r.charge) : ''];
    function drawRow(top, vals, h, opts) {
      opts = opts || {};
      if (opts.fill) rect(45.1, top, TABLE_R - 45.1, h, opts.fill);
      hline(45.1, TABLE_R, top + h);
      vline(45.1, top, top + h); vline(TABLE_R, top, top + h);
      COLS.forEach(([, x], i) => {
        const x2 = i + 1 < COLS.length ? COLS[i + 1][1] : TABLE_R;
        if (i && !opts.merge) vline(x, top, top + h);
        const v = vals[i]; if (!v) return;
        const size = i === 0 ? 4.9 : fs;
        const ls = wrap(v, F, size, x2 - x - 4);
        const y0 = top + (h - ls.length * lh) / 2 + (lh - size) / 2;
        ls.forEach((s, k) => { const w = F.widthOfTextAtSize(s, size); text(s, x + (x2 - x - w) / 2, y0 + k * lh, size); });
      });
    }
    const rowH = r => {
      const v = cells(r);
      let n = 1;
      COLS.forEach(([, x], i) => { const x2 = i + 1 < COLS.length ? COLS[i + 1][1] : TABLE_R; n = Math.max(n, wrap(v[i], F, i === 0 ? 4.9 : fs, x2 - x - 4).length); });
      return Math.max(14.8, n * lh + 6);
    };

    head();
    let top = colHead(195.5);
    const rows = d.rows || [];
    const FILL_TO = 18;
    let drawn = 0;
    for (const r of rows) {
      const h = rowH(r);
      if (top + h + 15 > H - BOTTOM) { page = doc.addPage([W, H]); top = colHead(48); }
      drawRow(top, cells(r), h); top += h; drawn++;
    }
    // empty grid lines like the template (one page only)
    while (drawn < FILL_TO && top + 14.8 + 15 <= H - BOTTOM) { drawRow(top, [], 14.8); top += 14.8; drawn++; }
    // total row
    const total = rows.reduce((s, r) => s + (Number(r.charge) || 0), 0);
    const th = 15;
    rect(45.1, top, TABLE_R - 45.1, th, PURPLE);
    hline(45.1, TABLE_R, top + th); vline(45.1, top, top + th); vline(TABLE_R, top, top + th); vline(515.3, top, top + th);
    const tw = B.widthOfTextAtSize('Total', 5.8);
    text('Total', 509 - tw, top + 5, 5.8, B);
    const tv = IB.money(Math.round(total * 100) / 100), tvw = F.widthOfTextAtSize(tv, fs);
    text(tv, 515.3 + (TABLE_R - 515.3 - tvw) / 2, top + 5, fs);
    return doc.save();
  };

  IB.fileName = function (patient) {
    const n = String(patient || 'Patient').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Patient';
    return `${n}_Bill.pdf`;
  };

  IB._serviceLine = serviceLine; IB._tokens = tokens;
  if (typeof module !== 'undefined' && module.exports) module.exports = IB;
  else root.IB = IB;
})(typeof window !== 'undefined' ? window : globalThis);
