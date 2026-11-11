/*
 * Affidavit engine — runs fully offline (browser or Node).
 *  - reads PDF text + positions (pdf.js)
 *  - finds underscore blanks, works out what each blank asks for from the words around it
 *  - parses the request letter (patient, DOB, facility, requested DOS, records vs billing)
 *  - parses invoices (UB-04 / CMS-1500 / itemized statements) for DOS and totals
 *  - builds the final PDF (filled affidavit + merged records/invoices) with pdf-lib
 */
(function (root) {
  'use strict';
  const AE = {};

  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
    'August', 'September', 'October', 'November', 'December'];

  // Human labels for every field kind the classifier can produce.
  AE.KINDS = {
    custodian: 'Custodian / affiant name',
    title: 'Affiant title',
    facility: 'Facility name',
    patient: 'Patient name',
    dob: 'Date of birth',
    county: 'County',
    state: 'State',
    pages: 'Number of pages',
    dos_from: 'DOS from (first date of service)',
    dos_to: 'DOS to (last date of service)',
    dos_range: 'Dates of service',
    dos_from_md: 'DOS from — month & day',
    dos_from_y2: 'DOS from — year (2 digits)',
    dos_to_md: 'DOS to — month & day',
    dos_to_y2: 'DOS to — year (2 digits)',
    amt_total: '$ Total charged',
    amt_writeoff: '$ Written off',
    amt_paid: '$ Paid to date',
    amt_balance: '$ Outstanding balance',
    amt_sought: '$ Balance still sought from the patient',
    amt_paid_plus_balance: '$ Paid + outstanding',
    notary_day: 'Sworn date — day',
    notary_month: 'Sworn date — month',
    notary_year2: 'Sworn date — year (2 digits)',
    notary_year4: 'Sworn date — year',
    notary_date: 'Sworn date (full)',
    yes: 'Answer: Yes',
    no: 'Answer: No',
    na: 'Answer: Not applicable',
    archive: 'Answer: archive (no records found?)',
    all_provided: 'Answer: provided all records',
    no_knowledge: 'Answer: no information (custodian of records)',
    knowledge_basis: 'Answer: basis of knowledge (custodian of records)',
    payor_names: 'Answer: names of who paid (no information if nobody did)',
    yes_payments: 'Answer: Yes (+ no payment has been made)',
    yes_pages: 'Answer: Yes + number of pages',
    yn_paid: 'Answer: been paid? (Yes / No)',
    yn_others_paid: 'Answer: paid by insurance or others? (Yes / No)',
    answer: 'Answer (remembered)',
    no_info: 'Answer: no information (custodian)',
    retention: 'Answer: records retention',
    custodian_title: 'Name + title',
    custodian_title_addr: 'Name + address + title',
    amt_balance_whom: '$ Outstanding balance + who owes it',
    employer_address: 'Employer + business address',
    custodian_employer: 'Name + employer + business address',
    amt_ins_paid: '$ Paid by insurance',
    amt_payor_paid: '$ Paid by insurance / Medicaid / Medicare',
    amt_collection: '$ Turned over for collection',
    amt_payor_owing: '$ Owed by insurance / Medicaid / Medicare',
    amt_med_paid: '$ Paid by Medicare/Medicaid',
    amt_pt_paid: '$ Paid by patient',
    amt_adjust: '$ Contractual adjustments',
    amt_lien: '$ Lien amount',
    signature: 'Signature line (left blank)',
    notary_sig: 'Notary signature (left blank)',
    commission: 'Notary commission (left blank)',
    unknown: 'Unrecognised blank',
    custom: 'Custom text'
  };
  // Kinds that are skipped by default — they get signed/stamped by hand.
  AE.SKIP_KINDS = new Set(['signature', 'notary_sig', 'commission', 'unknown']);

  // ---------------------------------------------------------------- dates
  AE.parseDate = function (s) {
    if (!s) return null;
    s = String(s).trim();
    let m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
    if (m) return mk(+m[1], +m[2], +m[3]);
    m = s.match(/^(\d{2})(\d{2})(\d{2})$/); // UB-04 MMDDYY
    if (m) return mk(+m[1], +m[2], +m[3]);
    m = s.match(/^(\d{2})(\d{2})(\d{4})$/); // MMDDYYYY
    if (m) return mk(+m[1], +m[2], +m[3]);
    m = s.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/);
    if (m) {
      const mi = MONTHS.findIndex(x => x.toLowerCase().startsWith(m[1].toLowerCase().slice(0, 3)));
      if (mi >= 0) return mk(mi + 1, +m[2], +m[3]);
    }
    return null;
    function mk(mo, d, y) {
      if (y < 100) y += (y <= (new Date().getFullYear() % 100) + 1) ? 2000 : 1900;
      if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
      const dt = new Date(y, mo - 1, d);
      return dt.getMonth() === mo - 1 ? dt : null;
    }
  };
  AE.fmtDate = function (d, style) {
    if (!d) return '';
    const mm = String(d.getMonth() + 1).padStart(2, '0'), dd = String(d.getDate()).padStart(2, '0');
    if (style === 'long') return `${MONTHS[d.getMonth()]} ${dd}, ${d.getFullYear()}`;
    return `${mm}/${dd}/${d.getFullYear()}`;
  };
  AE.ordinal = function (n) {
    const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  };
  const STATES = { TX: 'Texas', LA: 'Louisiana', OK: 'Oklahoma', NM: 'New Mexico', AR: 'Arkansas', CA: 'California', FL: 'Florida', NY: 'New York', PA: 'Pennsylvania' };
  AE.stateLong = s => STATES[String(s || '').trim().toUpperCase()] || s || '';
  AE.fmtMoney = function (n) {
    if (n === '' || n == null || isNaN(n)) return '';
    return Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };
  AE.parseMoney = function (s) {
    if (typeof s === 'number') return s;
    const v = parseFloat(String(s || '').replace(/[$,\s]/g, ''));
    return isNaN(v) ? null : v;
  };
  const DATE_RX = String.raw`(?:\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4})`;

  // ------------------------------------------------------------ measuring
  // Uses the same Helvetica metrics pdf-lib draws with, so blank positions line up.
  AE.init = async function (PDFLib) {
    AE.PDFLib = PDFLib;
    const doc = await PDFLib.PDFDocument.create();
    AE.font = await doc.embedFont(PDFLib.StandardFonts.Helvetica);
    const fallback = AE.font.widthOfTextAtSize('a', 1000);
    const cache = new Map();
    AE.charW = function (ch) {
      if (cache.has(ch)) return cache.get(ch);
      let w;
      try { w = AE.font.widthOfTextAtSize(ch, 1000); } catch (e) { w = fallback; }
      cache.set(ch, w);
      return w;
    };
    AE.textW = (s, size) => { let t = 0; for (const ch of s) t += AE.charW(ch); return t * size / 1000; };
  };
  // Replace characters Helvetica/WinAnsi cannot draw.
  AE.safeText = function (s) {
    let out = '';
    for (const ch of String(s)) {
      try { AE.font.encodeText(ch); out += ch; } catch (e) { out += '?'; }
    }
    return out;
  };

  // --------------------------------------------------------- PDF reading
  // opts: { fonts: read real glyph widths (needed only for blanks), onProgress(page, total) }
  AE.readPdf = async function (pdfjsLib, bytes, opts) {
    opts = opts || {};
    const doc = await pdfjsLib.getDocument({ data: bytes.slice(0), isEvalSupported: false, fontExtraProperties: true }).promise;
    const pages = [];
    for (let p = 1; p <= doc.numPages; p++) {
      if (opts.onProgress) opts.onProgress(p, doc.numPages);
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      const items = [];
      for (const it of tc.items) {
        if (!it.str || !it.str.trim()) continue;
        const h = Math.abs(it.transform[3]) || it.height || 10;
        // Skip rotated/vertical text — it never holds affidavit blanks.
        if (Math.abs(it.transform[1]) > 0.01 || Math.abs(it.transform[2]) > 0.01) continue;
        items.push({ str: it.str, x: it.transform[4], y: it.transform[5], w: it.width, h, font: it.fontName });
      }
      // Real glyph widths for fonts used by blanks (exact positions inside a text run), and the drawn
      // horizontal lines — Word often makes a blank by underlining spaces, which leaves no "____" text.
      const fontWidths = {};
      let hlines = [], imagePixels = 0;
      if (opts.fonts !== false) {
        try {
          const ol = await page.getOperatorList();
          hlines = horizontalLines(ol, pdfjsLib.OPS);
          // A scanner or fax machine puts the page in as one big picture (sometimes cut in strips).
          const O = pdfjsLib.OPS;
          let pixels = 0;
          ol.fnArray.forEach((fn, i) => {
            const a = ol.argsArray[i];
            if (fn === O.paintImageXObject) pixels += (a[1] || 0) * (a[2] || 0);
            else if (fn === O.paintImageMaskXObject || fn === O.paintInlineImageXObject) pixels += ((a[0] && a[0].width) || 0) * ((a[0] && a[0].height) || 0);
          });
          imagePixels = pixels;
          for (const name of new Set(items.filter(it => /_{3,}/.test(it.str)).map(it => it.font))) {
            try { fontWidths[name] = glyphWidths(page.commonObjs.get(name)); } catch (e) { /* fall back to Helvetica */ }
          }
        } catch (e) { /* fall back to Helvetica, no drawn lines */ }
      }
      // Edits made with a PDF editor's comment tools: a white box hiding printed words (white-out)
      // and a drawn line used as a blank.
      let whiteouts = [];
      if (opts.fonts !== false) {
        try {
          const isWhite = c => c && c.length >= 3 && c[0] > 240 && c[1] > 240 && c[2] > 240;
          for (const a of await page.getAnnotations()) {
            const r = a.rect || [0, 0, 0, 0];
            if (/^(Square|FreeText|Redact)$/.test(a.subtype) && (isWhite(a.interiorColor) || isWhite(a.color)))
              whiteouts.push({ x: r[0], y: r[1], w: r[2] - r[0], h: r[3] - r[1] });
            const lc = a.lineCoordinates;
            if (a.subtype === 'Line' && lc && Math.abs(lc[1] - lc[3]) < 2 && Math.abs(lc[2] - lc[0]) >= 8)
              hlines.push({ x: Math.min(lc[0], lc[2]), y: Math.min(lc[1], lc[3]), w: Math.abs(lc[2] - lc[0]) });
          }
        } catch (e) { /* no annotations */ }
      }
      const visibleItems = whiteouts.length ? hideUnder(items, whiteouts) : items;
      const view = page.view; // [x0, y0, x1, y1] user space
      pages.push({ num: p, width: view[2] - view[0], height: view[3] - view[1], x0: view[0], y0: view[1], rotate: page.rotate,
        items: visibleItems, fontWidths, hlines, whiteouts, imagePixels });
    }
    return { doc, numPages: doc.numPages, pages };
  };

  // Text covered by a white-out box is not on the page any more ("STATE OF TEXAS" with TEXAS whited out → "STATE OF").
  function hideUnder(items, boxes) {
    const out = [];
    for (const it of items) {
      const hit = boxes.filter(b => it.y >= b.y - 2 && it.y <= b.y + b.h && it.x < b.x + b.w && it.x + it.w > b.x);
      if (!hit.length) { out.push(it); continue; }
      const chars = [...it.str];
      const natural = AE.textW ? AE.textW(it.str, 1000) || 1 : chars.length;
      const scale = it.w / natural;
      let x = it.x, seg = null;
      const flush = () => { if (seg && seg.str.trim()) out.push(seg); seg = null; };
      for (const ch of chars) {
        const cw = (AE.textW ? AE.textW(ch, 1000) : 1) * scale;
        const covered = hit.some(b => x + cw / 2 > b.x && x + cw / 2 < b.x + b.w);
        if (covered) flush();
        else { if (!seg) seg = { ...it, str: '', x, w: 0 }; seg.str += ch; seg.w += cw; }
        x += cw;
      }
      flush();
    }
    return out;
  }

  // The paper and ink tones of a scan: a fax or a faded copy has grey paper or grey ink.
  AE.inkLevels = function (gray) {
    const hist = new Uint32Array(256);
    for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
    let bg = 128;
    for (let v = 128; v < 256; v++) if (hist[v] > hist[bg]) bg = v;
    let sum = 0, cnt = 0;
    for (let v = 0; v < bg - 50; v++) { sum += v * hist[v]; cnt += hist[v]; }
    return { bg, ink: cnt ? sum / cnt : Math.max(0, bg - 120) };
  };

  /*
   * Underlines in a scanned page are only pixels. Finds thin, long, dark horizontal lines in a greyscale image
   * (one byte per pixel) and returns them in pixel coordinates: [{ x0, x1, y, yL, yR }] (y = bottom row of the line in
   * its middle, yL / yR at its two ends). A crooked scan draws a line as a staircase and a fax breaks it into pieces,
   * so pieces that continue each other are joined. Letters do not pass: their strokes stand tall above the "line".
   * opts.ppt = pixels per PDF point.
   */
  AE.detectImageLines = function (gray, w, h, opts) {
    opts = opts || {};
    const ppt = opts.ppt || w / 612;
    const lv = AE.inkLevels(gray);
    const dark = opts.threshold || Math.round(lv.ink + 0.62 * (lv.bg - lv.ink));
    const minPiece = Math.max(10, Math.round(5 * ppt)), minLen = opts.minLen || Math.round(w * 0.035);
    const maxGap = Math.max(3, Math.round(1.2 * ppt)), maxThick = opts.maxThick || Math.max(4, Math.round(3 * ppt));
    const stair = maxGap * 2, bridge = Math.round(8 * ppt);
    // 1. long dark runs on each pixel row, chained into lines from row to row
    let pieces = [], active = [];
    for (let y = 0; y < h; y++) {
      const row = y * w;
      active = active.filter(l => l.lastY >= y - 2);
      let start = -1, lastDark = -10;
      for (let x = 0; x <= w; x++) {
        const isDark = x < w && gray[row + x] < dark;
        if (isDark) { if (start < 0) start = x; lastDark = x; }
        else if (start >= 0 && x - lastDark > maxGap) {
          if (lastDark - start + 1 >= minPiece) {
            const r = { x0: start, x1: lastDark, y };
            let l = active.find(o => o.segs.some(s => y - s.y <= 2 && Math.max(s.x0, r.x0) - Math.min(s.x1, r.x1) <= stair));
            if (!l) { l = { segs: [], lastY: y }; pieces.push(l); active.push(l); }
            l.segs.push(r); l.lastY = y;
          }
          start = -1;
        }
      }
    }
    // 2. a straight line through each piece
    const fit = l => {
      l.x0 = Math.min(...l.segs.map(s => s.x0)); l.x1 = Math.max(...l.segs.map(s => s.x1));
      let W = 0, mx = 0, my = 0;
      for (const s of l.segs) { const n = s.x1 - s.x0 + 1; W += n; mx += n * (s.x0 + s.x1) / 2; my += n * s.y; }
      mx /= W; my /= W;
      let sxy = 0, sxx = 0;
      for (const s of l.segs) { const n = s.x1 - s.x0 + 1, dx = (s.x0 + s.x1) / 2 - mx; sxy += n * dx * (s.y - my); sxx += n * (dx * dx + n * n / 12); }
      l.slope = Math.max(-0.07, Math.min(0.07, sxx ? sxy / sxx : 0));
      l.yAt = x => my + l.slope * (x - mx);
    };
    pieces.forEach(fit);
    // 3. pieces of a broken line continue each other
    pieces = pieces.filter(l => l.x1 - l.x0 + 1 >= minPiece).sort((a, b) => a.x0 - b.x0);
    for (let i = 0; i < pieces.length; i++) {
      for (let j = i + 1; j < pieces.length; j++) {
        const a = pieces[i], b = pieces[j];
        if (b.x0 - a.x1 > bridge) break;
        if (Math.abs(a.yAt(b.x0) - b.yAt(b.x0)) > Math.max(2, 1.2 * ppt)) continue;
        if (b.x1 <= a.x1 && a.x1 - a.x0 > 4 * (b.x1 - b.x0)) { pieces.splice(j, 1); j--; continue; } // a sliver of the same line
        a.segs.push(...b.segs); fit(a);
        pieces.splice(j, 1); j = i;
      }
    }
    // 4. a line is thin and nearly solid; a row of letters is neither
    const out = [];
    for (const l of pieces) {
      const len = l.x1 - l.x0 + 1;
      if (len < minLen) continue;
      const edge = 6 * ppt, midY = l.yAt((l.x0 + l.x1) / 2);
      if (midY < edge || midY > h - edge) continue; // the dark border of a copy or fax
      const stepX = Math.max(1, Math.floor(len / 200));
      const clear = Math.round(0.8 * ppt), reach = Math.round(5 * ppt); // where letters would stand if this were a row of text
      let cols = 0, inked = 0, tall = 0, above = 0, below = 0; const thick = [];
      const inkIn = (x, from, to) => {
        for (let t = Math.max(0, from); t <= Math.min(h - 1, to); t++) if (gray[t * w + x] < dark) return true;
        return false;
      };
      for (let x = l.x0; x <= l.x1; x += stepX) {
        cols++;
        const c = Math.round(l.yAt(x));
        let y = -1;
        for (const d of [0, 1, -1, 2, -2, 3, -3]) { const t = c + d; if (t >= 0 && t < h && gray[t * w + x] < dark) { y = t; break; } }
        if (y < 0) continue;
        inked++;
        let top = y, bot = y;
        while (top > 0 && gray[(top - 1) * w + x] < dark && y - top <= maxThick * 2) top--;
        while (bot < h - 1 && gray[(bot + 1) * w + x] < dark && bot - y <= maxThick * 2) bot++;
        const t = bot - top + 1;
        if (t > maxThick) tall++; else thick.push(t);
        if (inkIn(x, top - clear - reach, top - clear)) above++;
        if (inkIn(x, bot + clear, bot + clear + reach)) below++;
      }
      // The tops or feet of a row of letters also line up, but the letters' bodies sit right beside that "line".
      // A short real line is solid; only a long one may be broken up by a fax.
      const solid = len >= 150 * ppt ? 0.7 : 0.88;
      if (inked < cols * solid || tall > inked * 0.3 || !thick.length || above > cols * 0.3 || below > cols * 0.4) continue;
      thick.sort((a, b) => a - b);
      const half = thick[thick.length >> 1] / 2;
      const yOf = x => Math.round(l.yAt(x) + half);
      out.push({ x0: l.x0, x1: l.x1, y: yOf((l.x0 + l.x1) / 2), yL: yOf(l.x0), yR: yOf(l.x1), thick: half * 2 });
    }
    return out.sort((a, b) => a.y - b.y || a.x0 - b.x0);
  };

  /*
   * Whitens the printed lines in a scan before the OCR reads it: a line under the words makes the OCR see junk
   * ("Answer: — ee a") and misread the letters that touch it. Letters crossing the line stay.
   */
  AE.eraseImageLines = function (gray, w, h, lines, opts) {
    opts = opts || {};
    const ppt = opts.ppt || w / 612, maxThick = opts.maxThick || Math.max(4, Math.round(3 * ppt));
    const lv = AE.inkLevels(gray), dark = Math.round(lv.ink + 0.62 * (lv.bg - lv.ink));
    for (const l of lines) {
      const span = Math.max(1, l.x1 - l.x0);
      for (let x = l.x0; x <= l.x1; x++) {
        const c = Math.round(l.yL + (l.yR - l.yL) * (x - l.x0) / span - l.thick / 2);
        let y = -1;
        for (const d of [0, 1, -1, 2, -2, 3, -3, 4, -4]) { const t = c + d; if (t >= 0 && t < h && gray[t * w + x] < dark) { y = t; break; } }
        if (y < 0) continue;
        let top = y, bot = y;
        while (top > 0 && gray[(top - 1) * w + x] < dark && y - top <= maxThick + 1) top--;
        while (bot < h - 1 && gray[(bot + 1) * w + x] < dark && bot - y <= maxThick + 1) bot++;
        if (bot - top + 1 > maxThick + 1) continue; // a letter's stroke crosses here
        for (let t = Math.max(0, top - 1); t <= Math.min(h - 1, bot + 1); t++) gray[t * w + x] = 255;
      }
    }
  };

  // Fax and copier dirt: tiny dark specks standing alone in white space are whitened, in the copy that is read only.
  // A speck near bigger ink stays: it may be the dot of an "i", a full stop, or a piece of a letter on a low-resolution scan.
  AE.despeckle = function (gray, w, h, opts) {
    const ppt = (opts && opts.ppt) || w / 612, maxArea = Math.round(1.3 * ppt * ppt), reach = Math.round(3 * ppt);
    const lv = AE.inkLevels(gray), dark = Math.round(lv.ink + 0.62 * (lv.bg - lv.ink));
    const seen = new Uint8Array(w * h), stack = [], blob = [], small = [];
    for (let s = 0; s < gray.length; s++) {
      if (seen[s] || gray[s] >= dark) continue;
      stack.push(s); seen[s] = 1; blob.length = 0;
      let area = 0;
      while (stack.length) {
        const p = stack.pop();
        area++; blob.push(p);
        const x = p % w;
        if (x > 0 && !seen[p - 1] && gray[p - 1] < dark) { seen[p - 1] = 1; stack.push(p - 1); }
        if (x < w - 1 && !seen[p + 1] && gray[p + 1] < dark) { seen[p + 1] = 1; stack.push(p + 1); }
        if (p >= w && !seen[p - w] && gray[p - w] < dark) { seen[p - w] = 1; stack.push(p - w); }
        if (p < gray.length - w && !seen[p + w] && gray[p + w] < dark) { seen[p + w] = 1; stack.push(p + w); }
      }
      if (area <= maxArea) small.push(blob.slice());
      else for (const p of blob) seen[p] = 2; // real ink
    }
    for (const b of small) {
      const x = b[0] % w, y = Math.floor(b[0] / w);
      let near = false;
      for (let dy = -reach; dy <= reach && !near; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -reach; dx <= reach; dx++) {
          const xx = x + dx;
          if (xx >= 0 && xx < w && seen[yy * w + xx] === 2) { near = true; break; }
        }
      }
      if (!near) for (const p of b) gray[p] = 255;
    }
  };

  // A scan's own picture stays as it is; only what the OCR reads gets stretched from grey to black and white.
  AE.stretchContrast = function (gray) {
    const { bg, ink } = AE.inkLevels(gray);
    // Normal black-on-white pages are left alone: stretching them would wipe the thin strokes of the letters.
    if (bg >= 225 && ink <= 130) return false;
    const hist = new Uint32Array(256);
    for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
    let black = 0, seen = 0;
    while (black < bg && seen < gray.length * 0.002) seen += hist[black++]; // the darkest ink really used
    const range = Math.max(40, bg - black);
    for (let i = 0; i < gray.length; i++) {
      const v = (gray[i] - black) * 255 / range;
      gray[i] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
    return true;
  };

  // Is this page a picture rather than text? A fax header or a scanner's own bad text layer does not make it a document.
  AE.isScanPage = function (p) {
    if (p.items.length < 5) return true;
    const px = p.imagePixels || 0, chars = p.items.reduce((n, it) => n + it.str.length, 0);
    if (px >= 400000 && chars < 250) return true; // a standard-mode fax is a small picture
    if (px < 1500000) return false;
    if (AE.readableShare([p]) < 0.6) return true;
    // A "searchable" scan has good text but its lines are only pixels. That matters only on a page with answers to fill.
    return !(p.hlines || []).length && !p.items.some(it => /__/.test(it.str)) && AE.isAffidavitPage(p);
  };

  /*
   * What the OCR read, without its noise: junk from specks and dirt goes, and "Answcr:" / "Answer" (colon lost) becomes
   * the "Answer:" label so the blank after it is found.
   */
  const closeTo = (w, target) => { // at most one letter wrong, missing or extra
    if (w === target) return true;
    if (Math.abs(w.length - target.length) > 1) return false;
    let i = 0, j = 0, edits = 0;
    while (i < w.length && j < target.length) {
      if (w[i] === target[j]) { i++; j++; continue; }
      if (++edits > 1) return false;
      if (w.length > target.length) i++;
      else if (w.length < target.length) j++;
      else { i++; j++; }
    }
    return edits + (w.length - i) + (target.length - j) <= 1;
  };
  AE.cleanOcrItems = function (items) {
    const kept = items.filter(it => {
      const alnum = it.str.replace(/[^A-Za-z0-9]/g, '');
      if (!alnum) return /[$§&]/.test(it.str);
      if (it.conf == null) return true;
      const low = alnum.toLowerCase();
      if (OCR_VOCAB.has(low) || OK_SHORT_WORDS.test(low) || OCR_SHORT[low]) return true; // "Are", "Is": never junk, however unsure the OCR was
      if (/^\d+$/.test(alnum)) return it.conf >= 20; // the "20" of "day of ____, 20__" often reads with low confidence
      return !(it.conf < 30 || (it.conf < 55 && alnum.length <= 3));
    });
    for (const it of kept) {
      const letters = it.str.replace(/[^A-Za-z]/g, '').toLowerCase();
      if (!closeTo(letters, 'answer') || /[0-9]/.test(it.str)) continue;
      const row = kept.filter(o => o !== it && Math.abs(o.y - it.y) < 4);
      if (row.some(o => o.x + o.w <= it.x)) continue;           // the label comes first on its line
      const punct = /[:;.,'|]\W*$/.test(it.str);
      if (punct || !row.some(o => /[a-z]{3,}/i.test(o.str))) it.str = 'Answer:';
    }
    return kept;
  };

  // Words of the questions, for repairing what the OCR misread ("clectronic", "entrics"). Used only to decide the answer.
  const OCR_VOCAB = new Set(('able about above abovenamed absence accept accepted accepts access accompanying account accounting accounts actions activity acts actually address adjust adjusted adjustment adjustments admission affidavit after against agreed agreement agreements allow allows already also alterations among amount amounts another answer answered answers anyone anything applicable archive archives archiving arrangement asked assigned assignment associated attach attached attachment attempts attorney authorized available aware balance basis been before behalf best between beyond bill billed billing bills books briefly business capacity care case cash caused charge charged charges chiropractor circumstance claim clear clinic clinics close closed code collected collection communications compilations complete completely complied concern concerning condition conditions conducted considers constitutes contacted contained continue contract contractor contracts contractual control conveyance conveyed copies copy copying corporate correct correspondence counseled course courses court coverage covered current curriculum custodian custody data date deposition describe described destroyed detail determine determined device diagnoses diagnosis diagnostic diagnostics direct directed direction directly discount discounted discovery doctor doctors document documents does dollar done down duces duplicate duplicates duplication during each effort either electronic else employed employee employees employer entitled entity entries establish evaluated evaluation event events ever everything exact examination examined exchange exhibits exist expected expenses explain extracted facilities facility fair familiar fees file film filming films financial foregoing forgiven form format forms forth found from full further gather group hand handed hard have health healthcare held here hereafter history hospital identified identify identity illness image images imaging immediate incident included including incurred independent indicate indicates individual information injury insurance insurer itemized judgment kept kind knowledge known lawsuit lawyer legal legally legible length less letter letters limited list listed locate location locations long lost made maintained make making manage managed many marking matters means medicaid medical medicare memorandum mentioned method microfiche missing much name named names nature near necessary notary notes notice notification number nurses oath obligated obligation observed obtain occupation occupations occurred occurrence officer official open opinion opinions organized original originals osteopath other others otherwise outlined over owed owned page pages paid paper papers part party patient patients payment payments payor payors performed period person personal persons pertaining photocopying photographed photostatic physical physician please policies policy poor portion position possess possession possible preceding preparation prepared preparing present previous previously primary prior private procedure procedures process produce produced production profit prohibits protected protection provide provided provider providers provision public purchased purchasing quality question questions rate rather rays ready reason reasonable reasonably receivable received recommended record recorded recording records redacted redactions reduced reference referral referred reflected regarding regardless regular regulations reimbursement related release released remain remains removed rendered rent replace replaced report reports representative representatives requested requests require required requires residence respect response responsibility responsible result retention role said sale same sanitarium scanned scope seek seeking send sent served service services settled settlement shortly signed sold some soon sought source sources specific specified state steps still stored studies subject subpoena subpoenaed subpoenas such suggested suit supervision supervisor systems take taken taking tangible tecum telephone terms testify testifying than that their them themselves there thereafter therein thereof these they third this those three time times title took total transaction transactions transfer transferred transmit treated treatment treatments trial true trustworthiness trustworthy truthfully under understand unless unpaid used variations various vitae waived want were what whatsoever when where whether which whom will with withheld within wording work worked would write written your yourself ' +
    'are you the and for has had was not may can all any but who how why its our out his her one two per').split(' '));
  const OCR_SHORT = { arc: 'are', vou: 'you', yon: 'you', yout: 'your', vout: 'your', thc: 'the', tbe: 'the', aud: 'and', iu: 'in', ot: 'of', tor: 'for', lor: 'for', bv: 'by', ol: 'of', ou: 'on',
    dao: 'do', hase: 'have', hate: 'have', hane: 'have', amy: 'any', anv: 'any', thus: 'this' };
  const OCR_LOOKS_ALIKE = ['ce', 'vy', 'nu', 'li', 'tf', 'oa', 'hb', 'rn', 'il', 'ao', 'sa', 'mn'];
  const OK_SHORT_WORDS = /^(a|i|in|is|do|if|to|on|at|by|of|no|an|as|it|my|or|so|we|be|he|us|am)$/;
  const looksAlike = (a, b) => OCR_LOOKS_ALIKE.some(p => (p[0] === a && p[1] === b) || (p[0] === b && p[1] === a));
  const repairWord = w => {
    if (OCR_SHORT[w]) return OCR_SHORT[w];
    if (w.length < 3 || OCR_VOCAB.has(w) || OK_SHORT_WORDS.test(w)) return w;
    const hits = [];
    if (w.length >= 6) { for (const v of OCR_VOCAB) if (closeTo(w, v)) hits.push(v); }
    else {
      for (const v of OCR_VOCAB) {
        if (v.length !== w.length) continue;
        let diff = 0, alike = true;
        for (let i = 0; i < w.length; i++) if (w[i] !== v[i]) { diff++; alike = alike && looksAlike(w[i], v[i]); }
        if (diff === 1 && alike) hits.push(v);
      }
    }
    return hits.length === 1 ? hits[0] : w;
  };
  AE.ocrFix = function (text) {
    let q = text.toLowerCase().replace(/\brn(?=[a-z])/g, 'm')
      .replace(/\border\s*no\b\.?\s*:?\s*[\d.\-]*/g, ' ')   // the footer of the page before
      .replace(/([a-z])[.] (?=[a-z])/g, '$1, ')                // a comma read as a period
      .replace(/\b1s\b/g, 'is').replace(/\b1n\b/g, 'in').replace(/\b1f\b/g, 'if').replace(/\b0f\b/g, 'of').replace(/\b0r\b/g, 'or')
      .replace(/\bm (?=(your|vour|the|thc)\b)/g, 'in ')
      .trim();
    // junk read from the line above the question: "w in your capacity", "© are the entries", "ee a are the"
    for (let i = 0; i < 4; i++) {
      const m = q.match(/^\s*([^a-z\s]{1,6}|[a-z]{1,2})\s+/);
      if (!m) break;
      if (OK_SHORT_WORDS.test(m[1]) && m[1] !== 'a') break;
      q = q.slice(m[0].length);
    }
    q = q.replace(/[a-z]+/g, repairWord).replace(/photographed ?on/g, 'photographed on').replace(/attached ?to/g, 'attached to');
    // The first word of a line is the one most often lost: "[Are] the films kept…?"
    if (/\?\s*$/.test(q) && /^(the|these|those|such|you|your|films?|records?|name)\b/.test(q)) q = 'are ' + q;
    return q;
  };

  // Thin horizontal strokes / rectangles (underlines, signature lines) in page space: [{x, y, w}].
  function horizontalLines(ol, O) {
    const mul = (m, n) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3],
      m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
    const tp = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
    let ctm = [1, 0, 0, 1, 0, 0], fillWhite = false, strokeWhite = false;
    const stack = [], raw = [];
    const white = c => c && c.length >= 3 && c[0] > 240 && c[1] > 240 && c[2] > 240;
    const STROKE = new Set([O.stroke, O.closeStroke]);
    const FILL = new Set([O.fill, O.eoFill, O.fillStroke, O.eoFillStroke, O.closeFillStroke, O.closeEOFillStroke]);
    for (let i = 0; i < ol.fnArray.length; i++) {
      const fn = ol.fnArray[i], a = ol.argsArray[i];
      if (fn === O.save) stack.push({ ctm: ctm.slice(), fillWhite, strokeWhite });
      else if (fn === O.restore) { const st = stack.pop(); if (st) ({ ctm, fillWhite, strokeWhite } = st); }
      else if (fn === O.transform) ctm = mul(ctm, a);
      else if (fn === O.setFillRGBColor) fillWhite = white(a);
      else if (fn === O.setStrokeRGBColor) strokeWhite = white(a);
      else if (fn === O.constructPath) {
        // Only a path that is painted (not a clip / endPath) in a non-white colour is seen on the page.
        const paint = ol.fnArray[i + 1];
        if (!((STROKE.has(paint) && !strokeWhite) || (FILL.has(paint) && !fillWhite))) continue;
        const [sub, co] = a;
        let k = 0, cur = null;
        for (const op of sub) {
          if (op === O.rectangle) {
            const [x, y, w, h] = co.slice(k, k + 4); k += 4;
            const p1 = tp(ctm, x, y), p2 = tp(ctm, x + w, y + h);
            if (Math.abs(p2[1] - p1[1]) <= 2.5 && Math.abs(p2[0] - p1[0]) >= 8)
              raw.push({ x: Math.min(p1[0], p2[0]), y: Math.min(p1[1], p2[1]), w: Math.abs(p2[0] - p1[0]) });
          } else if (op === O.moveTo) { cur = tp(ctm, co[k], co[k + 1]); k += 2; }
          else if (op === O.lineTo) {
            const p = tp(ctm, co[k], co[k + 1]); k += 2;
            if (cur && Math.abs(p[1] - cur[1]) < 0.6 && Math.abs(p[0] - cur[0]) >= 8)
              raw.push({ x: Math.min(p[0], cur[0]), y: Math.min(p[1], cur[1]), w: Math.abs(p[0] - cur[0]) });
            cur = p;
          } else if (op === O.curveTo) k += 6;
          else if (op === O.curveTo2 || op === O.curveTo3) k += 4;
        }
      }
    }
    // Word draws an underline as 2–4 strokes ~1pt apart — keep one per underline.
    raw.sort((p, q) => q.y - p.y || p.x - q.x);
    const out = [];
    for (const l of raw) {
      const dup = out.find(o => Math.abs(o.y - l.y) < 2.2 && Math.min(o.x + o.w, l.x + l.w) - Math.max(o.x, l.x) > 0.8 * Math.min(o.w, l.w));
      if (dup) { const x1 = Math.max(dup.x + dup.w, l.x + l.w); dup.x = Math.min(dup.x, l.x); dup.w = x1 - dup.x; dup.y = Math.min(dup.y, l.y); }
      else out.push({ ...l });
    }
    return out;
  }

  // unicode char -> advance width (1/1000 em) from a pdf.js font object.
  function glyphWidths(f) {
    if (!f || !f.widths || !f.toUnicode) return null;
    const map = new Map();
    const tu = f.toUnicode._map || f.toUnicode;
    const scale = f.fontMatrix ? f.fontMatrix[0] * 1000 : 1;
    for (const code in tu) {
      const uni = tu[code], w = f.widths[code];
      if (typeof uni === 'string' && uni.length === 1 && typeof w === 'number' && w > 0 && !map.has(uni)) map.set(uni, w * scale);
    }
    return map.has('_') ? map : null;
  }

  // Groups items into text lines (top → bottom). `skip` = set of item indexes to ignore.
  function buildLines(page, skip) {
    const its = page.items.map((it, i) => ({ ...it, i })).filter(it => !skip || !skip.has(it.i));
    its.sort((a, b) => b.y - a.y || a.x - b.x);
    const lines = [];
    for (const it of its) {
      const tol = Math.max(2, it.h * 0.35);
      let line = lines.find(l => Math.abs(l.y - it.y) <= tol);
      if (!line) { line = { y: it.y, items: [] }; lines.push(line); }
      line.items.push(it);
    }
    lines.sort((a, b) => b.y - a.y);
    for (const l of lines) {
      l.items.sort((a, b) => a.x - b.x);
      l.text = joinItems(l.items);
    }
    return lines;
  }
  function joinItems(items) {
    let s = '', prevEnd = null;
    for (const it of items) {
      if (prevEnd != null && it.x - prevEnd > 0.8 && !/\s$/.test(s) && !/^\s/.test(it.str)) s += ' ';
      s += it.str;
      prevEnd = it.x + it.w;
    }
    return s.replace(/\s+/g, ' ').trim();
  }
  AE.pageLines = function (page) {
    if (!page._lines) page._lines = buildLines(page, null);
    return page._lines;
  };
  AE.fullText = function (pages) {
    return pages.map(p => AE.pageLines(p).map(l => l.text).join('\n')).join('\n');
  };

  // ------------------------------------------------------ blank detection
  // Pages that belong to someone else (process server, attorney) — their blanks are never ours to fill.
  const OTHER_PARTY = /officer'?s return|process server|person making service|return for completion|return of service|attorney certification|statement of assurance|respectfully submitted|certificate of service/i;
  // Only affidavit / deposition-question pages are ever written on. Letters, HIPAA authorizations,
  // attestations and every other form stay exactly as they came in.
  const AFFIDAVIT_PAGE = /\bsworn\b|\bsubscribed\b|questions to be propounded|^\s*(answer|ans)\s*[:;]|\s(answer|ans)\s*[:;]\s*(_|\$|$)|^\s*A\s*[.:]\s*[_\-—.]*\s*$/im;
  const AFFIDAVIT_WORD = /affidavit|direct questions|questions to be propounded|\b(answer|ans)\s*[:;]|^\s*A\s*[.:]\s*[_\-—.]*\s*$/im;
  const AUTH_PAGE = /authoriz|hipaa|release of (medical |health )?information|attestation|reproductive health|protected health information/i;
  AE.isAffidavitText = t => AFFIDAVIT_PAGE.test(t) && !OTHER_PARTY.test(t) && !(AUTH_PAGE.test(t) && !AFFIDAVIT_WORD.test(t));
  AE.isAffidavitPage = page => AE.isAffidavitText(AE.pageLines(page).map(l => l.text).join('\n'));

  AE.findBlanks = function (pages) {
    const blanks = [];
    let prevTail = ''; // last lines of the previous page, for questions that continue across a page break
    for (const page of pages) {
      const tail = prevTail;
      prevTail = AE.pageLines(page).slice(-6).map(l => l.text).join(' ');
      const found = [];
      page.items.forEach((it, idx) => {
        if (!/__/.test(it.str) && !/^[_\s.,;:]*_[_\s.,;:]*$/.test(it.str)) return;
        const rx = /_+/g; let m;
        const fw = page.fontWidths && page.fontWidths[it.font];
        const measure = fw ? (str => { let t = 0; for (const ch of str) t += fw.get(ch) ?? fw.get(' ') ?? 500; return t; })
                           : (str => AE.textW(str, 1000));
        const scale = it.w / (measure(it.str) || 1);
        while ((m = rx.exec(it.str))) {
          if (m[0].length < 2 && /[A-Za-z0-9]/.test(it.str.replace(/_/g, ''))) continue; // a lone "_" inside words
          const x = it.x + measure(it.str.slice(0, m.index)) * scale;
          const w = measure(m[0]) * scale;
          found.push({ page: page.num, itemIdx: idx, x, y: it.y, w, h: it.h, raw: it.str, mIndex: m.index, mLen: m[0].length });
        }
      });
      addAnchorBlanks(page, found);
      addLineBlanks(page, found);
      if (!found.length) continue;
      found.sort((a, c) => (Math.abs(a.y - c.y) < 3 ? 0 : c.y - a.y) || a.x - c.x);
      mergeSegments(page, found);

      // Text already written over a blank (a previously filled copy) — keep it out of the context.
      const overlay = new Map(); // item idx -> blank
      const anchors = new Set(found.map(b => b.itemIdx));
      page.items.forEach((it, idx) => {
        if (/__|^_+[.,]?$/.test(it.str) || /^[\s.,;:§)(]+$/.test(it.str) || anchors.has(idx)) return;
        for (const b of found) {
          const ox = Math.min(it.x + it.w, b.x + b.w) - Math.max(it.x, b.x);
          const dy = it.y - b.y;
          if (ox > Math.min(it.w, b.w) * 0.5 && dy > -3 && dy < b.h * 0.95) { overlay.set(idx, b); break; }
        }
      });
      const lines = buildLines(page, new Set(overlay.keys()));
      // "Affidavit / Certificate of No Records" — only signed when nothing was found, so its blanks start unticked.
      const noRec = lines.find(l => /^\s*(affidavit|certificate|certification|declaration) of no (medical |billing )?records?\b/i.test(l.text));
      for (const b of found) {
        b.noRecords = !!noRec && b.y < noRec.y + 2;
        b.ocr = !!page.ocr;
        let li = b.itemIdx != null ? lines.findIndex(l => l.items.some(it => it.i === b.itemIdx)) : -1;
        if (li < 0) {
          // A drawn underline: the text line it sits on, or (signature line) its place between two lines.
          let best = -1;
          lines.forEach((l, k) => { if (Math.abs(l.y - b.y) < 4 && (best < 0 || Math.abs(l.y - b.y) < Math.abs(lines[best].y - b.y))) best = k; });
          li = best;
        }
        let line = lines[li], prevIdx = li - 1, nextIdx = li + 1;
        if (!line) {
          const below = lines.findIndex(l => l.y < b.y);
          line = { items: [], text: '' };
          prevIdx = (below < 0 ? lines.length : below) - 1;
          nextIdx = below < 0 ? lines.length : below;
        }
        const before = line.items.filter(it => it.i !== b.itemIdx && it.x + it.w <= b.x + 1);
        const after = line.items.filter(it => it.i !== b.itemIdx && it.x >= b.x + b.w - 1);
        b.prefix = (joinItems(before) + ' ' + b.raw.slice(0, b.mIndex)).replace(/\s+/g, ' ').trim();
        b.suffix = (b.raw.slice(b.mIndex + b.mLen) + ' ' + (b.tail || '') + ' ' + joinItems(after)).replace(/\s+/g, ' ').trim();
        b.prevLine = prevIdx >= 0 ? lines[prevIdx].text : '';
        // up to 20 lines back: a question that quotes the whole subpoena request can run 17 lines
        b.prevLines = (prevIdx < 7 ? tail + ' ' : '') + lines.slice(Math.max(0, prevIdx - 19), prevIdx + 1).map(l => l.text).join(' ');
        b.nextLine = nextIdx < lines.length ? lines[nextIdx].text : '';
        b.lineText = line.text;
        const pre = [...overlay.entries()].filter(([, ob]) => ob === b).map(([i]) => page.items[i]);
        if (b.inline) pre.push(b.inline); // "Answer: yes" read as one piece of text
        b.prefilled = pre.length ? joinItems(pre.sort((a, c) => a.x - c.x)) : '';
        b.prefilledBox = pre.length ? {
          x0: Math.min(...pre.map(i => i.x)), x1: Math.max(...pre.map(i => i.x + i.w)),
          y0: Math.min(...pre.map(i => i.y)), y1: Math.max(...pre.map(i => i.y + i.h))
        } : null;
        const pageText = lines.map(l => l.text).join('\n');
        b.otherParty = OTHER_PARTY.test(pageText);
        b.pageHasAffidavit = AE.isAffidavitText(pageText);
        b.id = `p${page.num}_${Math.round(b.x)}_${Math.round(b.y)}`;
        blanks.push(b);
      }
    }
    classifyAll(blanks);
    return blanks.filter(b => !(b.virtual && b.kind === 'unknown'));
  };

  const overlapX = (a, b) => Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  // On a crooked scan a line's height changes along its length.
  const lineYAt = (ln, x) => (ln.yL == null ? ln.y : ln.yL + (ln.yR - ln.yL) * Math.max(0, Math.min(1, (x - ln.x) / Math.max(1, ln.w))));
  // Does this printed line lie under (or just through) this word or blank? OCR puts a word's y a little above the underline.
  const onRow = (ln, it) => { const d = lineYAt(ln, it.x) - it.y; return d > -9 && d < 4; };

  // Blanks drawn as underlines (Word: underlined spaces, signature lines). An underline under printed
  // words (a title, an underlined name) is not a blank. One that runs into a "____" blank widens it.
  function addLineBlanks(page, found) {
    for (const ln of page.hlines || []) {
      if (ln.w < 8 || ln.w > page.width * 0.85) continue; // an answer underline can be 462pt; full-width rules are not blanks
      if (page.ocr) {
        // The line of an "Answer:" belongs to that one blank, however many pieces the scan broke it into.
        if (ln.usedByAnswer) continue;
        if (found.some(b => b.answerRow && onRow(ln, b))) continue;
        // Dirt and letter strokes make short "lines". A real short blank has words beside it ("day of ____, 20__").
        const row = page.items.filter(it => onRow(ln, it));
        const rowText = row.map(it => it.str).join(' ');
        const min = !row.some(it => /[a-z0-9]{2,}/i.test(it.str)) ? 90 : (NOTARY_LINE.test(rowText) ? 18 : 40);
        if (ln.w < min) continue;
      }
      const joined = found.find(b => Math.abs(b.y - ln.y) < 6 && overlapX(b, ln) > -2);
      if (joined) {
        let x0 = Math.min(joined.x, ln.x), x1 = Math.max(joined.x + joined.w, ln.x + ln.w);
        for (const it of page.items) {
          if (/__|^_+[.,]?$/.test(it.str) || Math.abs(it.y - joined.y) > 3) continue;
          if (it.x + it.w <= joined.x + 1 && it.x + it.w > x0) x0 = it.x + it.w + 1;  // e.g. "$"
          if (it.x >= joined.x + joined.w - 1 && it.x < x1) x1 = it.x - 1;           // e.g. "."
        }
        joined.x = Math.min(joined.x, x0); joined.w = Math.max(joined.x + joined.w, x1) - joined.x;
        continue;
      }
      const onIt = page.items.filter(it => !/__|^_+[.,]?$/.test(it.str) && !/^[\s.,;:]+$/.test(it.str) && it.y >= ln.y - 1.5 && it.y - ln.y < 7);
      const covered = onIt.reduce((s, it) => s + Math.max(0, overlapX(it, ln)), 0);
      if (covered > ln.w * 0.35) continue;
      const near = page.items.filter(it => it.y >= ln.y - 1.5 && it.y - ln.y < 7);
      const ys = near.map(it => it.y).sort((a, c) => a - c);
      const hs = near.map(it => it.h).sort((a, c) => a - c);
      found.push({
        page: page.num, itemIdx: null, x: ln.x, y: ys.length ? ys[Math.floor(ys.length / 2)] : ln.y + 2,
        w: ln.w, h: Math.min(hs.length ? hs[Math.floor(hs.length / 2)] : 11, 13), raw: '', mIndex: 0, mLen: 0, virtual: true
      });
    }
  }

  // "____ ____" or an underline followed by "____" with nothing in between is one blank, not two.
  function mergeSegments(page, found) {
    for (let k = 0; k < found.length - 1; k++) {
      const a = found[k], b = found[k + 1];
      if (Math.abs(a.y - b.y) > (page.ocr ? 6 : 3)) continue;
      const gap = b.x - (a.x + a.w);
      if (gap > 12) continue;
      const between = page.items.some((it, i) => i !== a.itemIdx && i !== b.itemIdx && !/^[_\s]+$/.test(it.str) &&
        it.x + it.w > a.x + a.w + 1 && it.x < b.x - 1 && Math.abs(it.y - a.y) < 3);
      if (between) continue;
      if (a.itemIdx != null && a.itemIdx === b.itemIdx) {
        // both runs in one piece of text: "$__________ __________."
        if (/\S/.test(a.raw.slice(a.mIndex + a.mLen, b.mIndex).replace(/_/g, ''))) continue;
        a.mLen = b.mIndex + b.mLen - a.mIndex;
        a.tail = b.tail || '';
      } else {
        a.tail = (b.raw ? b.raw.slice(b.mIndex + b.mLen) : '') + (b.tail ? ' ' + b.tail : '');
        if (a.itemIdx == null && b.itemIdx != null) { a.itemIdx = b.itemIdx; a.raw = b.raw.slice(0, b.mIndex); a.mIndex = b.mIndex; a.mLen = 0; a.tail = b.raw.slice(b.mIndex + b.mLen) + (b.tail ? ' ' + b.tail : ''); }
      }
      a.w = Math.max(a.w, b.x + b.w - a.x);
      a.virtual = a.virtual && b.virtual;
      found.splice(k + 1, 1);
      k--;
    }
  }

  /*
   * Scanned forms have no "____" in their text — the lines are only in the image. Make blanks from the words around them:
   *  - "Answer:" / "Answer: $" → the space after it up to the next word or the right margin
   *  - sworn / notary lines → wide gaps between words ("on this ___ day of ___, 20__", "in ___ County")
   *  - a line ending in "personally appeared" / "State of" / "County of" → the rest of the line
   */
  const NOTARY_LINE = /sworn|subscribed|day of|county of|state of|appeared|seal of office|commission|expires/i;
  const LINE_END = /(appeared|state of|county of|my name is|in and for)\s*[,:]?$/i;
  function addAnchorBlanks(page, found) {
    if (found.length && !page.ocr) return; // the page has real "____" blanks — use those only
    const right = page.x0 + page.width - 45;
    // Values someone already typed onto the form use another font (and size) than the page's own text.
    const fontLen = {};
    page.items.forEach(it => { fontLen[it.font] = (fontLen[it.font] || 0) + it.str.length; });
    const mainFont = Object.keys(fontLen).sort((a, c) => fontLen[c] - fontLen[a])[0];
    const allLines = buildLines(page, null);
    allLines.forEach((line, li) => {
      const hs = line.items.filter(it => it.font === mainFont).map(it => it.h).sort((a, c) => a - c);
      const medH = hs[Math.floor(hs.length / 2)] || 10;
      // OCR reads a printed underline as "____" / "——" — that is part of the blank, not a word.
      const isLabel = it => /^\s*(answer|ans)\s*[:;]/i.test(it.str); // "Answer:" may be in its own font
      const form = line.items.filter(it => (isLabel(it) || (it.font === mainFont && Math.abs(it.h - medH) / medH <= 0.5)) && !/^[_\-—–=~.·,]+$/.test(it.str));
      const notaryLine = NOTARY_LINE.test(line.text) || (li > 0 && NOTARY_LINE.test(allLines[li - 1].text));
      const blank = (it, x, xEnd, labelLen, inline) => {
        if (xEnd - x < 12) return;
        found.push({ page: page.num, itemIdx: it.i, x, y: it.y, w: xEnd - x, h: Math.max(it.h, 10), virtual: true,
          raw: it.str.slice(0, labelLen), mIndex: labelLen, mLen: 0, inline });
      };
      form.forEach((it, k) => {
        const next = form[k + 1];
        const xEnd = next ? next.x - 3 : right;
        const m = it.str.match(/^\s*(answer|ans)\s*[:;]\s*\$?\s*/i) ||
          (k === 0 && it.str.match(/^\s*A\s*[.:]?\s*[_\-—.]*$/) && !form.slice(1).some(o => /[A-Za-z0-9]/.test(o.str)) ? [it.str] : null);
        if (m) {
          const labelW = it.w * m[0].length / Math.max(it.str.length, 1);
          const rest = it.str.slice(m[0].length).trim();
          const inline = rest ? { str: rest, x: it.x + labelW, y: it.y, w: it.w - labelW, h: it.h } : null;
          if (page.ocr) {
            // The printed line says where the blank ends, not whatever the OCR read on top of it. Anything really
            // written there ("Answer: yes") stays inside the blank and shows as "already has".
            const labelEnd = it.x + labelW;
            const row = (page.hlines || []).filter(ln => ln.w <= page.width * 0.85 && onRow(ln, it) && ln.x + ln.w > labelEnd + 15 && ln.x < labelEnd + 60);
            const later = form.slice(k + 1);
            const stop = later.find(o => /[A-Za-z]{2,}\s*:$/.test(o.str)); // "Answer: ____  Date: ____"
            const noLine = later.length > 4 ? later[0].x - 3 : right;       // no line found: a sentence ends the blank, a word or two does not
            let end = row.length ? Math.max(...row.map(ln => ln.x + ln.w)) : noLine;
            if (stop && stop.x > labelEnd + 20) end = Math.min(end, stop.x - 3);
            row.forEach(ln => { ln.usedByAnswer = true; });
            // "Answer:" alone with the line on the row below it: that line is this answer's, not a second blank
            if (!row.length) (page.hlines || []).forEach(ln => { const d = lineYAt(ln, it.x) - it.y; if (d <= -9 && d > -26 && Math.abs(ln.x - it.x) < 25 && ln.w > 100) ln.usedByAnswer = true; });
            const before = found.length;
            blank(it, labelEnd + 3, end, m[0].length, inline);
            if (found.length > before) found[before].answerRow = true;
            return;
          }
          if (!next || next.x - (it.x + it.w) > 12 || inline) blank(it, it.x + labelW + 3, inline ? Math.max(xEnd, it.x + it.w + 40) : xEnd, m[0].length, inline);
          return;
        }
        if (!notaryLine) return;
        if (page.ocr && (page.hlines || []).some(ln => onRow(ln, it))) return;
        const gap = (next ? next.x : right) - (it.x + it.w);
        const upTo = form.slice(0, k + 1).map(o => o.str).join(' ').trim();
        if (next && gap > 14) blank(it, it.x + it.w + 2, next.x - 2, it.str.length);
        else if (!next && gap > 50 && LINE_END.test(upTo)) blank(it, it.x + it.w + 3, Math.min(right, it.x + it.w + 180), it.str.length);
        else if (!next && /^20\.?$/.test(it.str.trim()) && gap > 20) blank(it, it.x + it.w + 1, it.x + it.w + 22, it.str.length);
      });
    });
  }

  function classifyAll(blanks) {
    let prev = null;
    for (const b of blanks) {
      b.kind = classify(b, prev);
      prev = b;
    }
  }

  function classify(b, prev) {
    const pre = b.prefix.toLowerCase();
    const suf = b.suffix.toLowerCase();
    // Nearest label only: text between the previous blank and this one, and up to the next blank.
    // When there is no wording on this line, look at the line above / below.
    const preL = pre.split(/_{2,}/).pop().trim();
    const sufL = suf.split(/_{2,}/)[0].trim();
    const hasWords = s => /[a-z]{3,}/.test(s);
    const before = (hasWords(preL) ? preL : b.prevLine.toLowerCase() + ' ' + preL).replace(/\s+/g, ' ').trim();
    const after = (hasWords(sufL) ? sufL : sufL + ' ' + b.nextLine.toLowerCase()).replace(/\s+/g, ' ').trim();
    const next = b.nextLine.toLowerCase();
    const sameLinePrev = prev && prev.page === b.page && Math.abs(prev.y - b.y) < 2;

    // Stand-alone line with a caption underneath → signature / printed name line.
    const continues = /(county of|state of|day of|appeared|name is|records (of|for)|business of|representative of|kept by|for|which)\s*[,:]?$/.test(b.prevLine.toLowerCase().replace(/[_\s]+$/, ''));
    const dateDone = b.ocr && prev && prev.page === b.page && !sameLinePrev && /^notary_(month|year)/.test(prev.kind);
    if ((!continues || dateDone) && !pre.replace(/[^a-z0-9$]/g, '') && !suf.replace(/[^a-z0-9$]/g, '')) {
      if (/notary|printer name/.test(next)) return 'notary_sig';
      if (/printed name|print name|name \(print/.test(next)) return 'custodian';
      if (/^\s*title/.test(next)) return 'title';
      if (/notary/.test(next)) return 'notary_sig';
      if (/affiant|signature|custodian|authorized|records (custodian|clerk)|witness|declarant/.test(next)) return 'signature';
    }
    if (/commission expires|my commission/.test(before) || /commission expires/.test(suf)) return 'commission';

    // Money
    const answerLabel = /\b(answer|ans)\s*[:;.]?\s*\$?\s*$/.test(preL) || /^a\s*[:.]?\s*$/.test(preL);
    if (!answerLabel && (/\$\s*$/.test(pre) || /^\s*dollars/.test(suf))) {
      // "Total charges: $____" → label before; "a. $____ Total amount charged…" → label after.
      const lab = preL.replace(/\$\s*$/, '').replace(/^\(?[a-e][.)]\s*/, '');
      const kind = src => {
        if (/plus|item c|c\s*\+\s*d/.test(src)) return 'amt_paid_plus_balance';
        if (/turned over|collection/.test(src)) return 'amt_collection';
        // who still owes / who paid: the patient vs. insurance, Medicaid, Medicare or another payor
        if (/(owing|owed|owes|due)\b.*\b(insur|medicaid|medicare|payor|payer)/.test(src)) return 'amt_payor_owing';
        if (/(owing|owed|owes)\b.*\b(patient|plaintiff|claimant|guarantor)/.test(src)) return 'amt_balance';
        if (/paid by (the )?(patient|plaintiff|claimant|guarantor)/.test(src)) return 'amt_pt_paid';
        if (/paid by .*(insur|medicaid|medicare|payor|payer)/.test(src)) return 'amt_payor_paid';
        if (/written off|write[- ]?off|discount/.test(src)) return 'amt_writeoff';
        if (/unpaid|right to be paid|outstanding|balance|legally entitled|due|remains owing|still owing/.test(src)) return 'amt_balance';
        if (/amount paid|been paid|paid for|payments?\b/.test(src)) return 'amt_paid';
        if (/total amount|billed|charged|charges/.test(src)) return 'amt_total';
        return null;
      };
      // the clause right before "$": "…currently unpaid but which ___ has a right to be paid after any adjustments or credits is $"
      const clause = (b.prevLine + ' ' + preL).toLowerCase().split(/[.;]\s/).pop();
      // "$____ was paid by the patient;" / "$____ remains owing by…" — the words after the blank say what it is
      const afterFirst = /^\s*(was|were|is|are|remains?|has been|have been)\b/.test(sufL);
      return (hasWords(lab) && kind(lab)) || (afterFirst && kind(after)) || kind(clause) || kind(after) || 'amt_total';
    }

    // Deposition on written questions: "ANSWER: ______" → decide from the question above it.
    if (answerLabel || (!hasWords(preL) && /\banswer\s*[:;.]?\s*$/i.test(b.prevLine))) {
      const MARK = '\u0001';
      const ctx = (b.prevLines + ' ' + b.prefix + ' ').replace(/_{2,}/g, ' ') // original case: "A." is a label, "a." is not
        // a middle initial ("JOHN A. DOE") is not an "A." answer or item label
        .replace(/(\b[A-Za-z]{2,}) ([A-Z])\. (?=[A-Z][A-Za-z'-]+\b)(?!(?:TOTAL|AMOUNT|THE|WHAT|HOW|PLEASE|DATE|NAME)\b)/g, '$1 $2 ')
        .replace(/\b(?:answer|ans)\s*[:;]/gi, MARK)                     // "Answer:" / "Answer;"
        .replace(/\b(?:answer|ans)\s*\.?\s*$/i, MARK)                    // this blank's own "Answer"
        .replace(/(^|\s)A\s*[.:]?(?=\s+(?:\d{1,2}[.\s]|$))/g, '$1' + MARK) // "A." / "A" before the next question
        .replace(/\s[QA]\s*[:.]\s/g, ' ' + MARK + ' ');                   // "Q: … A: …"
      const parts = ctx.split(MARK);
      let q = (parts.length > 1 ? parts[parts.length - 2] : ctx).replace(/\s+/g, ' ').trim();
      // Keep only the last numbered item: "22. Please fill in… (A) Total amount for all medical bill:" → "Total amount…"
      // ("8) Were these records…" numbers too — so a footer like "YZ01 - 66623-59-59" from the page before is dropped)
      const items = q.split(/(?:^|\s)(?:\d{1,2}[.)]|\(?[A-Fa-f][.)])\s+/).filter(s => s.trim());
      if (items.length) q = items[items.length - 1].trim();
      b.dwq = true;
      b.dollarPrinted = /\$\s*$/.test(pre);
      b.question = q;
      return classifyQuestion(b.ocr ? AE.ocrFix(q) : q.toLowerCase());
    }

    // "(a) The total amount for all medical billed is: ____" — an amount sentence that ends in "is:"
    const amountLabel = hasWords(preL) ? preL : before;
    if (/amount/.test(amountLabel) && /\b(is|was)\s*:?\s*$/.test(amountLabel)) {
      const k = classifyQuestion(amountLabel.split(/(?:^|\s)\(?[a-f]\)\s*/).pop());
      if (/^amt_/.test(k)) return k;
    }

    // Affiant name
    if (/^\(?\s*name of affiant/.test(suf) || /my name is\s*$/.test(pre) ||
        /(personally appeared|appeared|personally|came and appeared)\s*$/.test(before) ||
        /(full name|state your name|name of (the )?(affiant|custodian|declarant))\s*[:?]?\s*$/.test(before)) return 'custodian';

    const lead = hasWords(preL) ? pre : before; // the label may end the previous line
    if (/county of\s*$/.test(lead) || /^\s*county\b/.test(suf)) return 'county';
    if (/state of\s*$/.test(lead)) return 'state';

    if (/^\s*(total\s+)?pages?\b/.test(suf) || /(number of pages|total pages|no\. of pages|pages)\s*[:?]?\s*$/.test(pre)) return 'pages';

    // Sworn/notary date
    if (/^\s*(st|nd|rd|th)?\s*day of/.test(suf) || (/^\s*(st|nd|rd|th)?\s*day\b/.test(suf) && /\b(this|the|on)\s*$/.test(pre))) return 'notary_day';
    if (b.ocr && sameLinePrev && prev.kind === 'notary_month' && b.w < 60) return 'notary_year2';
    if (/d ?a ?y of\s*$/.test(lead)) return 'notary_month'; // some PDFs split the word: "da y of"
    if (sameLinePrev && /^notary_(month|day)$/.test(prev.kind) && /,?\s*20\.?\s*$/.test(pre)) return 'notary_year2';
    if (sameLinePrev && prev.kind === 'notary_month' && /,\s*$/.test(pre)) return 'notary_year4';
    if (/(subscribed|sworn)[^.]*\b(on|this)\s*$/.test(before) || /(subscribed|sworn)[^.]*before me,?\s*$/.test(before)) return 'notary_date';

    // Dates of service written as "from ________, 20__ to ________, 20__" (month + day, then the year's last digits)
    if (/^\s*,\s*(20|19)?\s*$/.test(sufL) || /^\s*,\s*(20|19)\b/.test(suf)) {
      if (/\bfrom\s*$/.test(lead)) return 'dos_from_md';
      if (/\b(to|through|thru)\s*$/.test(lead)) return 'dos_to_md';
    }
    if (sameLinePrev && /^dos_(from|to)_md$/.test(prev.kind) && /,?\s*(20|19)\.?\s*$/.test(pre)) return prev.kind.replace('_md', '_y2');

    // Dates of service
    if (/\bfrom\s*$/.test(pre) && /^\s*(to|through|thru|until|-)\b/.test(after)) return 'dos_from';
    if (/records (from|dated from)\s*$/.test(pre)) return 'dos_range';
    // "…records from <dates> for ____" → the patient
    if (/\bfor\s*$/.test(pre) && sameLinePrev && /^dos_/.test(prev.kind)) return 'patient';
    // "from ____ to ⏎ ____." — the "to" may end the line above
    if (/\b(to|through|thru)\s*$/.test(lead) && /\bfrom\b/.test(b.prevLine.toLowerCase() + ' ' + pre) && !/^\s*the present/.test(sufL)) return 'dos_to';
    if (/(dates? of service|\bdos\b|service dates?)\s*[:?]?\s*$/.test(before)) return 'dos_range';

    if (/(date of birth|\bdob\b|d\.o\.b\.?|birth ?date)( of)?\s*[:?]?\s*$/.test(before)) return 'dob';
    // "____, with the date of birth of ____" — the name comes right before its date of birth
    if (/^\s*,?\s*(with )?(the |a )?(date of birth|dob|d\.o\.b)/.test(suf)) return 'patient';
    if (/provided to\s*$/.test(lead) || /plaintiff,?\s*$/.test(pre)) return 'patient';
    if (/^\s*(provided to|(still )?has a right to be paid|has the right)/.test(sufL)) return 'facility';
    // "Attached hereto is/are ____ CD(s) of records/materials pertaining to ____" — only for CDs or films, left empty
    if (/\b(cd\(?s?\)?|films?|x-?rays?)\b[^_]*pertaining to\s*$/.test(pre)) return 'unknown';
    if (/(pertaining to|patient(?:'s)? name|name of patient|\bpatient|\bre|regarding|in reference to)\s*[:?]?\s*$/.test(pre) ||
        /^\s*\(?\s*(patient|name of patient)/.test(suf)) return 'patient';
    if (/(custodian of (the )?(medical |billing )?records (for|of)|records custodian for|custodian for|employed by|kept by|course of business of|business of|representative of|health ?care provider|name of (the )?(facility|provider|hospital)|facility|provider|hospital)\s*[:?]?\s*$/.test(before) ||
        /^\s*\(?\s*(name of (the )?(facility|provider|hospital)|facility|provider)\b/.test(suf)) return 'facility';
    if (/(title|position|capacity)\s*[:?]?\s*$/.test(pre)) return 'title';
    if (/(from|beginning)\s*$/.test(pre)) return /^\s*(to|through|thru)\b/.test(after) ? 'dos_from' : 'dos_range';
    return 'unknown';
  }

  // ---------------------------------------------------- facility profiles
  AE.normName = s => String(s || '').toLowerCase().replace(/\./g, '').replace(/\bd\s*\/\s*b\s*\/\s*a\b/g, 'dba').replace(/&/g, ' and ').replace(/care\s+capital/g, 'carecapital')
    .replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  // "Psychiatry of Texas c/o CareCapital" → "Psychiatry of Texas" (only for matching a request to the facility list)
  AE.baseName = name => String(name || '').split(/\s+c\/o\s+/i)[0].trim();
  // Name printed on the affidavit: the full name, "c/o CareCapital" included (user's rule).
  AE.affidavitName = name => String(name || '').replace(/\s+/g, ' ').trim();
  // Every way a facility may be written: full name, without "c/o …", both sides of "DBA", without MD/PA/PLLC.
  AE.facilityAliases = function (name) {
    const parts = new Set([name, AE.baseName(name)]);
    AE.baseName(name).split(/\s+d\/?b\/?a\/?\s+/i).forEach(x => parts.add(x));
    for (const p of [...parts]) {
      // drop credentials and single initials: "M. Radwan Al-Sabbagh, MD., PA" → "radwan al sabbagh"
      parts.add(AE.normName(p).split(' ').filter(t => t.length > 1 && !/^(md|pa|pllc|llc|inc|do|dr|lp|ltd|pc)$/.test(t)).join(' '));
    }
    return [...new Set([...parts].map(AE.normName))].filter(a => a.length >= 8 && a.includes(' '));
  };
  // Best facility profile named in `text` (longest alias wins; more mentions breaks ties).
  // OCR often loses the "&" of a name or reads it as "8" ("RIVER OAKS HOSPITAL 8 CLINICS"), so names are compared without "and".
  const noAnd = s => (' ' + s + ' ').replace(/ (and|8) /g, ' ').replace(/ (and|8) /g, ' ').replace(/\s+/g, ' ');
  AE.matchFacility = function (text, profiles) {
    const t = noAnd(AE.normName(text));
    // Text whose spaces were lost ("RIVEROAKS HOSPITAL") still matches, but only as whole words:
    // "BROAD HOSPITAL EASTEX" must not contain "AD Hospital East".
    let tc = '';
    const startsWord = [], endsWord = [];
    for (let i = 0; i < t.length; i++) {
      if (t[i] === ' ') continue;
      startsWord.push(t[i - 1] === ' ');
      endsWord.push(t[i + 1] === ' ');
      tc += t[i];
    }
    const wholeWordsNoSpace = s => {
      let n = 0;
      for (let k = tc.indexOf(s); k >= 0; k = tc.indexOf(s, k + 1)) if (startsWord[k] && endsWord[k + s.length - 1]) n++;
      return n;
    };
    let best = null;
    for (const p of profiles || []) {
      for (const a of AE.facilityAliases(p.name).concat(p.affName ? AE.facilityAliases(p.affName) : [])) {
        const b = noAnd(a).trim();
        const count = (t.split(' ' + b + ' ').length - 1) || wholeWordsNoSpace(b.replace(/ /g, ''));
        if (!count) continue;
        const score = a.length * 10 + count;
        if (!best || score > best.score) best = { profile: p, score, alias: a };
      }
    }
    return best;
  };

  // Values the tool can prove from the attachments — a different value already written there gets corrected.
  AE.CORRECTABLE = new Set(['amt_payor_paid', 'amt_collection', 'amt_payor_owing', 'dos_from', 'dos_to', 'dos_range', 'pages', 'amt_total', 'amt_writeoff', 'amt_paid', 'amt_balance', 'amt_paid_plus_balance']);
  AE.sameValue = function (kind, a, b) {
    a = String(a || '').trim(); b = String(b || '').trim();
    if (!a || !b) return a === b;
    if (/^amt_/.test(kind)) return AE.parseMoney(a) === AE.parseMoney(b);
    if (/^dos_(from|to)$/.test(kind)) {
      const da = AE.parseDate(a), db = AE.parseDate(b);
      if (da && db) return da.getTime() === db.getTime();
    }
    return a.toLowerCase().replace(/\s+/g, ' ') === b.toLowerCase().replace(/\s+/g, ' ');
  };

  // Standard DWQ / subpoena questions asked of a custodian of records.
  // Returns a field kind; 'answer' = case-specific question whose answer the app remembers from last time.
  AE.classifyQuestion = classifyQuestion;
  function classifyQuestion(q) {
    q = q.replace(/^\s*(question|q)?\s*(no\.?|#)?\s*\d*\s*[.):-]?\s*/, '')
      .replace(/^if you (have )?answered yes to question (number )?\d+,?\s*/, '')
      // "Of the total amount charged for treatment to X, how much was written off…" → ask only the last part
      .replace(/^of the total amount (charged|billed)[^,]*,\s*/, '');
    const handedOver = /have you (done so|done as requested|complied|(now )?(produced|provided))/.test(q);
    const yesNo = /^(are|is|were|was|have|has|do|does|did|can|will|would|if so)\b/.test(q) ||
      (/,\s*(was|were|is|are|did|does|has|have|will)\s/.test(q) && /\?\s*$/.test(q) && !/^(what|how|please)/.test(q)) ||
      (/\b(have|did|do|are|were|will) you\b[^?]*\?\s*$/.test(q) && !/^(what|how)\b/.test(q)) ||
      /^(please )?state whether/.test(q) || handedOver;
    // "Please release the records… Identify how many pages you have released. Have you done as requested?"
    if (/how many pages|number of pages|total (number of )?pages|amount of pages/.test(q)) return handedOver ? 'yes_pages' : 'pages';
    // "If not, why not?" asked on its own after "Have you complied?" — the records were handed over
    if (/^if (not|no),? (why( not)?|please explain|explain( why)?)\s*[?.]?\s*$/.test(q.trim())) return 'na';
    if (/\bname\b.*\b(title|position|occupation)\b/.test(q)) return /address|residence|telephone/.test(q) ? 'custodian_title_addr' : 'custodian_title';
    // Opinions a records custodian cannot give (reasonable / necessary)
    // also "…qualifications… to reach conclusions regarding medical necessity of treatment…"
    if (/\breasonable(ness)?\b|necessary|necessity/.test(q) && /charge|service|treatment|care/.test(q)) return 'no_info';
    // "In the event that no records can be found, are there archives or retention policies…?" — records were found
    if (/in the event (that )?no records|if no records (can be|are|were) (found|located)/.test(q)) return 'archive';
    // "Have you now provided all the records…?" / "…produced records… other than those made the basis of this suit?"
    if (/have you now provided all|other than (for )?those (records )?made the basis/.test(q)) return 'all_provided';
    // "Have you produced any and all communications with counsel / letters of protection…?" — a custodian produces what is in the file
    if (/have you produced (any and )?all\b/.test(q) && /communications?|letters? of protection|financial interest/.test(q)) return 'all_provided';
    // "…what is the basis of your personal knowledge regarding the billing…?"
    if (/basis of your (personal )?knowledge/.test(q)) return 'knowledge_basis';
    // What only the provider's office or the patient knows: insurance details, Letters of Protection, contracts and
    // negotiated rates, Medicare cost reports and rates, the patient's own doctors and pharmacies.
    if (/insurance (company )?information|insurance compan(y|ies) (were|was) identified|letter(s|\(s\))? of protection|financial interest in (this|the) (lawsuit|suit|case)|negotiated (or reduced )?rates|reduced rates|contracts? regarding|cost reports?|reimbursement rates?|primary care (physician|doctor)|pharmac(y|ies)/.test(q)) return 'no_knowledge';
    // Other providers that may hold records — a custodian cannot know
    if (/^are you aware of any other (hospital|clinic|physician|doctor|provider|facility)/.test(q)) return 'no_knowledge';
    if (/how long.*(maintain|kept|retain)|retention|before destruction/.test(q)) return 'retention';
    // "…please write the name of the private insurer… and the total amount paid by each" — only asked when someone else paid
    if (/name of the (private )?insurer/.test(q) && /amount|paid/.test(q)) return 'payor_names';
    // The provider's contracts, sold accounts and insurance terms — a custodian cannot know these.
    if (/managed care|contractual arrangement|terms of .*coverage|preceding (two|three|four|\d+) questions|purchased or assigned|purchasing third party|contracts? or agreements?|contract\(s\)|contract with medicare/.test(q)) return 'no_knowledge';
    // "Do you have any reason to believe the records have been edited, purged, culled…?" / "…has anyone suggested any part be withheld?"
    if (/reason to believe/.test(q) && /edited|purged|culled|altered|changed|made different/.test(q)) return 'no';
    if (/(requested|directed|suggested)\b/.test(q) && /withheld|protected from discovery/.test(q)) return 'no';
    // "If your answer to the preceding question is yes, please hand a copy of such records to the notary…"
    if (/^if your answer\b.*\byes\b/.test(q) && /\b(hand|attach|produce|furnish|deliver)\b/.test(q) && /\b(cop(y|ies)|records?|films?)\b/.test(q)) return 'yes';
    // "Please hand / release / produce the records to the Officer (Notary)…" / "Have you handed the records to the Officer?"
    if (/\bhave you (now )?handed\b/.test(q) && /officer|notary/.test(q)) return 'yes';
    if (/^please (hand|release|produce|furnish|deliver)\b/.test(q) && /officer|notary|photocopy|exhibit|attach/.test(q)) return 'yes';
    // "Please attach the copies of the records… Have you complied?"
    if (/^please attach\b/.test(q) && /\brecords?\b/.test(q)) return 'yes';
    if (/^(please )?(describe|identify|list) .*not (been )?(provided|produced|handed)/.test(q)) return 'na';
    // "If you have answered the previous question yes, please state the alterations or redactions…" — nothing was removed
    if (/^(if (so|yes)|if you (have )?answered|(please )?(state|describe|list|identify|explain))\b/.test(q) &&
      /alteration|redact|removed|withheld|extracted|destroyed|missing/.test(q)) return 'na';
    if (yesNo) {
      // Nothing was taken out and nothing was held back.
      // Nothing destroyed or missing, no other place or provider holding this patient's records.
      if (/extracted|removed anything|anything (been )?removed|redacted|withheld|altered|destroyed|missing|(that|which) you have not (provided|produced|handed)|^are there any (further|other|additional) (documents|records|locations|places|facilities|offices)|^are you aware of any/.test(q)) return 'no';
      // The custodian (CareCapital) does not manage the provider's accounts receivable.
      if (/responsibility to manage accounts/.test(q)) return 'no';
      // "Has your facility been paid…?" / "…been paid by private insurance, or by any person other than the patient?"
      if (/been paid by (any )?(private )?insur|paid by .*other than/.test(q)) return 'yn_others_paid';
      if (/^(has|have) (your|the|this) (facility|office|provider|practice|clinic|hospital) been paid|^have you been paid/.test(q)) return 'yn_paid';
      // "Has X made or caused to be made any billing records… any payments made by the patient?"
      if (/made or caused\b/.test(q) && /\bpayments?\b/.test(q)) return 'yes_payments';
      // Business-records foundation questions — always "Yes" for a custodian.
      if (/custodian|provider under (medicare|medicaid)|regular(ly)? (course|practice|conducted)|course of regularly|at,? (or )?(near|about) the time|shortly after|reasonably soon|closely related to (or simultaneous with )?the (occurrence|event|act)|simultaneous with the (occurrence|event|act)|maintained as required|as required by (the )?regulations|photographed on|attached to each (film|cd|dvd|image|x-?ray)|aid in (the )?(treatment|diagnosis)|person with knowledge|personal knowledge|exact duplicates?|true and correct|itemized statement|kept in the (regular )?course|possession, custody|custody,? (and |or |and\/or )?(subject to (your )?)?control|sound mind|understand (that )?the subpoena|(received?|accept(ed)?) (a |the )?subpoena|served with a subpoena|kept as described|have you (provided|produced|attached) all|have you (done so|done as requested|complied|(now )?(produced|provided))|legible|permanent part of the records|have you handed|handed over|in your custody|originals or true copies|true copies of|have you attached a complete|provide (medical )?treatment to|authorized .*\bto (produce|testify)|made or caused to be made|trustworth|(examined|treated|counseled|evaluated|seen) (by|at)\b|^are you aware that/.test(q)) return 'yes';
      return 'answer';
    }
    // "Please state your full name and the name and address of your employer."
    if (/your (full |complete )?name\b.*\bemployer/.test(q)) return 'custodian_employer';
    if (/(state|give|what is) your (full |complete )?name|^(please )?state (the )?(full )?name/.test(q)) return 'custodian';
    if (/by whom (are )?you (are )?employed|who (is your employer|employs you|do you work for)|name of (your )?employer|employer'?s name/.test(q))
      return /address/.test(q) ? 'employer_address' : 'facility';
    if (/\b(title|position|capacity)\b/.test(q) && /^(what|state|please)/.test(q)) return 'title';
    // things only the provider's billing system can tell: rates, fee schedules, payor names, "accepted in full"
    if (/\brates?\b|fee schedule|names? of|name\(s\)|payment in full|accepted as payment/.test(q)) return 'answer';
    if (/lien/.test(q)) return 'amt_lien';
    // "…which have been paid by the patient themselves (and not by private insurance or some other person)?"
    if (/paid/.test(q) && /\b(themselves|himself|herself)\b|\(and not by/.test(q)) return 'amt_pt_paid';
    // "What amount of the said current balance does the provider continue to seek from the patient…?"
    if (/continue to seek/.test(q)) return 'amt_sought';
    if (/(said|current) balance/.test(q)) return 'amt_balance';
    if (/total amount (still )?owed and by whom|owed,? and by whom/.test(q)) return 'amt_balance_whom';
    if (/total amount (actually )?paid by all|paid by all payors/.test(q)) return 'amt_paid';
    if (/out[- ]of[- ]pocket/.test(q) && /amount|paid/.test(q)) return 'amt_pt_paid';
    if (/owed/.test(q)) return /owed (to this provider )?by (the )?(third[- ]party|medicare|medicaid|insur)/.test(q) ? 'answer' : 'amt_balance';
    if (/how much .*\bbill|amount .*\bbilled\b/.test(q) && !/paid|written|balance/.test(q)) return 'amt_total';
    if (/amount (actually )?paid to (your|the|this) (facility|provider|office)/.test(q)) return 'amt_paid';
    // "Total amount paid by <the patient's name>" — anyone who is not an insurer, Medicare or "all payors"
    if (/total amount (of )?paid by (?!(the |any )?(private )?insur|medicare|medicaid|all\b|third)/.test(q)) return 'amt_pt_paid';
    if (/charged or billed|amount charged|billed or charged|total amount (of )?(all )?(charges|billed)|(total dollar|full|total|entire) amount of (the )?charges/.test(q)) return 'amt_total';
    if (/written off|charged off|write[- ]?off/.test(q)) return 'amt_writeoff';
    if (/accepted in full satisfaction/.test(q)) return 'answer';
    if (/paid by (the |any )?(private )?insur|paid by the third[- ]party payor/.test(q)) return /amount|paid/.test(q) ? 'amt_ins_paid' : 'answer';
    if (/medicare|medicaid/.test(q)) return /amount|paid/.test(q) ? 'amt_med_paid' : 'answer';
    if (/third[- ]party payor/.test(q)) return /amount|paid/.test(q) ? 'amt_ins_paid' : 'answer';
    if (/contractual (agreement )?adjustment/.test(q)) return 'amt_adjust';
    if (/written off|charged off|write[- ]?off/.test(q)) return 'amt_writeoff';
    if (/balance|still owed|outstanding|amount owed|unpaid|right to be paid/.test(q)) return 'amt_balance';
    if (/total amount paid|amount paid for services|been paid/.test(q)) return 'amt_paid';
    if (/amount paid by|paid by (the )?(patient|him|her)/.test(q)) return 'amt_pt_paid';
    if (/total amount (of )?(all )?(charges|for all|billed)|total charges|amount charged|amount of charges|medical bill/.test(q)) return 'amt_total';
    if (/dates? of (service|treatment)|date range/.test(q) && /^(what|state|please|list)/.test(q)) return 'dos_range';
    return 'answer';
  }

  // Value for a field kind given the case data.
  AE.valueFor = function (kind, d) {
    const sd = d.swornDate || new Date();
    const money = v => AE.fmtMoney(v == null || v === '' ? 0 : v);
    switch (kind) {
      case 'yes': return 'Yes';
      case 'no': return 'No';
      case 'na': return 'Not applicable';
      // the custodian's standard wording (from a filled LORR DWQ)
      case 'archive': return 'Archive';
      case 'all_provided': return `I have provided all ${d.type === 'billing' ? 'billing' : 'medical'} records under my care and possession.`;
      case 'knowledge_basis': return `I am the custodian of records. I maintain and produce the ${d.type === 'billing' ? 'billing' : 'medical'} records kept in the regular course of business.`;
      case 'no_knowledge': return `I do not have that information, I am the custodian of records, I maintain and produce ${d.type === 'billing' ? 'billing' : 'medical'} records.`;
      // Nobody else paid: the standard answer. Someone did: stays empty (red) so the names and amounts get typed in.
      case 'payor_names': return (+d.insPaid || 0) + (+d.medPaid || 0) > 0 ? '' : AE.valueFor('no_knowledge', d);
      // Payments are only entered for billing requests, so a records request can't say nothing was paid.
      case 'yes_payments': return d.type !== 'billing' || (+d.paid || 0) + (+d.insPaid || 0) + (+d.medPaid || 0) + (+d.ptPaid || 0) > 0 ? 'Yes' : 'Yes, but no payment has been made';
      case 'yes_pages': return d.pages != null && d.pages !== '' ? `Yes, ${d.pages} pages` : 'Yes';
      case 'yn_paid': return (+d.paid || 0) > 0 ? 'Yes' : 'No';
      case 'yn_others_paid': return (+d.insPaid || 0) + (+d.medPaid || 0) > 0 ? 'Yes' : 'No';
      case 'custodian': return d.custodian || '';
      case 'title': return d.title || '';
      case 'facility': return d.facility || '';
      case 'patient': return d.patient || '';
      case 'dob': return d.dob || '';
      case 'county': return d.county || '';
      case 'state': return d.state || '';
      case 'pages': return d.pages != null ? String(d.pages) : '';
      case 'dos_from': return d.dosFrom || '';
      case 'dos_to': return d.dosTo || '';
      case 'dos_range': return [d.dosFrom, d.dosTo].filter(Boolean).join(' to ');
      case 'dos_from_md': case 'dos_to_md': case 'dos_from_y2': case 'dos_to_y2': {
        // "December 01" + "25" for forms that print ", 20__" after the blank
        const raw = /from/.test(kind) ? d.dosFrom : d.dosTo;
        const dt = AE.parseDate(raw);
        if (!dt) return /_md$/.test(kind) ? (raw || '') : '';
        return /_md$/.test(kind) ? `${MONTHS[dt.getMonth()]} ${String(dt.getDate()).padStart(2, '0')}` : String(dt.getFullYear()).slice(2);
      }
      // Unknown total/balance stays empty (shown red) instead of printing 0.00.
      case 'amt_total': return d.total == null ? '' : money(d.total);
      case 'amt_writeoff': return money(d.writeoff);
      case 'amt_paid': return money(d.paid);
      case 'amt_balance': return d.balance == null ? '' : money(d.balance);
      case 'amt_sought': return money(0);
      case 'amt_paid_plus_balance': return d.balance == null ? '' : money((+d.paid || 0) + (+d.balance || 0));
      case 'amt_ins_paid': return money(d.insPaid);
      // self-pay accounts: nothing sent to collections and nothing owed by a payor unless entered
      case 'amt_payor_paid': return money((+d.insPaid || 0) + (+d.medPaid || 0));
      case 'amt_collection': return money(d.collection);
      case 'amt_payor_owing': return money(d.payorOwing);
      case 'amt_med_paid': return money(d.medPaid);
      case 'amt_pt_paid': return money(d.ptPaid);
      case 'amt_adjust': return money(d.adjust);
      case 'amt_lien': return d.lien == null ? '' : money(d.lien);
      case 'custodian_title': return [d.custodian, d.title].filter(Boolean).join(', ');
      case 'custodian_title_addr': return [d.custodian, d.address, d.title].filter(Boolean).join(', ');
      // "Total amount still owed and by whom" → "$147,717.77, Jane Doe"
      case 'amt_balance_whom': return d.balance == null ? '' : (+d.balance || 0) > 0 && d.patient ? `${money(d.balance)}, ${d.patient}` : money(d.balance);
      case 'employer_address': return [d.facility, d.address].filter(Boolean).join(', ');
      case 'custodian_employer': return [d.custodian, d.facility, d.address].filter(Boolean).join(', ');
      case 'no_info': return d.noInfo || '';
      case 'retention': return d.retention || '';
      case 'notary_day': return d.fillSworn ? String(sd.getDate()) : '';
      case 'notary_month': return d.fillSworn ? MONTHS[sd.getMonth()] : '';
      case 'notary_year2': return d.fillSworn ? String(sd.getFullYear()).slice(2) : '';
      case 'notary_year4': return d.fillSworn ? String(sd.getFullYear()) : '';
      case 'notary_date': return d.fillSworn ? AE.fmtDate(sd, 'long') : '';
      default: return '';
    }
  };

  // ---------------------------------------------------- request parsing
  AE.parseRequest = function (pages) {
    const lines = pages.flatMap(p => AE.pageLines(p).map(l => l.text));
    const text = lines.join('\n');
    const flat = lines.join(' ').replace(/\s+/g, ' ');
    const out = {};

    const billingScore = (flat.match(/18\.001|cost and necessity|billing records|itemized (statement|bill)|patient billing|amount charged|UB-04|CMS-1500|billing information/gi) || []).length;
    const recordsScore = (flat.match(/custodian of records|medical records|902\(10\)|complete file|records of|progress notes|radiology/gi) || []).length;
    out.type = billingScore > 0 && billingScore >= recordsScore * 0.5 ? 'billing' : 'records';
    out.billingScore = billingScore; out.recordsScore = recordsScore;
    out.subpoena = /deposition (up)?on written questions|written interrogatories|subpoena|duces tecum/i.test(flat);

    const clean = s => (s || '').replace(/_+/g, ' ').replace(/\s+/g, ' ').replace(/^[\s:,-]+|[\s:,.;-]+$/g, '').trim();
    const cleanName = s => AE.stripParty(clean(s));
    const okName = s => s && s.length >= 3 && s.length <= 60 && !/\d/.test(s) && /[a-z]/i.test(s) && s.split(' ').length <= 6;

    const namePatterns = [
      /\bPatient(?: Name)?\s*:\s*([A-Za-z][A-Za-z.,'\- ]+?)(?:\s+(?:Date|DOB|D\.O\.B|Claim|Client|SSN|File)\b|$)/im,
      /Records Pertaining To\s*:?\s*([A-Za-z][A-Za-z.,'\- ]+?)\s*$/im,
      /\bRe\s*:\s*(?:Patient\s*:\s*)?([A-Za-z][A-Za-z.,'\- ]+?)\s*$/im,
      /Client\s*:\s*([A-Za-z][A-Za-z.,'\- ]+?)\s*$/im
    ];
    for (const rx of namePatterns) {
      const m = text.match(rx);
      if (m && okName(cleanName(m[1])) && !/request|record|billing|affidavit|subpoena/i.test(m[1])) { out.patient = cleanName(m[1]); break; }
    }
    if (!out.patient) {
      const flatRx = [
        /Records? Regarding\s*:\s*([A-Z][A-Za-z.'\-]+(?: [A-Z][A-Za-z.'\-]+){1,3})\s*[;,]/,
        /Pertaining\s*to\s*[:;]\s*([A-Z][A-Za-z.'\-]+(?: [A-Z][A-Za-z.'\-]+){1,3})\s*(?:,|;|DOB|D\.O\.B|SSN|SS#)/,
        /billing records for ([A-Z][A-Za-z.'\- ]+?) and period/,
        /records? (?:for|of) ([A-Z][a-z]+(?: [A-Z][A-Za-z.'\-]+){1,3}) (?:from|for the period|and period)/,
        /pertaining to ([A-Z][A-Za-z.'\-]+(?: [A-Z][A-Za-z.'\-]+){1,3}) from said/
      ];
      for (const rx of flatRx) {
        const m = flat.match(rx);
        if (m && okName(cleanName(m[1]))) { out.patient = cleanName(m[1]); break; }
      }
    }
    // "LAST, FIRST" / "ROBERT BROWN" → "First Last"
    if (out.patient) out.patient = AE.personName(out.patient);

    let m = flat.match(new RegExp(String.raw`(?:Date of Birth|\bDOB|D\.O\.B\.?)\s*[:;\-]?\s*(` + DATE_RX + ')', 'i'));
    if (m) out.dob = AE.fmtDate(AE.parseDate(m[1]));
    m = flat.match(new RegExp(String.raw`Date of (?:Injury|Loss|Accident|Incident)\s*[:\-]?\s*(` + DATE_RX + ')', 'i'));
    if (m) out.doi = AE.fmtDate(AE.parseDate(m[1]));

    m = flat.match(new RegExp(String.raw`from\s+(` + DATE_RX + String.raw`)\s*(?:to|through|thru|-)\s*(?:the\s+)?(present|date|current|` + DATE_RX + ')', 'i'));
    if (m) {
      out.reqFrom = AE.fmtDate(AE.parseDate(m[1]));
      out.reqTo = /present|date|current/i.test(m[2]) ? 'Present' : AE.fmtDate(AE.parseDate(m[2]));
    } else if ((m = flat.match(new RegExp(String.raw`on or after\s+(` + DATE_RX + ')', 'i')))) {
      out.reqFrom = AE.fmtDate(AE.parseDate(m[1]));
      out.reqTo = 'Present';
    }

    const facRx = [
      /Custodian of (?:Billing )?Records for\s*:\s*([A-Z][A-Za-z0-9&.,'\/\- ]+?)\s+(?:Records Pertaining|\(|\d{3,}|Type of Records)/,
      /Custodian of Records for\s+([A-Z][^.]+?)\s*\.\s/,
      /Health ?care Provider\s*:\s*([A-Z][A-Za-z&.,'\- ]+?)\s+Records Pertaining/i,
      /Dear\s+([A-Z][A-Za-z&.,'\- ]+?(?:Hospital|Clinic|Clinics|Center|Medical|Health)[A-Za-z&.,'\- ]*?)\s*:/
    ];
    for (const rx of facRx) {
      const fm = flat.match(rx);
      if (fm && fm[1].length < 80 && !/_/.test(fm[1])) { out.facility = clean(fm[1]); break; }
    }
    return out;
  };
  // "Doe, John Jr." / "SMITH, JANE" → "John Doe Jr." / "Jane Smith"
  // Court-case words next to a name ("VICTOR MORENO, Plaintiff, v. …", "Plaintiff John Doe") are not part of it.
  const PARTY_RX = /\b(?:plaintiffs?|defendants?|petitioners?|respondents?|claimants?|applicants?|appellants?|appellees?|intervenors?|movants?|et\.? al\.?|individually|deceased)\b/i;
  AE.stripParty = function (s) {
    s = String(s || '').replace(/\s+/g, ' ').trim();
    s = s.replace(new RegExp('^(?:' + PARTY_RX.source + '[\\s,:;-]*)+', 'i'), ''); // in front of the name
    const m = s.match(PARTY_RX);
    if (m) s = s.slice(0, m.index); // after the name: drop it and everything that follows ("v. ABC Corp")
    return s.replace(/[\s,;:(-]+$/, '').trim();
  };
  AE.personName = function (s) {
    s = AE.stripParty(s).replace(/[,;:]+$/, '');
    if (/,/.test(s)) {
      const [last, rest] = s.split(/,(.+)/).map(x => (x || '').trim());
      const parts = rest.split(' ');
      const suffix = parts.filter(t => /^(jr|sr|ii|iii|iv)\.?$/i.test(t));
      const first = parts.filter(t => !suffix.includes(t));
      if (last && first.length) s = [...first, last, ...suffix].join(' ');
    }
    return s === s.toUpperCase() ? titleCase(s).replace(/\b(Ii|Iii|Iv)\b/g, m => m.toUpperCase()) : s;
  };
  const looksLikePerson = s => /^[A-Za-z][A-Za-z.'\-]+(,?\s+[A-Za-z][A-Za-z.'\-]*){1,4}$/.test(s.trim()) && !/\d/.test(s) &&
    !/hospital|clinic|medical|records|law|firm|llc|inc|pllc|present|houston|texas|street|road|\bdr\b|\bst\b|pharmacy|imaging|network|group|center|services/i.test(s);

  /*
   * Reads (never writes) a HIPAA authorization / release form: patient name, DOB and the facility that releases.
   *  - forms with printed labels: the typed value next to / under "Name of patient", "Date of birth", "authorize … to disclose"
   *  - scanned forms where only the typed values are text: a person's name on the same line as a date of birth
   * Typed values are recognised by their font being different from the form's own printed text.
   */
  AE.parseAuth = function (pages) {
    const out = {};
    for (const page of pages) {
      const fontLen = {};
      page.items.forEach(it => { fontLen[it.font] = (fontLen[it.font] || 0) + it.str.length; });
      const mainFont = Object.keys(fontLen).sort((a, c) => fontLen[c] - fontLen[a])[0];
      const labels = page.items.filter(it => it.font === mainFont);
      const hasLabels = labels.some(it => /name of patient|patient(?:'s)? name|printed name|date of birth|authoriz/i.test(it.str));
      const typed = page.items.map((it, i) => ({ ...it, i })).filter(it => (!hasLabels || it.font !== mainFont) && it.str.trim());
      // When a value was typed over another one (a correction), the one drawn last wins.
      const visible = typed.filter(a => !typed.some(b => b.i > a.i && Math.abs(b.x - a.x) < 6 && Math.abs(b.y - a.y) < 4));
      const near = (label, maxRight = 320) => visible
        .map(v => ({ v, dx: v.x - label.x, dy: label.y - v.y }))
        .filter(o => (Math.abs(o.dy) < 5 && o.dx > label.w - 2 && o.dx < label.w + maxRight) || (o.dy > 4 && o.dy < 30 && o.dx > -30 && o.dx < 300))
        .sort((a, b) => (Math.abs(a.dy) < 5 ? 0 : 1) - (Math.abs(b.dy) < 5 ? 0 : 1) || a.dy - b.dy || a.dx - b.dx);
      const lineOf = v => visible.filter(o => Math.abs(o.y - v.y) < 4).sort((a, b) => a.x - b.x);

      if (hasLabels) {
        for (const lb of labels) {
          if (!out.patient && /name of patient|patient(?:'s)? name|printed name(?! of legally)|name of individual/i.test(lb.str)) {
            const hit = near(lb).find(o => looksLikePerson(o.v.str));
            if (hit) out.patient = AE.personName(hit.v.str);
          }
          if (!out.dob && /date of birth|birth ?date|\bdob\b/i.test(lb.str)) {
            const hit = near(lb).find(o => /\d/.test(o.v.str));
            if (hit) {
              const parts = lineOf(hit.v).filter(o => o.x >= lb.x - 5 && o.x < lb.x + lb.w + 300).map(o => o.str.trim());
              const d = AE.parseDate(parts.join('/').replace(/\/+/g, '/')) || AE.parseDate(hit.v.str.trim());
              if (d) out.dob = AE.fmtDate(d);
            }
          }
          if (!out.facility && /authoriz\w* (the following|.*to (disclose|release))|name of facility|facility .*release/i.test(lb.str)) {
            const hit = visible.filter(v => v.y < lb.y && lb.y - v.y < 45 && v.str.trim().length > 6 && !looksLikePerson(v.str))
              .sort((a, b) => b.y - a.y)[0];
            if (hit) out.facility = hit.str.trim();
          }
        }
      } else if (!out.patient) {
        // Scanned form: the patient is the person's name typed on the same line as a date of birth.
        for (const v of visible) {
          if (!looksLikePerson(v.str)) continue;
          const date = lineOf(v).find(o => o !== v && AE.parseDate(o.str.trim()));
          const d = date && AE.parseDate(date.str.trim());
          if (d && d.getFullYear() < new Date().getFullYear() - 1) {
            out.patient = AE.personName(v.str); out.dob = AE.fmtDate(d); break;
          }
        }
      }
      if (out.patient && !out.page) out.page = page.num;
    }
    return out;
  };

  function titleCase(s) { return s.toLowerCase().replace(/\b([a-z])/g, c => c.toUpperCase()); }

  // ---------------------------------------------------- invoice parsing
  // CMS-1500 box 24 service line: "09 04 25 09 04 25 21 99223 ..." (from, to, place of service)
  const CMS_LINE = /\b(0[1-9]|1[0-2]) (0[1-9]|[12]\d|3[01]) \d{2} (0[1-9]|1[0-2]) (0[1-9]|[12]\d|3[01]) \d{2} \d{2}\b/;
  // UB-04 printed as data only (the red form and its labels are just a picture): revenue-code lines
  // "0250 Pharmacy 010126 2 150.00" and the line-23 totals row "0001 2 2 010526 5250.00" (page 2 of 2, creation date, total).
  const UB_REV_LINE = /^(?:\d{1,2}\s+)?0\d{3}\s+[A-Za-z].*\s\d{6}(?:\d{2})?\s+\d+\s+[\d,]+(?:\.\d{2})?$/gm;
  const UB_TOTAL_LINE = /^(?:\d{1,2}\s+)?0001\s+(\d{1,2})\s+(\d{1,2})\s+\d{6}(?:\d{2})?(?:\s+([\d,]+)(?:\.(\d{2})|\s+(\d{2})\b)?)?/;
  const isUb04 = t => /UB-?04|CMS-?1450|NUBC/i.test(t) || t.split('\n').some(l => UB_TOTAL_LINE.test(l)) ||
    (t.match(UB_REV_LINE) || []).length >= 2;
  // "Page n of m" of a UB-04 page: printed "PAGE 1 OF 2", or on a data-only print just "1 2 010526" / "0001 2 2 010526 …"
  function ubPageOf(lines) {
    const m = lines.map(l => l.text).join(' ').match(/PAGE\s+(\d+)\s+OF\s+(\d+)/i);
    if (m) return [+m[1], +m[2]];
    for (const l of lines) {
      const d = l.text.match(/^(?:\d{1,2}\s+)?(?:0001\s+)?(\d{1,2})\s+(\d{1,2})\s+\d{6}(?:\d{2})?(?:\s+[\d,.\s]+)?$/);
      if (d && +d[1] >= 1 && +d[1] <= +d[2]) return [+d[1], +d[2]];
    }
    return null;
  }
  // Returns { format, dates: [Date], from, to, total, nameOk, dobOk, notes: [] }
  AE.parseInvoice = function (pages, ctx) {
    ctx = ctx || {};
    const res = { format: 'Other', dates: [], total: null, notes: [] };
    const all = AE.fullText(pages);
    const today = new Date(); today.setHours(23, 59, 59);
    const dobDate = AE.parseDate(ctx.dob);
    const isDob = d => dobDate && d.getTime() === dobDate.getTime();

    if (isUb04(all)) {
      res.format = 'UB-04';
      let lastTotal = null;
      for (const p of pages) {
        const lines = AE.pageLines(p);
        let period = null;
        for (const l of lines) {
          const m = l.text.match(/\b\d{2}-?\d{7}\s+(\d{6}(?:\d{2})?)\s+(\d{6}(?:\d{2})?)\b/);
          if (m) { period = [AE.parseDate(m[1]), AE.parseDate(m[2])]; break; }
        }
        if (period && period[0]) res.dates.push(...period.filter(Boolean));
        // Service-line dates (field 45) as a cross-check / fallback.
        // Lines may start with the form's printed row number ("3 0460 ...").
        for (const l of lines) {
          if (!/^(\d{1,2}\s+)?0\d{3}\b/.test(l.text) || /^(\d{1,2}\s+)?0001\b/.test(l.text)) continue;
          const dm = l.text.match(/\b(\d{6}(?:\d{2})?)\b(?!\d)/g);
          if (dm && !period) dm.map(AE.parseDate).filter(Boolean).forEach(d => res.dates.push(d));
        }
        // Totals row = form line 23: "0001 PAGE 1 OF 1 CREATION DATE 042226 TOTALS 7388 20 0 00"
        const tl = lines.find(l => /^(\d{1,2}\s+)?0001\b/.test(l.text) || /\bTOTALS\b/.test(l.text));
        if (tl) {
          let v = null;
          const tm = tl.text.match(/\bTOTALS\s+([\d,]+)(?:\.(\d{2})|\s+(\d{2})\b)?/);
          const dm = tl.text.match(UB_TOTAL_LINE);
          if (tm) v = AE.parseMoney(tm[1]) + (+(tm[2] || tm[3] || 0)) / 100;
          else if (dm && dm[3]) {
            // Data-only print: "5250.00", "5250 00", or "525000" (the form's dotted line splits off the cents)
            v = dm[4] || dm[5] ? AE.parseMoney(dm[3]) + (+(dm[4] || dm[5])) / 100 : AE.parseMoney(dm[3]) / 100;
          } else {
            const nums = tl.items.filter(it => it.x > p.width * 0.66 && /^[\d,]+(\.\d{2})?$/.test(it.str.trim())).map(it => it.str.trim());
            if (nums.length) v = /\./.test(nums[0]) ? AE.parseMoney(nums[0])
              : AE.parseMoney(nums[0]) + (nums[1] && /^\d{2}$/.test(nums[1]) ? +nums[1] / 100 : 0);
          }
          const pg = ubPageOf([tl]);
          // On multi-page claims the total sits on the last page ("PAGE 2 OF 2").
          if (v != null && (!pg || pg[0] === pg[1])) lastTotal = (lastTotal || 0) + v;
        }
      }
      res.total = lastTotal;
      // UB-04 birthdate (field 10, MMDDYYYY, followed by sex)
      const bd = all.match(/\b(\d{8})\s+[MFU]\b/);
      const bdt = bd && AE.parseDate(bd[1]);
      if (bdt) {
        res.dob = AE.fmtDate(bdt);
        if (dobDate) res.dobOk = bdt.getTime() === dobDate.getTime();
      }
    } else if (/HEALTH INSURANCE CLAIM FORM|CMS-?1500|\(02\/12\)/i.test(all) || CMS_LINE.test(all)) {
      res.format = 'CMS-1500';
      // Box 25-29: "824094685 X 1918129V13131 X 1000 00 0 00 1000 00" (or "… X 2025.80 0.00") → total charge, amount paid
      let tot = null, paid = null, lineSum = null;
      for (const p of pages) for (const l of AE.pageLines(p)) {
        const m = l.text.match(/\b\d{2}-?\d{7}\s+X?\s*\S+\s+X?\s*([\d,]+)[.\s](\d{2})\s+([\d,]+)[.\s](\d{2})\b/);
        if (m) { tot = (tot || 0) + AE.parseMoney(m[1]) + (+m[2]) / 100; paid = (paid || 0) + AE.parseMoney(m[3]) + (+m[4]) / 100; }
        else {
          // Amounts printed without a decimal point, the form's dotted line splits off the cents: "… X 123456B X 125050 0" = $1,250.50, paid $0
          const n = l.text.match(/\b\d{2}-?\d{7}\s+X?\s*\S+\s+X?\s*(\d{3,})\s+(\d+)\s*$/);
          if (n) { tot = (tot || 0) + +n[1] / 100; paid = (paid || 0) + +n[2] / 100; }
        }
        // Box 24F on each service line: "05 11 26 05 11 26 10 99214 25 95 F4311 1282.10 1 1164205415" → charge before the units
        if (CMS_LINE.test(l.text)) {
          const rest = l.text.replace(CMS_LINE, ' ');
          const c = rest.match(/\s([\d,]+)[.\s](\d{2})\s+\d{1,3}(?=\s+(?:NPI\s+)?\d{10}\b|\s*$)/);
          const c2 = !c && rest.match(/\s(\d{3,})\s+\d{1,3}(?=\s+(?:NPI\s+)?\d{10}\b|\s*$)/); // "ABCD 125050 1 1234567890" = $1,250.50
          if (c) lineSum = (lineSum || 0) + AE.parseMoney(c[1]) + (+c[2]) / 100;
          else if (c2) lineSum = (lineSum || 0) + +c2[1] / 100;
        }
      }
      if (tot != null) { res.total = tot; res.paid = paid; }
      else if (lineSum != null) { res.total = Math.round(lineSum * 100) / 100; res.notes.push('Box 28 total is empty — total = sum of the service-line charges.'); }
      // Box 3 birth date after the patient name: "DOE JOHN 01 02 1980", "DOE, JOHN 01 02 80", "DOE JOHN A 01 02 1980".
      // A date that is too recent is a signature date ("SIGNATURE ON FILE 09 29 26").
      const brx = /[A-Z]\s+(\d{2})\s(\d{2})\s(\d{4}|\d{2})\b/g; let bd, bdt = null;
      while (!bdt && (bd = brx.exec(all))) {
        const d = AE.parseDate(`${bd[1]}/${bd[2]}/${bd[3]}`);
        if (d && d.getFullYear() < today.getFullYear() - 1) bdt = d;
      }
      if (bdt) { res.dob = AE.fmtDate(bdt); if (dobDate) res.dobOk = bdt.getTime() === dobDate.getTime(); }
      // Box 24A service dates "MM DD YY MM DD YY POS". Only when no service line is found, every "MM DD YY" on the
      // form is used — otherwise box 16/18 dates (hospitalization) and the signature date would widen the DOS.
      const srx = /\b(0[1-9]|1[0-2]) (0[1-9]|[12]\d|3[01]) (\d{2}) (0[1-9]|1[0-2]) (0[1-9]|[12]\d|3[01]) (\d{2}) \d{2}\b/g;
      let m;
      while ((m = srx.exec(all))) {
        for (const d of [AE.parseDate(`${m[1]}/${m[2]}/${m[3]}`), AE.parseDate(`${m[4]}/${m[5]}/${m[6]}`)]) if (d && d <= today) res.dates.push(d);
      }
      const rx = /\b(0[1-9]|1[0-2])\s(0[1-9]|[12]\d|3[01])\s(\d{2})\b/g;
      if (!res.dates.length) while ((m = rx.exec(all))) { const d = AE.parseDate(`${m[1]}/${m[2]}/${m[3]}`); if (d && d <= today && !isDob(d)) res.dates.push(d); }
      const tm = res.total == null && all.match(/TOTAL CHARGE[^\d$]*\$?\s*([\d,]+)[\s.](\d{2})\b/i);
      if (tm) res.total = AE.parseMoney(tm[1]) + (+tm[2]) / 100;
    }

    if (!res.dates.length) {
      // Itemized statement / anything else: every date on a line that is not a print/statement/due date.
      for (const p of pages) for (const l of AE.pageLines(p)) {
        if (/print|run date|statement date|due date|as of|birth|dob|d\.o\.b|issued|admit.*discharge/i.test(l.text)) continue;
        if (/(^|\s)(invoice\s+|bill\s+)?date\s*:/i.test(l.text) && !/service|visit|\bdos\b|treatment/i.test(l.text)) continue;
        const rx = new RegExp(DATE_RX, 'gi'); let m;
        while ((m = rx.exec(l.text))) {
          const d = AE.parseDate(m[0]);
          if (d && d <= today && !isDob(d)) res.dates.push(d);
        }
      }
    }
    if (res.total == null) {
      const rx = /(total charges?|total amount|grand total|account total|total billed|\btotal(?! paid| payments?| adjust))\s*:?\s*\$?\s*([\d,]+\.\d{2})/gi; let m, best = null;
      while ((m = rx.exec(all))) { const v = AE.parseMoney(m[2]); if (v != null && (best == null || v > best)) best = v; }
      res.total = best;
    }

    if (!res.dob) {
      const m = all.match(new RegExp(String.raw`(?:DOB|D\.O\.B\.?|Date of Birth|Birth ?date)\s*[:#]?\s*(` + DATE_RX + ')', 'i'));
      const d = m && AE.parseDate(m[1]);
      if (d) { res.dob = AE.fmtDate(d); if (dobDate) res.dobOk = d.getTime() === dobDate.getTime(); }
    }
    const pm = all.match(/\b(?:Patient(?: Name)?|Guarantor)\s*:\s*([A-Za-z][A-Za-z.'\-]+(?:,? [A-Za-z][A-Za-z.'\-]+){1,3})/);
    if (pm) res.patient = AE.personName(pm[1]);

    res.dates.sort((a, b) => a - b);
    res.from = res.dates[0] || null;
    res.to = res.dates[res.dates.length - 1] || null;

    if (ctx.patient) {
      const up = all.toUpperCase();
      const tokens = ctx.patient.toUpperCase().replace(/[^A-Z\s'-]/g, ' ').split(/\s+/)
        .filter(t => t.length > 1 && !/^(JR|SR|II|III|IV|MR|MRS|MS)$/.test(t));
      if (!all.trim()) res.nameOk = null;
      else {
        const found = tokens.filter(t => new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(up));
        // A 3-part name may be printed with one surname only ("Maria Lopez Diaz" → "LOPEZ, MARIA D")
        res.nameOk = tokens.length > 0 && (found.length === tokens.length ||
          (tokens.length >= 3 && found.includes(tokens[0]) && found.length >= tokens.length - 1));
      }
    }
    const unreadable = all.trim() && AE.readableShare(pages) < 0.6;
    if (unreadable) {
      // Scrambled font: the few readable words (e.g. the billing address) say nothing about the patient.
      if (res.nameOk === false) res.nameOk = null;
      res.notes.push('Invoice text cannot be read (scrambled font) — type the DOS and total, and check the patient name by eye.');
    }
    if (!all.trim()) res.notes.push('No text layer (scanned) — enter DOS and amount by hand.');
    if (!res.dates.length && all.trim() && !unreadable) res.notes.push('No dates of service found — enter them by hand.');
    if (res.total == null && all.trim() && !unreadable) res.notes.push('Total charges not found — enter by hand.');
    return res;
  };

  // CareCapital's own cover letter that comes in front of purchased invoices — not part of the bill, never merged.
  // (The invoice itself also says "C/O CARE CAPITAL", so the letter is recognised by its wording, not the name.)
  AE.isCareCapitalCover = function (page) {
    const t = AE.pageLines(page).map(l => l.text).join(' ');
    return /care\s*capital/i.test(t) &&
      /rightful owner of the accompanying|purchased and is the rightful owner|issue payment directly to care\s*capital|billing affidavit requests associated|record service purchased/i.test(t) &&
      !/health insurance claim form|UB-?04|CMS-?1450/i.test(t) && !CMS_LINE.test(t);
  };

  // Share of a page's characters that are real letters/digits. Some PDFs use fonts whose text comes out
  // as control characters (looks fine on screen, unreadable to the tool).
  AE.readableShare = function (pages) {
    const t = AE.fullText(pages).replace(/\s+/g, '');
    if (!t) return 0;
    return (t.match(/[A-Za-z0-9]/g) || []).length / t.length;
  };

  // Splits a file of UB-04s into claims (each ends on "PAGE n OF n"). Returns arrays of pages.
  AE.splitClaims = function (pages) {
    const txt = AE.fullText(pages);
    if (!isUb04(txt)) {
      // CMS-1500: every form page carries its own box 28 total → one claim per page
      const perPage = pages.map(p => AE.fullText([p]));
      if (pages.length > 1 && perPage.every(t => CMS_LINE.test(t))) return pages.map(p => [p]);
      return [pages];
    }
    const groups = []; let cur = [];
    for (const p of pages) {
      cur.push(p);
      const m = ubPageOf(AE.pageLines(p));
      if (!m || m[0] === m[1]) { groups.push(cur); cur = []; }
    }
    if (cur.length) groups.push(cur);
    return groups;
  };

  // Does a records file mention the patient? (true / false / null when there is no text)
  AE.mentionsPatient = function (pages, patient) {
    const all = AE.fullText(pages).toUpperCase();
    if (!all.trim() || !patient || AE.readableShare(pages) < 0.6) return null; // no text, or scrambled font
    const last = patient.toUpperCase().replace(/[^A-Z\s'-]/g, ' ').split(/\s+/)
      .filter(t => t.length > 1 && !/^(JR|SR|II|III|IV)$/.test(t)).pop();
    return last ? all.includes(last) : null;
  };

  // ---------------------------------------------------- standard affidavit text
  AE.standardAffidavit = function (type, d) {
    const u = s => s || '____________________';
    const sd = d.swornDate || new Date();
    const sworn = d.fillSworn
      ? `SWORN TO AND SUBSCRIBED before me on the ${AE.ordinal(sd.getDate())} day of ${MONTHS[sd.getMonth()]}, ${sd.getFullYear()}.`
      : 'SWORN TO AND SUBSCRIBED before me on the _____ day of ________________, 20____.';
    if (type === 'billing') {
      const m = v => '$' + AE.fmtMoney(v == null || v === '' ? 0 : v);
      return {
        title: 'AFFIDAVIT CONCERNING COST AND NECESSITY OF SERVICES',
        subtitle: '(Pursuant to Tex. Civ. Prac. & Rem. Code §§ 18.001 & 18.002)',
        head: [`STATE OF ${u(AE.stateLong(d.state)).toUpperCase()}`, `COUNTY OF ${u(d.county).toUpperCase()}`],
        body: [
          `Healthcare Provider: ${u(d.facility)}`,
          `Records Pertaining To: ${u(d.patient)}${d.dob ? ` (DOB ${d.dob})` : ''}`,
          `BEFORE ME, the undersigned authority, personally appeared ${u(d.custodian)}, who, being by me duly sworn, deposed as follows:`,
          `"My name is ${u(d.custodian)}. I am over eighteen (18) years of age, of sound mind, capable of making this affidavit, and personally acquainted with the facts herein stated.`,
          `I am the person in charge of patient billing records of the above referenced health care provider. Attached to this affidavit are records that provide an itemized statement of the service and the charge for the service that the above referenced health care provider provided to the patient from ${u(d.dosFrom)} to ${d.dosTo && !/present/i.test(d.dosTo) ? d.dosTo : 'the present'}. The attached records are part of this affidavit.`,
          `The attached records are kept by me in the regular course of business. The information contained in the records was transmitted to me in the regular course of business by the above referenced health care provider or an employee or representative of the above referenced health care provider who had personal knowledge of the information. The records were made at or near the time or reasonably soon after the time that the service was provided. The records are the original or an exact duplicate of the original.`,
          `The service provided was necessary, and the amount charged for the service was reasonable at the time and place that the service was provided.`,
          `a. ${m(d.total)} — Total amount charged by ${u(d.facility)}`,
          `b. ${m(d.writeoff)} — Total amount written off from the total charges, which ${u(d.facility)} agrees it will never seek to collect from any source`,
          `c. ${m(d.paid)} — Total amount paid to date on the referenced account`,
          `d. ${m(d.balance)} — Total amount presently outstanding on the referenced account that ${u(d.facility)} is legally entitled to collect`,
          `e. ${m((+d.paid || 0) + (+d.balance || 0))} — Total amount paid plus total amount presently outstanding (item c plus item d)"`
        ],
        sworn
      };
    }
    return {
      title: 'AFFIDAVIT',
      subtitle: 'BUSINESS RECORDS — MEDICAL RECORDS (Tex. R. Evid. 803(6), 902(10))',
      head: [`STATE OF ${u(AE.stateLong(d.state)).toUpperCase()}`, `COUNTY OF ${u(d.county).toUpperCase()}`],
      body: [
        `BEFORE ME, the undersigned authority, on this date personally appeared ${u(d.custodian)}, who, after being by me duly sworn, states and deposes as follows:`,
        `"My name is ${u(d.custodian)}. I am over the age of eighteen, of sound mind, and capable of making this Affidavit. I am personally acquainted with the facts herein stated.`,
        `I am the Custodian of Records for ${u(d.facility)}. Attached hereto are ${d.pages != null ? d.pages : '______'} pages of records from ${u(d.dosFrom)} to ${u(d.dosTo || 'Present')} pertaining to ${u(d.patient)}${d.dob ? ` (DOB ${d.dob})` : ''} from said medical provider, which were kept in the regular course of business. It was in the regular course of business of said medical provider for an employee or representative with knowledge of the act, event, condition, opinion, or diagnosis recorded to make the record or to transmit information thereof to be included in such record; and the record was made at or near the time or reasonably soon thereafter. The records attached hereto are the original or exact duplicates of the originals."`
      ],
      sworn
    };
  };

  // ---------------------------------------------------- output
  /*
   * opts = {
   *   requestBytes, keepPages: [1-based page numbers] | null (all),
   *   fills: [{page, x, y, w, h, value, align}] | typed text [{page, x, y, free: true, size, color, value}],
   *   ink: [{page, pts: [[x, y]…], width, color}],
   *   attachments: [{bytes, kind: 'pdf'|'jpg'|'png', pages?: [0-based page indexes]}],
   *   standard: null | {type, data, insertAfter}   // generated affidavit page
   * }
   */
  AE.buildPdf = async function (opts) {
    const { PDFDocument, rgb } = AE.PDFLib;
    let out;
    if (opts.requestBytes) out = await PDFDocument.load(opts.requestBytes, { ignoreEncryption: true });
    else out = await PDFDocument.create();
    const font = await out.embedFont(AE.PDFLib.StandardFonts.Helvetica);
    const bold = await out.embedFont(AE.PDFLib.StandardFonts.HelveticaBold);
    const safe = s => { let o = ''; for (const ch of String(s)) { try { font.encodeText(ch); o += ch; } catch (e) { o += '?'; } } return o; };

    const pages = out.getPages();
    // A white-out annotation would sit on top of anything we write. On the pages we fill, turn it into a
    // white box in the page itself (same look) so the new value shows above it.
    for (const wo of opts.whiteouts || []) {
      const page = pages[wo.page - 1];
      if (!page) continue;
      const annots = page.node.Annots();
      if (annots) {
        for (let i = annots.size() - 1; i >= 0; i--) {
          const d = annots.lookup(i);
          const rect = d && d.lookup && d.lookup(AE.PDFLib.PDFName.of('Rect'));
          if (!rect || !rect.asRectangle) continue;
          const r = rect.asRectangle();
          if (Math.abs(r.x - wo.x) < 1.5 && Math.abs(r.y - wo.y) < 1.5 && Math.abs(r.width - wo.w) < 1.5) annots.remove(i);
        }
      }
      page.drawRectangle({ x: wo.x, y: wo.y, width: wo.w, height: wo.h, color: rgb(1, 1, 1) });
    }
    for (const f of opts.fills || []) {
      if (f.free) {
        // text the user typed on the page: own size and colour, one line per Enter, never shrunk
        const page = pages[f.page - 1];
        if (!page) continue;
        String(f.value || '').split('\n').forEach((line, i) => {
          const v = safe(line);
          if (v.trim()) page.drawText(v, { x: f.x, y: f.y + 1.5 - i * f.size * 1.2, size: f.size, font, color: f.color ? rgb(...f.color) : rgb(0, 0, 0) });
        });
        continue;
      }
      const v = safe(f.value || '').trim();
      if (!v) continue;
      const page = pages[f.page - 1];
      if (!page) continue;
      if (f.cover) {
        // White out a wrong value that was already written on the blank — stop above the underline.
        const y0 = Math.max(f.cover.y0 - 1.5, f.y + 0.6);
        page.drawRectangle({ x: f.cover.x0 - 1, y: y0, width: f.cover.x1 - f.cover.x0 + 2, height: f.cover.y1 - y0 + 1, color: rgb(1, 1, 1) });
      }
      let size = Math.min(f.size || 11, Math.max(8, (f.h || 12) * 0.9)); // ≥ 8pt to start; shrinks below only to fit
      const avail = Math.max(10, (f.w || 100) - 2);
      while (size > 6 && font.widthOfTextAtSize(v, size) > avail) size -= 0.5;
      const tw = font.widthOfTextAtSize(v, size);
      let x = f.x + 1;
      if (f.align === 'center' && tw < (f.w || 0)) x = f.x + ((f.w || 0) - tw) / 2;
      page.drawText(v, { x, y: f.y + 1.5, size, font, color: f.color ? rgb(...f.color) : rgb(0, 0, 0) });
    }

    // pen drawings: an SVG path is y-down, so the PDF y is negated (drawn from the page origin)
    for (const k of opts.ink || []) {
      const page = pages[k.page - 1];
      if (!page || k.pts.length < 2) continue;
      const path = k.pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(2)} ${(-p[1]).toFixed(2)}`).join(' ');
      page.drawSvgPath(path, { x: 0, y: 0, borderColor: rgb(...k.color), borderWidth: k.width, borderLineCap: AE.PDFLib.LineCapStyle.Round });
    }

    if (opts.keepPages) {
      const keep = new Set(opts.keepPages);
      for (let i = pages.length - 1; i >= 0; i--) if (!keep.has(i + 1)) out.removePage(i);
    }

    if (opts.standard) {
      const sp = drawStandard(out, font, bold, safe, opts.standard);
      const at = Math.min(opts.standard.insertAt ?? 0, out.getPageCount());
      out.insertPage(at, sp);
    }

    // Copy every needed page of a source file in ONE copyPages call — copying claim by claim would
    // duplicate the file's shared fonts/images for each claim and blow up the file size.
    const copiedBySrc = new Map(); // bytes -> Map(page index -> copied page)
    for (const a of opts.attachments || []) {
      if (a.kind !== 'pdf' || copiedBySrc.has(a.bytes)) continue;
      const src = await PDFDocument.load(a.bytes, { ignoreEncryption: true });
      const want = [...new Set((opts.attachments || []).filter(x => x.bytes === a.bytes)
        .flatMap(x => x.pages || src.getPageIndices()))];
      const copied = await out.copyPages(src, want);
      copiedBySrc.set(a.bytes, { src, map: new Map(want.map((idx, k) => [idx, copied[k]])) });
    }
    for (const a of opts.attachments || []) {
      if (a.kind === 'pdf') {
        const { src, map } = copiedBySrc.get(a.bytes);
        (a.pages || src.getPageIndices()).forEach(idx => out.addPage(map.get(idx)));
      } else {
        const img = a.kind === 'png' ? await out.embedPng(a.bytes) : await out.embedJpg(a.bytes);
        const W = 612, H = 792, M = 18;
        const s = Math.min((W - 2 * M) / img.width, (H - 2 * M) / img.height, 1.5);
        const p = out.addPage([W, H]);
        p.drawImage(img, { x: (W - img.width * s) / 2, y: (H - img.height * s) / 2, width: img.width * s, height: img.height * s });
      }
    }
    return await out.save();
  };

  function drawStandard(doc, font, bold, safe, st) {
    const { PDFPage, rgb } = AE.PDFLib;
    const t = AE.standardAffidavit(st.type, st.data);
    const page = PDFPage.create(doc);
    page.setSize(612, 792);
    const L = 72, R = 540, W = R - L;
    let y = 720;
    const center = (s, f, size) => { s = safe(s); page.drawText(s, { x: (612 - f.widthOfTextAtSize(s, size)) / 2, y, size, font: f, color: rgb(0, 0, 0) }); y -= size + 8; };
    const para = (s, size = 11, indent = 36, gap = 10) => {
      const words = safe(s).split(' ');
      let line = '', first = true;
      const flush = () => { page.drawText(line, { x: L + (first ? indent : 0), y, size, font, color: rgb(0, 0, 0) }); y -= size + 4; line = ''; first = false; };
      for (const w of words) {
        const test = line ? line + ' ' + w : w;
        if (font.widthOfTextAtSize(test, size) > W - (first ? indent : 0)) flush();
        line = line ? line + ' ' + w : w;
      }
      if (line) flush();
      y -= gap;
    };
    center(t.title, bold, 13);
    center(t.subtitle, font, 9.5);
    y -= 6;
    t.head.forEach(h => { page.drawText(safe(h), { x: L, y, size: 11, font: bold }); y -= 15; });
    y -= 8;
    const small = t.body.join(' ').length > 1900 ? 10 : 11;
    t.body.forEach((b, i) => para(b, small, /^[a-e]\. /.test(b) ? 18 : 36, /^[a-d]\. /.test(b) ? 4 : 10));
    y -= 18;
    page.drawLine({ start: { x: 324, y }, end: { x: R, y }, thickness: 0.7 });
    y -= 13;
    page.drawText(safe(st.data.custodian || 'Affiant'), { x: 324, y, size: 10, font });
    y -= 12;
    page.drawText(safe(st.data.title || 'Custodian of Records'), { x: 324, y, size: 10, font });
    y -= 30;
    para(t.sworn, 11, 36, 10);
    y -= 20;
    page.drawLine({ start: { x: 324, y }, end: { x: R, y }, thickness: 0.7 });
    y -= 13;
    page.drawText(safe(`Notary Public in and for the State of ${AE.stateLong(st.data.state) || '________'}`), { x: 324, y, size: 10, font });
    return page;
  }

  // Output file name: "RequestID_Patient Name.pdf" (just "Patient Name.pdf" until a request ID is known).
  AE.fileName = function (patient, type, pattern, reqId) {
    const clean = s => String(s || '').replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, ' ').trim();
    const name = clean(AE.stripParty(patient)) || 'Patient', id = clean(reqId);
    const p = pattern || (id ? '{id}_{name}' : '{name}');
    return p.replace('{id}', id).replace('{name}', name) + '.pdf';
  };

  // Request ID: a "Request ID / Request # / Request No." printed in the request, else the number in its file name
  // ("Req_25144285_….pdf", "… REQ 85152.2.pdf", "23642745 adhc ….pdf").
  AE.requestId = function (fileName, pages) {
    const text = pages && pages.length ? AE.fullText(pages.slice(0, 3)) : '';
    const t = text.match(/\brequest\s*(?:id|#|no\.?|number)\s*[:#.]?\s*#?\s*(\d[\d-]{3,})/i);
    if (t) return t[1].replace(/-+$/, '');
    const f = String(fileName || '').replace(/\.[a-z0-9]+$/i, '');
    const m = f.match(/\breq(?:uest)?(?:[\s_#-]*(?:id|no\.?))?[\s_#.-]*(\d{4,})/i) || f.match(/^\s*(\d{5,})/) || f.match(/(?:^|[^\d.])(\d{6,})(?![\d])/);
    return m ? m[1] : '';
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = AE;
  else root.AE = AE;
})(typeof window !== 'undefined' ? window : globalThis);
