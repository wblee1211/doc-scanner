/**
 * Scanner — OpenCV.js 기반 문서 테두리 인식, 원근 보정, 필터 처리
 */
window.Scanner = (() => {
  let ready = false;

  /** OpenCV 런타임 초기화 대기 (빌드마다 노출 방식이 달라 모두 대응) */
  function init() {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('OpenCV 초기화 시간 초과')), 60000);
      const done = () => { clearTimeout(timer); ready = true; resolve(); };
      let c = window.cv;
      if (!c) return reject(new Error('cv 없음'));
      if (typeof c === 'function' && !c.Mat) {
        try { c = c(); } catch (e) { return reject(e); }
      }
      if (c.Mat) { window.cv = c; return done(); }
      if (typeof c.then === 'function') {
        c.then((m) => {
          // Emscripten 모듈은 자체 then을 가지므로 resolve에 그대로 넘기지 않는다
          if (m && m.then) delete m.then;
          window.cv = m;
          done();
        });
      } else {
        c.onRuntimeInitialized = done;
      }
    });
  }

  const isReady = () => ready;

  // ---------- 기하 유틸 ----------
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  /** 4점을 시계방향 [좌상, 우상, 우하, 좌하] 순서로 정렬 */
  function orderQuad(pts) {
    const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
    const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
    const sorted = pts.slice().sort((a, b) =>
      Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
    let tl = 0;
    sorted.forEach((p, i) => { if (p.x + p.y < sorted[tl].x + sorted[tl].y) tl = i; });
    return [0, 1, 2, 3].map((k) => sorted[(tl + k) % 4]);
  }

  function polygonArea(q) {
    let a = 0;
    for (let i = 0; i < q.length; i++) {
      const p = q[i], n = q[(i + 1) % q.length];
      a += p.x * n.y - n.x * p.y;
    }
    return Math.abs(a) / 2;
  }

  /** 볼록 사각형인지 검사 (모든 외적 부호가 같아야 함) */
  function isConvex(q) {
    let sign = 0;
    for (let i = 0; i < 4; i++) {
      const a = q[i], b = q[(i + 1) % 4], c = q[(i + 2) % 4];
      const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
      if (Math.abs(cross) < 1e-6) return false;
      const s = Math.sign(cross);
      if (sign === 0) sign = s; else if (s !== sign) return false;
    }
    return true;
  }

  /** 사각형 내각이 너무 찌그러지지 않았는지 (문서다운 모양인지) */
  function hasReasonableAngles(q) {
    for (let i = 0; i < 4; i++) {
      const p = q[(i + 3) % 4], c = q[i], n = q[(i + 1) % 4];
      const v1 = { x: p.x - c.x, y: p.y - c.y }, v2 = { x: n.x - c.x, y: n.y - c.y };
      const cos = (v1.x * v2.x + v1.y * v2.y) / (Math.hypot(v1.x, v1.y) * Math.hypot(v2.x, v2.y));
      const deg = Math.acos(Math.max(-1, Math.min(1, cos))) * 180 / Math.PI;
      if (deg < 45 || deg > 135) return false;
    }
    return true;
  }

  function matToPoints(mat) {
    const pts = [];
    for (let i = 0; i < mat.rows; i++) pts.push({ x: mat.data32S[i * 2], y: mat.data32S[i * 2 + 1] });
    return pts;
  }

  /** 엣지 이미지에서 가장 큰 문서형 사각형 찾기 */
  function findQuadInEdges(edges, w, h) {
    const contours = new cv.MatVector();
    const hierarchy = new cv.Mat();
    cv.findContours(edges, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
    const imgArea = w * h;
    let best = null, bestArea = 0;

    for (let i = 0; i < contours.size(); i++) {
      const cnt = contours.get(i);
      const area = cv.contourArea(cnt);
      if (area < imgArea * 0.1 || area <= bestArea) { cnt.delete(); continue; }

      const hull = new cv.Mat();
      cv.convexHull(cnt, hull, false, true);
      const peri = cv.arcLength(hull, true);
      for (const eps of [0.02, 0.03, 0.045, 0.06]) {
        const approx = new cv.Mat();
        cv.approxPolyDP(hull, approx, eps * peri, true);
        if (approx.rows === 4) {
          const q = orderQuad(matToPoints(approx));
          const a = polygonArea(q);
          if (a > bestArea && a < imgArea * 0.985 && isConvex(q) && hasReasonableAngles(q)) {
            best = q; bestArea = a;
          }
          approx.delete();
          break;
        }
        approx.delete();
      }
      hull.delete();
      cnt.delete();
    }
    contours.delete();
    hierarchy.delete();
    return best ? { quad: best, area: bestArea } : null;
  }

  /**
   * 문서 사각형 검출
   * @param {HTMLCanvasElement} canvas 입력 이미지
   * @param {number} maxDim 처리용 축소 크기
   * @returns {Array<{x,y}>|null} 원본 캔버스 좌표계의 4점
   */
  function detect(canvas, maxDim = 500) {
    if (!ready) return null;
    const src = cv.imread(canvas);
    const scale = Math.min(1, maxDim / Math.max(src.cols, src.rows));
    const small = new cv.Mat();
    if (scale < 1) cv.resize(src, small, new cv.Size(Math.round(src.cols * scale), Math.round(src.rows * scale)), 0, 0, cv.INTER_AREA);
    else src.copyTo(small);
    src.delete();

    const w = small.cols, h = small.rows;
    const gray = new cv.Mat();
    cv.cvtColor(small, gray, cv.COLOR_RGBA2GRAY);
    small.delete();

    const results = [];
    const k3 = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
    const k9 = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(9, 9));
    const blur = new cv.Mat(), edges = new cv.Mat(), tmp = new cv.Mat();

    try {
      // 전략 1: 모폴로지 닫힘으로 글자를 지운 뒤 Canny
      cv.morphologyEx(gray, tmp, cv.MORPH_CLOSE, k9, new cv.Point(-1, -1), 2);
      cv.GaussianBlur(tmp, blur, new cv.Size(5, 5), 0);
      cv.Canny(blur, edges, 30, 100);
      cv.dilate(edges, edges, k3, new cv.Point(-1, -1), 2);
      results.push(findQuadInEdges(edges, w, h));

      // 전략 2: 일반 Canny
      cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0);
      cv.Canny(blur, edges, 60, 180);
      cv.dilate(edges, edges, k3, new cv.Point(-1, -1), 1);
      results.push(findQuadInEdges(edges, w, h));

      // 전략 3: Otsu 이진화 (밝은 문서 / 어두운 배경)
      cv.threshold(blur, edges, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
      cv.morphologyEx(edges, edges, cv.MORPH_OPEN, k9);
      results.push(findQuadInEdges(edges, w, h));
    } finally {
      gray.delete(); blur.delete(); edges.delete(); tmp.delete(); k3.delete(); k9.delete();
    }

    const best = results.filter(Boolean).sort((a, b) => b.area - a.area)[0];
    if (!best) return null;
    return best.quad.map((p) => ({ x: p.x / scale, y: p.y / scale }));
  }

  /** 원근 보정: quad 영역을 평평한 직사각형 캔버스로 변환 */
  function warp(canvas, quad, maxSide = 3500) {
    const [tl, tr, br, bl] = quad;
    let w = Math.max(dist(tl, tr), dist(bl, br));
    let h = Math.max(dist(tl, bl), dist(tr, br));
    const s = Math.min(1, maxSide / Math.max(w, h));
    w = Math.max(1, Math.round(w * s));
    h = Math.max(1, Math.round(h * s));

    const out = document.createElement('canvas');
    out.width = w; out.height = h;

    if (!ready) {
      // OpenCV 없이: 경계 상자만 잘라내기
      const xs = quad.map((p) => p.x), ys = quad.map((p) => p.y);
      const x0 = Math.min(...xs), y0 = Math.min(...ys);
      out.width = Math.round(Math.max(...xs) - x0);
      out.height = Math.round(Math.max(...ys) - y0);
      out.getContext('2d').drawImage(canvas, -x0, -y0);
      return out;
    }

    const src = cv.imread(canvas);
    const dst = new cv.Mat();
    const srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, [tl.x, tl.y, tr.x, tr.y, br.x, br.y, bl.x, bl.y]);
    const dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, w, 0, w, h, 0, h]);
    const M = cv.getPerspectiveTransform(srcTri, dstTri);
    cv.warpPerspective(src, dst, M, new cv.Size(w, h), cv.INTER_CUBIC, cv.BORDER_REPLICATE, new cv.Scalar());
    cv.imshow(out, dst);
    src.delete(); dst.delete(); srcTri.delete(); dstTri.delete(); M.delete();
    return out;
  }

  /** 그림자/조명 얼룩 제거용 배경(종이색) 추정 — 축소 후 글자를 지우고 부드럽게 퍼뜨린다 */
  // size가 작을수록 더 큰 물체(색칠된 도형 등)까지 '내용'으로 보고 보존한다
  function estimateBackground(ch, size = 600) {
    const small = new cv.Mat(), bg = new cv.Mat();
    const f = Math.min(1, size / Math.max(ch.cols, ch.rows));
    cv.resize(ch, small, new cv.Size(Math.round(ch.cols * f), Math.round(ch.rows * f)), 0, 0, cv.INTER_AREA);
    const k = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(7, 7));
    cv.dilate(small, small, k, new cv.Point(-1, -1), 2);
    cv.medianBlur(small, small, size >= 400 ? 21 : 11);
    cv.GaussianBlur(small, small, new cv.Size(0, 0), size >= 400 ? 4 : 3);
    cv.resize(small, bg, new cv.Size(ch.cols, ch.rows), 0, 0, cv.INTER_LINEAR);
    small.delete(); k.delete();
    return bg;
  }

  /** 채널을 배경으로 나눠 종이를 흰색(≈255)으로 맞추고, 글자 윤곽을 살짝 선명하게 */
  function normalizeChannel(ch, sharpen = true) {
    const den = new cv.Mat();
    cv.GaussianBlur(ch, den, new cv.Size(3, 3), 0); // 카메라 노이즈 완화
    const bg = estimateBackground(den);
    const out = new cv.Mat();
    cv.divide(den, bg, out, 255);
    bg.delete(); den.delete();
    if (sharpen) {
      const blur = new cv.Mat();
      cv.GaussianBlur(out, blur, new cv.Size(0, 0), 1.5);
      cv.addWeighted(out, 1.5, blur, -0.5, 0, out);
      blur.delete();
    }
    return out;
  }

  function percentile(hist, total, p) {
    let acc = 0;
    for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= total * p) return i; }
    return 255;
  }

  /**
   * 정규화된 이미지의 밝기 분포에서 흰점/검은점 자동 계산
   * - 흰점보다 밝은 것(종이, 뒷면 비침, 노이즈)은 완전한 흰색으로
   * - 검은점보다 어두운 것(글자)은 진한 검정으로
   */
  function autoLevels(lumAt, count) {
    const hist = new Uint32Array(256);
    const step = Math.max(1, Math.floor(count / 250000));
    let n = 0;
    for (let i = 0; i < count; i += step) { hist[lumAt(i)]++; n++; }
    const paper = percentile(hist, n, 0.5);   // 종이가 화면 대부분을 차지
    const ink = percentile(hist, n, 0.01);
    const white = Math.max(160, Math.min(240, paper - 28));
    const black = Math.max(0, Math.min(white - 80, ink + 30));
    return { white, black };
  }

  const LEVELS = { whiteGap: 14, blackKeep: 0.55, sharpen: 0.35, maxGain: 2.2, bwRatio: 0.75 };

  /**
   * 종이 색/밝기 지도 추정 — 자연스러운 보정용 (채널 하나)
   * 크게 축소한 뒤 '최대값' 필터로 주변의 밝은 종이를 퍼뜨린다.
   * 글자는 물론 색칠된 도형 위에도 주변 종이 색이 덮이므로, 도형 색이 허옇게 날아가지 않는다.
   */
  function estimatePaper(ch) {
    const small = new cv.Mat(), out = new cv.Mat();
    const f = Math.min(1, 200 / Math.max(ch.cols, ch.rows));
    cv.resize(ch, small, new cv.Size(Math.max(1, Math.round(ch.cols * f)), Math.max(1, Math.round(ch.rows * f))), 0, 0, cv.INTER_AREA);
    const k = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(7, 7));
    cv.dilate(small, small, k, new cv.Point(-1, -1), 2);
    cv.GaussianBlur(small, small, new cv.Size(0, 0), 3);
    cv.resize(small, out, new cv.Size(ch.cols, ch.rows), 0, 0, cv.INTER_LINEAR);
    small.delete(); k.delete();
    return out;
  }

  /**
   * 자연스러운 문서 보정 (컬러 / 그레이)
   * 1) 채널별 종이 지도로 나눠 그림자·조명 얼룩·종이 누런기를 고르게 (도형 색은 유지)
   * 2) 레벨: 종이는 흰색, 글자는 조금만 더 진하게 — 채도는 건드리지 않음
   * 3) 아주 약한 선명화
   */
  function cleanNatural(src, out, grayscale) {
    const rgb = new cv.Mat();
    cv.cvtColor(src, rgb, grayscale ? cv.COLOR_RGBA2GRAY : cv.COLOR_RGBA2RGB);
    const chans = new cv.MatVector();
    cv.split(rgb, chans);
    const n = chans.size();
    const maxGain = LEVELS.maxGain;
    const norm = new cv.MatVector();
    for (let ci = 0; ci < n; ci++) {
      const ch = chans.get(ci);
      const paper = estimatePaper(ch);
      const d = ch.data, P = paper.data;
      const nm = new cv.Mat(ch.rows, ch.cols, cv.CV_8UC1);
      const o = nm.data;
      for (let i = 0; i < d.length; i++) {
        const v = d[i] * Math.min(maxGain, 255 / Math.max(P[i], 1));
        o[i] = v > 255 ? 255 : v;
      }
      norm.push_back(nm);
      ch.delete(); paper.delete(); nm.delete();
    }
    chans.delete(); rgb.delete();

    const res = new cv.Mat();
    if (n === 1) { const m = norm.get(0); m.copyTo(res); m.delete(); } else cv.merge(norm, res);
    norm.delete();

    // 밝기 분포에서 흰점/검은점: 종이 → 흰색, 글자는 '조금만' 진하게
    const d = res.data, px = res.rows * res.cols;
    const lum = n === 1 ? (i) => d[i] : (i) => (d[i * 3] * 77 + d[i * 3 + 1] * 150 + d[i * 3 + 2] * 29) >> 8;
    const hist = new Uint32Array(256);
    const step = Math.max(1, Math.floor(px / 250000));
    let hn = 0;
    for (let i = 0; i < px; i += step) { hist[lum(i)]++; hn++; }
    const paperLv = percentile(hist, hn, 0.5);
    const ink = percentile(hist, hn, 0.005);
    const white = Math.max(170, paperLv - LEVELS.whiteGap);
    const black = Math.min(white - 100, ink * LEVELS.blackKeep);
    res.convertTo(res, -1, 255 / (white - black), -black * 255 / (white - black));

    // 아주 약한 언샤프 마스크 (계단 현상 없이 글자 윤곽만 또렷하게)
    if (LEVELS.sharpen > 0) {
      const blur = new cv.Mat();
      cv.GaussianBlur(res, blur, new cv.Size(0, 0), 1.0);
      cv.addWeighted(res, 1 + LEVELS.sharpen, blur, -LEVELS.sharpen, 0, res);
      blur.delete();
    }
    const rgba = new cv.Mat();
    cv.cvtColor(res, rgba, n === 1 ? cv.COLOR_GRAY2RGBA : cv.COLOR_RGB2RGBA);
    cv.imshow(out, rgba);
    res.delete(); rgba.delete();
  }

  /** 흑백 이미지에서 몇 픽셀짜리 외딴 검은 점만 지운다 (가는 선·글자는 보존) */
  function removeSpeckles(bin, maxArea) {
    const inv = new cv.Mat(), labels = new cv.Mat(), stats = new cv.Mat(), cents = new cv.Mat();
    cv.bitwise_not(bin, inv);
    const n = cv.connectedComponentsWithStats(inv, labels, stats, cents, 8, cv.CV_32S);
    const small = new Uint8Array(n);
    for (let i = 1; i < n; i++) small[i] = stats.intAt(i, cv.CC_STAT_AREA) <= maxArea ? 1 : 0;
    const lab = labels.data32S, b = bin.data;
    for (let i = 0; i < lab.length; i++) if (small[lab[i]]) b[i] = 255;
    inv.delete(); labels.delete(); stats.delete(); cents.delete();
  }

  /** 흑백 문서: 글자/배경을 완전한 흑·백으로 */
  function cleanBW(src, out) {
    const gray = new cv.Mat();
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    const norm = normalizeChannel(gray);
    gray.delete();
    const d = norm.data;
    const px = norm.rows * norm.cols;
    const { white, black } = autoLevels((i) => d[i], px);
    const bin = new cv.Mat();
    cv.threshold(norm, bin, black + (white - black) * LEVELS.bwRatio, 255, cv.THRESH_BINARY);
    norm.delete();
    removeSpeckles(bin, Math.max(4, Math.round(px / 400000)));
    const rgba = new cv.Mat();
    cv.cvtColor(bin, rgba, cv.COLOR_GRAY2RGBA);
    cv.imshow(out, rgba);
    bin.delete(); rgba.delete();
  }

  /**
   * 글자가 아닌 큰 테두리(답 칸 네모, 그림 틀)와 가로줄(분수선, 밑줄)을 지운다
   * ink: 글자=255 인 이진 이미지 (제자리 수정)
   */
  function removeBoxesAndRules(ink) {
    const labels = new cv.Mat(), stats = new cv.Mat(), cents = new cv.Mat();
    const n = cv.connectedComponentsWithStats(ink, labels, stats, cents, 8, cv.CV_32S);
    const W = cv.CC_STAT_WIDTH, H = cv.CC_STAT_HEIGHT, A = cv.CC_STAT_AREA;
    // 글자 크기 기준: 적당한 크기 덩어리들의 높이 중앙값
    const hs = [];
    for (let i = 1; i < n; i++) {
      const h = stats.intAt(i, H), a = stats.intAt(i, A);
      if (a >= 12 && h >= 6) hs.push(h);
    }
    hs.sort((x, y) => x - y);
    const med = hs.length ? hs[Math.floor(hs.length / 2)] : 20;
    const kill = new Uint8Array(n);
    for (let i = 1; i < n; i++) {
      const w = stats.intAt(i, W), h = stats.intAt(i, H), a = stats.intAt(i, A);
      const fill = a / (w * h);
      const hollowBox = (h > med * 1.8 || w > med * 4) && fill < 0.3;      // 속이 빈 큰 테두리
      const rule = w > med * 2.5 && h < med * 0.45;                         // 가로선
      const bar = h > med * 2.5 && w < med * 0.45;                          // 세로선
      const blob = (h > med * 4 && w > med * 4);                            // 큰 그림 덩어리
      if (hollowBox || rule || bar || blob) kill[i] = 1;
    }
    const lab = labels.data32S, d = ink.data;
    for (let i = 0; i < lab.length; i++) if (kill[lab[i]]) d[i] = 0;
    labels.delete(); stats.delete(); cents.delete();
  }

  /**
   * 글자 인식용 전처리: 흑백으로 만들고, 네모 칸·밑줄 같은 긴 선을 지워 글자만 남긴다
   * @returns {HTMLCanvasElement}
   */
  function ocrPrep(canvas) {
    const out = document.createElement('canvas');
    out.width = canvas.width; out.height = canvas.height;
    if (!ready) { out.getContext('2d').drawImage(canvas, 0, 0); return out; }
    const src = cv.imread(canvas);
    const gray = new cv.Mat();
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    src.delete();
    const norm = normalizeChannel(gray, false);
    gray.delete();
    const px = norm.rows * norm.cols;
    const d = norm.data;
    const { white, black } = autoLevels((i) => d[i], px);
    const ink = new cv.Mat(); // 글자 = 흰색(255)
    cv.threshold(norm, ink, black + (white - black) * LEVELS.bwRatio, 255, cv.THRESH_BINARY_INV);
    norm.delete();

    removeBoxesAndRules(ink);

    cv.bitwise_not(ink, ink); // 다시 흰 바탕 검은 글자
    removeSpeckles(ink, Math.max(4, Math.round(px / 400000)));
    const rgba = new cv.Mat();
    cv.cvtColor(ink, rgba, cv.COLOR_GRAY2RGBA);
    cv.imshow(out, rgba);
    ink.delete(); rgba.delete();
    return out;
  }

  /**
   * 필터 적용
   * @param {'original'|'clean'|'gray'|'bw'} filter  clean=자연스러운 컬러 문서
   */
  function applyFilter(canvas, filter) {
    const out = document.createElement('canvas');
    out.width = canvas.width; out.height = canvas.height;
    if (filter === 'original' || !ready) {
      out.getContext('2d').drawImage(canvas, 0, 0);
      return out;
    }
    const src = cv.imread(canvas);
    try {
      if (filter === 'bw') cleanBW(src, out);
      else cleanNatural(src, out, filter === 'gray');
    } finally {
      src.delete();
    }
    return out;
  }

  return { init, isReady, detect, warp, applyFilter, ocrPrep, orderQuad, isConvex, polygonArea, LEVELS };
})();
