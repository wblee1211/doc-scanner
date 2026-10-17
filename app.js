/**
 * App — 화면 전환, 카메라, 테두리 조정 UI, 페이지 관리, PDF 내보내기
 */
window.App = (() => {
  const $ = (id) => document.getElementById(id);

  const state = {
    cvReady: false,
    autoDetect: true,
    stream: null,
    track: null,
    torchOn: false,
    liveQuad: null,      // 비디오 좌표계 목표 사각형
    displayQuad: null,   // 화면에 그려지는 보간된 사각형
    missCount: 0,
    pages: [],           // { src: dataURL, quad, filter, rotation, out: dataURL, w, h }
    session: null,       // 현재 편집 중인 { srcCanvas, quad, warped, filter, rotation, cache, editIndex }
    pageSize: 'a4',
    viewerIndex: -1,
  };

  // ---------- 공통 유틸 ----------
  let toastTimer;
  function toast(msg, ms = 2000) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), ms);
  }

  function showLoader(text) {
    $('loaderText').textContent = text;
    $('loader').classList.remove('hide', 'hidden');
  }
  function hideLoader() { $('loader').classList.add('hide'); }

  /** 무거운 작업 전에 로더를 그릴 시간을 준다 */
  const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 16)));

  function showScreen(name) {
    document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('active', s.id === `screen-${name}`));
    if (name === 'camera') startDetectLoop(); else stopDetectLoop();
    if (name === 'crop') requestAnimationFrame(() => crop.layout());
    if (name === 'pages') renderPages();
  }

  function canvasFromImage(img, maxSide = 3000) {
    const w0 = img.naturalWidth || img.videoWidth || img.width;
    const h0 = img.naturalHeight || img.videoHeight || img.height;
    const s = Math.min(1, maxSide / Math.max(w0, h0));
    const c = document.createElement('canvas');
    c.width = Math.round(w0 * s);
    c.height = Math.round(h0 * s);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c;
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  }

  function rotateCanvas(canvas, deg) {
    deg = ((deg % 360) + 360) % 360;
    if (deg === 0) return canvas;
    const out = document.createElement('canvas');
    const swap = deg === 90 || deg === 270;
    out.width = swap ? canvas.height : canvas.width;
    out.height = swap ? canvas.width : canvas.height;
    const ctx = out.getContext('2d');
    ctx.translate(out.width / 2, out.height / 2);
    ctx.rotate((deg * Math.PI) / 180);
    ctx.drawImage(canvas, -canvas.width / 2, -canvas.height / 2);
    return out;
  }

  function defaultQuad(w, h, inset = 0.08) {
    const dx = w * inset, dy = h * inset;
    return [{ x: dx, y: dy }, { x: w - dx, y: dy }, { x: w - dx, y: h - dy }, { x: dx, y: h - dy }];
  }

  function fullQuad(w, h) {
    return [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }];
  }

  // ---------- 카메라 ----------
  async function startCamera() {
    const video = $('video');
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showCameraMessage(location.protocol === 'https:' || location.hostname === 'localhost'
        ? '이 브라우저는 카메라 미리보기를 지원하지 않습니다.'
        : '카메라 미리보기는 HTTPS 주소에서만 동작합니다.<br>아래 버튼으로 기본 카메라를 사용할 수 있어요.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 3840 },
          height: { ideal: 2160 },
        },
      });
      state.stream = stream;
      state.track = stream.getVideoTracks()[0];
      video.srcObject = stream;
      await video.play().catch(() => {});
      $('cameraMsg').classList.add('hidden');
      setupTorch();
    } catch (err) {
      console.warn(err);
      const denied = err && (err.name === 'NotAllowedError' || err.name === 'SecurityError');
      showCameraMessage(denied
        ? '카메라 권한이 거부되었습니다.<br>브라우저 설정에서 카메라 권한을 허용해주세요.'
        : '카메라를 시작할 수 없습니다.');
    }
  }

  function stopCamera() {
    if (state.stream) state.stream.getTracks().forEach((t) => t.stop());
    state.stream = null;
    state.track = null;
    state.torchOn = false;
    $('btnTorch').classList.remove('on');
  }

  function showCameraMessage(html) {
    $('cameraMsgText').innerHTML = html;
    $('cameraMsg').classList.remove('hidden');
    $('hint').classList.add('hidden');
  }

  function setupTorch() {
    const btn = $('btnTorch');
    try {
      const caps = state.track.getCapabilities ? state.track.getCapabilities() : {};
      btn.classList.toggle('hidden', !caps.torch);
    } catch { btn.classList.add('hidden'); }
  }

  async function toggleTorch() {
    if (!state.track) return;
    state.torchOn = !state.torchOn;
    try {
      await state.track.applyConstraints({ advanced: [{ torch: state.torchOn }] });
      $('btnTorch').classList.toggle('on', state.torchOn);
    } catch {
      state.torchOn = false;
      toast('플래시를 사용할 수 없습니다');
    }
  }

  // ---------- 실시간 문서 인식 ----------
  const detectCanvas = document.createElement('canvas');
  let detectTimer = null, rafId = null;

  function startDetectLoop() {
    stopDetectLoop();
    const tick = () => {
      detectFrame();
      detectTimer = setTimeout(tick, 150);
    };
    tick();
    const draw = () => { drawOverlay(); rafId = requestAnimationFrame(draw); };
    draw();
  }

  function stopDetectLoop() {
    clearTimeout(detectTimer);
    cancelAnimationFrame(rafId);
    detectTimer = rafId = null;
  }

  function detectFrame() {
    const video = $('video');
    const hint = $('hint');
    if (!state.autoDetect || !state.cvReady || !video.videoWidth || video.paused) {
      state.liveQuad = null;
      return;
    }
    const vw = video.videoWidth, vh = video.videoHeight;
    const s = 360 / Math.max(vw, vh);
    detectCanvas.width = Math.round(vw * s);
    detectCanvas.height = Math.round(vh * s);
    detectCanvas.getContext('2d', { willReadFrequently: true }).drawImage(video, 0, 0, detectCanvas.width, detectCanvas.height);
    let q = null;
    try { q = Scanner.detect(detectCanvas, 360); } catch (e) { console.warn(e); }

    if (q) {
      state.liveQuad = q.map((p) => ({ x: p.x / s, y: p.y / s }));
      state.missCount = 0;
      hint.textContent = '문서를 찾았어요 · 촬영하세요';
      hint.classList.add('found');
    } else if (++state.missCount > 4) {
      state.liveQuad = null;
      hint.textContent = '문서를 화면 안에 맞춰주세요';
      hint.classList.remove('found');
    }
  }

  function drawOverlay() {
    const video = $('video');
    const cv = $('overlay');
    const dpr = window.devicePixelRatio || 1;
    const cw = cv.clientWidth, ch = cv.clientHeight;
    if (cv.width !== Math.round(cw * dpr) || cv.height !== Math.round(ch * dpr)) {
      cv.width = Math.round(cw * dpr);
      cv.height = Math.round(ch * dpr);
    }
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);

    const target = state.liveQuad;
    if (!target) { state.displayQuad = null; return; }
    if (!state.displayQuad) state.displayQuad = target.map((p) => ({ ...p }));
    else state.displayQuad = state.displayQuad.map((p, i) => ({
      x: p.x + (target[i].x - p.x) * 0.35,
      y: p.y + (target[i].y - p.y) * 0.35,
    }));

    // object-fit: cover 좌표 변환
    const vw = video.videoWidth, vh = video.videoHeight;
    const scale = Math.max(cw / vw, ch / vh);
    const ox = (cw - vw * scale) / 2, oy = (ch - vh * scale) / 2;
    const pts = state.displayQuad.map((p) => ({ x: ox + p.x * scale, y: oy + p.y * scale }));

    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath();
    ctx.fillStyle = 'rgba(61,139,255,0.18)';
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#3d8bff';
    ctx.lineJoin = 'round';
    ctx.stroke();
    ctx.fillStyle = '#fff';
    pts.forEach((p) => { ctx.beginPath(); ctx.arc(p.x, p.y, 6, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); });
  }

  // ---------- 촬영 ----------
  async function capture() {
    const video = $('video');
    if (!video.videoWidth) { $('fallbackInput').click(); return; }
    const flash = document.createElement('div');
    flash.className = 'flash';
    document.body.appendChild(flash);
    setTimeout(() => flash.remove(), 300);

    const canvas = canvasFromImage(video, 3000);
    const s = canvas.width / video.videoWidth;
    const live = state.liveQuad ? state.liveQuad.map((p) => ({ x: p.x * s, y: p.y * s })) : null;
    await startSession(canvas, null, live);
  }

  /** 새 촬영/불러온 이미지로 편집 세션 시작 */
  async function startSession(canvas, editIndex = null, hintQuad = null, savedQuad = null) {
    let quad = savedQuad;
    if (!quad && state.cvReady) {
      try { quad = Scanner.detect(canvas, 600); } catch (e) { console.warn(e); }
    }
    if (!quad) quad = hintQuad;
    const detected = !!quad;
    if (!quad) quad = defaultQuad(canvas.width, canvas.height);

    state.session = {
      srcCanvas: canvas,
      quad,
      warped: null,
      filter: editIndex != null ? state.pages[editIndex].filter : 'original',
      rotation: editIndex != null ? state.pages[editIndex].rotation : 0,
      cache: {},
      editIndex,
    };
    $('cropHint').textContent = savedQuad || detected
      ? '모서리 점을 드래그해 문서 테두리에 맞추세요'
      : '문서를 자동으로 찾지 못했어요. 모서리를 직접 맞춰주세요';
    showScreen('crop');
  }

  async function handleFiles(files) {
    files = Array.from(files).filter((f) => f.type.startsWith('image/'));
    if (!files.length) return;

    if (files.length === 1) {
      const url = URL.createObjectURL(files[0]);
      try {
        const img = await loadImage(url);
        await startSession(canvasFromImage(img, 3000));
      } catch { toast('이미지를 불러올 수 없습니다'); }
      finally { URL.revokeObjectURL(url); }
      return;
    }

    // 여러 장: 자동 인식 → 보정 후 바로 추가
    for (let i = 0; i < files.length; i++) {
      showLoader(`이미지 처리 중… (${i + 1}/${files.length})`);
      await nextFrame();
      const url = URL.createObjectURL(files[i]);
      try {
        const img = await loadImage(url);
        const canvas = canvasFromImage(img, 3000);
        let quad = null;
        if (state.cvReady) { try { quad = Scanner.detect(canvas, 600); } catch {} }
        quad = quad || fullQuad(canvas.width, canvas.height);
        const warped = Scanner.warp(canvas, quad);
        addPage({ srcCanvas: canvas, quad, filter: 'original', rotation: 0, outCanvas: warped }, null);
      } catch (e) { console.warn(e); }
      finally { URL.revokeObjectURL(url); }
    }
    hideLoader();
    toast(`${files.length}장을 추가했어요`);
    showScreen('pages');
  }

  // ---------- 테두리 조정 화면 ----------
  const crop = (() => {
    const canvas = $('cropCanvas');
    const ctx = canvas.getContext('2d');
    let fit = { s: 1, ox: 0, oy: 0 };
    let drag = null; // { type: 'corner'|'edge', index, last }
    const PAD = 28;

    function layout() {
      const dpr = window.devicePixelRatio || 1;
      const r = canvas.getBoundingClientRect();
      canvas.width = Math.round(r.width * dpr);
      canvas.height = Math.round(r.height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const src = state.session && state.session.srcCanvas;
      if (!src) return;
      const s = Math.min((r.width - PAD * 2) / src.width, (r.height - PAD * 2) / src.height);
      fit = { s, ox: (r.width - src.width * s) / 2, oy: (r.height - src.height * s) / 2, w: r.width, h: r.height };
      draw();
    }

    const toScreen = (p) => ({ x: fit.ox + p.x * fit.s, y: fit.oy + p.y * fit.s });
    const toImage = (x, y) => ({ x: (x - fit.ox) / fit.s, y: (y - fit.oy) / fit.s });

    function handles() {
      const q = state.session.quad.map(toScreen);
      const mids = q.map((p, i) => {
        const n = q[(i + 1) % 4];
        return { x: (p.x + n.x) / 2, y: (p.y + n.y) / 2 };
      });
      return { corners: q, mids };
    }

    function draw() {
      const ses = state.session;
      if (!ses) return;
      const src = ses.srcCanvas;
      ctx.clearRect(0, 0, fit.w, fit.h);
      ctx.drawImage(src, fit.ox, fit.oy, src.width * fit.s, src.height * fit.s);

      const { corners, mids } = handles();
      const valid = Scanner.isConvex(ses.quad);

      // 바깥 영역 어둡게
      ctx.save();
      ctx.beginPath();
      ctx.rect(fit.ox, fit.oy, src.width * fit.s, src.height * fit.s);
      corners.slice().reverse().forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.closePath();
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.fill('evenodd');
      ctx.restore();

      // 테두리
      ctx.beginPath();
      corners.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.closePath();
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = valid ? '#3d8bff' : '#ff5c6c';
      ctx.stroke();

      // 변 중앙 핸들
      mids.forEach((p, i) => {
        const horizontal = i % 2 === 0;
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(p.x - (horizontal ? 14 : 4), p.y - (horizontal ? 4 : 14), horizontal ? 28 : 8, horizontal ? 8 : 28, 4);
        else ctx.rect(p.x - (horizontal ? 14 : 4), p.y - (horizontal ? 4 : 14), horizontal ? 28 : 8, horizontal ? 8 : 28);
        ctx.fillStyle = '#fff';
        ctx.fill();
      });

      // 모서리 핸들
      corners.forEach((p, i) => {
        const active = drag && drag.type === 'corner' && drag.index === i;
        ctx.beginPath();
        ctx.arc(p.x, p.y, active ? 14 : 11, 0, Math.PI * 2);
        ctx.fillStyle = active ? 'rgba(61,139,255,0.35)' : 'rgba(255,255,255,0.25)';
        ctx.fill();
        ctx.lineWidth = 3;
        ctx.strokeStyle = valid ? '#3d8bff' : '#ff5c6c';
        ctx.stroke();
      });

      if (drag && drag.type === 'corner') drawLoupe(corners[drag.index], ses.quad[drag.index]);
    }

    /** 드래그 중인 모서리를 확대해서 보여주는 돋보기 */
    function drawLoupe(screenPt, imgPt) {
      const R = 56, zoom = 2.5;
      const left = screenPt.x > fit.w / 2;
      const cx = left ? R + 16 : fit.w - R - 16;
      const cy = R + 16;
      const src = state.session.srcCanvas;
      const sr = R / (fit.s * zoom); // 원본 이미지에서 잘라낼 반경
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, Math.PI * 2);
      ctx.fillStyle = '#000';
      ctx.fill();
      ctx.clip();
      ctx.drawImage(src, imgPt.x - sr, imgPt.y - sr, sr * 2, sr * 2, cx - R, cy - R, R * 2, R * 2);
      ctx.strokeStyle = '#3d8bff';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(cx - 12, cy); ctx.lineTo(cx + 12, cy);
      ctx.moveTo(cx, cy - 12); ctx.lineTo(cx, cy + 12);
      ctx.stroke();
      ctx.restore();
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, Math.PI * 2);
      ctx.lineWidth = 3;
      ctx.strokeStyle = '#fff';
      ctx.stroke();
    }

    function pointerPos(e) {
      const r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    }

    function clamp(p) {
      const src = state.session.srcCanvas;
      return { x: Math.max(0, Math.min(src.width, p.x)), y: Math.max(0, Math.min(src.height, p.y)) };
    }

    canvas.addEventListener('pointerdown', (e) => {
      if (!state.session) return;
      const pos = pointerPos(e);
      const { corners, mids } = handles();
      let best = null, bestD = 40;
      corners.forEach((p, i) => {
        const d = Math.hypot(p.x - pos.x, p.y - pos.y);
        if (d < bestD) { bestD = d; best = { type: 'corner', index: i }; }
      });
      if (!best) {
        mids.forEach((p, i) => {
          const d = Math.hypot(p.x - pos.x, p.y - pos.y);
          if (d < 32 && d < bestD) { bestD = d; best = { type: 'edge', index: i }; }
        });
      }
      if (!best) return;
      drag = { ...best, last: toImage(pos.x, pos.y) };
      canvas.setPointerCapture(e.pointerId);
      e.preventDefault();
      draw();
    });

    canvas.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const pos = pointerPos(e);
      const ip = toImage(pos.x, pos.y);
      const q = state.session.quad;
      if (drag.type === 'corner') {
        q[drag.index] = clamp(ip);
      } else {
        const dx = ip.x - drag.last.x, dy = ip.y - drag.last.y;
        const a = drag.index, b = (drag.index + 1) % 4;
        q[a] = clamp({ x: q[a].x + dx, y: q[a].y + dy });
        q[b] = clamp({ x: q[b].x + dx, y: q[b].y + dy });
      }
      drag.last = ip;
      draw();
    });

    const end = () => { drag = null; draw(); };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    window.addEventListener('resize', () => { if ($('screen-crop').classList.contains('active')) layout(); });

    return { layout, draw };
  })();

  function cropDetect() {
    const ses = state.session;
    if (!state.cvReady) { toast('스캔 엔진을 불러오는 중입니다'); return; }
    const q = Scanner.detect(ses.srcCanvas, 800);
    if (q) { ses.quad = q; toast('문서 테두리를 찾았어요'); }
    else toast('문서를 찾지 못했어요. 직접 조정해주세요');
    crop.draw();
  }

  function cropRotate() {
    const ses = state.session;
    const h = ses.srcCanvas.height;
    ses.srcCanvas = rotateCanvas(ses.srcCanvas, 90);
    // 시계방향 90° 회전: (x, y) → (h - y, x)
    ses.quad = Scanner.orderQuad(ses.quad.map((p) => ({ x: h - p.y, y: p.x })));
    crop.layout();
  }

  async function cropApply() {
    const ses = state.session;
    if (!Scanner.isConvex(ses.quad) || Scanner.polygonArea(ses.quad) < 100) {
      toast('테두리 모양이 올바르지 않아요');
      return;
    }
    showLoader('원근 보정 중…');
    await nextFrame();
    try {
      ses.warped = Scanner.warp(ses.srcCanvas, ses.quad);
      ses.cache = {};
      await renderEdit();
      showScreen('edit');
    } catch (e) {
      console.error(e);
      toast('보정 중 오류가 발생했어요');
    } finally { hideLoader(); }
  }

  // ---------- 보정(필터) 화면 ----------
  function filteredCanvas() {
    const ses = state.session;
    if (!ses.cache[ses.filter]) ses.cache[ses.filter] = Scanner.applyFilter(ses.warped, ses.filter);
    return rotateCanvas(ses.cache[ses.filter], ses.rotation);
  }

  async function renderEdit() {
    const ses = state.session;
    const out = filteredCanvas();
    const c = $('editCanvas');
    c.width = out.width;
    c.height = out.height;
    c.getContext('2d').drawImage(out, 0, 0);
    document.querySelectorAll('.filter').forEach((b) => b.classList.toggle('active', b.dataset.filter === ses.filter));
  }

  async function setFilter(f) {
    const ses = state.session;
    if (ses.filter === f) return;
    ses.filter = f;
    if (!ses.cache[f]) { showLoader('필터 적용 중…'); await nextFrame(); }
    try { await renderEdit(); } finally { hideLoader(); }
  }

  async function rotateEdit(delta) {
    state.session.rotation = (state.session.rotation + delta + 360) % 360;
    await renderEdit();
  }

  function addPage(ses, editIndex) {
    const outCanvas = ses.outCanvas || $('editCanvas');
    const page = {
      src: ses.srcCanvas.toDataURL('image/jpeg', 0.9),
      quad: ses.quad.map((p) => ({ ...p })),
      filter: ses.filter,
      rotation: ses.rotation,
      out: outCanvas.toDataURL('image/jpeg', ses.filter === 'bw' ? 0.8 : 0.88),
      w: outCanvas.width,
      h: outCanvas.height,
    };
    if (editIndex != null) state.pages[editIndex] = page;
    else state.pages.push(page);
    updatePagesButton();
  }

  async function saveEdit() {
    const ses = state.session;
    showLoader('저장 중…');
    await nextFrame();
    addPage(ses, ses.editIndex);
    hideLoader();
    const wasEdit = ses.editIndex != null;
    state.session = null;
    if (wasEdit) { toast('페이지를 수정했어요'); showScreen('pages'); }
    else { toast(`${state.pages.length}페이지 저장됨`); showScreen('camera'); }
  }

  function updatePagesButton() {
    const n = state.pages.length;
    const btn = $('btnPages');
    btn.classList.toggle('has', n > 0);
    $('pagesCount').textContent = n;
    $('pagesCount').classList.toggle('hidden', n === 0);
    if (n) $('pagesThumb').src = state.pages[n - 1].out;
  }

  // ---------- 페이지 목록 ----------
  const ICONS = {
    left: '<svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>',
    right: '<svg viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"/></svg>',
    del: '<svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>',
  };

  function renderPages() {
    const grid = $('pagesGrid');
    const n = state.pages.length;
    $('pagesTitleCount').textContent = n ? `(${n})` : '';
    $('pagesEmpty').classList.toggle('hidden', n > 0);
    $('exportPanel').classList.toggle('hidden', n === 0);
    $('btnClearAll').style.visibility = n ? 'visible' : 'hidden';
    grid.innerHTML = '';
    state.pages.forEach((p, i) => {
      const card = document.createElement('div');
      card.className = 'page-card';
      card.innerHTML = `
        <div class="thumb"><img src="${p.out}" alt="${i + 1}페이지" /></div>
        <div class="meta">
          <span class="num">${i + 1}</span>
          <div class="acts">
            <button data-act="left" ${i === 0 ? 'disabled' : ''} aria-label="앞으로">${ICONS.left}</button>
            <button data-act="right" ${i === n - 1 ? 'disabled' : ''} aria-label="뒤로">${ICONS.right}</button>
            <button data-act="del" class="del" aria-label="삭제">${ICONS.del}</button>
          </div>
        </div>`;
      card.querySelector('.thumb').addEventListener('click', () => openViewer(i));
      card.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => pageAction(b.dataset.act, i)));
      grid.appendChild(card);
    });
    updatePagesButton();
  }

  function pageAction(act, i) {
    const pages = state.pages;
    if (act === 'left' && i > 0) [pages[i - 1], pages[i]] = [pages[i], pages[i - 1]];
    if (act === 'right' && i < pages.length - 1) [pages[i + 1], pages[i]] = [pages[i], pages[i + 1]];
    if (act === 'del') {
      if (!confirm(`${i + 1}페이지를 삭제할까요?`)) return;
      pages.splice(i, 1);
    }
    renderPages();
  }

  function openViewer(i) {
    state.viewerIndex = i;
    $('viewerImg').src = state.pages[i].out;
    $('viewerTitle').textContent = `${i + 1} / ${state.pages.length}`;
    $('viewer').classList.remove('hidden');
  }

  async function editPage(i) {
    $('viewer').classList.add('hidden');
    const p = state.pages[i];
    showLoader('불러오는 중…');
    try {
      const img = await loadImage(p.src);
      const canvas = canvasFromImage(img, 4000);
      await startSession(canvas, i, null, p.quad.map((q) => ({ ...q })));
    } finally { hideLoader(); }
  }

  // ---------- PDF ----------
  const PAGE_SIZES = { a4: [595.28, 841.89], letter: [612, 792] };

  function defaultFileName() {
    const d = new Date();
    const z = (n) => String(n).padStart(2, '0');
    return `스캔_${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}_${z(d.getHours())}${z(d.getMinutes())}`;
  }

  function fileName() {
    const raw = $('pdfName').value.trim() || defaultFileName();
    return raw.replace(/[\\/:*?"<>|]/g, '_').replace(/\.pdf$/i, '') + '.pdf';
  }

  async function buildPdf() {
    if (!window.jspdf) throw new Error('jsPDF 로드 실패');
    const { jsPDF } = window.jspdf;
    let doc = null;
    for (const p of state.pages) {
      const landscape = p.w > p.h;
      let pw, ph;
      if (state.pageSize === 'fit') {
        // 긴 변을 A4 긴 변에 맞춤
        const long = 841.89;
        pw = landscape ? long : long * (p.w / p.h);
        ph = landscape ? long * (p.h / p.w) : long;
      } else {
        const [a, b] = PAGE_SIZES[state.pageSize];
        pw = landscape ? b : a;
        ph = landscape ? a : b;
      }
      const orientation = pw > ph ? 'l' : 'p';
      if (!doc) doc = new jsPDF({ orientation, unit: 'pt', format: [pw, ph], compress: true });
      else doc.addPage([pw, ph], orientation);

      // 페이지 안에 비율 유지하며 가운데 배치
      const s = Math.min(pw / p.w, ph / p.h);
      const iw = p.w * s, ih = p.h * s;
      doc.addImage(p.out, 'JPEG', (pw - iw) / 2, (ph - ih) / 2, iw, ih, undefined, 'FAST');
    }
    doc.setProperties({ title: fileName().replace(/\.pdf$/, ''), creator: '문서 스캐너' });
    return doc;
  }

  async function downloadPdf() {
    if (!state.pages.length) return;
    showLoader('PDF 만드는 중…');
    await nextFrame();
    try {
      const doc = await buildPdf();
      doc.save(fileName());
      toast('PDF를 저장했어요');
    } catch (e) {
      console.error(e);
      toast('PDF 생성에 실패했어요');
    } finally { hideLoader(); }
  }

  async function sharePdf() {
    if (!state.pages.length) return;
    showLoader('PDF 만드는 중…');
    await nextFrame();
    try {
      const doc = await buildPdf();
      const file = new File([doc.output('blob')], fileName(), { type: 'application/pdf' });
      hideLoader();
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: file.name });
      } else {
        doc.save(file.name);
      }
    } catch (e) {
      if (e && e.name !== 'AbortError') { console.error(e); toast('공유에 실패했어요'); }
    } finally { hideLoader(); }
  }

  // ---------- 이벤트 바인딩 ----------
  function bind() {
    $('btnShutter').addEventListener('click', capture);
    $('btnAuto').addEventListener('click', () => {
      state.autoDetect = !state.autoDetect;
      $('btnAuto').setAttribute('aria-pressed', state.autoDetect);
      if (!state.autoDetect) {
        state.liveQuad = null;
        $('hint').textContent = '자동 인식이 꺼져 있어요';
        $('hint').classList.remove('found');
      }
    });
    $('btnTorch').addEventListener('click', toggleTorch);
    $('btnPages').addEventListener('click', () => showScreen('pages'));
    $('fileInput').addEventListener('change', (e) => { handleFiles(e.target.files); e.target.value = ''; });
    $('fallbackInput').addEventListener('change', (e) => { handleFiles(e.target.files); e.target.value = ''; });
    $('btnFallbackCapture').addEventListener('click', () => $('fallbackInput').click());

    $('btnCropBack').addEventListener('click', () => {
      const wasEdit = state.session && state.session.editIndex != null;
      state.session = null;
      showScreen(wasEdit ? 'pages' : 'camera');
    });
    $('btnCropApply').addEventListener('click', cropApply);
    $('btnDetect').addEventListener('click', cropDetect);
    $('btnFull').addEventListener('click', () => {
      const s = state.session.srcCanvas;
      state.session.quad = fullQuad(s.width, s.height);
      crop.draw();
    });
    $('btnRotateSrc').addEventListener('click', cropRotate);

    $('btnEditBack').addEventListener('click', () => showScreen('crop'));
    $('btnRecrop').addEventListener('click', () => showScreen('crop'));
    $('btnEditSave').addEventListener('click', saveEdit);
    $('btnRotateL').addEventListener('click', () => rotateEdit(-90));
    $('btnRotateR').addEventListener('click', () => rotateEdit(90));
    $('filters').addEventListener('click', (e) => {
      const b = e.target.closest('.filter');
      if (b) setFilter(b.dataset.filter);
    });

    $('btnPagesBack').addEventListener('click', () => showScreen('camera'));
    $('btnStartScan').addEventListener('click', () => showScreen('camera'));
    $('btnClearAll').addEventListener('click', () => {
      if (!state.pages.length || !confirm('스캔한 페이지를 모두 삭제할까요?')) return;
      state.pages = [];
      renderPages();
    });
    $('pageSize').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      state.pageSize = b.dataset.size;
      $('pageSize').querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
    });
    $('btnPdf').addEventListener('click', downloadPdf);
    $('btnShare').addEventListener('click', sharePdf);
    if (!navigator.share) $('btnShare').classList.add('hidden');

    $('btnViewerClose').addEventListener('click', () => $('viewer').classList.add('hidden'));
    $('btnViewerEdit').addEventListener('click', () => editPage(state.viewerIndex));

    $('pdfName').value = defaultFileName();

    // 백그라운드 전환 시 카메라 정지 / 복귀 시 재시작
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) stopCamera();
      else if (!state.stream) startCamera();
    });
    window.addEventListener('beforeunload', (e) => {
      if (state.pages.length) { e.preventDefault(); e.returnValue = ''; }
    });
  }

  // ---------- 시작 ----------
  function onOpenCvReady() {
    state.cvReady = true;
    hideLoader();
  }

  function onOpenCvFailed() {
    hideLoader();
    $('btnAuto').setAttribute('aria-pressed', 'false');
    toast('스캔 엔진을 불러오지 못했어요. 수동 자르기만 사용할 수 있어요', 4000);
  }

  bind();
  startCamera();
  showScreen('camera');

  return { onOpenCvReady, onOpenCvFailed, state };
})();
