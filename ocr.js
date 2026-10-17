/**
 * OCR — Tesseract.js(한국어+영어) 글자 인식, PDF 숨은 글자 레이어
 * 필요할 때만 엔진·언어 데이터·글꼴을 내려받는다 (처음 한 번, 이후 브라우저 캐시)
 */
window.OCR = (() => {
  const TESS_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
  // 검색 가능한 PDF에 한글을 넣기 위한 글꼴 (나눔고딕, OFL 라이선스)
  const FONT_URL = 'https://cdn.jsdelivr.net/gh/google/fonts@16680f8688ffcd467d2eb2146a9ce0343404581d/ofl/nanumgothic/NanumGothic-Regular.ttf';
  const FONT_FILE = 'NanumGothic-Regular.ttf';
  const FONT_NAME = 'NanumGothic';
  const MAX_SIDE = 2200; // 인식용 이미지 최대 크기 (너무 크면 폰에서 느림)

  let workerPromise = null;
  let onProgress = null;
  let fontB64 = null;

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error('스크립트 로드 실패: ' + src));
      document.head.appendChild(s);
    });
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  }

  function getWorker() {
    if (!workerPromise) {
      workerPromise = (async () => {
        if (!window.Tesseract) await loadScript(TESS_URL);
        const worker = await Tesseract.createWorker(['kor', 'eng'], 1, {
          logger: (m) => onProgress && onProgress(m),
        });
        await worker.setParameters({ preserve_interword_spaces: '1' });
        return worker;
      })().catch((e) => { workerPromise = null; throw e; });
    }
    return workerPromise;
  }

  // 글자로 볼 수 없는 토큰: 기호만 있거나, 네모 칸 테두리를 잘못 읽은 낱자 모음/자음
  const JUNK = /^([|!¦「」『』\[\](){}<>~`'"_=+*^\\/:;.,·…—–\-、ㆍ©®°‘’“”@#$%&]+|[ㄱ-ㅣ]|[A-Za-z]{1,2}|[©®@][0-9A-Za-z]*)$/;

  /**
   * 이미지에서 글자 인식
   * @param {HTMLCanvasElement} canvas 인식할 이미지 (전처리된 흑백 권장)
   * @param {(m:{status:string, progress:number})=>void} progress
   * @returns {{text:string, lines:Array<{text,x0,y0,x1,y1}>, w:number, h:number}}
   */
  async function recognize(canvas, progress) {
    onProgress = progress;
    const worker = await getWorker();
    const w = canvas.width, h = canvas.height;
    // 너무 크면 줄이고, 작으면(글자가 작으면) 키워서 인식률을 높인다
    const s = Math.min(1.6, MAX_SIDE / Math.max(w, h));
    let input = canvas;
    if (Math.abs(s - 1) > 0.05) {
      input = document.createElement('canvas');
      input.width = Math.round(w * s);
      input.height = Math.round(h * s);
      input.getContext('2d').drawImage(canvas, 0, 0, input.width, input.height);
    }

    const { data } = await worker.recognize(input);
    const lines = (data.lines || [])
      .map((ln) => {
        const words = (ln.words || []).filter((wd) => wd.text.trim() && !JUNK.test(wd.text.trim()));
        if (!words.length) return null;
        // 띄어쓰기는 Tesseract가 만든 줄 텍스트를 그대로 쓰고, 잡음 토큰만 뺀다
        const text = ln.text.split(/\s+/).filter((t) => t && !JUNK.test(t)).join(' ');
        const letters = (text.match(/[가-힣A-Za-z0-9]/g) || []).length;
        const hangulOrNum = (text.match(/[가-힣0-9]/g) || []).length;
        if (ln.confidence < 40 || letters < Math.max(1, text.replace(/\s/g, '').length * 0.5)) return null;
        if (hangulOrNum < 2 && text.length < 4) return null; // 짧은 영문 잡음 줄
        return {
          text,
          x0: Math.min(...words.map((wd) => wd.bbox.x0)) / s,
          y0: Math.min(...words.map((wd) => wd.bbox.y0)) / s,
          x1: Math.max(...words.map((wd) => wd.bbox.x1)) / s,
          y1: Math.max(...words.map((wd) => wd.bbox.y1)) / s,
        };
      })
      .filter(Boolean);

    // 줄 간격이 크게 벌어진 곳은 빈 줄로 문단 구분
    let text = '';
    lines.forEach((ln, i) => {
      if (i) {
        const prev = lines[i - 1];
        const gap = ln.y0 - prev.y1, lh = prev.y1 - prev.y0;
        text += gap > lh * 1.2 ? '\n\n' : '\n';
      }
      text += ln.text;
    });
    return { text, lines, w, h };
  }

  // ---------- 검색 가능한 PDF ----------
  function toBase64(buf) {
    const bytes = new Uint8Array(buf);
    let bin = '';
    const CH = 0x8000;
    for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    return btoa(bin);
  }

  /** jsPDF 문서에 한글 글꼴 등록 (글꼴 파일은 한 번만 내려받음) */
  async function ensureFont(doc) {
    if (!fontB64) {
      const res = await fetch(FONT_URL);
      if (!res.ok) throw new Error('글꼴 다운로드 실패');
      fontB64 = toBase64(await res.arrayBuffer());
    }
    doc.addFileToVFS(FONT_FILE, fontB64);
    doc.addFont(FONT_FILE, FONT_NAME, 'normal');
  }

  /**
   * 페이지 이미지 위에 보이지 않는 글자를 같은 위치에 깔아 검색·복사가 되게 한다
   * @param x,y,iw,ih PDF에 이미지가 놓인 위치와 크기(pt)
   */
  function addTextLayer(doc, ocr, x, y, iw, ih) {
    if (!ocr || !ocr.lines.length) return;
    doc.setFont(FONT_NAME, 'normal');
    const sx = iw / ocr.w, sy = ih / ocr.h;
    for (const ln of ocr.lines) {
      const bw = (ln.x1 - ln.x0) * sx, bh = (ln.y1 - ln.y0) * sy;
      if (bw <= 0 || bh <= 0 || !ln.text) continue;
      doc.setFontSize(bh * 1.1);
      const tw = doc.getTextWidth(ln.text);
      doc.text(ln.text, x + ln.x0 * sx, y + ln.y1 * sy - bh * 0.12, {
        renderingMode: 'invisible',
        baseline: 'alphabetic',
        horizontalScale: tw > 0 ? bw / tw : 1,
      });
    }
  }

  return { recognize, ensureFont, addTextLayer };
})();
