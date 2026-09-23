import JSZip from 'jszip';
import UTIF from 'utif';
import { editState, loadPresets, savePresets, installDebugHook, type EditState, type BorderStyle } from './state';
import { CropController, getDesqueezedPlaneSize, renderCroppedRegionFromOriginal } from './crop';
import { buildToneFilterString, createGrainTile, Engine3D } from './compose';
import { renderSlideBase, computeFontSizePx, computeGlowPx, drawWatermarkText, drawLogo, drawAppWatermark } from './render';

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

let originalImg: HTMLImageElement | null = null; let currentStrategy = 'seamless';
let baseProxyCropUrl: string | null = null; let proxyCropUrl: string | null = null;
let sourceImg: HTMLImageElement | null = null;
const grainTile = createGrainTile();
let activeGlobalRatio = 1; let zoomMode = 'fit';
let isMargin = false; let bgColor = '#000000';
let isBold = false; let isGlow = true;
let tPosX = 50, tPosY = 94, lPosX = 50, lPosY = 80; let logoObj: HTMLImageElement | null = null; let logoUrl: string | null = null; let activeTarget: 'text' | 'logo' | null = null;
let isCropperReady = false; let isSplitView = false; let splitPos = 50;
let textStylePreset: 'none' | 'gold' | 'silver' = 'none';
let savedCustomPresets: any[] = [];

const cropCtrl = new CropController(DOM.main, {
  onSmartSnap: ({ label, box }) => {
    if (!DOM.badge) return;
    if (label && box) {
      DOM.badge.innerText = label;
      DOM.badge.classList.remove('opacity-0');
      DOM.badge.style.top = Math.max(10, box.top - 28) + 'px';
      DOM.badge.style.left = (box.left + box.width / 2) + 'px';
    } else {
      DOM.badge.classList.add('opacity-0');
    }
  },
});

installDebugHook((rect) => cropCtrl.setCropForTest(rect));

function mirrorFormatStateToEditState() {
  editState.update((s) => ({
    ...s,
    strategy: currentStrategy as EditState['strategy'],
    baseRatio: isNaN(parseFloat(DOM.sRatio.value)) ? null : parseFloat(DOM.sRatio.value),
    slides: parseInt(DOM.sSlides.value) as 2 | 3 | 4,
    squeeze: parseInt(DOM.sSqueeze.value) as EditState['squeeze'],
  }));
}

function currentTargetAspect(): number {
  const br = parseFloat(DOM.sRatio.value);
  if (currentStrategy === 'seamless' && !isNaN(br)) return br * parseInt(DOM.sSlides.value);
  return br;
}

function syncAspectToCropper() {
  mirrorFormatStateToEditState();
  if (!cropCtrl.isReady) return;
  cropCtrl.retarget(currentTargetAspect());
}

window.addEventListener('DOMContentLoaded', () => {
  loadPresetsFromStorage();
  initGlobalDrag();
});

function loadPresetsFromStorage() {
  savedCustomPresets = loadPresets();
  renderPresetChips();
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

bindInputSlider(DOM.sAngle, DOM.inAngle, () => { cropCtrl.setFineAngle(Number(DOM.sAngle.value)); });
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
    if (formatTab && !formatTab.classList.contains('hidden') && cropCtrl.isReady && isCropperReady) {
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
    setTimeout(() => {
      if (originalImg && !cropCtrl.isReady) { remountCropper(); }
      else if (cropCtrl.isReady) { DOM.main.classList.add('opacity-100'); cropCtrl.resize(); }
    }, 50);
  } else {
    cropCtrl.destroy(); isCropperReady = false;
    DOM.main.classList.remove('opacity-100'); DOM.main.style.display = 'none';
    if (proxyCropUrl) { DOM.previewArea.classList.remove('hidden'); DOM.zoomControls.classList.remove('hidden'); DOM.zoomControls.classList.add('flex'); DOM.btnBA.style.display = 'flex'; DOM.btnZen.style.display = 'flex'; applyZoom(); }
  }
}

document.querySelectorAll<HTMLElement>('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab!));
});

document.querySelectorAll<HTMLElement>('#strategy-btns .min-btn').forEach(btn => {
  btn.addEventListener('click', e => {
    document.querySelectorAll('#strategy-btns .min-btn').forEach(b => b.classList.remove('active')); (e.target as HTMLElement).classList.add('active'); currentStrategy = (e.target as HTMLElement).dataset.val!;
    const isSingle = currentStrategy === 'single';
    DOM.seamlessWrapper.classList.toggle('disabled-block', isSingle);
    if (isSingle && DOM.sRatio.value === 'NaN') DOM.sRatio.value = '0.8';
    syncAspectToCropper();
  });
});

function resetFraming() {
  const needsRebuild = DOM.sSqueeze.value !== '100';
  if (currentStrategy === 'seamless' || currentStrategy === 'triptych') { DOM.sRatio.value = '0.8'; DOM.sSlides.value = '3'; } else { DOM.sRatio.value = 'NaN'; }
  DOM.sAngle.value = '0'; DOM.inAngle.value = '0'; DOM.sSqueeze.value = '100';
  mirrorFormatStateToEditState();
  editState.update(s => ({ ...s, rotation: { base: 0, fine: 0 } }));
  if (needsRebuild) { DOM.main.classList.remove('opacity-100'); DOM.main.classList.add('opacity-0'); setTimeout(() => remountCropper(), 300); }
  else if (cropCtrl.isReady) { cropCtrl.setFineAngle(0); cropCtrl.retarget(currentTargetAspect()); }
}

DOM.sSqueeze.addEventListener('change', () => {
  DOM.main.classList.remove('opacity-100');
  DOM.main.classList.add('opacity-0');
  setTimeout(() => remountCropper(), 300);
});

DOM.sRatio.addEventListener('change', syncAspectToCropper); DOM.sSlides.addEventListener('change', syncAspectToCropper);

async function rotateBase(deg: 90) {
  if (!originalImg) return;
  DOM.main.classList.remove('opacity-100'); DOM.main.classList.add('opacity-0');
  await cropCtrl.rotateBase(deg);
  DOM.main.classList.remove('opacity-0'); DOM.main.classList.add('opacity-100');
}

async function remountCropper() {
  if (!originalImg) return;
  mirrorFormatStateToEditState();
  isCropperReady = false;
  await cropCtrl.mount(originalImg, parseInt(DOM.sSqueeze.value));
  isCropperReady = true;
  DOM.main.classList.remove('opacity-0'); DOM.main.classList.add('opacity-100');
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

  DOM.upText.innerText = 'Processing...'; if (DOM.sAngle) DOM.sAngle.value = '0'; if (DOM.inAngle) DOM.inAngle.value = '0';
  editState.update(s => ({ ...s, rotation: { base: 0, fine: 0 }, crop: { x: 0, y: 0, width: 0, height: 0 } }));
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
  if (!cropCtrl.isReady || !isCropperReady) return;
  try {
    if (DOM.badge) DOM.badge.classList.add('opacity-0');
    const cvs = cropCtrl.getCroppedCanvas({ maxWidth: 2560, maxHeight: 2560, fillColor: 'transparent', imageSmoothingEnabled: true, imageSmoothingQuality: 'high' })!;
    if (!cvs || cvs.width === 0 || cvs.height === 0) { alert('크롭 영역을 다시 지정해주세요.'); return; }
    activeGlobalRatio = cvs.width / cvs.height; baseProxyCropUrl = cvs.toDataURL('image/png'); cvs.width = 0; cvs.height = 0;
    ModuleColor.triggerEngine(true);
  } catch (_err) { alert('오류가 발생했습니다.'); }
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.src = url;
  });
}

function currentToneFilterString(): string {
  return buildToneFilterString({
    lut: el<HTMLSelectElement>('select-lut').value as EditState['tone']['lut'],
    lutIntensity: Number(el<HTMLInputElement>('slider-lut-intensity').value),
    brightness: Number(DOM.sBr.value),
    contrast: Number(DOM.sCo.value),
    saturation: Number(DOM.sSa.value),
  });
}

/** Redraws every visible slide's canvas (background/image/border/grain/text/logo/watermark) without touching DOM structure. Shared by every color/typo/frame control that doesn't change slide count. */
function redrawSlides() {
  if (!sourceImg) return;
  const pW = document.getElementById('preview-wrapper-parent'); if (!pW) return;
  const slides = (currentStrategy === 'seamless' || currentStrategy === 'triptych') ? parseInt(DOM.sSlides.value) : 1;
  const isSingle = currentStrategy === 'single';
  const isPanned = currentStrategy === 'seamless' || currentStrategy === 'triptych';
  const filterString = currentToneFilterString();
  const dpr = window.devicePixelRatio || 1;

  const cssH = pW.clientHeight;
  const cssW = pW.clientWidth / slides;
  const fontSizePx = computeFontSizePx(cssH, isSingle, Number(DOM.sFontScale.value));
  const glowPx = computeGlowPx(parseInt(DOM.sGlowAmt.value), fontSizePx);
  const target = DOM.wmTarget ? DOM.wmTarget.value : 'all';
  const txt = DOM.wmText.value.trim();
  const showAppLogo = DOM.toggleAppLogo ? DOM.toggleAppLogo.checked : false;
  const uiLogoWidth = cssW * (Number(DOM.sLogoScale.value) / 100) * 0.2;

  const frame = {
    bgColor,
    isMargin,
    marginScale: isMargin ? parseInt(DOM.sMarginScale.value) / 100 : 1,
    border: DOM.sBorder.value as BorderStyle,
    borderWeight: parseFloat(DOM.sBorderWeight.value),
  };

  document.querySelectorAll<HTMLCanvasElement>('.preview-slide-canvas').forEach((canvas) => {
    const i = Number(canvas.dataset.slideIndex);
    canvas.width = Math.max(1, Math.round(cssW * dpr));
    canvas.height = Math.max(1, Math.round(cssH * dpr));
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    renderSlideBase({
      ctx, width: cssW, height: cssH, slideIndex: i, slidesCount: slides, isPanned,
      source: { image: sourceImg!, naturalWidth: sourceImg!.naturalWidth, naturalHeight: sourceImg!.naturalHeight },
      filterString, frame, grain: { tile: grainTile, amountPct: Number(DOM.sGrain.value) },
    });

    const shouldShow = isSingle || target === 'all' || parseInt(target) === i + 1;
    if (txt && shouldShow) {
      drawWatermarkText({
        ctx, text: txt, x: cssW * (tPosX / 100), y: cssH * (tPosY / 100),
        fontSizePx, fontFamily: DOM.fontSel.value, bold: isBold, preset: textStylePreset,
        plainColor: DOM.textColor.value, glow: isGlow, glowPx,
      });
    }
    if (logoObj && logoUrl && shouldShow && DOM.toggleLogo.checked) {
      drawLogo({
        ctx, image: logoObj, naturalWidth: logoObj.naturalWidth, naturalHeight: logoObj.naturalHeight,
        x: cssW * (lPosX / 100), y: cssH * (lPosY / 100), width: uiLogoWidth, opacityPct: Number(DOM.sLogoOp.value),
      });
    }
    if (showAppLogo) drawAppWatermark({ ctx, width: cssW, height: cssH });
  });

  updateDragHitTargets(slides, isSingle, cssW, cssH, fontSizePx, uiLogoWidth);
}

/** Keeps the invisible drag hit-target overlays (for text/logo pointer interaction) in sync with what redrawSlides() just painted. */
function updateDragHitTargets(slides: number, isSingle: boolean, cssW: number, cssH: number, fontSizePx: number, uiLogoWidth: number) {
  const txt = DOM.wmText.value.trim();
  const target = DOM.wmTarget ? DOM.wmTarget.value : 'all';
  const showLogo = logoObj && logoUrl && DOM.toggleLogo.checked;

  for (let i = 1; i <= slides; i++) {
    const pane = document.getElementById(`glass-pane-${i}`); if (!pane) continue;
    const shouldShow = isSingle || target === 'all' || parseInt(target) === i;

    let te = pane.querySelector<HTMLElement>('.draggable-text');
    if (txt && shouldShow) {
      if (!te) { te = document.createElement('div'); te.className = 'draggable-text'; te.tabIndex = 0; pane.appendChild(te); }
      te.style.left = `${tPosX}%`; te.style.top = `${tPosY}%`; te.style.display = 'flex';
      te.innerHTML = `<span style="visibility:hidden; display:inline-block; font-family:'${DOM.fontSel.value}', sans-serif; font-size:${fontSizePx}px; ${isBold ? 'font-weight:700;' : ''} letter-spacing:0.1em;">${txt}</span>`;
    } else if (te) { te.style.display = 'none'; }

    let le = pane.querySelector<HTMLElement>('.draggable-logo');
    if (showLogo && shouldShow) {
      if (!le) { le = document.createElement('div'); le.className = 'draggable-logo'; le.tabIndex = 0; pane.appendChild(le); }
      le.style.left = `${lPosX}%`; le.style.top = `${lPosY}%`; le.style.display = 'flex';
      le.innerHTML = `<img src="${logoUrl}" style="opacity:0; width:${uiLogoWidth}px; min-width:${uiLogoWidth}px; pointer-events:none; max-width:none !important; flex-shrink:0;">`;
    } else if (le) { le.style.display = 'none'; }
  }
  void cssW; void cssH;
}

const ModuleFrame = {
  updateBorderOptions: function () { DOM.borderWeightWrapper.classList.toggle('hidden', DOM.sBorder.value !== 'fineart'); this.build(); },
  build: async function () {
    if (!proxyCropUrl) return;
    sourceImg = await loadImage(proxyCropUrl);

    DOM.previewInner.innerHTML = '';
    const p = document.createElement('div'); p.id = 'preview-wrapper-parent'; p.className = 'flex relative m-auto'; p.style.aspectRatio = String(activeGlobalRatio); p.style.flexShrink = '0'; p.style.boxShadow = '0 40px 100px rgba(0,0,0,0.95)';

    const slides = (currentStrategy === 'seamless' || currentStrategy === 'triptych') ? parseInt(DOM.sSlides.value) : 1;
    const afterLayer = document.createElement('div'); afterLayer.className = 'preview-layer flex w-full h-full absolute inset-0'; afterLayer.id = 'layer-images-after';
    for (let i = 0; i < slides; i++) {
      const col = document.createElement('div'); col.className = 'flex flex-col flex-1 h-full relative';
      const sc = document.createElement('div'); sc.className = 'slide-container w-full h-full flex-1 relative shadow-inner border-[#111] last:border-r-0';
      if (currentStrategy === 'seamless' || currentStrategy === 'triptych') sc.style.borderRightWidth = '4px';
      const canvas = document.createElement('canvas'); canvas.className = 'preview-slide-canvas absolute inset-0 w-full h-full'; canvas.dataset.slideIndex = String(i);
      sc.appendChild(canvas);
      col.appendChild(sc); afterLayer.appendChild(col);
    }
    p.appendChild(afterLayer);

    const lg = document.createElement('div'); lg.className = 'layer-glass absolute inset-0 flex z-50 pointer-events-none';
    for (let i = 0; i < slides; i++) {
      const gp = document.createElement('div'); gp.className = 'flex-1 relative h-full pointer-events-none overflow-hidden'; gp.id = `glass-pane-${i + 1}`;
      gp.innerHTML = `<div class="snap-guide snap-guide-x hidden"></div><div class="snap-guide snap-guide-y hidden"></div>`; lg.appendChild(gp);
    }
    p.appendChild(lg); DOM.previewInner.appendChild(p); DOM.btnExport.classList.remove('opacity-50', 'cursor-not-allowed');

    if (isSplitView) {
      const layerImagesBefore = this.createBeforeLayer(); layerImagesBefore.id = 'layer-images-before';
      layerImagesBefore.style.clipPath = `polygon(0 0, ${splitPos}% 0, ${splitPos}% 100%, 0 100%)`; layerImagesBefore.style.zIndex = '20'; p.appendChild(layerImagesBefore);
      const handle = document.createElement('div'); handle.id = 'split-handle'; handle.className = 'absolute top-0 bottom-0 cursor-ew-resize border-r-[3px] border-white shadow-[0_0_10px_rgba(0,0,0,0.5)]'; handle.style.zIndex = '60'; handle.style.left = `${splitPos}%`; handle.style.transform = 'translateX(-1.5px)';
      const handleCircle = document.createElement('div'); handleCircle.className = 'absolute top-1/2 left-1/2 w-7 h-7 bg-white rounded-full flex items-center justify-center shadow-lg transform -translate-x-1/2 -translate-y-1/2'; handleCircle.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="2"><path d="M13 5l7 7-7 7M11 5l-7 7 7 7"/></svg>`; handle.appendChild(handleCircle);
      handle.addEventListener('mousedown', (e) => { isDraggingSplit = true; e.preventDefault(); e.stopPropagation(); }); p.appendChild(handle);
    }

    redrawSlides(); applyZoom();
  },
  /** The raw, unedited comparison layer for Split View -- intentionally plain (no filter/border/grain/text), unlike the canvas-rendered "after" layer. */
  createBeforeLayer: function (): HTMLDivElement {
    const slides = (currentStrategy === 'seamless' || currentStrategy === 'triptych') ? parseInt(DOM.sSlides.value) : 1;
    const layer = document.createElement('div'); layer.className = 'preview-layer flex w-full h-full absolute inset-0';
    for (let i = 0; i < slides; i++) {
      const col = document.createElement('div'); col.className = 'flex flex-col flex-1 h-full relative';
      const sc = document.createElement('div'); sc.className = 'slide-container w-full h-full flex-1 relative shadow-inner border-[#111] last:border-r-0';
      if (currentStrategy === 'seamless' || currentStrategy === 'triptych') sc.style.borderRightWidth = '4px';
      sc.style.backgroundColor = '#000000';
      const iw = document.createElement('div'); iw.className = 'absolute overflow-hidden pointer-events-none preview-img-wrapper'; iw.style.width = '100%'; iw.style.height = '100%'; iw.style.left = '0'; iw.style.top = '0';
      const img = document.createElement('img'); img.src = proxyCropUrl!;
      if (currentStrategy === 'seamless' || currentStrategy === 'triptych') { img.className = 'preview-img absolute max-w-none h-full'; img.style.width = `${slides * 100}%`; img.style.transform = `translateX(-${(i / slides) * 100}%)`; } else { img.className = 'preview-img absolute w-full h-full object-cover'; }
      iw.appendChild(img); sc.appendChild(iw);
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
        setTimeout(async () => {
          hideLoading();
          if (isFirstLoad) { switchTab('frame'); await ModuleFrame.build(); } else { sourceImg = await loadImage(proxyCropUrl!); redrawSlides(); }
        }, 50);
      }, 50);
      return;
    }

    proxyCropUrl = baseProxyCropUrl;
    if (isFirstLoad) { switchTab('frame'); ModuleFrame.build(); } else { loadImage(proxyCropUrl!).then((img) => { sourceImg = img; redrawSlides(); }); }
  },
  updateCSSFilters: function () { redrawSlides(); },
};

function resetTone() { DOM.sHl.value = '0'; DOM.inHl.value = '0'; DOM.sSh.value = '0'; DOM.inSh.value = '0'; el<HTMLSelectElement>('select-lut').value = 'none'; ModuleColor.triggerEngine(); }
function resetColor() { DOM.sBr.value = '100'; DOM.inBr.value = '100'; DOM.sCo.value = '100'; DOM.inCo.value = '100'; DOM.sSa.value = '100'; DOM.inSa.value = '100'; DOM.sGrain.value = '0'; DOM.inGrain.value = '0'; ModuleColor.updateCSSFilters(); }

const ModuleTypo = {
  updateColorFromPicker: function () { textStylePreset = 'none'; document.querySelectorAll('.preset-pill').forEach(p => p.classList.remove('active')); redrawSlides(); },
  update: function () { redrawSlides(); },
  updatePositions: function () { redrawSlides(); },
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
  savedCustomPresets.push(preset); savePresets(savedCustomPresets);
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

function deletePreset(id: number) { savedCustomPresets = savedCustomPresets.filter(p => p.id !== id); savePresets(savedCustomPresets); renderPresetChips(); }

function setBG(elm: HTMLElement) { document.querySelectorAll('[data-bg]').forEach(b => b.classList.remove('active')); elm.classList.add('active'); bgColor = elm.dataset.bg!; document.querySelectorAll<HTMLElement>('.slide-container').forEach(sc => { if (!sc.closest('[style*="polygon"]')) { sc.style.backgroundColor = bgColor; } }); ModuleTypo.update(); }
function setMargin(val: boolean) { isMargin = val; el('btn-edge').classList.toggle('active', !val); el('btn-margin').classList.toggle('active', val); DOM.marginScaleWrapper.classList.toggle('hidden', !val); ModuleFrame.build(); }

function closeExportModal() {
  el('export-modal').classList.remove('show');
  setTimeout(() => { el('export-gallery-container').innerHTML = ''; }, 300);
}

DOM.btnExport.addEventListener('click', async () => {
  if (!originalImg) return alert('크롭 영역을 다시 확인해주세요.');

  const exportState = editState.get();
  const plane = getDesqueezedPlaneSize(originalImg, exportState.squeeze, exportState.rotation.base);
  const cropPxW = exportState.crop.width * plane.width;
  const cropPxH = exportState.crop.height * plane.height;
  if (cropPxW && cropPxH) {
    activeGlobalRatio = cropPxW / cropPxH;
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

    await new Promise(r => setTimeout(r, 50));
    let mCvs: HTMLCanvasElement = renderCroppedRegionFromOriginal(originalImg, exportState.squeeze, exportState.rotation.base, exportState.crop, targetW);

    const lutSelect = document.getElementById('select-lut') as HTMLSelectElement | null;
    const lutVal = (lutSelect ? lutSelect.value : 'none') as EditState['tone']['lut'];
    const hlVal = parseFloat(DOM.sHl.value); const shVal = parseFloat(DOM.sSh.value); const hasCustomLut = lutVal === 'custom' && !!Engine3D.lutData;
    const intensity = Number(el<HTMLInputElement>('slider-lut-intensity').value) / 100;

    // brightness/contrast/saturation + the kodak/fuji/cinematic CSS-emulated LUTs are baked into
    // the base composite via the same filterString the live preview uses (renderSlideBase below);
    // only the WebGL-only custom-LUT/highlight-shadow pass needs a separate pre-processing step here.
    if (hasCustomLut || hlVal !== 0 || shVal !== 0) {
      const hlF = 1.0 + (hlVal / 100.0); const shF = 1.0 + (shVal / 100.0);
      mCvs = await Engine3D.apply(mCvs, intensity, hlF, shF, hasCustomLut);
    }

    const filterString = currentToneFilterString();
    const gi = parseInt(DOM.sGrain.value);
    const frame = { bgColor, isMargin, marginScale: isMargin ? parseInt(DOM.sMarginScale.value) / 100 : 1, border: DOM.sBorder.value as BorderStyle, borderWeight: parseFloat(DOM.sBorderWeight.value) };

    const gCon = el('export-gallery-container'); gCon.innerHTML = ''; const fArr: File[] = []; let sBlb: Blob | null = null; const zip = new JSZip();

    const showAppLogo = DOM.toggleAppLogo ? DOM.toggleAppLogo.checked : false;
    const target = DOM.wmTarget ? DOM.wmTarget.value : 'all';
    const isSingle = currentStrategy === 'single';
    const isPanned = currentStrategy === 'seamless' || currentStrategy === 'triptych';
    const eH = mCvs.height;
    const sliceW = mCvs.width / slides;
    const fontSizePx = computeFontSizePx(eH, isSingle, Number(DOM.sFontScale.value));
    const glowPx = computeGlowPx(parseInt(DOM.sGlowAmt.value), fontSizePx);

    for (let i = 0; i < slides; i++) {
      updateLoadingText(`Encoding File ${i + 1} / ${slides}...`);
      await new Promise(r => setTimeout(r, 50));

      const finalSliceW = Math.floor(sliceW); const finalExportH = Math.floor(eH);
      const wCv = document.createElement('canvas'); wCv.width = finalSliceW; wCv.height = finalExportH;
      const ctx = wCv.getContext('2d')!; ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';

      renderSlideBase({
        ctx, width: finalSliceW, height: finalExportH, slideIndex: i, slidesCount: slides, isPanned,
        source: { image: mCvs, naturalWidth: mCvs.width, naturalHeight: mCvs.height },
        filterString, frame, grain: { tile: grainTile, amountPct: gi },
      });

      const txt = DOM.wmText.value.trim();
      const shouldShowTypo = isSingle || target === 'all' || parseInt(target) === i + 1;

      if (txt && shouldShowTypo) {
        drawWatermarkText({
          ctx, text: txt, x: finalSliceW * (tPosX / 100), y: finalExportH * (tPosY / 100),
          fontSizePx, fontFamily: DOM.fontSel.value, bold: isBold, preset: textStylePreset,
          plainColor: DOM.textColor.value, glow: isGlow, glowPx,
        });
      }

      if (logoObj && logoUrl && DOM.toggleLogo.checked && shouldShowTypo) {
        const logoWidth = finalSliceW * 0.2 * (Number(DOM.sLogoScale.value) / 100);
        drawLogo({
          ctx, image: logoObj, naturalWidth: logoObj.naturalWidth, naturalHeight: logoObj.naturalHeight,
          x: finalSliceW * (lPosX / 100), y: finalExportH * (lPosY / 100), width: logoWidth, opacityPct: Number(DOM.sLogoOp.value),
        });
      }

      if (showAppLogo) drawAppWatermark({ ctx, width: finalSliceW, height: finalExportH });

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
