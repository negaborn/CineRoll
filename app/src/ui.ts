// DOM wiring. EditState (state.ts) is the single source of truth for every
// edit setting; this file only:
//   1. writes it from control events            (controls -> state)
//   2. reflects it back into the controls       (state -> syncControls)
//   3. reacts to what changed                   (state -> react: Cropper, tone engine, redraw)
// Preview and export read settings exclusively from EditState -- never from
// the DOM. Non-setting runtime data (the decoded photo, logo image, LUT data,
// preview proxy URLs) and pure view state (tab, zoom, split view) live here.
import UTIF from 'utif';
import { editState, patchGroup, loadPresets, savePresets, installDebugHook, type EditState, type TextPresetRecord } from './state';
import { CropController, getCropFrameSize } from './crop';
import { buildToneFilterString, createGrainTile, Engine3D } from './compose';
import { renderSlideBase, computeFontSizePx, computeGlowPx, drawWatermarkText, drawLogo, drawAppWatermark } from './render';
import { runExport, packageAndDeliver, type ExportRequest, type ExportQuality } from './export';

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
  sLut: el<HTMLSelectElement>('select-lut'), sLutIntensity: el<HTMLInputElement>('slider-lut-intensity'), valLutIntensity: el<HTMLSpanElement>('val-lut-intensity'), lutWrap: el<HTMLDivElement>('lut-intensity-wrapper'),
  wmText: el<HTMLInputElement>('watermarkText'), fontSel: el<HTMLSelectElement>('fontSelect'), textColor: el<HTMLInputElement>('textColorPicker'),
  wmTarget: el<HTMLSelectElement>('watermarkTarget'),
  sGlowAmt: el<HTMLInputElement>('slider-glow-amount'), sFontScale: el<HTMLInputElement>('slider-fontScale'), inFontScale: el<HTMLInputElement>('in-fontScale'),
  btnBold: el<HTMLButtonElement>('btnBold'), btnGlow: el<HTMLButtonElement>('btnGlow'), btnGold: el<HTMLButtonElement>('btn-preset-gold'), btnSilver: el<HTMLButtonElement>('btn-preset-silver'),
  upLogo: el<HTMLInputElement>('uploadLogo'), logoSettings: el<HTMLDivElement>('logoSettings'), logoStatus: el<HTMLSpanElement>('logoStatus'), toggleLogo: el<HTMLInputElement>('toggle-logo'),
  sLogoScale: el<HTMLInputElement>('sliderLogoScale'), inLogoScale: el<HTMLInputElement>('in-logoScale'),
  sLogoOp: el<HTMLInputElement>('sliderLogoOp'), inLogoOp: el<HTMLInputElement>('in-logoOp'),
  btnExport: el<HTMLButtonElement>('btn-export'), badge: el<HTMLDivElement>('smart-snap-badge'),
  zoomControls: el<HTMLDivElement>('zoom-controls'), sliderZoom: el<HTMLInputElement>('slider-zoom'), inZoom: el<HTMLInputElement>('in-zoom'),
  btnEdge: el<HTMLButtonElement>('btn-edge'), btnMargin: el<HTMLButtonElement>('btn-margin'),
  marginScaleWrapper: el<HTMLDivElement>('margin-scale-wrapper'), sMarginScale: el<HTMLInputElement>('slider-margin-scale'), inMarginScale: el<HTMLInputElement>('in-margin-scale'),
  sBorder: el<HTMLSelectElement>('select-border'), sBorderWeight: el<HTMLInputElement>('slider-borderWeight'), inBorderWeight: el<HTMLInputElement>('in-borderWeight'), borderWeightWrapper: el<HTMLDivElement>('border-weight-wrapper'),
  exportQuality: el<HTMLSelectElement>('exportQuality'),
  seamlessWrapper: el<HTMLDivElement>('seamless-count-wrapper'),
  toggleAppLogo: el<HTMLInputElement>('toggleAppLogo'), presetList: el<HTMLDivElement>('custom-presets-container'),
};

// --- Runtime assets and view state (not edit settings) ---
let originalImg: HTMLImageElement | null = null;
let baseProxyCropUrl: string | null = null; // applied framing, before the WebGL tone pass
let proxyCropUrl: string | null = null; // applied framing, after the WebGL tone pass
let sourceImg: HTMLImageElement | null = null; // proxyCropUrl, decoded -- what the preview canvases draw
let logoObj: HTMLImageElement | null = null;
let logoUrl: string | null = null;
const grainTile = createGrainTile();
let activeGlobalRatio = 1;
let zoomMode = 'fit';
let activeTarget: 'text' | 'logo' | null = null;
let isCropperReady = false;
let isSplitView = false;
let splitPos = 50;
let savedCustomPresets: TextPresetRecord[] = [];

const S = () => editState.get();
const FRESH_CROP = { x: 0, y: 0, width: 0, height: 0 };
const isFreshCrop = (c: EditState['crop']) => c.width <= 0 || c.height <= 0;
const slideCount = (s: EditState) => (s.strategy === 'single' ? 1 : s.slides);
const isPannedStrategy = (s: EditState) => s.strategy === 'seamless' || s.strategy === 'triptych';
/** Target crop aspect for the current strategy (seamless pans across `slides` frames of baseRatio). */
const targetAspect = (s: EditState) => (s.baseRatio == null ? NaN : s.strategy === 'seamless' ? s.baseRatio * s.slides : s.baseRatio);
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

const cropCtrl = new CropController(DOM.main, {
  onSmartSnap: ({ label, box }) => {
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

// ============================================================================
// State -> controls
// ============================================================================

function setVal(control: HTMLInputElement | HTMLSelectElement, v: string) {
  if (control.value !== v) control.value = v;
}

function syncControls(s: EditState) {
  document.querySelectorAll<HTMLElement>('#strategy-btns .min-btn').forEach((b) => b.classList.toggle('active', b.dataset.val === s.strategy));
  DOM.seamlessWrapper.classList.toggle('disabled-block', s.strategy === 'single');
  setVal(DOM.sRatio, s.baseRatio == null ? 'NaN' : String(s.baseRatio));
  setVal(DOM.sSlides, String(s.slides));
  setVal(DOM.sSqueeze, String(s.squeeze));
  setVal(DOM.sAngle, String(s.rotation.fine)); setVal(DOM.inAngle, String(s.rotation.fine));

  document.querySelectorAll<HTMLElement>('[data-bg]').forEach((b) => b.classList.toggle('active', b.dataset.bg!.toLowerCase() === s.frame.bgColor.toLowerCase()));
  DOM.btnEdge.classList.toggle('active', !s.frame.margin);
  DOM.btnMargin.classList.toggle('active', s.frame.margin);
  DOM.marginScaleWrapper.classList.toggle('hidden', !s.frame.margin);
  const ms = String(Math.round(s.frame.marginScale * 100));
  setVal(DOM.sMarginScale, ms); setVal(DOM.inMarginScale, ms);
  setVal(DOM.sBorder, s.frame.border);
  DOM.borderWeightWrapper.classList.toggle('hidden', s.frame.border !== 'fineart');
  setVal(DOM.sBorderWeight, String(s.frame.borderWeight)); setVal(DOM.inBorderWeight, String(s.frame.borderWeight));

  setVal(DOM.sLut, s.tone.lut);
  setVal(DOM.sLutIntensity, String(s.tone.lutIntensity));
  DOM.valLutIntensity.innerText = `${s.tone.lutIntensity}%`;
  DOM.lutWrap.classList.toggle('opacity-50', s.tone.lut === 'none');
  DOM.lutWrap.classList.toggle('pointer-events-none', s.tone.lut === 'none');
  setVal(DOM.sHl, String(s.tone.highlights)); setVal(DOM.inHl, String(s.tone.highlights));
  setVal(DOM.sSh, String(s.tone.shadows)); setVal(DOM.inSh, String(s.tone.shadows));
  setVal(DOM.sBr, String(s.tone.brightness)); setVal(DOM.inBr, String(s.tone.brightness));
  setVal(DOM.sCo, String(s.tone.contrast)); setVal(DOM.inCo, String(s.tone.contrast));
  setVal(DOM.sSa, String(s.tone.saturation)); setVal(DOM.inSa, String(s.tone.saturation));
  setVal(DOM.sGrain, String(s.tone.grain)); setVal(DOM.inGrain, String(s.tone.grain));

  setVal(DOM.wmText, s.typo.text);
  setVal(DOM.fontSel, s.typo.font);
  setVal(DOM.textColor, s.typo.color);
  DOM.btnBold.classList.toggle('active', s.typo.bold);
  DOM.btnGlow.classList.toggle('active', s.typo.glow);
  DOM.btnGold.classList.toggle('active', s.typo.preset === 'gold');
  DOM.btnSilver.classList.toggle('active', s.typo.preset === 'silver');
  setVal(DOM.sGlowAmt, String(s.typo.glowAmount));
  setVal(DOM.sFontScale, String(s.typo.fontScale)); setVal(DOM.inFontScale, String(s.typo.fontScale));
  setVal(DOM.wmTarget, String(s.typo.target));

  DOM.toggleLogo.checked = s.logo.enabled;
  DOM.logoSettings.classList.toggle('opacity-30', !s.logo.enabled);
  DOM.logoSettings.classList.toggle('pointer-events-none', !s.logo.enabled);
  setVal(DOM.sLogoScale, String(s.logo.scale)); setVal(DOM.inLogoScale, String(s.logo.scale));
  setVal(DOM.sLogoOp, String(s.logo.opacity)); setVal(DOM.inLogoOp, String(s.logo.opacity));
  DOM.toggleAppLogo.checked = s.appWatermark;
}

// ============================================================================
// State -> side effects
// ============================================================================

/** Inputs of the WebGL tone pass (custom .cube LUT and highlight/shadow); CSS-only tone changes just redraw. */
function toneEngineKey(s: EditState): string {
  const custom = s.tone.lut === 'custom' && !!Engine3D.lutData;
  return JSON.stringify([custom, custom ? s.tone.lutIntensity : null, s.tone.highlights, s.tone.shadows, s.tone.customLutRev]);
}

function react(s: EditState, prev: EditState) {
  syncControls(s);
  if (!originalImg) return;

  // Framing view: only while the Cropper is on screen (Format tab).
  if (currentTab === 'format') {
    if (s.squeeze !== prev.squeeze || s.rotation.base !== prev.rotation.base) {
      // The proxy image has squeeze and base rotation baked in -> rebuild it (fade out first).
      DOM.main.classList.remove('opacity-100'); DOM.main.classList.add('opacity-0');
      trackMount(delay(s.squeeze !== prev.squeeze ? 300 : 0).then(() => remountCropper()));
    } else if (cropCtrl.isReady) {
      if (s.rotation.fine !== prev.rotation.fine) cropCtrl.syncFineAngle();
      if (isFreshCrop(s.crop) && !isFreshCrop(prev.crop)) cropCtrl.resetCropBox();
      else if (s.strategy !== prev.strategy || s.baseRatio !== prev.baseRatio || s.slides !== prev.slides) cropCtrl.retarget(targetAspect(s));
    }
  }

  if (toneEngineKey(s) !== toneEngineKey(prev)) {
    runToneEngine();
  } else if (s.frame !== prev.frame || s.tone !== prev.tone || s.typo !== prev.typo || s.logo !== prev.logo || s.appWatermark !== prev.appWatermark) {
    requestRedraw();
  }
}

editState.subscribe(react);

let redrawQueued = false;
/** Coalesces redraws to one per animation frame (drags and slider scrubs fire many state updates). */
function requestRedraw() {
  if (redrawQueued) return;
  redrawQueued = true;
  requestAnimationFrame(() => { redrawQueued = false; redrawSlides(); });
}

// ============================================================================
// Controls -> state
// ============================================================================

/**
 * Slider + companion number box. commitOn 'input' writes state while
 * scrubbing; 'change' only on release (for the expensive WebGL tone inputs),
 * with onScrub updating just the visible label/number meanwhile.
 */
function bindSlider(slider: HTMLInputElement, input: HTMLInputElement | null, commit: (v: number) => void, commitOn: 'input' | 'change' = 'input', onScrub?: (v: number) => void) {
  slider.addEventListener('input', () => {
    if (input) input.value = slider.value;
    onScrub?.(Number(slider.value));
    if (commitOn === 'input') commit(Number(slider.value));
  });
  if (commitOn === 'change') slider.addEventListener('change', () => commit(Number(slider.value)));
  input?.addEventListener('change', () => {
    let v = parseFloat(input.value);
    if (isNaN(v)) v = Number(slider.value);
    v = clamp(v, parseFloat(slider.min), parseFloat(slider.max));
    input.value = String(v); slider.value = String(v);
    commit(v);
  });
}

// Format
document.querySelectorAll<HTMLElement>('#strategy-btns .min-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const strategy = btn.dataset.val as EditState['strategy'];
    if (strategy === S().strategy) return; // re-tapping the active strategy keeps its ratio
    editState.update((s) => ({ ...s, strategy }));
    // Single opens in Free (Smart Snap) so the snap guides work without a trip
    // to the ratio menu. The box first takes the single-frame shape above (as
    // before), then only the ratio lock is released; a fixed ratio can still be picked.
    if (strategy === 'single') editState.update((s) => ({ ...s, baseRatio: null }));
  });
});
DOM.sRatio.addEventListener('change', () => { const v = parseFloat(DOM.sRatio.value); editState.update((s) => ({ ...s, baseRatio: isNaN(v) ? null : v })); });
DOM.sSlides.addEventListener('change', () => editState.update((s) => ({ ...s, slides: parseInt(DOM.sSlides.value) as EditState['slides'] })));
DOM.sSqueeze.addEventListener('change', () => editState.update((s) => ({ ...s, squeeze: parseInt(DOM.sSqueeze.value) as EditState['squeeze'] })));
bindSlider(DOM.sAngle, DOM.inAngle, (v) => editState.update((s) => ({ ...s, rotation: { ...s.rotation, fine: v } })));

function resetFraming() {
  editState.update((s) => ({
    ...s,
    baseRatio: isPannedStrategy(s) ? 0.8 : null,
    slides: isPannedStrategy(s) ? 3 : s.slides,
    squeeze: 100,
    rotation: { base: 0, fine: 0 },
    crop: FRESH_CROP,
  }));
}

// Frame
document.querySelectorAll<HTMLElement>('[data-bg]').forEach((btn) => btn.addEventListener('click', () => patchGroup('frame', { bgColor: btn.dataset.bg! })));
DOM.btnEdge.addEventListener('click', () => patchGroup('frame', { margin: false }));
DOM.btnMargin.addEventListener('click', () => patchGroup('frame', { margin: true }));
bindSlider(DOM.sMarginScale, DOM.inMarginScale, (v) => patchGroup('frame', { marginScale: v / 100 }));
DOM.sBorder.addEventListener('change', () => patchGroup('frame', { border: DOM.sBorder.value as EditState['frame']['border'] }));
bindSlider(DOM.sBorderWeight, DOM.inBorderWeight, (v) => patchGroup('frame', { borderWeight: v }));

// Color / tone
bindSlider(DOM.sBr, DOM.inBr, (v) => patchGroup('tone', { brightness: v }));
bindSlider(DOM.sCo, DOM.inCo, (v) => patchGroup('tone', { contrast: v }));
bindSlider(DOM.sSa, DOM.inSa, (v) => patchGroup('tone', { saturation: v }));
bindSlider(DOM.sGrain, DOM.inGrain, (v) => patchGroup('tone', { grain: v }));
bindSlider(DOM.sHl, DOM.inHl, (v) => patchGroup('tone', { highlights: v }), 'change');
bindSlider(DOM.sSh, DOM.inSh, (v) => patchGroup('tone', { shadows: v }), 'change');
bindSlider(DOM.sLutIntensity, null, (v) => patchGroup('tone', { lutIntensity: v }), 'change', (v) => { DOM.valLutIntensity.innerText = `${v}%`; });
DOM.sLut.addEventListener('change', () => patchGroup('tone', { lut: DOM.sLut.value as EditState['tone']['lut'] }));
el('btn-reset-tone').addEventListener('click', () => patchGroup('tone', { highlights: 0, shadows: 0, lut: 'none' }));
el('btn-reset-color').addEventListener('click', () => patchGroup('tone', { brightness: 100, contrast: 100, saturation: 100, grain: 0 }));
el('btn-upload-lut-trigger').addEventListener('click', () => el<HTMLInputElement>('uploadLut').click());
el<HTMLInputElement>('uploadLut').addEventListener('change', async (e) => {
  const file = (e.target as HTMLInputElement).files?.[0]; if (!file) return;
  showLoading('Parsing .CUBE 3D Matrix...');
  try {
    Engine3D.parseCube(await file.text());
    el('opt-custom-lut').classList.remove('hidden');
    editState.update((s) => ({ ...s, tone: { ...s.tone, lut: 'custom', customLutRev: s.tone.customLutRev + 1 } }));
  } catch (_err) {
    alert('LUT 파일을 읽는 중 오류가 발생했습니다.');
  } finally {
    if (!baseProxyCropUrl) hideLoading();
  }
});

// Typo
DOM.wmText.addEventListener('input', () => patchGroup('typo', { text: DOM.wmText.value }));
DOM.fontSel.addEventListener('change', () => patchGroup('typo', { font: DOM.fontSel.value }));
// Opening the color picker drops any gold/silver preset, as in v150.
DOM.textColor.addEventListener('click', () => patchGroup('typo', { preset: 'none' }));
DOM.textColor.addEventListener('input', () => patchGroup('typo', { color: DOM.textColor.value.toLowerCase(), preset: 'none' }));
DOM.btnBold.addEventListener('click', () => patchGroup('typo', { bold: !S().typo.bold }));
DOM.btnGlow.addEventListener('click', () => patchGroup('typo', { glow: !S().typo.glow }));
bindSlider(DOM.sGlowAmt, null, (v) => patchGroup('typo', { glowAmount: v }));
bindSlider(DOM.sFontScale, DOM.inFontScale, (v) => patchGroup('typo', { fontScale: v }));
DOM.wmTarget.addEventListener('change', () => patchGroup('typo', { target: (DOM.wmTarget.value === 'all' ? 'all' : parseInt(DOM.wmTarget.value)) as EditState['typo']['target'] }));
DOM.btnGold.addEventListener('click', () => patchGroup('typo', { preset: 'gold' }));
DOM.btnSilver.addEventListener('click', () => patchGroup('typo', { preset: 'silver' }));

// Logo / watermark
DOM.toggleLogo.addEventListener('change', () => {
  if (DOM.toggleLogo.checked && !logoUrl) {
    DOM.toggleLogo.checked = false; // no logo yet: open the picker instead
    DOM.upLogo.click();
    return;
  }
  patchGroup('logo', { enabled: DOM.toggleLogo.checked });
});
el('btn-upload-logo-trigger').addEventListener('click', () => DOM.upLogo.click());
DOM.upLogo.addEventListener('change', (e) => {
  const file = (e.target as HTMLInputElement).files?.[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = (event) => {
    const url = event.target!.result as string;
    const img = new Image();
    img.onload = () => {
      logoUrl = url; logoObj = img;
      DOM.logoStatus.classList.remove('hidden');
      // Force a redraw even if the logo was already enabled (the image itself changed).
      editState.update((s) => ({ ...s, logo: { ...s.logo, enabled: true } }));
    };
    img.src = url;
  };
  reader.readAsDataURL(file);
});
bindSlider(DOM.sLogoScale, DOM.inLogoScale, (v) => patchGroup('logo', { scale: v }));
bindSlider(DOM.sLogoOp, DOM.inLogoOp, (v) => patchGroup('logo', { opacity: v }));
DOM.toggleAppLogo.addEventListener('change', () => editState.update((s) => ({ ...s, appWatermark: DOM.toggleAppLogo.checked })));

// Presets
function saveCurrentPreset() {
  const t = S().typo;
  if (!t.text.trim() && !logoUrl) return alert('저장할 텍스트나 로고를 설정해주세요.');
  savedCustomPresets.push({ id: Date.now(), text: t.text.trim(), color: t.color, bold: t.bold, glow: t.glow, font: t.font, glowAmt: t.glowAmount, type: t.preset });
  savePresets(savedCustomPresets);
  const saveBtn = el('btn-save-preset');
  saveBtn.innerText = '✔️ Saved'; saveBtn.classList.add('text-green-400');
  setTimeout(() => { saveBtn.innerText = 'SAVE PRESET'; saveBtn.classList.remove('text-green-400'); }, 1000);
  renderPresetChips();
}

function loadPreset(p: TextPresetRecord) {
  patchGroup('typo', { text: p.text, color: p.color.toLowerCase(), bold: p.bold, glow: p.glow, font: p.font, glowAmount: Number(p.glowAmt) || 15, preset: p.type });
}

function deletePreset(id: number) {
  savedCustomPresets = savedCustomPresets.filter((p) => p.id !== id);
  savePresets(savedCustomPresets);
  renderPresetChips();
}

function renderPresetChips() {
  DOM.presetList.innerHTML = '';
  savedCustomPresets.forEach((p) => {
    const chip = document.createElement('div'); chip.className = 'preset-chip flex items-center bg-[#18181b] border border-border rounded text-[9px] text-zinc-400 cursor-pointer hover:border-coral-500/50 transition-colors font-bold tracking-wide';
    const nameBtn = document.createElement('div'); nameBtn.className = 'px-3 py-1.5 truncate max-w-[100px]'; nameBtn.innerText = p.text ? p.text : 'Preset'; nameBtn.onclick = () => loadPreset(p);
    const delBtn = document.createElement('div'); delBtn.className = 'px-2 py-1.5 border-l border-border hover:bg-coral-500 hover:text-white transition-colors'; delBtn.innerText = '✕'; delBtn.onclick = (e) => { e.stopPropagation(); deletePreset(p.id); };
    chip.appendChild(nameBtn); chip.appendChild(delBtn); DOM.presetList.appendChild(chip);
  });
}
el('btn-save-preset').addEventListener('click', saveCurrentPreset);

// ============================================================================
// Zoom, zen, split view (view state only)
// ============================================================================

function applyZoom() {
  const parentWrap = document.getElementById('preview-wrapper-parent');
  if (!parentWrap) return;
  const isMobile = window.innerWidth < 768;
  const padX = isMobile ? 32 : 64; const padY = isMobile ? 120 : 128;
  const parentW = DOM.previewArea.clientWidth - padX; const parentH = DOM.previewArea.clientHeight - padY;
  if (parentW <= 0 || parentH <= 0) return;
  const fitH = Math.min(parentH, parentW / activeGlobalRatio);
  const h = zoomMode === 'fit' ? fitH : fitH * (Number(DOM.sliderZoom.value) / 100);
  parentWrap.style.height = h + 'px';
  parentWrap.style.width = (h * activeGlobalRatio) + 'px';
  if (zoomMode === 'fit') { DOM.inZoom.value = '100'; DOM.sliderZoom.value = '100'; } else { DOM.inZoom.value = DOM.sliderZoom.value; }
  redrawSlides();
}

function setZoom(mode: string) { zoomMode = mode; if (mode === 'fit') { DOM.sliderZoom.value = '100'; DOM.inZoom.value = '100'; } applyZoom(); }
window.addEventListener('resize', () => { if (zoomMode === 'fit') applyZoom(); });
DOM.sliderZoom.addEventListener('input', () => { zoomMode = 'custom'; DOM.inZoom.value = DOM.sliderZoom.value; applyZoom(); });
DOM.sliderZoom.addEventListener('touchmove', () => { zoomMode = 'custom'; DOM.inZoom.value = DOM.sliderZoom.value; applyZoom(); }, { passive: true });
DOM.inZoom.addEventListener('change', () => { zoomMode = 'custom'; DOM.sliderZoom.value = DOM.inZoom.value; applyZoom(); });

function toggleSplitView() {
  isSplitView = !isSplitView;
  DOM.btnBA.classList.toggle('bg-zinc-800', isSplitView);
  DOM.btnBA.classList.toggle('text-white', isSplitView);
  ModuleFrame.build();
}

let zenTimeout: ReturnType<typeof setTimeout> | undefined;
function flashExitZen(btn: HTMLElement) {
  btn.classList.remove('opacity-0'); btn.classList.add('opacity-100');
  clearTimeout(zenTimeout);
  zenTimeout = setTimeout(() => { btn.classList.remove('opacity-100'); btn.classList.add('opacity-0'); }, 2000);
}

function toggleZenMode() {
  if (!proxyCropUrl) return;
  document.body.classList.toggle('zen-mode');
  const isZen = document.body.classList.contains('zen-mode');
  const exitBtn = el('btn-exit-zen');
  if (isZen) { exitBtn.classList.remove('hidden'); exitBtn.classList.add('flex'); flashExitZen(exitBtn); }
  else { exitBtn.classList.add('hidden'); exitBtn.classList.remove('flex'); }
  setTimeout(() => applyZoom(), 100);
}

window.addEventListener('mousemove', () => { if (document.body.classList.contains('zen-mode')) flashExitZen(el('btn-exit-zen')); });

let isDraggingSplit = false;
window.addEventListener('mousemove', (e) => {
  if (!isDraggingSplit || !isSplitView) return;
  e.preventDefault();
  const parentWrapper = document.getElementById('preview-wrapper-parent');
  const layerImagesBefore = document.getElementById('layer-images-before');
  const handle = document.getElementById('split-handle');
  if (!parentWrapper || !layerImagesBefore || !handle) return;
  const rect = parentWrapper.getBoundingClientRect();
  splitPos = clamp(((e.clientX - rect.left) / rect.width) * 100, 0, 100);
  layerImagesBefore.style.clipPath = `polygon(0 0, ${splitPos}% 0, ${splitPos}% 100%, 0 100%)`;
  handle.style.left = `${splitPos}%`;
});
window.addEventListener('mouseup', () => { isDraggingSplit = false; });

// ============================================================================
// Caption/logo positioning (drag + arrow keys write typo.pos / logo.pos)
// ============================================================================

function moveTarget(target: 'text' | 'logo', x: number, y: number) {
  if (target === 'text') patchGroup('typo', { pos: { x, y } });
  else patchGroup('logo', { pos: { x, y } });
}

document.addEventListener('keydown', (e) => {
  const isInput = ['INPUT', 'TEXTAREA'].includes((e.target as HTMLElement).tagName);
  if (e.key.toLowerCase() === 'f' && !isInput) { e.preventDefault(); toggleZenMode(); }
  if (e.key === 'Escape' && document.body.classList.contains('zen-mode')) { toggleZenMode(); }
  if (e.key === 'Enter' && !isInput && (e.target as HTMLElement).tagName !== 'BUTTON') {
    if (currentTab === 'format' && cropCtrl.isReady && isCropperReady) { e.preventDefault(); applyCropAndRender(); }
  }
  if (activeTarget && !isInput) {
    const step = 0.5;
    const pos = activeTarget === 'text' ? S().typo.pos : S().logo.pos;
    const d: Record<string, [number, number]> = { ArrowUp: [0, -step], ArrowDown: [0, step], ArrowLeft: [-step, 0], ArrowRight: [step, 0] };
    if (d[e.key]) { e.preventDefault(); moveTarget(activeTarget, pos.x + d[e.key][0], pos.y + d[e.key][1]); }
  }
});

const DragState: { active: boolean; target: 'text' | 'logo' | null; container: HTMLElement | null; gx: HTMLElement | null; gy: HTMLElement | null } =
  { active: false, target: null, container: null, gx: null, gy: null };

function initGlobalDrag() {
  function startDrag(type: 'text' | 'logo', elm: HTMLElement) {
    DragState.active = true; DragState.target = type; activeTarget = type;
    DragState.container = elm.parentElement;
    if (DragState.container) { DragState.gx = DragState.container.querySelector('.snap-guide-x'); DragState.gy = DragState.container.querySelector('.snap-guide-y'); }
    document.querySelectorAll('.draggable-text, .draggable-logo').forEach((n) => n.classList.remove('is-active-target'));
    elm.classList.add('is-active-target');
    elm.focus();
  }
  const pick = (t: HTMLElement) => ({ te: t.closest('.draggable-text') as HTMLElement | null, le: t.closest('.draggable-logo') as HTMLElement | null });

  window.addEventListener('mousedown', (e) => {
    const target = e.target as HTMLElement; const { te, le } = pick(target);
    if (te) startDrag('text', te);
    else if (le) startDrag('logo', le);
    else if (target.closest('#preview-wrapper-parent')) {
      activeTarget = null;
      document.querySelectorAll('.draggable-text, .draggable-logo').forEach((n) => n.classList.remove('is-active-target'));
    }
  });
  window.addEventListener('touchstart', (e) => { const { te, le } = pick(e.target as HTMLElement); if (te) startDrag('text', te); else if (le) startDrag('logo', le); }, { passive: false });

  function moveDrag(e: MouseEvent | TouchEvent) {
    if (!DragState.active || !DragState.container || !DragState.target) return;
    e.preventDefault();
    const rect = DragState.container.getBoundingClientRect();
    const point = 'touches' in e ? e.touches[0] : e;
    let px = clamp(((point.clientX - rect.left) / rect.width) * 100, 0, 100);
    let py = clamp(((point.clientY - rect.top) / rect.height) * 100, 0, 100);
    const snap = 2.5; let sx = false, sy = false;
    if (Math.abs(px - 50) < snap) { px = 50; sx = true; }
    if (Math.abs(py - 50) < snap) { py = 50; sy = true; }
    if (Math.abs(py - 94) < snap) { py = 94; sy = true; }
    moveTarget(DragState.target, px, py);
    if (DragState.gx) { DragState.gx.style.display = sy ? 'block' : 'none'; DragState.gx.style.top = `${py}%`; }
    if (DragState.gy) { DragState.gy.style.display = sx ? 'block' : 'none'; DragState.gy.style.left = `${px}%`; }
  }
  window.addEventListener('mousemove', moveDrag);
  window.addEventListener('touchmove', moveDrag, { passive: false });

  function endDrag() { DragState.active = false; if (DragState.gx) DragState.gx.style.display = 'none'; if (DragState.gy) DragState.gy.style.display = 'none'; }
  window.addEventListener('mouseup', endDrag); window.addEventListener('touchend', endDrag);
}

// ============================================================================
// Loading overlay
// ============================================================================

const updateLoadingText = (text: string) => { el('loading-text').innerText = text; };
const showLoading = (msg: string) => { updateLoadingText(msg); el('loading-overlay').classList.remove('hidden'); el('loading-overlay').classList.add('flex'); };
const hideLoading = () => { el('loading-overlay').classList.add('hidden'); el('loading-overlay').classList.remove('flex'); };

// ============================================================================
// Framing apply: leaving the Format tab always applies the current framing
// ============================================================================

let currentTab = 'format';
let switchSeq = 0;
/** The latest in-flight Cropper (re)build, if any -- a capture must wait for it or it reads a stale/half-built Cropper. */
let pendingMount: Promise<void> | null = null;
/** Framing key at the last capture; null until something has been applied for the current photo. */
let lastAppliedKey: string | null = null;

function trackMount(p: Promise<void>): Promise<void> {
  pendingMount = p;
  p.finally(() => { if (pendingMount === p) pendingMount = null; });
  return p;
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Everything that changes what the crop produces. Rounded so float drift from Cropper's setData/getData round-trip isn't mistaken for an edit. */
function framingKey(s: EditState = S()): string {
  const r = (n: number) => Math.round(n * 1e4) / 1e4;
  return JSON.stringify([r(s.crop.x), r(s.crop.y), r(s.crop.width), r(s.crop.height), s.rotation.base, s.rotation.fine, s.squeeze, s.strategy, s.baseRatio, s.slides]);
}

/** Snapshots the live Cropper's framing as the preview source. False if there is no valid crop to take. */
function captureFraming(): boolean {
  if (!cropCtrl.isReady || !isCropperReady) return false;
  DOM.badge.classList.add('opacity-0');
  const cvs = cropCtrl.getCroppedCanvas({ maxWidth: 2560, maxHeight: 2560, fillColor: 'transparent', imageSmoothingEnabled: true, imageSmoothingQuality: 'high' });
  if (!cvs || cvs.width === 0 || cvs.height === 0) { alert('크롭 영역을 다시 지정해주세요.'); return false; }
  activeGlobalRatio = cvs.width / cvs.height;
  baseProxyCropUrl = cvs.toDataURL('image/png');
  cvs.width = 0; cvs.height = 0;
  lastAppliedKey = framingKey();
  return true;
}

function showPreview() {
  DOM.previewArea.classList.remove('hidden'); DOM.zoomControls.classList.remove('hidden'); DOM.zoomControls.classList.add('flex');
  DOM.btnBA.style.display = 'flex'; DOM.btnZen.style.display = 'flex';
  applyZoom();
}

async function switchTab(target: string) {
  const seq = ++switchSeq;
  let reframed = false;
  if (target !== 'format' && currentTab === 'format' && originalImg) {
    if (pendingMount) await pendingMount;
    if (seq !== switchSeq) return; // a newer tab click superseded this one while we waited
    if (framingKey() !== lastAppliedKey) {
      if (!captureFraming()) return; // stay on Format so the crop can be fixed
      reframed = true;
    }
  }
  currentTab = target;

  document.querySelectorAll<HTMLElement>('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === target));
  document.querySelectorAll('.tab-content').forEach((c) => c.classList.add('hidden'));
  el(`tab-${target}`).classList.remove('hidden');

  if (target === 'format') {
    DOM.previewArea.classList.add('hidden'); DOM.zoomControls.classList.add('hidden'); DOM.btnBA.style.display = 'none'; DOM.btnZen.style.display = 'none';
    DOM.main.classList.remove('hidden'); DOM.main.style.display = 'block'; void DOM.main.offsetWidth;
    if (originalImg && !cropCtrl.isReady && !pendingMount) trackMount(delay(50).then(() => remountCropper()));
    else if (cropCtrl.isReady) setTimeout(() => { DOM.main.classList.add('opacity-100'); cropCtrl.resize(); }, 50);
  } else {
    cropCtrl.destroy(); isCropperReady = false;
    DOM.main.classList.remove('opacity-100'); DOM.main.style.display = 'none';
    if (reframed) { showPreview(); runToneEngine({ rebuild: true }); }
    else if (proxyCropUrl) showPreview();
  }
}

document.querySelectorAll<HTMLElement>('.tab-btn').forEach((btn) => btn.addEventListener('click', () => switchTab(btn.dataset.tab!)));

async function remountCropper() {
  if (!originalImg) return;
  isCropperReady = false;
  const mounted = await cropCtrl.mount(originalImg, S().squeeze);
  if (!mounted) return; // superseded by a newer rebuild or by leaving the Format tab
  isCropperReady = true;
  DOM.main.classList.remove('opacity-0'); DOM.main.classList.add('opacity-100');
}

/** "Apply Crop" is simply leaving Format for Frame -- the tab switch does the applying. */
function applyCropAndRender() {
  switchTab('frame');
}

// ============================================================================
// Photo intake
// ============================================================================

['dragenter', 'dragover', 'dragleave', 'drop'].forEach((eName) => { DOM.mainStage.addEventListener(eName, (e) => { e.preventDefault(); e.stopPropagation(); }, false); });
DOM.mainStage.addEventListener('drop', (e) => { const dt = (e as DragEvent).dataTransfer; if (dt?.files.length) handleFile(dt.files[0]); });
DOM.upInput.addEventListener('change', () => { if (DOM.upInput.files?.length) { handleFile(DOM.upInput.files[0]); DOM.upInput.value = ''; } });

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image decode failed'));
    img.src = url;
  });
}

async function decodePhoto(file: File): Promise<HTMLImageElement> {
  if (!file.name.match(/\.tiff?$/i)) return loadImage(URL.createObjectURL(file));
  const arrayBuffer = await file.arrayBuffer();
  const ifds = UTIF.decode(arrayBuffer); UTIF.decodeImage(arrayBuffer, ifds[0]);
  const rgba = UTIF.toRGBA8(ifds[0]);
  const cvs = document.createElement('canvas'); cvs.width = ifds[0].width; cvs.height = ifds[0].height;
  cvs.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer as ArrayBuffer), cvs.width, cvs.height), 0, 0);
  const url = cvs.toDataURL('image/jpeg', 0.95);
  cvs.width = 0; cvs.height = 0;
  return loadImage(url);
}

/** Apple's proprietary "auxiliary rotation" (gyro-derived orientation) marker.
 *  Only Apple's own software honors it; standard EXIF-orientation decoders
 *  (this app included) can't read it, so a photo carrying it may render
 *  upside-down/sideways even though its plain EXIF Orientation tag looks fine. */
async function hasAppleAuxRotation(file: File): Promise<boolean> {
  if (!/^image\/(jpe?g|heic|heif)$/i.test(file.type) && !file.name.match(/\.(jpe?g|heic|heif)$/i)) return false;
  const buf = new Uint8Array(await file.slice(0, 262144).arrayBuffer());
  const needle = [0x41, 0x52, 0x4f, 0x54]; // 'AROT'
  outer: for (let i = 0; i < buf.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (buf[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

function showOrientationWarning() {
  let el = document.getElementById('orientation-warning');
  if (!el) {
    el = document.createElement('div');
    el.id = 'orientation-warning';
    el.className = 'text-[10px] text-amber-400 bg-amber-400/10 border border-amber-400/30 rounded px-2 py-1.5 mb-2 leading-snug';
    el.textContent = '⚠ 이 사진은 아이폰 메타데이터 특성상 방향이 부정확하게 표시될 수 있습니다. 뒤집혀 보이면 아래 90°/180° 버튼으로 보정하세요.';
    const anchor = document.getElementById('btn-rotate-90')?.parentElement;
    anchor?.parentElement?.insertBefore(el, anchor);
  }
  el.classList.remove('hidden');
}
function hideOrientationWarning() {
  document.getElementById('orientation-warning')?.classList.add('hidden');
}

async function handleFile(file: File) {
  if (!file) return;
  const validExts = /\.(jpe?g|png|tiff?|webp|gif|rw2|cr2|cr3|nef|arw|dng)$/i;
  if (!file.type.startsWith('image/') && !file.name.match(validExts)) { alert('지원하지 않는 이미지 형식입니다.'); return; }
  DOM.upText.innerText = 'Processing...';
  let img: HTMLImageElement;
  try { img = await decodePhoto(file); } catch (_err) { alert('이미지 처리 오류.'); DOM.upText.innerText = 'Import Resource'; return; }
  if (await hasAppleAuxRotation(file)) showOrientationWarning(); else hideOrientationWarning();

  // A new photo replaces everything tied to the old one -- including a Cropper
  // that may still be mounted (a second photo dropped onto the Format tab).
  cropCtrl.destroy(); isCropperReady = false;
  pendingMount = null; // destroy() already cancelled any in-flight mount of the old photo
  originalImg = img;
  baseProxyCropUrl = null; proxyCropUrl = null; sourceImg = null; lastAppliedKey = null;
  DOM.previewInner.innerHTML = '';
  DOM.upZone.classList.add('hidden');
  editState.update((s) => ({ ...s, rotation: { base: 0, fine: 0 }, crop: FRESH_CROP }));
  await switchTab('format'); // mounts the Cropper for the new photo
}

// ============================================================================
// Preview rendering (reads EditState only)
// ============================================================================

/** Redraws every visible slide's canvas (background/image/border/grain/text/logo/watermark) from EditState, without touching DOM structure. */
function redrawSlides() {
  if (!sourceImg) return;
  const pW = document.getElementById('preview-wrapper-parent'); if (!pW) return;
  const s = S();
  const slides = slideCount(s);
  const isSingle = s.strategy === 'single';
  const filterString = buildToneFilterString(s.tone);
  const dpr = window.devicePixelRatio || 1;

  const cssH = pW.clientHeight;
  const cssW = pW.clientWidth / slides;
  const fontSizePx = computeFontSizePx(cssH, isSingle, s.typo.fontScale);
  const glowPx = computeGlowPx(s.typo.glowAmount, fontSizePx);
  const text = s.typo.text.trim();
  const uiLogoWidth = cssW * (s.logo.scale / 100) * 0.2;
  const frame = { bgColor: s.frame.bgColor, isMargin: s.frame.margin, marginScale: s.frame.margin ? s.frame.marginScale : 1, border: s.frame.border, borderWeight: s.frame.borderWeight };

  document.querySelectorAll<HTMLCanvasElement>('.preview-slide-canvas').forEach((canvas) => {
    const i = Number(canvas.dataset.slideIndex);
    canvas.width = Math.max(1, Math.round(cssW * dpr));
    canvas.height = Math.max(1, Math.round(cssH * dpr));
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    renderSlideBase({
      ctx, width: cssW, height: cssH, slideIndex: i, slidesCount: slides, isPanned: isPannedStrategy(s),
      source: { image: sourceImg!, naturalWidth: sourceImg!.naturalWidth, naturalHeight: sourceImg!.naturalHeight },
      filterString, frame, grain: { tile: grainTile, amountPct: s.tone.grain },
    });

    const shouldShow = isSingle || s.typo.target === 'all' || s.typo.target === i + 1;
    if (text && shouldShow) {
      drawWatermarkText({
        ctx, text, x: cssW * (s.typo.pos.x / 100), y: cssH * (s.typo.pos.y / 100),
        fontSizePx, fontFamily: s.typo.font, bold: s.typo.bold, preset: s.typo.preset,
        plainColor: s.typo.color, glow: s.typo.glow, glowPx,
      });
    }
    if (logoObj && s.logo.enabled && shouldShow) {
      drawLogo({
        ctx, image: logoObj, naturalWidth: logoObj.naturalWidth, naturalHeight: logoObj.naturalHeight,
        x: cssW * (s.logo.pos.x / 100), y: cssH * (s.logo.pos.y / 100), width: uiLogoWidth, opacityPct: s.logo.opacity,
      });
    }
    if (s.appWatermark) drawAppWatermark({ ctx, width: cssW, height: cssH });
  });

  updateDragHitTargets(s, fontSizePx, uiLogoWidth);

  // Canvas text, unlike DOM text, doesn't reflow when a web font arrives: if the
  // caption's font isn't loaded yet, request it -- 'loadingdone' repaints once it lands.
  if (text) {
    const spec = `${s.typo.bold ? 'bold ' : ''}${Math.max(1, fontSizePx)}px '${s.typo.font}'`;
    if (!document.fonts.check(spec)) document.fonts.load(spec).catch(() => {});
  }
}

document.fonts.addEventListener('loadingdone', () => requestRedraw());

/** Keeps the invisible drag hit-target overlays (text/logo pointer interaction) in sync with what redrawSlides() just painted. */
function updateDragHitTargets(s: EditState, fontSizePx: number, uiLogoWidth: number) {
  const text = s.typo.text.trim();
  for (let i = 1; i <= slideCount(s); i++) {
    const pane = document.getElementById(`glass-pane-${i}`); if (!pane) continue;
    const shouldShow = s.strategy === 'single' || s.typo.target === 'all' || s.typo.target === i;

    let te = pane.querySelector<HTMLElement>('.draggable-text');
    if (text && shouldShow) {
      if (!te) { te = document.createElement('div'); te.className = 'draggable-text'; te.tabIndex = 0; pane.appendChild(te); }
      te.style.left = `${s.typo.pos.x}%`; te.style.top = `${s.typo.pos.y}%`; te.style.display = 'flex';
      const span = document.createElement('span');
      span.style.cssText = `visibility:hidden; display:inline-block; font-family:'${s.typo.font}', sans-serif; font-size:${fontSizePx}px; ${s.typo.bold ? 'font-weight:700;' : ''} letter-spacing:0.1em;`;
      span.textContent = text;
      te.replaceChildren(span);
    } else if (te) { te.style.display = 'none'; }

    let le = pane.querySelector<HTMLElement>('.draggable-logo');
    if (logoObj && logoUrl && s.logo.enabled && shouldShow) {
      if (!le) { le = document.createElement('div'); le.className = 'draggable-logo'; le.tabIndex = 0; pane.appendChild(le); }
      le.style.left = `${s.logo.pos.x}%`; le.style.top = `${s.logo.pos.y}%`; le.style.display = 'flex';
      le.innerHTML = `<img src="${logoUrl}" style="opacity:0; width:${uiLogoWidth}px; min-width:${uiLogoWidth}px; pointer-events:none; max-width:none !important; flex-shrink:0;">`;
    } else if (le) { le.style.display = 'none'; }
  }
}

const ModuleFrame = {
  /** Rebuilds the preview's slide layout (count/strategy) around the applied framing, then redraws. */
  build: async function () {
    if (!proxyCropUrl) return;
    sourceImg = await loadImage(proxyCropUrl);
    const s = S();
    const slides = slideCount(s);
    const panned = isPannedStrategy(s);

    DOM.previewInner.innerHTML = '';
    const p = document.createElement('div'); p.id = 'preview-wrapper-parent'; p.className = 'flex relative m-auto'; p.style.aspectRatio = String(activeGlobalRatio); p.style.flexShrink = '0'; p.style.boxShadow = '0 40px 100px rgba(0,0,0,0.95)';

    const afterLayer = document.createElement('div'); afterLayer.className = 'preview-layer flex w-full h-full absolute inset-0'; afterLayer.id = 'layer-images-after';
    for (let i = 0; i < slides; i++) {
      const col = document.createElement('div'); col.className = 'flex flex-col flex-1 h-full relative';
      const sc = document.createElement('div'); sc.className = 'slide-container w-full h-full flex-1 relative shadow-inner border-[#111] last:border-r-0';
      if (panned) sc.style.borderRightWidth = '4px';
      const canvas = document.createElement('canvas'); canvas.className = 'preview-slide-canvas absolute inset-0 w-full h-full'; canvas.dataset.slideIndex = String(i);
      sc.appendChild(canvas); col.appendChild(sc); afterLayer.appendChild(col);
    }
    p.appendChild(afterLayer);

    const lg = document.createElement('div'); lg.className = 'layer-glass absolute inset-0 flex z-50 pointer-events-none';
    for (let i = 0; i < slides; i++) {
      const gp = document.createElement('div'); gp.className = 'flex-1 relative h-full pointer-events-none overflow-hidden'; gp.id = `glass-pane-${i + 1}`;
      gp.innerHTML = `<div class="snap-guide snap-guide-x hidden"></div><div class="snap-guide snap-guide-y hidden"></div>`; lg.appendChild(gp);
    }
    p.appendChild(lg); DOM.previewInner.appendChild(p); DOM.btnExport.classList.remove('opacity-50', 'cursor-not-allowed');

    if (isSplitView) {
      const before = this.createBeforeLayer(slides, panned); before.id = 'layer-images-before';
      before.style.clipPath = `polygon(0 0, ${splitPos}% 0, ${splitPos}% 100%, 0 100%)`; before.style.zIndex = '20'; p.appendChild(before);
      const handle = document.createElement('div'); handle.id = 'split-handle'; handle.className = 'absolute top-0 bottom-0 cursor-ew-resize border-r-[3px] border-white shadow-[0_0_10px_rgba(0,0,0,0.5)]'; handle.style.zIndex = '60'; handle.style.left = `${splitPos}%`; handle.style.transform = 'translateX(-1.5px)';
      const handleCircle = document.createElement('div'); handleCircle.className = 'absolute top-1/2 left-1/2 w-7 h-7 bg-white rounded-full flex items-center justify-center shadow-lg transform -translate-x-1/2 -translate-y-1/2'; handleCircle.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="2"><path d="M13 5l7 7-7 7M11 5l-7 7 7 7"/></svg>`; handle.appendChild(handleCircle);
      handle.addEventListener('mousedown', (e) => { isDraggingSplit = true; e.preventDefault(); e.stopPropagation(); }); p.appendChild(handle);
    }

    redrawSlides(); applyZoom();
  },
  /** The raw, unedited comparison layer for Split View -- intentionally plain (no filter/border/grain/text). */
  createBeforeLayer: function (slides: number, panned: boolean): HTMLDivElement {
    const layer = document.createElement('div'); layer.className = 'preview-layer flex w-full h-full absolute inset-0';
    for (let i = 0; i < slides; i++) {
      const col = document.createElement('div'); col.className = 'flex flex-col flex-1 h-full relative';
      const sc = document.createElement('div'); sc.className = 'slide-container w-full h-full flex-1 relative shadow-inner border-[#111] last:border-r-0';
      if (panned) sc.style.borderRightWidth = '4px';
      sc.style.backgroundColor = '#000000';
      const iw = document.createElement('div'); iw.className = 'absolute overflow-hidden pointer-events-none preview-img-wrapper'; iw.style.cssText += 'width:100%;height:100%;left:0;top:0;';
      const img = document.createElement('img'); img.src = proxyCropUrl!;
      if (panned) { img.className = 'preview-img absolute max-w-none h-full'; img.style.width = `${slides * 100}%`; img.style.transform = `translateX(-${(i / slides) * 100}%)`; } else { img.className = 'preview-img absolute w-full h-full object-cover'; }
      iw.appendChild(img); sc.appendChild(iw); col.appendChild(sc); layer.appendChild(col);
    }
    return layer;
  },
};

// ============================================================================
// WebGL tone pass (custom LUT + highlights/shadows) on the applied framing
// ============================================================================

let toneSeq = 0;
let rebuildRequested = false;

/**
 * Re-runs the tone pass on the applied framing, then redraws (or rebuilds the
 * layout if requested). Each run takes a sequence number; a run superseded by
 * a newer one abandons itself, so a slow older pass can never overwrite the
 * result of a newer one. A requested rebuild survives being superseded.
 */
function runToneEngine(opts: { rebuild?: boolean } = {}) {
  const seq = ++toneSeq;
  rebuildRequested = rebuildRequested || !!opts.rebuild;
  if (!baseProxyCropUrl) { hideLoading(); return; } // nothing applied yet -- takes effect on the first apply
  const s = S();
  const hasCustomLut = s.tone.lut === 'custom' && !!Engine3D.lutData;
  const needsGl = hasCustomLut || s.tone.highlights !== 0 || s.tone.shadows !== 0;
  const base = baseProxyCropUrl;

  const finish = async () => {
    if (seq !== toneSeq) return;
    const rebuild = rebuildRequested;
    rebuildRequested = false;
    if (rebuild) {
      await ModuleFrame.build();
      if (currentTab !== 'format') showPreview();
    } else {
      sourceImg = await loadImage(proxyCropUrl!);
      if (seq === toneSeq) redrawSlides();
    }
  };

  if (!needsGl) {
    hideLoading();
    proxyCropUrl = base;
    finish();
    return;
  }

  showLoading('Rendering Core Tone...');
  setTimeout(async () => {
    if (seq !== toneSeq) return;
    const img = await loadImage(base);
    if (seq !== toneSeq) return;
    const cvs = document.createElement('canvas'); cvs.width = img.width; cvs.height = img.height;
    cvs.getContext('2d')!.drawImage(img, 0, 0);
    const processed = await Engine3D.apply(cvs, s.tone.lutIntensity / 100, 1 + s.tone.highlights / 100, 1 + s.tone.shadows / 100, hasCustomLut);
    if (seq !== toneSeq) return;
    proxyCropUrl = processed.toDataURL('image/jpeg', 0.95);
    setTimeout(async () => { if (seq === toneSeq) hideLoading(); await finish(); }, 50);
  }, 50);
}

// ============================================================================
// Export (reads EditState only)
// ============================================================================

function closeExportModal() {
  el('export-modal').classList.remove('show');
  setTimeout(() => { el('export-gallery-container').innerHTML = ''; }, 300);
}

DOM.btnExport.addEventListener('click', async () => {
  if (!originalImg) return alert('크롭 영역을 다시 확인해주세요.');
  const s = S();
  const frame = getCropFrameSize(originalImg, s.squeeze, s.rotation.base, s.rotation.fine);
  const cropPxW = s.crop.width * frame.width;
  const cropPxH = s.crop.height * frame.height;
  if (cropPxW && cropPxH) activeGlobalRatio = cropPxW / cropPxH;

  DOM.btnExport.classList.add('opacity-70', 'pointer-events-none'); showLoading('Rendering High-Res...');
  try {
    await document.fonts.ready;
    const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) || window.innerWidth < 768;
    const request: ExportRequest = {
      originalImg,
      squeeze: s.squeeze,
      baseRotation: s.rotation.base,
      fineRotation: s.rotation.fine,
      crop: s.crop,
      strategy: s.strategy,
      slides: slideCount(s),
      qualityMode: DOM.exportQuality.value as ExportQuality, // an output option, not an edit setting
      isMobile,
      tone: { ...s.tone, hasCustomLut: s.tone.lut === 'custom' && !!Engine3D.lutData },
      frame: { bgColor: s.frame.bgColor, isMargin: s.frame.margin, marginScale: s.frame.margin ? s.frame.marginScale : 1, border: s.frame.border, borderWeight: s.frame.borderWeight },
      typo: { ...s.typo, text: s.typo.text.trim() },
      logo: { image: logoObj, enabled: !!logoObj && s.logo.enabled, scale: s.logo.scale, opacity: s.logo.opacity, pos: s.logo.pos },
      appWatermark: s.appWatermark,
    };

    const result = await runExport(request, updateLoadingText);
    const gCon = el('export-gallery-container'); gCon.innerHTML = '';
    for (const slide of result.slides) {
      const imgEl = document.createElement('img');
      imgEl.src = URL.createObjectURL(slide.blob);
      imgEl.className = 'export-img-item';
      gCon.appendChild(imgEl);
    }

    const outcome = await packageAndDeliver(result, isMobile, updateLoadingText);
    hideLoading();
    if (outcome === 'shared') DOM.btnExport.innerText = '✅ Saved!';
    else {
      el('export-modal').classList.add('show');
      DOM.btnExport.innerText = outcome === 'share-fallback' ? '✅ Ready!' : '✅ Downloaded!';
    }
  } catch (err) {
    hideLoading(); alert('Export Failed: ' + (err as Error).message); DOM.btnExport.innerText = '❌ Failed';
  } finally {
    DOM.btnExport.classList.remove('opacity-70', 'pointer-events-none');
    setTimeout(() => { DOM.btnExport.innerText = 'Export Gallery'; }, 3000);
  }
});

// ============================================================================
// Remaining buttons
// ============================================================================

el('btn-close-export').addEventListener('click', closeExportModal);
el('btn-return-workspace').addEventListener('click', closeExportModal);
el('btn-exit-zen').addEventListener('click', toggleZenMode);
el('btn-reload-logo').addEventListener('click', () => location.reload());
el('btn-new-photo').addEventListener('click', () => location.reload());
DOM.btnZen.addEventListener('click', toggleZenMode);
DOM.btnBA.addEventListener('click', toggleSplitView);
el('btn-zoom-fit').addEventListener('click', () => setZoom('fit'));
el('btn-reset-framing').addEventListener('click', resetFraming);
el('btn-rotate-90').addEventListener('click', () => { if (originalImg) cropCtrl.rotateBase(90); });
el('btn-rotate-180').addEventListener('click', () => { if (originalImg) { cropCtrl.rotateBase(90); cropCtrl.rotateBase(90); } });
el('btn-apply-crop').addEventListener('click', applyCropAndRender);

savedCustomPresets = loadPresets();
renderPresetChips();
initGlobalDrag();
syncControls(S());
