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
  function warp(canvas, quad, maxSide = 2400) {
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

  /** 그림자/조명 얼룩 제거용 배경 추정 (축소 후 처리해 속도 확보) */
  function estimateBackground(ch) {
    const small = new cv.Mat(), bg = new cv.Mat();
    const f = Math.min(1, 600 / Math.max(ch.cols, ch.rows));
    cv.resize(ch, small, new cv.Size(Math.round(ch.cols * f), Math.round(ch.rows * f)), 0, 0, cv.INTER_AREA);
    const k = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(7, 7));
    cv.dilate(small, small, k, new cv.Point(-1, -1), 2);
    cv.medianBlur(small, small, 21);
    cv.resize(small, bg, new cv.Size(ch.cols, ch.rows), 0, 0, cv.INTER_LINEAR);
    small.delete(); k.delete();
    return bg;
  }

  function normalizeChannel(ch) {
    const bg = estimateBackground(ch);
    const out = new cv.Mat();
    cv.divide(ch, bg, out, 255);
    bg.delete();
    return out;
  }

  /**
   * 필터 적용
   * @param {'original'|'magic'|'gray'|'bw'} filter
   */
  function applyFilter(canvas, filter) {
    const out = document.createElement('canvas');
    out.width = canvas.width; out.height = canvas.height;
    if (filter === 'original' || !ready) {
      out.getContext('2d').drawImage(canvas, 0, 0);
      return out;
    }

    const src = cv.imread(canvas);
    const dst = new cv.Mat();
    try {
      if (filter === 'gray') {
        cv.cvtColor(src, dst, cv.COLOR_RGBA2GRAY);
      } else if (filter === 'magic') {
        const rgb = new cv.Mat();
        cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);
        const chans = new cv.MatVector();
        cv.split(rgb, chans);
        const merged = new cv.MatVector();
        for (let i = 0; i < 3; i++) {
          const c = chans.get(i);
          const n = normalizeChannel(c);
          merged.push_back(n);
          c.delete(); n.delete();
        }
        const tmp = new cv.Mat();
        cv.merge(merged, tmp);
        // 약간의 대비 강화
        tmp.convertTo(dst, -1, 1.15, -20);
        rgb.delete(); chans.delete(); merged.delete(); tmp.delete();
      } else if (filter === 'bw') {
        const gray = new cv.Mat();
        cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
        const norm = normalizeChannel(gray);
        let block = Math.round(Math.max(gray.cols, gray.rows) / 60) | 1;
        block = Math.max(15, block);
        cv.adaptiveThreshold(norm, dst, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, block, 12);
        gray.delete(); norm.delete();
      }
      cv.imshow(out, dst);
    } finally {
      src.delete(); dst.delete();
    }
    return out;
  }

  return { init, isReady, detect, warp, applyFilter, orderQuad, isConvex, polygonArea };
})();
