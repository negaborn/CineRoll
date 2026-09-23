import Cropper from 'cropperjs';
import 'cropperjs/dist/cropper.css';
import JSZip from 'jszip';
import UTIF from 'utif';

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const e = document.getElementById(id);
  if (!e) throw new Error(`Missing element #${id}`);
  return e as T;
}

const DOM = {
  mainStage: el<HTMLElement>('main-stage'), main: el<HTMLDivElement>('image-container'),
  previewArea: el<HTMLDivElement>('preview-area'), previewInner: el<HTMLDivElement>('preview-area-inner'),
  btnBA: el<HTMLButtonElement>('btn-split-view'), btnZen: el<HTMLButtonElement>('btn-zen-mode'),
  upZone: el<HTMLDivElement>('upload-zone'), upInput: el<HTMLInputElement>('upload-input'), upText: el<HTMLSpanElement>('uploadText'),
  sRatio: el<HTMLSelectElement>('select-ratio'), sSlides: el<HTMLSelectElement>('select-slides'), sSqueeze: el<HTMLSelectElement>('select-squeeze'),
  sAngle: el<HTMLInputElement>('slider-angle'), inAngle: el<HTMLInputElement>('in-angle'),
  sBr: el<HTMLInputElement>('slider-br'), inBr: el<HTMLInputElement>('in-br'),
  sCo: el<HTMLInputElement>('slider-co'), inCo: el<HTMLInputElement>('in-co'),
  sSa: el<HTMLInputElement>('slider-sa'), inSa: el<HTMLInputElement>('in-sa'),
  sGrain: el<HTMLInputElement>('slider-grain'), inGrain: el<HTMLInputElement>('in-grain'),
  sHl: el<HTMLInputElement>('slider-hl'), inHl: el<HTMLInputElement>('in-hl'),
  sSh: el<HTMLInputElement>('slider-sh'), inSh: el<HTMLInputElement>('in-sh'),
  wmText: el<HTMLInputElement>('watermarkText'), fontSel: el<HTMLSelectElement>('fontSelect'), textColor: el<HTMLInputElement>('textColorPicker'),
  wmTarget: el<HTMLSelectElement>('watermarkTarget'),
  sGlowAmt: el<HTMLInputElement>('slider-glow-amount'), sFontScale: el<HTMLInputElement>('slider-fontScale'), inFontScale: el<HTMLInputElement>('in-fontScale'),
  upLogo: el<HTMLInputElement>('uploadLogo'), logoSettings: el<HTMLDivElement>('logoSettings'), logoStatus: el<HTMLSpanElement>('logoStatus'), toggleLogo: el<HTMLInputElement>('toggle-logo'),
  sLogoScale: el<HTMLInputElement>('sliderLogoScale'), inLogoScale: el<HTMLInputElement>('in-logoScale'),
  sLogoOp: el<HTMLInputElement>('sliderLogoOp'), inLogoOp: el<HTMLInputElement>('in-logoOp'),
  btnExport: el<HTMLButtonElement>('btn-export'), badge: el<HTMLDivElement>('smart-snap-badge'),
  zoomControls: el<HTMLDivElement>('zoom-controls'), sliderZoom: el<HTMLInputElement>('slider-zoom'), inZoom: el<HTMLInputElement>('in-zoom'),
  marginScaleWrapper: el<HTMLDivElement>('margin-scale-wrapper'), sMarginScale: el<HTMLInputElement>('slider-margin-scale'), inMarginScale: el<HTMLInputElement>('in-margin-scale'),
  sBorder: el<HTMLSelectElement>('select-border'), sBorderWeight: el<HTMLInputElement>('slider-borderWeight'), inBorderWeight: el<HTMLInputElement>('in-borderWeight'), borderWeightWrapper: el<HTMLDivElement>('border-weight-wrapper'),
  exportQuality: el<HTMLSelectElement>('exportQuality'),
  ratioWrapper: el<HTMLDivElement>('ratio-wrapper'), seamlessWrapper: el<HTMLDivElement>('seamless-count-wrapper'),
  toggleAppLogo: el<HTMLInputElement>('toggleAppLogo'), presetList: el<HTMLDivElement>('custom-presets-container'),
};

let cropper: any = null; let originalImg: HTMLImageElement | null = null; let currentStrategy = 'seamless';
let baseProxyCropUrl: string | null = null; let proxyCropUrl: string | null = null;
let staticGrainDataUrl = ''; let activeGlobalRatio = 1; let zoomMode = 'fit';
let isMargin = false; let bgColor = '#000000';
let isBold = false; let isGlow = true;
let tPosX = 50, tPosY = 94, lPosX = 50, lPosY = 80; let logoObj: HTMLImageElement | null = null; let logoUrl: string | null = null; let activeTarget: 'text' | 'logo' | null = null;
let isCropperReady = false; let isSplitView = false; let splitPos = 50;
let textStylePreset: 'none' | 'gold' | 'silver' = 'none';
let savedCustomPresets: any[] = [];
let baseRotation = 0;

function initGrain() {
  const c = document.createElement('canvas'); c.width = 256; c.height = 256; const ctx = c.getContext('2d')!; const id = ctx.createImageData(256, 256);
  for (let i = 0; i < id.data.length; i += 4) { const v = Math.random() < 0.5 ? 0 : 255; id.data[i] = id.data[i + 1] = id.data[i + 2] = v; id.data[i + 3] = 40; }
  ctx.putImageData(id, 0, 0); staticGrainDataUrl = c.toDataURL('image/png');
}
initGrain();

window.addEventListener('DOMContentLoaded', () => {
  loadPresetsFromStorage();
  initGlobalDrag();
});

function loadPresetsFromStorage() {
  const stored = localStorage.getItem('cineroll_presets_v4');
  if (stored) { try { savedCustomPresets = JSON.parse(stored); renderPresetChips(); } catch (_e) { /* ignore corrupt storage */ } }
}

function applyZoom() {
  const parentWrap = document.getElementById('preview-wrapper-parent');
  if (!parentWrap) return;
  const isMobile = window.innerWidth < 768;
  const padX = isMobile ? 32 : 64; const padY = isMobile ? 120 : 128;
  const parentW = DOM.previewArea.clientWidth - padX; const parentH = DOM.previewArea.clientHeight - padY;
  if (parentW <= 0 || parentH <= 0) return;

  if (zoomMode === 'fit') {
    const targetH = Math.min(parentH, parentW / activeGlobalRatio);
    (parentWrap as HTMLElement).style.height = targetH + 'px'; (parentWrap as HTMLElement).style.width = (targetH * activeGlobalRatio) + 'px';
    DOM.inZoom.value = '100'; DOM.sliderZoom.value = '100';
  } else {
    const baseHeightForZoom = Math.min(parentH, parentW / activeGlobalRatio);
    const zoomedH = baseHeightForZoom * (Number(DOM.sliderZoom.value) / 100);
    (parentWrap as HTMLElement).style.height = zoomedH + 'px'; (parentWrap as HTMLElement).style.width = (zoomedH * activeGlobalRatio) + 'px';
    DOM.inZoom.value = DOM.sliderZoom.value;
  }
  ModuleTypo.update();
}

function setZoom(mode: string) { zoomMode = mode; if (mode === 'fit') { DOM.sliderZoom.value = '100'; DOM.inZoom.value = '100'; } applyZoom(); }
window.addEventListener('resize', () => { if (zoomMode === 'fit') applyZoom(); });

DOM.sliderZoom.addEventListener('input', (e) => { zoomMode = 'custom'; DOM.inZoom.value = (e.target as HTMLInputElement).value; applyZoom(); });
DOM.sliderZoom.addEventListener('touchmove', (e) => { zoomMode = 'custom'; DOM.inZoom.value = (e.target as HTMLInputElement).value; applyZoom(); }, { passive: true });
DOM.inZoom.addEventListener('change', (e) => { zoomMode = 'custom'; DOM.sliderZoom.value = (e.target as HTMLInputElement).value; applyZoom(); });

function bindInputSlider(slider: HTMLInputElement, input: HTMLInputElement, callback?: () => void, isTone = false) {
  if (!slider || !input) return;
  slider.addEventListener('input', (e) => { input.value = (e.target as HTMLInputElement).value; if (!isTone && callback) callback(); });
  if (isTone) { slider.addEventListener('change', () => { if (callback) callback(); }); }
  input.addEventListener('change', (e) => {
    let val = parseFloat((e.target as HTMLInputElement).value);
    if (val < parseFloat(slider.min)) val = Number(slider.min);
    if (val > parseFloat(slider.max)) val = Number(slider.max);
    (e.target as HTMLInputElement).value = String(val); slider.value = String(val);
    if (callback) callback();
  });
}

bindInputSlider(DOM.sAngle, DOM.inAngle, () => { if (cropper) cropper.rotateTo(Number(DOM.sAngle.value)); });
bindInputSlider(DOM.sBr, DOM.inBr, () => ModuleColor.updateCSSFilters());
bindInputSlider(DOM.sCo, DOM.inCo, () => ModuleColor.updateCSSFilters());
bindInputSlider(DOM.sSa, DOM.inSa, () => ModuleColor.updateCSSFilters());
bindInputSlider(DOM.sGrain, DOM.inGrain, () => ModuleColor.updateCSSFilters());
bindInputSlider(DOM.sHl, DOM.inHl, () => ModuleColor.triggerEngine(), true);
bindInputSlider(DOM.sSh, DOM.inSh, () => ModuleColor.triggerEngine(), true);
bindInputSlider(DOM.sLogoScale, DOM.inLogoScale, () => ModuleTypo.update());
bindInputSlider(DOM.sLogoOp, DOM.inLogoOp, () => ModuleTypo.update());
bindInputSlider(DOM.sMarginScale, DOM.inMarginScale, () => ModuleFrame.build());
bindInputSlider(DOM.sFontScale, DOM.inFontScale, () => ModuleTypo.update());
bindInputSlider(DOM.sBorderWeight, DOM.inBorderWeight, () => ModuleFrame.build());

function toggleSplitView() {
  isSplitView = !isSplitView;
  DOM.btnBA.classList.toggle('bg-zinc-800', isSplitView);
  DOM.btnBA.classList.toggle('text-white', isSplitView);
  ModuleFrame.build();
}

let zenTimeout: ReturnType<typeof setTimeout> | undefined;

function toggleZenMode() {
  if (!proxyCropUrl) return;
  document.body.classList.toggle('zen-mode');
  const isZen = document.body.classList.contains('zen-mode');
  const exitBtn = document.getElementById('btn-exit-zen');
  if (exitBtn) {
    if (isZen) {
      exitBtn.classList.remove('hidden'); exitBtn.classList.add('flex');
      exitBtn.classList.remove('opacity-0'); exitBtn.classList.add('opacity-100');
      clearTimeout(zenTimeout);
      zenTimeout = setTimeout(() => { exitBtn.classList.remove('opacity-100'); exitBtn.classList.add('opacity-0'); }, 2000);
    } else {
      exitBtn.classList.add('hidden'); exitBtn.classList.remove('flex');
    }
  }
  setTimeout(() => applyZoom(), 100);
}

window.addEventListener('mousemove', () => {
  if (document.body.classList.contains('zen-mode')) {
    const btn = document.getElementById('btn-exit-zen');
    if (btn) {
      btn.classList.remove('opacity-0');
      btn.classList.add('opacity-100');
      clearTimeout(zenTimeout);
      zenTimeout = setTimeout(() => {
        btn.classList.remove('opacity-100');
        btn.classList.add('opacity-0');
      }, 2000);
    }
  }
});

let isDraggingSplit = false;
window.addEventListener('mousemove', (e) => {
  if (!isDraggingSplit || !isSplitView) return;
  e.preventDefault();
  const parentWrapper = document.getElementById('preview-wrapper-parent');
  const layerImagesBefore = document.getElementById('layer-images-before');
  const handle = document.getElementById('split-handle');
  if (!parentWrapper || !layerImagesBefore || !handle) return;

  const rect = parentWrapper.getBoundingClientRect();
  let pct = ((e.clientX - rect.left) / rect.width) * 100;
  pct = Math.max(0, Math.min(100, pct));
  splitPos = pct;
  (layerImagesBefore as HTMLElement).style.clipPath = `polygon(0 0, ${pct}% 0, ${pct}% 100%, 0 100%)`;
  (handle as HTMLElement).style.left = `${pct}%`;
});
window.addEventListener('mouseup', () => { isDraggingSplit = false; });

document.addEventListener('keydown', (e) => {
  const isInput = ['INPUT', 'TEXTAREA'].includes((e.target as HTMLElement).tagName);
  if (e.key.toLowerCase() === 'f' && !isInput) { e.preventDefault(); toggleZenMode(); }
  if (e.key === 'Escape' && document.body.classList.contains('zen-mode')) { toggleZenMode(); }
  if (e.key === 'Enter' && !isInput && (e.target as HTMLElement).tagName !== 'BUTTON') {
    const formatTab = document.getElementById('tab-format');
    if (formatTab && !formatTab.classList.contains('hidden') && cropper && isCropperReady) {
      e.preventDefault(); applyCropAndRender();
    }
  }
  if (activeTarget && !isInput) {
    const step = 0.5; let moved = false;
    if (e.key === 'ArrowUp') { if (activeTarget === 'text') tPosY -= step; else lPosY -= step; moved = true; }
    if (e.key === 'ArrowDown') { if (activeTarget === 'text') tPosY += step; else lPosY += step; moved = true; }
    if (e.key === 'ArrowLeft') { if (activeTarget === 'text') tPosX -= step; else lPosX -= step; moved = true; }
    if (e.key === 'ArrowRight') { if (activeTarget === 'text') tPosX += step; else lPosX += step; moved = true; }
    if (moved) { e.preventDefault(); ModuleTypo.updatePositions(); }
  }
});

const DragState: { active: boolean; target: 'text' | 'logo' | null; container: HTMLElement | null; gx: HTMLElement | null; gy: HTMLElement | null } =
  { active: false, target: null, container: null, gx: null, gy: null };

function initGlobalDrag() {
  function startDrag(_e: Event, type: 'text' | 'logo', elm: HTMLElement) {
    DragState.active = true; DragState.target = type; activeTarget = type;
    DragState.container = elm.parentElement;
    if (DragState.container) { DragState.gx = DragState.container.querySelector('.snap-guide-x'); DragState.gy = DragState.container.querySelector('.snap-guide-y'); }

    document.querySelectorAll('.draggable-text, .draggable-logo').forEach(n => n.classList.remove('is-active-target'));
    elm.classList.add('is-active-target');
    elm.focus();
  }

  window.addEventListener('mousedown', e => {
    const target = e.target as HTMLElement;
    const te = target.closest('.draggable-text') as HTMLElement | null; const le = target.closest('.draggable-logo') as HTMLElement | null;
    if (te) { startDrag(e, 'text', te); }
    else if (le) { startDrag(e, 'logo', le); }
    else if (target.closest('#preview-wrapper-parent')) {
      activeTarget = null;
      document.querySelectorAll('.draggable-text, .draggable-logo').forEach(n => n.classList.remove('is-active-target'));
    }
  });

  window.addEventListener('touchstart', e => {
    const target = e.target as HTMLElement;
    const te = target.closest('.draggable-text') as HTMLElement | null; const le = target.closest('.draggable-logo') as HTMLElement | null;
    if (te) startDrag(e, 'text', te); else if (le) startDrag(e, 'logo', le);
  }, { passive: false });

  function moveDrag(e: MouseEvent | TouchEvent) {
    if (!DragState.active || !DragState.container) return;
    e.preventDefault();
    const rect = DragState.container.getBoundingClientRect();
    const point = 'touches' in e ? e.touches[0] : e;
    const clientX = point.clientX;
    const clientY = point.clientY;
    let px = ((clientX - rect.left) / rect.width) * 100;
    let py = ((clientY - rect.top) / rect.height) * 100;
    px = Math.max(0, Math.min(100, px)); py = Math.max(0, Math.min(100, py));
    const snap = 2.5; let sx = false, sy = false;
    if (Math.abs(px - 50) < snap) { px = 50; sx = true; }
    if (Math.abs(py - 50) < snap) { py = 50; sy = true; }
    if (Math.abs(py - 94) < snap) { py = 94; sy = true; }

    if (DragState.target === 'text') { tPosX = px; tPosY = py; } else { lPosX = px; lPosY = py; }
    ModuleTypo.updatePositions();

    if (DragState.gx) { DragState.gx.style.display = sy ? 'block' : 'none'; DragState.gx.style.top = `${py}%`; }
    if (DragState.gy) { DragState.gy.style.display = sx ? 'block' : 'none'; DragState.gy.style.left = `${px}%`; }
  }

  window.addEventListener('mousemove', moveDrag);
  window.addEventListener('touchmove', moveDrag, { passive: false });

  function endDrag() { DragState.active = false; if (DragState.gx) DragState.gx.style.display = 'none'; if (DragState.gy) DragState.gy.style.display = 'none'; }
  window.addEventListener('mouseup', endDrag); window.addEventListener('touchend', endDrag);
}

const Engine3D = {
  canvas: document.createElement('canvas'), gl: null as WebGL2RenderingContext | null, program: null as WebGLProgram | null, posBuf: null as WebGLBuffer | null,
  lutData: null as { size: number; data: Uint8Array } | null, identityLut: null as { size: number; data: Uint8Array } | null,
  initIdentityLut: function () {
    const size = 16; const data = new Uint8Array(size * size * size * 4); let i = 0;
    for (let z = 0; z < size; z++) { for (let y = 0; y < size; y++) { for (let x = 0; x < size; x++) { data[i++] = Math.round((x / (size - 1)) * 255); data[i++] = Math.round((y / (size - 1)) * 255); data[i++] = Math.round((z / (size - 1)) * 255); data[i++] = 255; } } }
    this.identityLut = { size, data };
  },
  parseCube: function (text: string) {
    const lines = text.split('\n'); let size = 0; const vals: number[] = [];
    for (let line of lines) { line = line.trim(); if (line.startsWith('LUT_3D_SIZE')) { size = parseInt(line.split(/\s+/)[1]); } else if (line && !line.startsWith('#') && /^[0-9.-]/.test(line)) { const parts = line.split(/\s+/).map(Number); vals.push(parts[0], parts[1], parts[2]); } }
    const data = new Uint8Array(size * size * size * 4); let vIdx = 0;
    for (let i = 0; i < data.length; i += 4) { data[i] = Math.max(0, Math.min(255, Math.round(vals[vIdx] * 255))); data[i + 1] = Math.max(0, Math.min(255, Math.round(vals[vIdx + 1] * 255))); data[i + 2] = Math.max(0, Math.min(255, Math.round(vals[vIdx + 2] * 255))); data[i + 3] = 255; vIdx += 3; }
    this.lutData = { size, data };
  },
  apply: async function (sourceCanvas: HTMLCanvasElement, intensity: number, hl: number, sh: number, hasCustomLut: boolean): Promise<HTMLCanvasElement> {
    if (!this.gl) { this.gl = this.canvas.getContext('webgl2', { preserveDrawingBuffer: true }); this.initIdentityLut(); }
    const gl = this.gl; if (!gl) return sourceCanvas;

    if (!this.program) {
      const vsSource = `#version 300 es\n in vec2 a_position; out vec2 v_texCoord; void main() { gl_Position = vec4(a_position, 0.0, 1.0); v_texCoord = vec2((a_position.x + 1.0) / 2.0, 1.0 - (a_position.y + 1.0) / 2.0); }`;
      const fsSource = `#version 300 es\n precision highp float; precision highp sampler3D; in vec2 v_texCoord; uniform sampler2D u_image; uniform sampler3D u_lut; uniform float u_intensity; uniform float u_hl; uniform float u_sh; uniform int u_hasLut; out vec4 outColor; float getLum(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); } void main() { vec4 texColor = texture(u_image, v_texCoord); vec3 color = texColor.rgb; float lum = getLum(color); float shadowMask = pow(clamp(1.0 - (lum / 0.5), 0.0, 1.0), 1.5); float hlMask = pow(clamp((lum - 0.5) / 0.5, 0.0, 1.0), 1.5); color *= 1.0 + (u_sh - 1.0) * shadowMask; color *= 1.0 + (u_hl - 1.0) * hlMask; color = clamp(color, 0.0, 1.0); vec3 finalColor = color; if (u_hasLut == 1) { vec3 lutColor = texture(u_lut, color).rgb; finalColor = mix(color, lutColor, u_intensity); } outColor = vec4(finalColor, texColor.a); }`;
      const createShader = (type: number, source: string) => { const s = gl.createShader(type)!; gl.shaderSource(s, source); gl.compileShader(s); return s; };
      this.program = gl.createProgram()!; gl.attachShader(this.program, createShader(gl.VERTEX_SHADER, vsSource)); gl.attachShader(this.program, createShader(gl.FRAGMENT_SHADER, fsSource)); gl.linkProgram(this.program);
      this.posBuf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuf); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
    }

    gl.useProgram(this.program);
    const posLoc = gl.getAttribLocation(this.program, 'a_position');
    gl.enableVertexAttribArray(posLoc);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuf);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

    const lutTex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_3D, lutTex);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    const activeLut = (hasCustomLut && this.lutData) ? this.lutData : this.identityLut!;
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA, activeLut.size, activeLut.size, activeLut.size, 0, gl.RGBA, gl.UNSIGNED_BYTE, activeLut.data);

    gl.uniform1i(gl.getUniformLocation(this.program, 'u_lut'), 1);
    gl.uniform1f(gl.getUniformLocation(this.program, 'u_intensity'), intensity);
    gl.uniform1f(gl.getUniformLocation(this.program, 'u_hl'), hl);
    gl.uniform1f(gl.getUniformLocation(this.program, 'u_sh'), sh);
    gl.uniform1i(gl.getUniformLocation(this.program, 'u_hasLut'), hasCustomLut ? 1 : 0);

    const isHuge = sourceCanvas.width > 4096 || sourceCanvas.height > 4096;

    if (!isHuge) {
      this.canvas.width = sourceCanvas.width; this.canvas.height = sourceCanvas.height;
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);

      const imgTex = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, imgTex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, sourceCanvas);
      gl.uniform1i(gl.getUniformLocation(this.program, 'u_image'), 0);

      gl.drawArrays(gl.TRIANGLES, 0, 6);

      const outCvs = document.createElement('canvas');
      outCvs.width = this.canvas.width; outCvs.height = this.canvas.height;
      outCvs.getContext('2d')!.drawImage(this.canvas, 0, 0);

      gl.deleteTexture(imgTex);
      gl.deleteTexture(lutTex);
      return outCvs;
    } else {
      const outCvs = document.createElement('canvas');
      outCvs.width = sourceCanvas.width; outCvs.height = sourceCanvas.height;
      const outCtx = outCvs.getContext('2d')!;
      const TILE_SIZE = 2048;

      for (let y = 0; y < sourceCanvas.height; y += TILE_SIZE) {
        for (let x = 0; x < sourceCanvas.width; x += TILE_SIZE) {
          const w = Math.min(TILE_SIZE, sourceCanvas.width - x);
          const h = Math.min(TILE_SIZE, sourceCanvas.height - y);

          const tileCvs = document.createElement('canvas');
          tileCvs.width = w; tileCvs.height = h;
          tileCvs.getContext('2d')!.drawImage(sourceCanvas, x, y, w, h, 0, 0, w, h);

          this.canvas.width = w; this.canvas.height = h;
          gl.viewport(0, 0, w, h);

          const imgTex = gl.createTexture();
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, imgTex);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, tileCvs);
          gl.uniform1i(gl.getUniformLocation(this.program, 'u_image'), 0);

          gl.drawArrays(gl.TRIANGLES, 0, 6);

          outCtx.drawImage(this.canvas, x, y);
          gl.deleteTexture(imgTex);
          tileCvs.width = 0; tileCvs.height = 0;
        }
      }
      gl.deleteTexture(lutTex);
      return outCvs;
    }
  },
};

const updateLoadingText = (text: string) => { const e = document.getElementById('loading-text'); if (e) e.innerText = text; };
const showLoading = (msg: string) => { updateLoadingText(msg); document.getElementById('loading-overlay')!.classList.remove('hidden'); document.getElementById('loading-overlay')!.classList.add('flex'); };
const hideLoading = () => { document.getElementById('loading-overlay')!.classList.add('hidden'); document.getElementById('loading-overlay')!.classList.remove('flex'); };

el<HTMLInputElement>('uploadLut').addEventListener('change', async e => {
  const file = (e.target as HTMLInputElement).files?.[0]; if (!file) return; showLoading('Parsing .CUBE 3D Matrix...');
  try { const text = await file.text(); Engine3D.parseCube(text); el('opt-custom-lut').classList.remove('hidden'); (el<HTMLSelectElement>('select-lut')).value = 'custom'; ModuleColor.triggerEngine(); }
  catch (_err) { alert('LUT 파일을 읽는 중 오류가 발생했습니다.'); hideLoading(); }
});

DOM.upLogo.addEventListener('change', e => {
  const file = (e.target as HTMLInputElement).files?.[0]; if (!file) return; const reader = new FileReader();
  reader.onload = (event) => { logoUrl = event.target!.result as string; logoObj = new Image(); logoObj.onload = () => { DOM.toggleLogo.checked = true; DOM.logoStatus.classList.remove('hidden'); DOM.logoSettings.classList.remove('opacity-30', 'pointer-events-none'); ModuleTypo.update(); }; logoObj.src = logoUrl; };
  reader.readAsDataURL(file);
});

function switchTab(target: string) {
  document.querySelectorAll<HTMLElement>('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === target));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.add('hidden'));
  document.getElementById(`tab-${target}`)!.classList.remove('hidden');

  if (target === 'format') {
    DOM.previewArea.classList.add('hidden'); DOM.zoomControls.classList.add('hidden'); DOM.btnBA.style.display = 'none'; DOM.btnZen.style.display = 'none';
    DOM.main.classList.remove('hidden'); DOM.main.style.display = 'block'; void DOM.main.offsetWidth;
    setTimeout(() => { if (originalImg && !cropper) { setupCropper(); } else if (cropper) { DOM.main.classList.add('opacity-100'); cropper.resize(); } }, 50);
  } else {
    DOM.main.classList.remove('opacity-100'); DOM.main.style.display = 'none';
    if (proxyCropUrl) { DOM.previewArea.classList.remove('hidden'); DOM.zoomControls.classList.remove('hidden'); DOM.zoomControls.classList.add('flex'); DOM.btnBA.style.display = 'flex'; DOM.btnZen.style.display = 'flex'; applyZoom(); }
  }
}

document.querySelectorAll<HTMLElement>('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab!));
});

function updateCropperRatio() {
  if (!cropper) return; let fr = NaN; const br = parseFloat(DOM.sRatio.value);
  if (currentStrategy === 'seamless' && !isNaN(br)) fr = br * parseInt(DOM.sSlides.value); else fr = br;
  cropper.setAspectRatio(fr); const cd = cropper.getCanvasData(); let bw = cd.width * 0.85, bh = cd.height * 0.85;
  if (!isNaN(fr)) { const cr = cd.width / cd.height; if (fr > cr) { bw = cd.width * 0.85; bh = bw / fr; } else { bh = cd.height * 0.85; bw = bh * fr; } }
  cropper.setCropBoxData({ left: cd.left + (cd.width - bw) / 2, top: cd.top + (cd.height - bh) / 2, width: bw, height: bh });
}

document.querySelectorAll<HTMLElement>('#strategy-btns .min-btn').forEach(btn => {
  btn.addEventListener('click', e => {
    document.querySelectorAll('#strategy-btns .min-btn').forEach(b => b.classList.remove('active')); (e.target as HTMLElement).classList.add('active'); currentStrategy = (e.target as HTMLElement).dataset.val!;
    const isSingle = currentStrategy === 'single';
    DOM.seamlessWrapper.classList.toggle('disabled-block', isSingle);
    if (isSingle && DOM.sRatio.value === 'NaN') DOM.sRatio.value = '0.8';
    updateCropperRatio();
  });
});

function resetFraming() {
  const needsRebuild = DOM.sSqueeze.value !== '100';
  if (currentStrategy === 'seamless' || currentStrategy === 'triptych') { DOM.sRatio.value = '0.8'; DOM.sSlides.value = '3'; } else { DOM.sRatio.value = 'NaN'; }
  DOM.sAngle.value = '0'; DOM.inAngle.value = '0'; DOM.sSqueeze.value = '100';
  if (needsRebuild) { DOM.main.classList.remove('opacity-100'); DOM.main.classList.add('opacity-0'); setTimeout(() => setupCropper(), 300); } else if (cropper) { cropper.rotateTo(0); updateCropperRatio(); }
}

DOM.sSqueeze.addEventListener('change', () => {
  DOM.main.classList.remove('opacity-100');
  DOM.main.classList.add('opacity-0');
  setTimeout(setupCropper, 300);
});

DOM.sRatio.addEventListener('change', updateCropperRatio); DOM.sSlides.addEventListener('change', updateCropperRatio);
function rotateBase(deg: number) { baseRotation = (baseRotation + deg) % 360; applyRotation(); }
function applyRotation() { if (!cropper) return; cropper.rotateTo(baseRotation + (parseFloat(DOM.sAngle.value) || 0)); }

function setupCropper() {
  if (!originalImg) return; isCropperReady = false;
  if (cropper) { cropper.destroy(); cropper = null; }
  DOM.main.innerHTML = ''; const newImg = document.createElement('img'); newImg.style.display = 'block'; newImg.style.maxWidth = '100%';
  const sf = parseFloat(DOM.sSqueeze.value) / 100;

  newImg.onload = () => {
    requestAnimationFrame(() => {
      cropper = new Cropper(newImg, {
        viewMode: 1, dragMode: 'none', autoCrop: false, background: false, checkOrientation: true,
        ready: () => { cropper.crop(); updateCropperRatio(); isCropperReady = true; DOM.main.classList.remove('opacity-0'); DOM.main.classList.add('opacity-100'); applyRotation(); },
        crop: () => {
          const isFree = isNaN(parseFloat(DOM.sRatio.value));
          if (!isFree) { if (DOM.badge) DOM.badge.classList.add('opacity-0'); return; }
          const d = cropper.getCropBoxData();
          if (!d || d.width === 0 || d.height === 0) return;
          const r = d.width / d.height; let txt = '';
          if (r > 0.78 && r < 0.82) txt = '4:5 Vertical IG'; else if (r > 0.98 && r < 1.02) txt = '1:1 Square'; else if (r > 1.75 && r < 1.8) txt = '16:9 Landscape'; else if (r > 0.65 && r < 0.68) txt = '2:3 Vertical'; else if (r > 1.45 && r < 1.55) txt = '3:2 Horizontal'; else if (r > 0.74 && r < 0.76) txt = '3:4 Classic';
          if (txt && DOM.badge) { DOM.badge.innerText = txt; DOM.badge.classList.remove('opacity-0'); DOM.badge.style.top = Math.max(10, d.top - 28) + 'px'; DOM.badge.style.left = (d.left + d.width / 2) + 'px'; }
          else if (DOM.badge) DOM.badge.classList.add('opacity-0');
        },
      });
    });
  };

  if (sf === 1.0) { DOM.main.appendChild(newImg); newImg.src = originalImg.src; return; }

  const cvs = document.createElement('canvas'); let tw = originalImg.naturalWidth * sf; let th = originalImg.naturalHeight;
  const maxW = 3500; if (tw > maxW) { const scale = maxW / tw; th *= scale; tw = maxW; } cvs.width = tw; cvs.height = th;
  cvs.getContext('2d')!.drawImage(originalImg, 0, 0, originalImg.naturalWidth, originalImg.naturalHeight, 0, 0, tw, th);
  cvs.toBlob((blob) => { DOM.main.appendChild(newImg); newImg.src = URL.createObjectURL(blob!); cvs.width = 0; cvs.height = 0; }, 'image/jpeg', 0.95);
}

['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eName => { DOM.mainStage.addEventListener(eName, e => { e.preventDefault(); e.stopPropagation(); }, false); });

DOM.mainStage.addEventListener('drop', e => {
  const dt = (e as DragEvent).dataTransfer;
  if (dt?.files.length) handleFile(dt.files[0]);
});

DOM.upInput.addEventListener('change', e => {
  const input = e.target as HTMLInputElement;
  if (input.files?.length) {
    handleFile(input.files[0]);
    input.value = '';
  }
});

async function handleFile(file: File) {
  if (!file) return;
  const validExts = /\.(jpe?g|png|tiff?|webp|gif|rw2|cr2|cr3|nef|arw|dng)$/i;
  if (!file.type.startsWith('image/') && !file.name.match(validExts)) {
    alert('지원하지 않는 이미지 형식입니다.'); return;
  }

  DOM.upText.innerText = 'Processing...'; baseRotation = 0; if (DOM.sAngle) DOM.sAngle.value = '0'; if (DOM.inAngle) DOM.inAngle.value = '0';
  try {
    if (file.name.match(/\.tiff?$/i)) {
      const arrayBuffer = await file.arrayBuffer(); const ifds = UTIF.decode(arrayBuffer); UTIF.decodeImage(arrayBuffer, ifds[0]);
      const rgba = UTIF.toRGBA8(ifds[0]); const cvs = document.createElement('canvas'); cvs.width = ifds[0].width; cvs.height = ifds[0].height;
      const ctx = cvs.getContext('2d')!; const imgData = new ImageData(new Uint8ClampedArray(rgba.buffer as ArrayBuffer), cvs.width, cvs.height); ctx.putImageData(imgData, 0, 0);
      originalImg = new Image(); originalImg.onload = () => { DOM.upZone.classList.add('hidden'); switchTab('format'); }; originalImg.src = cvs.toDataURL('image/jpeg', 0.95); cvs.width = 0; cvs.height = 0;
    } else {
      originalImg = new Image(); originalImg.onload = () => { DOM.upZone.classList.add('hidden'); switchTab('format'); }; originalImg.src = URL.createObjectURL(file);
    }
  } catch (_err) { alert('이미지 처리 오류.'); DOM.upText.innerText = 'Import Resource'; }
}

function applyCropAndRender() {
  if (!cropper || !isCropperReady) return;
  try {
    if (DOM.badge) DOM.badge.classList.add('opacity-0');
    const cvs = cropper.getCroppedCanvas({ maxWidth: 2560, maxHeight: 2560, fillColor: 'transparent', imageSmoothingEnabled: true, imageSmoothingQuality: 'high' });
    if (!cvs || cvs.width === 0 || cvs.height === 0) { alert('크롭 영역을 다시 지정해주세요.'); return; }
    activeGlobalRatio = cvs.width / cvs.height; baseProxyCropUrl = cvs.toDataURL('image/png'); cvs.width = 0; cvs.height = 0;
    ModuleColor.triggerEngine(true);
  } catch (_err) { alert('오류가 발생했습니다.'); }
}

const ModuleFrame = {
  updateBorderOptions: function () { DOM.borderWeightWrapper.classList.toggle('hidden', DOM.sBorder.value !== 'fineart'); this.build(); },
  build: function () {
    if (!proxyCropUrl) return;
    DOM.previewInner.innerHTML = '';
    const p = document.createElement('div'); p.id = 'preview-wrapper-parent'; p.className = 'flex relative m-auto'; p.style.aspectRatio = String(activeGlobalRatio); p.style.flexShrink = '0'; p.style.boxShadow = '0 40px 100px rgba(0,0,0,0.95)';
    p.appendChild(this.createLayer('after'));

    const lg = document.createElement('div'); lg.className = 'layer-glass absolute inset-0 flex z-50 pointer-events-none';
    const slides = (currentStrategy === 'seamless' || currentStrategy === 'triptych') ? parseInt(DOM.sSlides.value) : 1;
    for (let i = 0; i < slides; i++) {
      const gp = document.createElement('div'); gp.className = 'flex-1 relative h-full pointer-events-none overflow-hidden'; gp.id = `glass-pane-${i + 1}`;
      gp.innerHTML = `<div class="snap-guide snap-guide-x hidden"></div><div class="snap-guide snap-guide-y hidden"></div>`; lg.appendChild(gp);
    }
    p.appendChild(lg); DOM.previewInner.appendChild(p); DOM.btnExport.classList.remove('opacity-50', 'cursor-not-allowed');

    if (isSplitView) {
      const layerImagesBefore = this.createLayer('before'); layerImagesBefore.id = 'layer-images-before';
      layerImagesBefore.style.clipPath = `polygon(0 0, ${splitPos}% 0, ${splitPos}% 100%, 0 100%)`; layerImagesBefore.style.zIndex = '20'; p.appendChild(layerImagesBefore);
      const handle = document.createElement('div'); handle.id = 'split-handle'; handle.className = 'absolute top-0 bottom-0 cursor-ew-resize border-r-[3px] border-white shadow-[0_0_10px_rgba(0,0,0,0.5)]'; handle.style.zIndex = '60'; handle.style.left = `${splitPos}%`; handle.style.transform = 'translateX(-1.5px)';
      const handleCircle = document.createElement('div'); handleCircle.className = 'absolute top-1/2 left-1/2 w-7 h-7 bg-white rounded-full flex items-center justify-center shadow-lg transform -translate-x-1/2 -translate-y-1/2'; handleCircle.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="2"><path d="M13 5l7 7-7 7M11 5l-7 7 7 7"/></svg>`; handle.appendChild(handleCircle);
      handle.addEventListener('mousedown', (e) => { isDraggingSplit = true; e.preventDefault(); e.stopPropagation(); }); p.appendChild(handle);
    }

    ModuleColor.updateCSSFilters(); ModuleTypo.update(); applyZoom();
  },
  createLayer: function (type: 'before' | 'after') {
    const slides = (currentStrategy === 'seamless' || currentStrategy === 'triptych') ? parseInt(DOM.sSlides.value) : 1;
    const layer = document.createElement('div'); layer.className = 'preview-layer flex w-full h-full absolute inset-0';

    const intensity = Number(el<HTMLInputElement>('slider-lut-intensity').value) / 100;
    const lutVal = el<HTMLSelectElement>('select-lut').value;
    const filters: Record<string, string> = { kodak: `sepia(${50 * intensity}%) contrast(${100 + 15 * intensity}%) saturate(${100 + 20 * intensity}%) hue-rotate(${-10 * intensity}deg)`, fuji: `sepia(${30 * intensity}%) hue-rotate(${10 * intensity}deg) saturate(${100 - 10 * intensity}%) contrast(${100 - 5 * intensity}%)`, cinematic: `contrast(${100 + 20 * intensity}%) saturate(${100 + 10 * intensity}%) sepia(${40 * intensity}%) hue-rotate(${-15 * intensity}deg)` };
    const cssLutStr = (lutVal !== 'none' && lutVal !== 'custom') ? filters[lutVal] : 'none';

    let f = cssLutStr;
    if (type === 'after' && (DOM.sBr.value !== '100' || DOM.sCo.value !== '100' || DOM.sSa.value !== '100')) { if (f === 'none') f = ''; f += ` brightness(${DOM.sBr.value}%) contrast(${DOM.sCo.value}%) saturate(${DOM.sSa.value}%)`; }
    const mScale = isMargin ? parseInt(DOM.sMarginScale.value) / 100 : 1;
    const bType = DOM.sBorder.value; const bWt = parseFloat(DOM.sBorderWeight.value);

    for (let i = 0; i < slides; i++) {
      const col = document.createElement('div'); col.className = 'flex flex-col flex-1 h-full relative';
      const sc = document.createElement('div'); sc.className = 'slide-container w-full h-full flex-1 relative shadow-inner border-[#111] last:border-r-0';
      if (currentStrategy === 'seamless' || currentStrategy === 'triptych') sc.style.borderRightWidth = '4px';
      sc.style.backgroundColor = type === 'after' ? bgColor : '#000000';
      if (isMargin && type === 'after' && bType === 'vnotch') sc.classList.add('border-vnotch');

      const iw = document.createElement('div'); iw.className = 'absolute overflow-hidden pointer-events-none preview-img-wrapper';
      if (isMargin && type === 'after') {
        if (bType === 'instant') { const pS = mScale * 0.88; iw.style.width = `${pS * 100}%`; iw.style.height = `${pS * 100}%`; iw.style.left = `${(1 - pS) / 2 * 100}%`; iw.style.top = '6%'; }
        else { iw.style.width = `${mScale * 100}%`; iw.style.height = `${mScale * 100}%`; iw.style.left = `${(1 - mScale) / 2 * 100}%`; iw.style.top = `${(1 - mScale) / 2 * 100}%`; if (bType === 'fineart') iw.style.border = `${Math.max(1, bWt)}px solid rgba(20,20,20,0.95)`; }
      } else { iw.style.width = '100%'; iw.style.height = '100%'; iw.style.left = '0'; iw.style.top = '0'; }

      const img = document.createElement('img'); img.src = proxyCropUrl!; img.style.filter = f;
      if (currentStrategy === 'seamless' || currentStrategy === 'triptych') { img.className = 'preview-img absolute max-w-none h-full'; img.style.width = `${slides * 100}%`; img.style.transform = `translateX(-${(i / slides) * 100}%)`; } else { img.className = 'preview-img absolute w-full h-full object-cover'; }

      iw.appendChild(img); sc.appendChild(iw);
      if (type === 'after') { const grain = document.createElement('div'); grain.className = 'gallery-grain-overlay'; grain.style.backgroundImage = `url(${staticGrainDataUrl})`; grain.style.opacity = String((Number(DOM.sGrain.value) / 100) * 2.5); sc.appendChild(grain); }
      col.appendChild(sc); layer.appendChild(col);
    }
    return layer;
  },
};

const ModuleColor = {
  triggerEngine: function (isFirstLoad = false) {
    const lutSelect = document.getElementById('select-lut') as HTMLSelectElement | null;
    const lutVal = lutSelect ? lutSelect.value : 'none';
    const intensity = Number(el<HTMLInputElement>('slider-lut-intensity').value) / 100;
    el('val-lut-intensity').innerText = `${Math.round(intensity * 100)}%`;
    const lutWrap = el('lut-intensity-wrapper');
    const hlVal = parseFloat(DOM.sHl.value); const shVal = parseFloat(DOM.sSh.value);
    const hasCustomLut = lutVal === 'custom' && !!Engine3D.lutData;

    if (lutVal !== 'none') {
      lutWrap.classList.remove('opacity-50', 'pointer-events-none');
    } else {
      lutWrap.classList.add('opacity-50', 'pointer-events-none');
    }

    if (hasCustomLut || hlVal !== 0 || shVal !== 0) {
      showLoading('Rendering Core Tone...');

      setTimeout(async () => {
        const img = new Image();
        const p = new Promise<void>(r => { img.onload = () => r(); });
        img.src = baseProxyCropUrl!;
        await p;

        const cvs = document.createElement('canvas'); cvs.width = img.width; cvs.height = img.height;
        const ctx = cvs.getContext('2d')!;
        ctx.drawImage(img, 0, 0);

        const hlF = 1.0 + (hlVal / 100.0); const shF = 1.0 + (shVal / 100.0);
        const processedCanvas = await Engine3D.apply(cvs, intensity, hlF, shF, hasCustomLut);
        proxyCropUrl = processedCanvas.toDataURL('image/jpeg', 0.95);
        setTimeout(() => { hideLoading(); if (isFirstLoad) { switchTab('frame'); ModuleFrame.build(); } else { ModuleFrame.build(); } }, 50);
      }, 50);
      return;
    }

    proxyCropUrl = baseProxyCropUrl;
    if (isFirstLoad) { switchTab('frame'); ModuleFrame.build(); } else { ModuleFrame.build(); }
  },
  updateCSSFilters: function () {
    const intensity = Number(el<HTMLInputElement>('slider-lut-intensity').value) / 100;
    const lutVal = el<HTMLSelectElement>('select-lut').value;
    const filters: Record<string, string> = { kodak: `sepia(${50 * intensity}%) contrast(${100 + 15 * intensity}%) saturate(${100 + 20 * intensity}%) hue-rotate(${-10 * intensity}deg)`, fuji: `sepia(${30 * intensity}%) hue-rotate(${10 * intensity}deg) saturate(${100 - 10 * intensity}%) contrast(${100 - 5 * intensity}%)`, cinematic: `contrast(${100 + 20 * intensity}%) saturate(${100 + 10 * intensity}%) sepia(${40 * intensity}%) hue-rotate(${-15 * intensity}deg)` };
    let cssLutStr = (lutVal !== 'none' && lutVal !== 'custom') ? filters[lutVal] : 'none';

    let f = cssLutStr;
    if (DOM.sBr.value !== '100' || DOM.sCo.value !== '100' || DOM.sSa.value !== '100') { if (f === 'none') f = ''; f += ` brightness(${DOM.sBr.value}%) contrast(${DOM.sCo.value}%) saturate(${DOM.sSa.value}%)`; }
    if (f === '') f = 'none';

    document.querySelectorAll<HTMLElement>('.preview-img').forEach(img => { if (!img.closest('[style*="polygon"]')) { img.style.filter = f; } });
    document.querySelectorAll<HTMLElement>('.gallery-grain-overlay').forEach(gr => gr.style.opacity = String((Number(DOM.sGrain.value) / 100) * 2.5));
  },
};

function resetTone() { DOM.sHl.value = '0'; DOM.inHl.value = '0'; DOM.sSh.value = '0'; DOM.inSh.value = '0'; el<HTMLSelectElement>('select-lut').value = 'none'; ModuleColor.triggerEngine(); }
function resetColor() { DOM.sBr.value = '100'; DOM.inBr.value = '100'; DOM.sCo.value = '100'; DOM.inCo.value = '100'; DOM.sSa.value = '100'; DOM.inSa.value = '100'; DOM.sGrain.value = '0'; DOM.inGrain.value = '0'; ModuleColor.updateCSSFilters(); }

const ModuleTypo = {
  updateColorFromPicker: function () { textStylePreset = 'none'; document.querySelectorAll('.preset-pill').forEach(p => p.classList.remove('active')); this.update(); },
  update: function () {
    const txt = DOM.wmText.value.trim();
    const target = DOM.wmTarget ? DOM.wmTarget.value : 'all';
    const isSingle = currentStrategy === 'single';
    const slides = (currentStrategy === 'seamless' || currentStrategy === 'triptych') ? parseInt(DOM.sSlides.value) : 1;
    const gAmt = parseInt(DOM.sGlowAmt.value); const pW = document.getElementById('preview-wrapper-parent'); if (!pW) return;
    const fSc = Number(DOM.sFontScale.value) / 100; const fs = Math.floor(pW.clientHeight * (isSingle ? 0.025 : 0.018)) * fSc;

    const showAppLogo = DOM.toggleAppLogo ? DOM.toggleAppLogo.checked : false;
    const currentUiWidth = pW.clientWidth / slides;
    const uiLogoWidth = currentUiWidth * (Number(DOM.sLogoScale.value) / 100) * 0.2;

    for (let i = 1; i <= slides; i++) {
      const pane = document.getElementById(`glass-pane-${i}`); if (!pane) continue;
      const shouldShow = isSingle || (target === 'all' || parseInt(target) === i);

      let te = pane.querySelector<HTMLElement>('.draggable-text');
      if (txt && shouldShow) {
        if (!te) { te = document.createElement('div'); te.className = 'draggable-text'; te.tabIndex = 0; pane.appendChild(te); }
        te.style.left = `${tPosX}%`; te.style.top = `${tPosY}%`; te.style.display = 'flex';
        let spanClass = ''; let spanStyle = `font-family: '${DOM.fontSel.value}', sans-serif; font-size:${fs}px; ${isBold ? 'font-weight:700;' : ''} letter-spacing:0.1em;`;
        if (textStylePreset === 'gold') spanClass = 'text-preset-gold'; else if (textStylePreset === 'silver') spanClass = 'text-preset-silver';
        if (textStylePreset !== 'none') { if (isGlow) spanStyle += `filter: drop-shadow(0 0 ${gAmt * (fs / 50)}px rgba(0,0,0,0.8));`; }
        else { spanStyle += ` color: ${DOM.textColor.value}; `; if (isGlow) spanStyle += `text-shadow: 0 0 ${gAmt * (fs / 50)}px ${DOM.textColor.value};`; }
        te.innerHTML = `<span class="${spanClass}" style="display:inline-block; ${spanStyle}">${txt}</span>`;
      } else if (te) { te.style.display = 'none'; }

      let le = pane.querySelector<HTMLElement>('.draggable-logo');
      if (logoObj && logoUrl && shouldShow && DOM.toggleLogo.checked) {
        if (!le) { le = document.createElement('div'); le.className = 'draggable-logo'; le.tabIndex = 0; pane.appendChild(le); }
        le.style.left = `${lPosX}%`; le.style.top = `${lPosY}%`; le.style.display = 'flex';
        le.innerHTML = `<img src="${logoUrl}" style="opacity:${Number(DOM.sLogoOp.value) / 100}; width:${uiLogoWidth}px; min-width:${uiLogoWidth}px; pointer-events:none; max-width:none !important; flex-shrink:0;">`;
      } else if (le) { le.style.display = 'none'; }

      let appWm = pane.querySelector<HTMLElement>('.app-watermark-preview');
      if (showAppLogo) {
        if (!appWm) {
          appWm = document.createElement('div'); appWm.className = 'app-watermark-preview absolute bottom-4 right-4 pointer-events-none z-50 text-[9px] md:text-[10px] text-white/90 font-bold tracking-widest';
          appWm.style.fontFamily = "'Outfit', sans-serif";
          appWm.innerText = 'cineRoll.studio'; pane.appendChild(appWm);
        }
        appWm.style.textShadow = '0 2px 4px rgba(0,0,0,0.9), 0 0 2px rgba(0,0,0,0.8)';
        appWm.style.display = 'block';
      } else if (appWm) { appWm.style.display = 'none'; }
    }
  },
  updatePositions: function () { document.querySelectorAll<HTMLElement>('.draggable-text').forEach(elx => { elx.style.left = `${tPosX}%`; elx.style.top = `${tPosY}%`; }); document.querySelectorAll<HTMLElement>('.draggable-logo').forEach(elx => { elx.style.left = `${lPosX}%`; elx.style.top = `${lPosY}%`; }); },
};

function handleLogoToggleCheckbox() {
  if (!logoUrl && DOM.toggleLogo.checked) { DOM.toggleLogo.checked = false; DOM.upLogo.click(); return; }
  if (DOM.toggleLogo.checked) { DOM.logoSettings.classList.remove('opacity-30', 'pointer-events-none'); } else { DOM.logoSettings.classList.add('opacity-30', 'pointer-events-none'); }
  ModuleTypo.update();
}

function toggleBold() { isBold = !isBold; el('btnBold').classList.toggle('active', isBold); ModuleTypo.update(); }
function toggleGlow() { isGlow = !isGlow; el('btnGlow').classList.toggle('active', isGlow); ModuleTypo.update(); }

function applyCinePreset(type: 'gold' | 'silver') { textStylePreset = type; document.querySelectorAll('.preset-pill').forEach(p => p.classList.remove('active')); if (type === 'gold') { el('btn-preset-gold').classList.add('active'); } else if (type === 'silver') { el('btn-preset-silver').classList.add('active'); } ModuleTypo.update(); }

function saveCurrentPreset() {
  const txt = DOM.wmText.value.trim(); if (!txt && !logoUrl) return alert('저장할 텍스트나 로고를 설정해주세요.');
  const preset = { id: Date.now(), text: txt, color: DOM.textColor.value, bold: isBold, glow: isGlow, font: DOM.fontSel.value, glowAmt: DOM.sGlowAmt.value, type: textStylePreset };
  savedCustomPresets.push(preset); localStorage.setItem('cineroll_presets_v4', JSON.stringify(savedCustomPresets));
  const saveBtn = el('btn-save-preset'); saveBtn.innerText = '✔️ Saved'; saveBtn.classList.add('text-green-400'); setTimeout(() => { saveBtn.innerText = 'SAVE PRESET'; saveBtn.classList.remove('text-green-400'); }, 1000); renderPresetChips();
}

function renderPresetChips() {
  const container = document.getElementById('custom-presets-container'); if (!container) return; container.innerHTML = '';
  savedCustomPresets.forEach(p => {
    const chip = document.createElement('div'); chip.className = 'preset-chip flex items-center bg-[#18181b] border border-border rounded text-[9px] text-zinc-400 cursor-pointer hover:border-coral-500/50 transition-colors font-bold tracking-wide';
    const nameBtn = document.createElement('div'); nameBtn.className = 'px-3 py-1.5 truncate max-w-[100px]'; nameBtn.innerText = p.text ? p.text : 'Preset'; nameBtn.onclick = () => loadPreset(p);
    const delBtn = document.createElement('div'); delBtn.className = 'px-2 py-1.5 border-l border-border hover:bg-coral-500 hover:text-white transition-colors'; delBtn.innerText = '✕'; delBtn.onclick = (e) => { e.stopPropagation(); deletePreset(p.id); };
    chip.appendChild(nameBtn); chip.appendChild(delBtn); container.appendChild(chip);
  });
}

function loadPreset(p: any) {
  DOM.wmText.value = p.text; DOM.textColor.value = p.color; isBold = p.bold; isGlow = p.glow; DOM.fontSel.value = p.font; DOM.sGlowAmt.value = p.glowAmt || '15'; textStylePreset = p.type;
  el('btnBold').classList.toggle('active', isBold); el('btnGlow').classList.toggle('active', isGlow); document.querySelectorAll('.preset-pill').forEach(btn => btn.classList.remove('active')); if (p.type === 'gold') el('btn-preset-gold').classList.add('active'); if (p.type === 'silver') el('btn-preset-silver').classList.add('active'); ModuleTypo.update();
}

function deletePreset(id: number) { savedCustomPresets = savedCustomPresets.filter(p => p.id !== id); localStorage.setItem('cineroll_presets_v4', JSON.stringify(savedCustomPresets)); renderPresetChips(); }

function setBG(elm: HTMLElement) { document.querySelectorAll('[data-bg]').forEach(b => b.classList.remove('active')); elm.classList.add('active'); bgColor = elm.dataset.bg!; document.querySelectorAll<HTMLElement>('.slide-container').forEach(sc => { if (!sc.closest('[style*="polygon"]')) { sc.style.backgroundColor = bgColor; } }); ModuleTypo.update(); }
function setMargin(val: boolean) { isMargin = val; el('btn-edge').classList.toggle('active', !val); el('btn-margin').classList.toggle('active', val); DOM.marginScaleWrapper.classList.toggle('hidden', !val); ModuleFrame.build(); }

function closeExportModal() {
  el('export-modal').classList.remove('show');
  setTimeout(() => { el('export-gallery-container').innerHTML = ''; }, 300);
}

DOM.btnExport.addEventListener('click', async () => {
  if (!cropper) return alert('크롭 영역을 다시 확인해주세요.');

  const cropData = cropper.getCropBoxData();
  if (cropData && cropData.width && cropData.height) {
    activeGlobalRatio = cropData.width / cropData.height;
  }

  DOM.btnExport.classList.add('opacity-70', 'pointer-events-none'); showLoading('Rendering High-Res...');
  try {
    await document.fonts.ready; const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) || window.innerWidth < 768;

    const qualMode = DOM.exportQuality.value;
    let mimeType = 'image/jpeg';
    let encQual = 0.9;

    const SAFE_MAX_DIM = 16000;
    const MAX_AREA = isMobile ? 16777216 : 67108864;

    let targetW = 0, targetH = 0;
    const slides = (currentStrategy === 'seamless' || currentStrategy === 'triptych') ? parseInt(DOM.sSlides.value) : 1;

    if (qualMode === 'web') {
      const bW = isMobile ? 3000 : 6000;
      encQual = 1.0;
      targetW = (currentStrategy === 'seamless') ? bW * slides : bW;
    } else if (qualMode === 'ig') {
      const bW = 2160;
      targetW = (currentStrategy === 'seamless') ? bW * slides : bW;
    } else if (qualMode === 'png') {
      mimeType = 'image/png';
      targetW = SAFE_MAX_DIM;
    }

    targetH = targetW / activeGlobalRatio;

    if (targetW > SAFE_MAX_DIM || targetH > SAFE_MAX_DIM) {
      const s = Math.min(SAFE_MAX_DIM / targetW, SAFE_MAX_DIM / targetH);
      targetW *= s;
      targetH *= s;
    }

    if ((targetW * targetH) > MAX_AREA) {
      const s = Math.sqrt(MAX_AREA / (targetW * targetH));
      targetW *= s;
      targetH *= s;
    }

    targetW = Math.floor(targetW);
    targetH = Math.floor(targetW / activeGlobalRatio);

    const cropperOptions = {
      width: targetW,
      height: targetH,
      fillColor: 'transparent',
      imageSmoothingEnabled: true,
      imageSmoothingQuality: 'high',
    };

    await new Promise(r => setTimeout(r, 50));
    let mCvs = cropper.getCroppedCanvas(cropperOptions);

    const lutSelect = document.getElementById('select-lut') as HTMLSelectElement | null;
    const lutVal = lutSelect ? lutSelect.value : 'none';
    const hlVal = parseFloat(DOM.sHl.value); const shVal = parseFloat(DOM.sSh.value); const hasCustomLut = lutVal === 'custom' && !!Engine3D.lutData;

    const intensity = Number(el<HTMLInputElement>('slider-lut-intensity').value) / 100;
    const filters: Record<string, string> = { kodak: `sepia(${50 * intensity}%) contrast(${100 + 15 * intensity}%) saturate(${100 + 20 * intensity}%) hue-rotate(${-10 * intensity}deg)`, fuji: `sepia(${30 * intensity}%) hue-rotate(${10 * intensity}deg) saturate(${100 - 10 * intensity}%) contrast(${100 - 5 * intensity}%)`, cinematic: `contrast(${100 + 20 * intensity}%) saturate(${100 + 10 * intensity}%) sepia(${40 * intensity}%) hue-rotate(${-15 * intensity}deg)` };
    const cssLutStr = (lutVal !== 'none' && lutVal !== 'custom') ? filters[lutVal] : 'none';

    if (hasCustomLut || hlVal !== 0 || shVal !== 0 || cssLutStr !== 'none') {
      if (cssLutStr !== 'none') {
        const tempCvs = document.createElement('canvas'); tempCvs.width = mCvs.width; tempCvs.height = mCvs.height;
        const ctx = tempCvs.getContext('2d')!; ctx.filter = cssLutStr; ctx.drawImage(mCvs, 0, 0); mCvs = tempCvs;
      }
      const hlF = 1.0 + (hlVal / 100.0); const shF = 1.0 + (shVal / 100.0);
      mCvs = await Engine3D.apply(mCvs, intensity, hlF, shF, hasCustomLut);
    }

    const sW = mCvs.width / slides;
    const eH = mCvs.height;

    const mS = isMargin ? parseInt(DOM.sMarginScale.value) / 100 : 1; const bWt = parseFloat(DOM.sBorderWeight.value); const bTy = DOM.sBorder.value;
    const gi = parseInt(DOM.sGrain.value); let gCvs: HTMLCanvasElement | null = null;
    if (gi > 0) { gCvs = document.createElement('canvas'); gCvs.width = 512; gCvs.height = 512; const gx = gCvs.getContext('2d')!; const id = gx.createImageData(512, 512); for (let i = 0; i < id.data.length; i += 4) { id.data[i] = id.data[i + 1] = id.data[i + 2] = Math.random() < 0.5 ? 0 : 255; id.data[i + 3] = 255; } gx.putImageData(id, 0, 0); }

    const gCon = el('export-gallery-container'); gCon.innerHTML = ''; const fArr: File[] = []; let sBlb: Blob | null = null; const zip = new JSZip();

    const showAppLogo = DOM.toggleAppLogo ? DOM.toggleAppLogo.checked : false;
    const target = DOM.wmTarget ? DOM.wmTarget.value : 'all';

    for (let i = 0; i < slides; i++) {
      updateLoadingText(`Encoding File ${i + 1} / ${slides}...`);
      await new Promise(r => setTimeout(r, 50));

      const wCv = document.createElement('canvas');
      const finalSliceW = Math.floor(sW); const finalExportH = Math.floor(eH);
      wCv.width = finalSliceW; wCv.height = finalExportH;
      const ctx = wCv.getContext('2d')!; ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
      ctx.fillStyle = isMargin ? bgColor : '#000000'; ctx.fillRect(0, 0, finalSliceW, finalExportH); ctx.save();

      let dx = 0, dy = 0, dw = sW, dh = eH;
      if (isMargin) {
        if (bTy === 'instant') { const pS = mS * 0.88; dw = sW * pS; dh = eH * pS; dx = (sW - dw) / 2; dy = eH * 0.06; } else { dw = sW * mS; dh = eH * mS; dx = (sW - dw) / 2; dy = (eH - dh) / 2; }
        if (currentStrategy === 'seamless' || currentStrategy === 'triptych') ctx.drawImage(mCvs, i * sW, 0, sW, eH, dx, dy, dw, dh); else ctx.drawImage(mCvs, dx, dy, dw, dh);
      } else { if (currentStrategy === 'seamless' || currentStrategy === 'triptych') ctx.drawImage(mCvs, i * sW, 0, sW, eH, 0, 0, finalSliceW, finalExportH); else ctx.drawImage(mCvs, 0, 0, finalSliceW, finalExportH); }
      ctx.restore();

      if (isMargin && bTy === 'fineart') { ctx.save(); const strokeW = Math.max(1, eH * 0.001 * bWt); ctx.strokeStyle = 'rgba(20,20,20,0.95)'; ctx.lineWidth = strokeW; ctx.strokeRect(dx + strokeW / 2, dy + strokeW / 2, dw - strokeW, dh - strokeW); ctx.restore(); }
      if (gCvs) { ctx.save(); ctx.globalAlpha = (gi / 100) * 1.5; ctx.globalCompositeOperation = 'soft-light'; ctx.fillStyle = ctx.createPattern(gCvs, 'repeat')!; ctx.fillRect(0, 0, finalSliceW, finalExportH); ctx.restore(); }

      const txt = DOM.wmText.value.trim();
      const shouldShowTypo = currentStrategy === 'single' || target === 'all' || parseInt(target) === i + 1;

      if (txt && shouldShowTypo) {
        ctx.save(); ctx.font = `${isBold ? 'bold ' : ''} ${Math.floor(eH * (currentStrategy === 'single' ? 0.025 : 0.018) * (Number(DOM.sFontScale.value) / 100))}px '${DOM.fontSel.value}', sans-serif`; ctx.textBaseline = 'middle'; ctx.textAlign = 'center'; (ctx as any).letterSpacing = '2px';
        if (textStylePreset !== 'none') {
          const gradient = ctx.createLinearGradient(sW * (tPosX / 100) - 100, eH * (tPosY / 100) - 20, sW * (tPosX / 100) + 100, eH * (tPosY / 100) + 20);
          if (textStylePreset === 'gold') { gradient.addColorStop(0, '#BF953F'); gradient.addColorStop(0.25, '#FCF6BA'); gradient.addColorStop(0.5, '#B38728'); gradient.addColorStop(0.75, '#FBF5B7'); gradient.addColorStop(1, '#AA771C'); } else { gradient.addColorStop(0, '#8A9097'); gradient.addColorStop(0.25, '#E0E5EC'); gradient.addColorStop(0.5, '#8A9097'); gradient.addColorStop(0.75, '#B0B5BB'); gradient.addColorStop(1, '#595F66'); }
          ctx.fillStyle = gradient;
        } else { ctx.fillStyle = DOM.textColor.value; }
        if (isGlow) { ctx.shadowColor = textStylePreset !== 'none' ? 'rgba(0,0,0,0.8)' : DOM.textColor.value; ctx.shadowBlur = parseInt(DOM.sGlowAmt.value) * 1.5; }
        ctx.fillText(txt, sW * (tPosX / 100), eH * (tPosY / 100)); ctx.restore();
      }

      if (logoObj && logoUrl && DOM.toggleLogo.checked && shouldShowTypo) {
        ctx.save(); ctx.globalAlpha = Number(DOM.sLogoOp.value) / 100; const lgScale = Number(DOM.sLogoScale.value) / 100; const maxW = sW * 0.2 * lgScale; const ratio = logoObj.height / logoObj.width; const finalW = maxW; const finalH = maxW * ratio; ctx.drawImage(logoObj, sW * (lPosX / 100) - finalW / 2, eH * (lPosY / 100) - finalH / 2, finalW, finalH); ctx.restore();
      }

      if (showAppLogo) {
        ctx.save();
        const appWmSize = Math.max(16, eH * 0.012);
        ctx.font = `700 ${appWmSize}px 'Outfit', sans-serif`;
        ctx.shadowColor = 'rgba(0,0,0,0.9)';
        ctx.shadowBlur = 8;
        ctx.shadowOffsetY = 1;
        ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'bottom';
        ctx.fillText('cineRoll.studio', finalSliceW - (eH * 0.015), finalExportH - (eH * 0.015));
        ctx.restore();
      }

      const ext = mimeType === 'image/png' ? 'png' : 'jpg';
      const fn = (currentStrategy === 'seamless' || currentStrategy === 'triptych') ? `cineRoll_pan_${i + 1}.${ext}` : `cineRoll_output.${ext}`;

      const blob: Blob | null = await new Promise(r => wCv.toBlob(r, mimeType, encQual));

      if (!blob) throw new Error('Failed to generate image blob');
      sBlb = blob;
      fArr.push(new File([blob], fn, { type: mimeType }));
      zip.file(fn, blob);

      const imgEl = document.createElement('img');
      imgEl.src = URL.createObjectURL(blob);
      imgEl.className = 'export-img-item';
      el('export-gallery-container').appendChild(imgEl);

      wCv.width = 0; wCv.height = 0;
    }

    if (!isMobile) {
      if (slides === 1) {
        const l = document.createElement('a'); l.href = URL.createObjectURL(sBlb!); l.download = `cineRoll_Output.${mimeType === 'image/png' ? 'png' : 'jpg'}`; l.click();
      } else {
        updateLoadingText('Packaging Gallery (ZIP)...');
        await new Promise(r => setTimeout(r, 100));
        const c = await zip.generateAsync({ type: 'blob' });
        const l = document.createElement('a'); l.href = URL.createObjectURL(c); l.download = 'cineRoll_Gallery.zip'; l.click();
      }
      hideLoading();
      el('export-modal').classList.add('show');
      DOM.btnExport.innerText = '✅ Downloaded!';
    } else {
      hideLoading();
      try {
        if ((navigator as any).canShare && (navigator as any).canShare({ files: fArr })) {
          await (navigator as any).share({ files: fArr }); DOM.btnExport.innerText = '✅ Saved!';
        } else throw new Error('share unsupported');
      } catch (_e) {
        el('export-modal').classList.add('show'); DOM.btnExport.innerText = '✅ Ready!';
      }
    }
    mCvs.width = 0; mCvs.height = 0;
  } catch (err) { hideLoading(); alert('Export Failed: ' + (err as Error).message); DOM.btnExport.innerText = '❌ Failed'; } finally { DOM.btnExport.classList.remove('opacity-70', 'pointer-events-none'); setTimeout(() => { DOM.btnExport.innerText = 'Export Gallery'; }, 3000); }
});

// --- Wiring for elements that were inline event handlers in the original markup ---
el('btn-close-export').addEventListener('click', closeExportModal);
el('btn-return-workspace').addEventListener('click', closeExportModal);
el('btn-exit-zen').addEventListener('click', toggleZenMode);
el('btn-reload-logo').addEventListener('click', () => location.reload());
el('btn-new-photo').addEventListener('click', () => location.reload());
DOM.btnZen.addEventListener('click', toggleZenMode);
DOM.btnBA.addEventListener('click', toggleSplitView);
el('btn-zoom-fit').addEventListener('click', () => setZoom('fit'));
el('btn-reset-framing').addEventListener('click', resetFraming);
el('btn-rotate-90').addEventListener('click', () => rotateBase(90));
el('btn-apply-crop').addEventListener('click', applyCropAndRender);
document.querySelectorAll<HTMLElement>('[data-bg]').forEach(btn => btn.addEventListener('click', () => setBG(btn)));
el('btn-edge').addEventListener('click', () => setMargin(false));
el('btn-margin').addEventListener('click', () => setMargin(true));
el('btn-upload-lut-trigger').addEventListener('click', () => el<HTMLInputElement>('uploadLut').click());
el<HTMLSelectElement>('select-lut').addEventListener('change', () => ModuleColor.triggerEngine());
el<HTMLInputElement>('slider-lut-intensity').addEventListener('input', function () { el('val-lut-intensity').innerText = this.value + '%'; });
el<HTMLInputElement>('slider-lut-intensity').addEventListener('change', () => ModuleColor.triggerEngine());
el('btn-reset-tone').addEventListener('click', resetTone);
el('btn-reset-color').addEventListener('click', resetColor);
el<HTMLSelectElement>('select-border').addEventListener('change', () => ModuleFrame.updateBorderOptions());
el('btn-save-preset').addEventListener('click', saveCurrentPreset);
el('btn-preset-gold').addEventListener('click', () => applyCinePreset('gold'));
el('btn-preset-silver').addEventListener('click', () => applyCinePreset('silver'));
DOM.textColor.addEventListener('click', () => ModuleTypo.updateColorFromPicker());
DOM.textColor.addEventListener('input', () => ModuleTypo.updateColorFromPicker());
el('btnBold').addEventListener('click', toggleBold);
el('btnGlow').addEventListener('click', toggleGlow);
DOM.fontSel.addEventListener('change', () => ModuleTypo.update());
DOM.wmText.addEventListener('input', () => ModuleTypo.update());
DOM.wmTarget.addEventListener('change', () => ModuleTypo.update());
DOM.toggleLogo.addEventListener('change', handleLogoToggleCheckbox);
el('btn-upload-logo-trigger').addEventListener('click', () => DOM.upLogo.click());
DOM.toggleAppLogo.addEventListener('change', () => ModuleTypo.update());
