/*
 * Offline OCR for scanned PDFs (pages that are only a picture, e.g. from a Canon scanner).
 * Uses the Tesseract engine in lib/ocr-core.js and the English data in lib/ocr-eng-data.js.
 * Both are loaded only the first time a scanned page needs reading. Nothing leaves this computer.
 */
(function (root) {
  'use strict';
  const OCR = {};
  let ready = null;

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error('Could not load ' + src));
      document.head.appendChild(s);
    });
  }

  OCR.init = function () {
    if (!ready) {
      ready = (async () => {
        await loadScript('lib/ocr-core.js');
        await loadScript('lib/ocr-eng-data.js');
        const M = await root.TesseractCore();
        const gz = Uint8Array.from(atob(root.OCR_ENG_GZ_B64), c => c.charCodeAt(0));
        const data = new Uint8Array(await new Response(new Blob([gz]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
        root.OCR_ENG_GZ_B64 = null;
        M.FS.writeFile('/eng.traineddata', data);
        const api = new M.TessBaseAPI();
        if (api.Init('/', 'eng', 1)) throw new Error('The OCR engine could not start.');
        return { M, api };
      })();
      ready.catch(() => { ready = null; });
    }
    return ready;
  };

  /*
   * Reads the words on a rendered page. Returns boxes in canvas pixels:
   * [{ text, left, width, lineTop, lineBottom }] — every word carries its whole line's top/bottom,
   * so words on one line share a baseline.
   */
  OCR.readCanvas = async function (canvas) {
    const { M, api } = await OCR.init();
    const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
    M.FS.writeFile('/input', new Uint8Array(await blob.arrayBuffer()));
    api.SetImageFile(1, 0);
    api.SetPageSegMode(1); // automatic page layout with orientation detection
    api.Recognize(null);
    const rows = api.GetTSVText(0).split('\n').map(l => l.split('\t'));
    const lines = {};
    for (const c of rows) if (c[0] === '4') lines[c.slice(2, 5).join('.')] = { top: +c[7], height: +c[9] };
    const words = [];
    for (const c of rows) {
      if (c[0] !== '5' || !c[11] || !c[11].trim()) continue;
      const line = lines[c.slice(2, 5).join('.')] || { top: +c[7], height: +c[9] };
      words.push({ text: c[11].trim(), left: +c[6], width: +c[8], lineTop: line.top, lineBottom: line.top + line.height, conf: +c[10] });
    }
    return words;
  };

  root.OCR = OCR;
})(window);
