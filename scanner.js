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

  // ---------- 사각형 맞추기 ----------
  const cross3 = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y);

  /** 볼록 다각형에서 '지워도 면적이 가장 덜 줄어드는' 꼭짓점을 하나씩 지워 4각형으로 줄인다 */
  function reduceToQuad(poly) {
    const p = poly.slice();
    while (p.length > 4) {
      let best = -1, bestLoss = Infinity;
      for (let i = 0; i < p.length; i++) {
        const loss = Math.abs(cross3(p[(i - 1 + p.length) % p.length], p[i], p[(i + 1) % p.length]));
        if (loss < bestLoss) { bestLoss = loss; best = i; }
      }
      p.splice(best, 1);
    }
    return p.length === 4 ? p : null;
  }

  /** 점들에 맞는 직선 (주성분 방향) */
  function fitLine(pts) {
    let mx = 0, my = 0;
    for (const p of pts) { mx += p.x; my += p.y; }
    mx /= pts.length; my /= pts.length;
    let sxx = 0, sxy = 0, syy = 0;
    for (const p of pts) { const dx = p.x - mx, dy = p.y - my; sxx += dx * dx; sxy += dx * dy; syy += dy * dy; }
    const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    return { x: mx, y: my, dx: Math.cos(ang), dy: Math.sin(ang) };
  }
  const lineDist = (p, L) => Math.abs((p.x - L.x) * L.dy - (p.y - L.y) * L.dx);
  function intersect(L1, L2) {
    const den = L1.dx * L2.dy - L1.dy * L2.dx;
    if (Math.abs(den) < 1e-6) return null;
    const t = ((L2.x - L1.x) * L2.dy - (L2.y - L1.y) * L2.dx) / den;
    return { x: L1.x + L1.dx * t, y: L1.y + L1.dy * t };
  }

  /**
   * 대략적인 4각형의 각 변에 가까운 윤곽점들로 직선을 다시 맞추고, 직선끼리 만나는 곳을 꼭짓점으로.
   * → 둥근 귀퉁이, 손가락에 가려진 모서리도 실제 모서리 위치로 복원된다
   */
  function refineQuad(q, pts, tol) {
    const lines = [];
    for (let k = 0; k < 4; k++) {
      const a = q[k], b = q[(k + 1) % 4];
      const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const ux = (b.x - a.x) / len, uy = (b.y - a.y) / len;
      const near = [];
      for (const p of pts) {
        const t = ((p.x - a.x) * ux + (p.y - a.y) * uy) / len;
        if (t < 0.08 || t > 0.92) continue;
        if (Math.abs((p.x - a.x) * uy - (p.y - a.y) * ux) < tol) near.push(p);
      }
      let L = { x: a.x, y: a.y, dx: ux, dy: uy };
      if (near.length >= 8) {
        L = fitLine(near);
        const inl = near.filter((p) => lineDist(p, L) < tol * 0.5);
        if (inl.length >= 8) L = fitLine(inl);
      }
      lines.push(L);
    }
    const out = [];
    for (let k = 0; k < 4; k++) {
      const c = intersect(lines[(k + 3) % 4], lines[k]);
      if (!c || !isFinite(c.x) || !isFinite(c.y)) return q;
      out.push(c);
    }
    return out;
  }

  /**
   * 경계 강도 지도: 밝기·채도의 Sobel 기울기. 변의 법선 방향 성분만 '경계'로 인정해서
   * 나뭇결·천 무늬처럼 방향이 맞지 않는 선에 속지 않는다
   */
  function makeGrad(blurGray, blurSat) {
    const g = {};
    const tmp = [new cv.Mat(), new cv.Mat(), new cv.Mat(), new cv.Mat()];
    cv.Sobel(blurGray, tmp[0], cv.CV_16S, 1, 0, 3);
    cv.Sobel(blurGray, tmp[1], cv.CV_16S, 0, 1, 3);
    cv.Sobel(blurSat, tmp[2], cv.CV_16S, 1, 0, 3);
    cv.Sobel(blurSat, tmp[3], cv.CV_16S, 0, 1, 3);
    g.gx = tmp[0].data16S.slice(); g.gy = tmp[1].data16S.slice();
    g.sx = tmp[2].data16S.slice(); g.sy = tmp[3].data16S.slice();
    g.w = blurGray.cols; g.h = blurGray.rows;
    tmp.forEach((m) => m.delete());
    return g;
  }
  const GRAD_T = 26; // 경계로 볼 최소 기울기 (Sobel 3x3 기준)

  /** (x,y)에서 법선 (nx,ny) 방향 경계 세기 — 방향이 어긋나면 0 */
  function normalStrength(g, x, y, nx, ny) {
    const i = y * g.w + x;
    let best = 0;
    for (const [ax, ay] of [[g.gx[i], g.gy[i]], [g.sx[i], g.sy[i]]]) {
      const mag = Math.hypot(ax, ay);
      if (mag < GRAD_T) continue;
      const along = Math.abs(ax * nx + ay * ny);
      if (along > 0.8 * mag && along > best) best = along;
    }
    return best;
  }

  /** 4각형 변을 따라 방향이 맞는 경계가 있는 비율. 화면 가장자리에 걸친 부분은 통과 */
  function edgeSupport(q, g) {
    const { w, h } = g;
    let hit = 0, tot = 0, onBorderSides = 0;
    for (let k = 0; k < 4; k++) {
      const a = q[k], b = q[(k + 1) % 4];
      const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const nx = -(b.y - a.y) / len, ny = (b.x - a.x) / len;
      const n = Math.max(16, Math.round(len / 3));
      let border = 0;
      for (let i = 1; i < n; i++) {
        const t = i / n, px = a.x + (b.x - a.x) * t, py = a.y + (b.y - a.y) * t;
        tot++;
        if (px < 3 || py < 3 || px > w - 4 || py > h - 4) { hit++; border++; continue; }
        for (let o = -2; o <= 2; o++) {
          const x = Math.round(px + nx * o), y = Math.round(py + ny * o);
          if (normalStrength(g, x, y, nx, ny)) { hit++; break; }
        }
      }
      if (border > n * 0.5) onBorderSides++;
    }
    return onBorderSides >= 3 ? 0 : hit / tot;
  }

  /** 4각형 안쪽 테두리 띠가 '종이처럼 하얀지' 비율 — 옆 물체까지 포함한 잘못된 후보를 걸러낸다 */
  function insidePaper(q, white, w, h, thr, off) {
    let ok = 0, tot = 0;
    for (let k = 0; k < 4; k++) {
      const a = q[k], b = q[(k + 1) % 4];
      const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const nx = -(b.y - a.y) / len, ny = (b.x - a.x) / len; // 시계방향 정렬 → 안쪽 법선
      for (let i = 1; i < 12; i++) {
        const t = i / 12;
        const x = Math.round(a.x + (b.x - a.x) * t + nx * off), y = Math.round(a.y + (b.y - a.y) * t + ny * off);
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        tot++;
        if (white[y * w + x] >= thr) ok++;
      }
    }
    return tot ? ok / tot : 0;
  }

  /** 대략적인 4각형의 각 변을 근처의 실제 경계선에 달라붙게 다시 맞춘다 */
  function snapQuad(q, g, tol) {
    const { w, h } = g;
    const lines = [];
    for (let k = 0; k < 4; k++) {
      const a = q[k], b = q[(k + 1) % 4];
      const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const ux = (b.x - a.x) / len, uy = (b.y - a.y) / len, nx = -uy, ny = ux;
      const n = Math.max(20, Math.round(len / 2));
      const pts = [];
      let border = 0;
      for (let i = 1; i < n; i++) {
        const t = 0.06 + 0.88 * (i / n), px = a.x + (b.x - a.x) * t, py = a.y + (b.y - a.y) * t;
        if (px < 3 || py < 3 || px > w - 4 || py > h - 4) { border++; continue; }
        let bestS = 0, bp = null;
        for (let o = -tol; o <= tol; o++) {
          const x = Math.round(px + nx * o), y = Math.round(py + ny * o);
          if (x < 1 || y < 1 || x > w - 2 || y > h - 2) continue;
          const st = normalStrength(g, x, y, nx, ny) / (1 + Math.abs(o) * 0.03);
          if (st > bestS) { bestS = st; bp = { x, y }; }
        }
        if (bp) pts.push(bp);
      }
      let L = { x: a.x, y: a.y, dx: ux, dy: uy };
      if (pts.length >= Math.max(8, (n - border) * 0.3)) {
        L = fitLine(pts);
        for (const th of [tol * 0.5, 1.5]) {
          const inl = pts.filter((p) => lineDist(p, L) < Math.max(1.5, th));
          if (inl.length >= 8) L = fitLine(inl);
        }
      }
      lines.push(L);
    }
    const out = [];
    for (let k = 0; k < 4; k++) {
      const c = intersect(lines[(k + 3) % 4], lines[k]);
      if (!c || !isFinite(c.x) || !isFinite(c.y)) return q;
      out.push(c);
    }
    return out;
  }

  function nearQuad(a, b, tol) {
    let s = 0;
    for (let i = 0; i < 4; i++) s += Math.hypot(a[i].x - b[i].x, a[i].y - b[i].y);
    return s / 4 < tol;
  }

  /** 윤곽선 목록에서 문서 후보 4각형 만들기 */
  function collectCandidates(bin, mode, w, h, out) {
    const contours = new cv.MatVector(), hier = new cv.Mat();
    cv.findContours(bin, contours, hier, mode, cv.CHAIN_APPROX_NONE);
    const imgArea = w * h, diag = Math.hypot(w, h);
    const list = [];
    for (let i = 0; i < contours.size(); i++) {
      const cnt = contours.get(i);
      if (cnt.rows < 20) { cnt.delete(); continue; }
      const hull = new cv.Mat();
      cv.convexHull(cnt, hull, false, true);
      const hullArea = cv.contourArea(hull);
      if (hullArea < imgArea * 0.1) { hull.delete(); cnt.delete(); continue; }
      list.push({ cnt, hull, hullArea });
    }
    list.sort((x, y) => y.hullArea - x.hullArea);
    list.forEach((c, idx) => {
      if (idx < 10) {
        const hp = matToPoints(c.hull);
        let q = hp.length >= 4 ? reduceToQuad(hp) : null;
        if (q) {
          const pts = matToPoints(c.cnt);
          q = orderQuad(refineQuad(orderQuad(q), pts, diag * 0.012));
          out.push({ quad: q, hullArea: c.hullArea });
        }
      }
      c.cnt.delete(); c.hull.delete();
    });
    contours.delete(); hier.delete();
  }

  /**
   * 긴 직선(허프 변환)으로 4각형 후보 만들기: 가로 성향 2개 × 세로 성향 2개 조합
   */
  function houghQuads(edges, w, h) {
    const lines = new cv.Mat();
    const minLen = Math.round(Math.min(w, h) * 0.22);
    cv.HoughLinesP(edges, lines, 1, Math.PI / 180, Math.round(minLen * 0.5), minLen, Math.round(minLen * 0.15));
    const raw = [];
    for (let i = 0; i < lines.rows; i++) {
      const [x1, y1, x2, y2] = lines.data32S.subarray(i * 4, i * 4 + 4);
      const len = Math.hypot(x2 - x1, y2 - y1);
      if (len < 1) continue;
      const dx = (x2 - x1) / len, dy = (y2 - y1) / len;
      raw.push({ x: (x1 + x2) / 2, y: (y1 + y2) / 2, dx, dy, len, horiz: Math.abs(dx) >= Math.abs(dy) });
    }
    lines.delete();
    // 거의 같은 직선은 하나로 (긴 것 우선)
    raw.sort((a, b) => b.len - a.len);
    const diag = Math.hypot(w, h), merged = [];
    for (const L of raw) {
      const dup = merged.some((M) => Math.abs(L.dx * M.dy - L.dy * M.dx) < 0.07 && lineDist(L, M) < diag * 0.015);
      if (!dup) merged.push(L);
    }
    const H = merged.filter((L) => L.horiz).slice(0, 8);
    const V = merged.filter((L) => !L.horiz).slice(0, 8);
    const out = [];
    for (let i = 0; i < H.length; i++) for (let j = i + 1; j < H.length; j++) {
      const [top, bot] = H[i].y < H[j].y ? [H[i], H[j]] : [H[j], H[i]];
      if (bot.y - top.y < h * 0.2) continue;
      for (let a = 0; a < V.length; a++) for (let b = a + 1; b < V.length; b++) {
        const [lft, rgt] = V[a].x < V[b].x ? [V[a], V[b]] : [V[b], V[a]];
        if (rgt.x - lft.x < w * 0.2) continue;
        const q = [intersect(top, lft), intersect(top, rgt), intersect(bot, rgt), intersect(bot, lft)];
        if (q.every(Boolean)) out.push(q);
      }
    }
    return out;
  }

  /**
   * 문서 사각형 검출
   * @param {HTMLCanvasElement} canvas 입력 이미지
   * @param {number} maxDim 처리용 축소 크기
   * @param {Array<{x,y}>} [prev] 직전 프레임 결과(원본 좌표) — 비슷한 후보를 우대해 화면이 덜 흔들림
   * @param {number} [minScore] 이보다 신뢰도가 낮으면 null (문서 없는 화면에서 엉뚱한 사각형 방지)
   * @returns {Array<{x,y}>|null} 원본 캔버스 좌표계의 4점 (배열에 .score 신뢰도 포함)
   */
  function detect(canvas, maxDim = 500, prev = null, minScore = 0.22) {
    if (!ready) return null;
    const src = cv.imread(canvas);
    const scale = Math.min(1, maxDim / Math.max(src.cols, src.rows));
    const small = new cv.Mat();
    if (scale < 1) cv.resize(src, small, new cv.Size(Math.round(src.cols * scale), Math.round(src.rows * scale)), 0, 0, cv.INTER_AREA);
    else src.copyTo(small);
    src.delete();

    const w = small.cols, h = small.rows, imgArea = w * h, diag = Math.hypot(w, h);
    const rgb = new cv.Mat(), gray = new cv.Mat(), hsv = new cv.Mat(), chans = new cv.MatVector();
    cv.cvtColor(small, rgb, cv.COLOR_RGBA2RGB);
    cv.cvtColor(rgb, gray, cv.COLOR_RGB2GRAY);
    cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);
    cv.split(hsv, chans);
    const sat = chans.get(1);
    small.delete(); rgb.delete(); hsv.delete(); chans.delete();

    const k3 = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
    const k9 = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(9, 9));
    const blur = new cv.Mat(), closed = new cv.Mat(), e = new cv.Mat(), tmp = new cv.Mat();
    const white = new cv.Mat(), sblur = new cv.Mat(), soft = new cv.Mat(), region = new cv.Mat();
    const cands = [];

    try {
      // 글자를 지운 밝기 영상, 부드럽게 한 채도 영상
      cv.morphologyEx(gray, closed, cv.MORPH_CLOSE, k9, new cv.Point(-1, -1), 2);
      cv.GaussianBlur(closed, blur, new cv.Size(5, 5), 0);
      cv.GaussianBlur(sat, sblur, new cv.Size(5, 5), 0);
      const g = makeGrad(blur, sblur);

      // 엣지 후보: 보통 대비 / 아주 약한 대비(흰 책상 위 종이) / 채도 경계
      cv.Canny(blur, e, 25, 75);
      cv.dilate(e, tmp, k3, new cv.Point(-1, -1), 1);
      collectCandidates(tmp, cv.RETR_LIST, w, h, cands);
      cv.GaussianBlur(closed, soft, new cv.Size(0, 0), 2.5);
      cv.Canny(soft, e, 8, 24);
      cv.dilate(e, tmp, k3, new cv.Point(-1, -1), 1);
      collectCandidates(tmp, cv.RETR_LIST, w, h, cands);
      cv.Canny(sblur, e, 15, 45);
      cv.dilate(e, tmp, k3, new cv.Point(-1, -1), 1);
      collectCandidates(tmp, cv.RETR_LIST, w, h, cands);

      // 영역 후보: 밝은 부분 / 하얀 부분(밝고 채도 낮음). 붙어 있는 배경 물체와 떼기 위해 깎아서도 한 번 더
      cv.subtract(blur, sblur, white);
      let whiteThr = 128;
      for (const srcMap of [blur, white]) {
        const t = cv.threshold(srcMap, region, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
        if (srcMap === white) whiteThr = t;
        cv.morphologyEx(region, region, cv.MORPH_OPEN, k9);
        cv.morphologyEx(region, region, cv.MORPH_CLOSE, k9);
        collectCandidates(region, cv.RETR_EXTERNAL, w, h, cands);
        cv.erode(region, tmp, k9, new cv.Point(-1, -1), 2);
        collectCandidates(tmp, cv.RETR_EXTERNAL, w, h, cands);
      }

      const whiteData = white.data;
      const prevS = prev ? prev.map((p) => ({ x: p.x * scale, y: p.y * scale })) : null;
      const tol = Math.max(4, Math.round(diag * 0.025));
      const paperOff = Math.max(3, diag * 0.012);
      let best = null, bestScore = 0, bestSup = 0;

      /** 후보 평가: 모양 → 종이 띠 → 경계 일치도 순으로 걸러서 점수 */
      const consider = (q, hullArea) => {
        if (q.some((p) => p.x < -w * 0.05 || p.y < -h * 0.05 || p.x > w * 1.05 || p.y > h * 1.05)) return;
        q = q.map((p) => ({ x: Math.max(0, Math.min(w - 1, p.x)), y: Math.max(0, Math.min(h - 1, p.y)) }));
        if (!isConvex(q) || !hasReasonableAngles(q)) return;
        const area = polygonArea(q);
        if (area < imgArea * 0.1 || area > imgArea * 0.97) return;
        if (hullArea && (area / hullArea < 0.6 || area / hullArea > 1.6)) return; // 원·찌그러진 모양 제외
        const paper = insidePaper(q, whiteData, w, h, whiteThr * 0.85, paperOff);
        const sup = edgeSupport(q, g);
        if (sup < 0.6) return;
        let score = Math.pow(sup, 3) * Math.sqrt(area / imgArea) * (0.35 + 0.65 * paper);
        if (prevS && nearQuad(q, prevS, diag * 0.04)) score *= 1.25;
        if (score > bestScore) { bestScore = score; best = q; bestSup = sup; }
      };

      for (const c of cands) {
        // 실제 경계선에 달라붙이기 (넓게 → 좁게)
        let q = orderQuad(snapQuad(c.quad, g, tol));
        q = orderQuad(snapQuad(q, g, Math.max(3, tol >> 1)));
        consider(q, c.hullArea);
      }

      // 폴백: 잡동사니에 윤곽이 엉킨 경우 — 긴 직선들로 4각형 조합
      if (!best || bestSup < 0.8) {
        cv.Canny(blur, e, 25, 75);
        cv.Canny(sblur, tmp, 15, 45);
        cv.bitwise_or(e, tmp, e);
        for (const q of houghQuads(e, w, h)) consider(orderQuad(snapQuad(q, g, Math.max(3, tol >> 1))), 0);
      }

      if (!best || bestScore < minScore) return null;
      const res = best.map((p) => ({ x: p.x / scale, y: p.y / scale }));
      res.score = bestScore;
      return res;
    } finally {
      [gray, sat, k3, k9, blur, closed, e, tmp, white, sblur, soft, region].forEach((m) => m.delete());
    }
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

  return { init, isReady, detect, nearQuad, warp, applyFilter, ocrPrep, orderQuad, isConvex, polygonArea, LEVELS };
})();
