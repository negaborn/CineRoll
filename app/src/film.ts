// Film simulations, ported from the verified prototypes in reference/film-sim/:
//   classic-pan-400-CURRENT.html  (B&W, HP5-style asymmetric toe/shoulder)
//   newsprint-400-CURRENT.html    (B&W, Tri-X-style 4-point keyframe curve)
//   vivid-slide-50-FINAL.html     (colour, Velvia 50 / Provia 100F, Lab base/detail)
//
// One implementation serves both the preview and the export, so they can't drift.
// What changed from the prototypes is only the plumbing, never the look:
//  - No crop to a fixed ratio: any aspect (e.g. 2.4:1 anamorphic) goes through as is.
//  - Resolution independence: every spatial constant (blur radii, grain size,
//    halation spread, texture-probe distance) is defined at the resolution the
//    film was tuned at (REF_LONG_SIDE) and scaled to the image being processed,
//    so a 2600px preview and a 8000px export look the same. At the tuning size
//    (scale 1) the output is the prototype's, pixel for pixel. The anti-banding
//    dither is the exception: it always works per output pixel.
//  - Per-photo statistics (auto shadow lift, adaptive contrast) are measured on a
//    copy scaled to the tuning size, exactly as the prototype measured them.
//  - Memory: processed in horizontal strips with enough overlap for every blur,
//    which gives results identical to processing the whole frame at once.
//  - Parameters are the prototypes' confirmed defaults; nothing is re-tuned.

export type FilmId = 'classic-pan-400' | 'newsprint-400' | 'velvia-50' | 'provia-100f';

export const FILM_IDS: FilmId[] = ['classic-pan-400', 'newsprint-400', 'velvia-50', 'provia-100f'];

export const FILM_LABELS: Record<FilmId, string> = {
  'classic-pan-400': 'Classic Pan 400',
  'newsprint-400': 'Newsprint 400',
  'velvia-50': 'Vivid Slide 50 · Velvia 50',
  'provia-100f': 'Vivid Slide 50 · Provia 100F',
};

type Curve = [number, number][];

interface BwSpec {
  kind: 'bw';
  /** Long side (px) the prototype was tuned at: classic 900x600 working canvas, newsprint <=1100. */
  refLongSide: number;
  curve: 'classic' | 'newsprint';
  redWeight: number;
  contrast: number;
  grain: number;
  halation: number;
  localContrast: number;
  /** Exposure anchor: prototype default is manual +0 (auto anchor off). */
  exposureShift: number;
  /** Shadow-coverage detection: "dark AND textured" (Rec.709 luminance below toe, local texture above threshold). */
  toeLen: number;
  autoShadowCeil: number;
  autoShadowMult: number;
  grainGain: number;
}

interface ColorSpec {
  kind: 'color';
  refLongSide: number;
  L: Curve;
  a: Curve;
  b: Curve;
  contrast: number;
  saturation: number;
  warmPriority: number;
  grain: number;
  halation: number;
  localContrast: number;
  warmth: number;
  exposureShift: number;
  autoContrast: boolean;
}

// t3mujinpack Darktable curves, as digitized in vivid-slide-50-FINAL.html (FILM_CURVES).
const VELVIA_CURVES = {
  L: [[0, 0], [0.0589, 0.0275], [0.178, 0.1052], [0.2917, 0.233], [0.4852, 0.4718], [0.8375, 0.8868], [1, 0.9835]] as Curve,
  a: [[0, 0], [0.2297, 0.1664], [0.3402, 0.2981], [0.3714, 0.3337], [0.435, 0.4133], [0.4768, 0.4693], [0.4989, 0.4979], [0.5338, 0.5512], [0.5596, 0.5851], [0.7544, 0.8007], [1, 1]] as Curve,
  b: [[0, 0], [0.431, 0.4144], [0.4984, 0.5026], [0.5243, 0.5305], [0.5676, 0.5672], [0.6004, 0.5972], [0.6504, 0.6505], [0.7524, 0.7641], [1, 1]] as Curve,
};
const PROVIA_CURVES = {
  L: [[0, 0.01], [0.0366, 0.0318], [0.1312, 0.1077], [0.2748, 0.2577], [0.4827, 0.5122], [0.61, 0.6607], [0.6956, 0.7598], [0.792, 0.8667], [0.9113, 0.9551], [0.997, 0.995], [1, 1]] as Curve,
  a: [[0, 0], [0.3082, 0.2678], [0.4255, 0.3826], [0.5034, 0.502], [0.5291, 0.543], [0.7061, 0.7543], [0.8685, 0.9067], [1, 1]] as Curve,
  b: [[0, 0], [0.2283, 0.1963], [0.3357, 0.315], [0.3985, 0.4026], [0.485, 0.4867], [0.5016, 0.5016], [0.5245, 0.5232], [0.5451, 0.5515], [0.5874, 0.6099], [0.6362, 0.6538], [0.7106, 0.7293], [0.8552, 0.8696], [0.9981, 0.9774], [1, 1]] as Curve,
};

// Shared vivid-slide defaults (slider values in vivid-slide-50-FINAL.html);
// saturation / warm priority come from its per-film FILM_DEFAULTS.
const VIVID_SHARED = { refLongSide: 2600, contrast: 0.62, grain: 0.09, halation: 0.16, localContrast: 0.52, warmth: 0, exposureShift: 0, autoContrast: true };

export const FILM_SPECS: Record<FilmId, BwSpec | ColorSpec> = {
  'classic-pan-400': {
    kind: 'bw', refLongSide: 900, curve: 'classic',
    redWeight: 0.74, contrast: 0.55, grain: 0.19, halation: 0.10, localContrast: 0, exposureShift: 0,
    toeLen: 0.32, autoShadowCeil: 0.70, autoShadowMult: 1.4, grainGain: 26,
  },
  'newsprint-400': {
    kind: 'bw', refLongSide: 1100, curve: 'newsprint',
    redWeight: 0.65, contrast: 0.70, grain: 0.24, halation: 0.08, localContrast: 0.38, exposureShift: 0,
    toeLen: 0.30, autoShadowCeil: 0.30, autoShadowMult: 0.55, grainGain: 27,
  },
  'velvia-50': { kind: 'color', ...VIVID_SHARED, ...VELVIA_CURVES, saturation: 0.75, warmPriority: 0.55 },
  'provia-100f': { kind: 'color', ...VIVID_SHARED, ...PROVIA_CURVES, saturation: 0.58, warmPriority: 0.18 },
};

// ---------------------------------------------------------------------------
// Shared helpers (verbatim maths from the prototypes)
// ---------------------------------------------------------------------------

export function seededNoise(x: number, y: number, seed: number): number {
  const n = Math.sin(x * 12.9898 + y * 78.233 + seed * 37.719) * 43758.5453;
  return n - Math.floor(n);
}

/**
 * Grain noise at the film's tuning resolution. At scale 1 this is exactly the
 * prototype's per-pixel noise; above it, the tuning-size noise field is sampled
 * bilinearly -- what the prototype's canvas looked like when the browser scaled
 * it up for display -- so the grain keeps its size relative to the frame.
 */
function grainNoise(x: number, y: number, seed: number, inv: number): number {
  if (inv === 1) return seededNoise(x, y, seed);
  const fx = x * inv;
  const fy = y * inv;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;
  const n00 = seededNoise(x0, y0, seed);
  const n10 = seededNoise(x0 + 1, y0, seed);
  const n01 = seededNoise(x0, y0 + 1, seed);
  const n11 = seededNoise(x0 + 1, y0 + 1, seed);
  return (n00 * (1 - tx) + n10 * tx) * (1 - ty) + (n01 * (1 - tx) + n11 * tx) * ty;
}

/** Separable box blur with edge clamping (the prototypes' boxBlur). */
export function boxBlur(src: Float32Array, w: number, h: number, radius: number): Float32Array {
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  const r = radius;
  for (let y = 0; y < h; y++) {
    let acc = 0;
    for (let x = -r; x <= r; x++) acc += src[y * w + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      tmp[y * w + x] = acc / (2 * r + 1);
      const addX = Math.min(w - 1, x + r + 1);
      const remX = Math.max(0, x - r);
      acc += src[y * w + addX] - src[y * w + remX];
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let y = -r; y <= r; y++) acc += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = acc / (2 * r + 1);
      const addY = Math.min(h - 1, y + r + 1);
      const remY = Math.max(0, y - r);
      acc += tmp[addY * w + x] - tmp[remY * w + x];
    }
  }
  return out;
}

// --- Classic Pan 400 ---

/** Asymmetric toe/shoulder + straight-line gain + independent shadow lift (classic-pan-400 toneCurve). */
export function classicToneCurve(v: number, strength: number, shadowLift: number): number {
  const toeLen = 0.32;
  const shoulderLen = 0.22;
  let out: number;
  if (strength <= 0) out = v;
  else if (v < toeLen) {
    const t = v / toeLen;
    out = Math.pow(t, 1 - 0.35 * strength) * toeLen;
  } else if (v > 1 - shoulderLen) {
    const t = (v - (1 - shoulderLen)) / shoulderLen;
    out = (1 - shoulderLen) + (1 - Math.pow(1 - t, 1.8 + strength * 0.9)) * shoulderLen;
  } else out = v;
  out = (out - 0.5) * (1 + 0.35 * strength) + 0.5;
  if (shadowLift > 0 && v < toeLen) {
    const fade = Math.pow(1 - v / toeLen, 1.4);
    out += shadowLift * 0.22 * fade;
  }
  return Math.min(1, Math.max(0, out));
}

// --- Newsprint 400 ---

export const NEWSPRINT_CURVE_POINTS: Curve = [
  [0.00, 0.005],
  [0.10, 0.075],
  [0.30, 0.205],
  [0.50, 0.50],
  [0.82, 0.85],
  [1.00, 1.00],
];
const NEWSPRINT_SHADOW_LIFT_BOUNDARY = 0.30;

function newsprintCurveShape(v: number): number {
  const P = NEWSPRINT_CURVE_POINTS;
  for (let i = 0; i < P.length - 1; i++) {
    const a = P[i];
    const b = P[i + 1];
    if (v >= a[0] && v <= b[0]) {
      const t = b[0] - a[0] > 0 ? (v - a[0]) / (b[0] - a[0]) : 0;
      return a[1] + t * (b[1] - a[1]);
    }
  }
  return v;
}

/**
 * Newsprint 400 tone curve: identity -> keyframe-curve blend by strength, then
 * shadow lift. Deliberately NO extra global gain stage: the keyframes already
 * encode the contrast, and stacking a gain on top double-applied it (the
 * "double gain" bug that crushed lower midtones).
 */
export function newsprintToneCurve(v: number, strength: number, shadowLift: number): number {
  const shaped = newsprintCurveShape(v);
  let out = v + (shaped - v) * strength;
  if (shadowLift > 0 && v < NEWSPRINT_SHADOW_LIFT_BOUNDARY) {
    const fade = Math.pow(1 - v / NEWSPRINT_SHADOW_LIFT_BOUNDARY, 1.4);
    out += shadowLift * 0.11 * fade;
  }
  return Math.min(1, Math.max(0, out));
}

// --- Vivid Slide 50 ---

function curveShape(pts: Curve, v: number): number {
  const first = pts[0];
  const last = pts[pts.length - 1];
  if (v <= first[0]) { const slope = (pts[1][1] - first[1]) / ((pts[1][0] - first[0]) || 1e-6); return first[1] + (v - first[0]) * slope; }
  if (v >= last[0]) { const prev = pts[pts.length - 2]; const slope = (last[1] - prev[1]) / ((last[0] - prev[0]) || 1e-6); return last[1] + (v - last[0]) * slope; }
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    if (v >= a[0] && v <= b[0]) { const t = b[0] - a[0] > 0 ? (v - a[0]) / (b[0] - a[0]) : 0; return a[1] + t * (b[1] - a[1]); }
  }
  return v;
}

const lin = (c: number) => (c > 0.04045 ? Math.pow((c + 0.055) / 1.055, 2.4) : c / 12.92);
/** sRGB linearization for 8-bit inputs (same values as lin(), precomputed). */
const LIN8 = (() => { const t = new Float64Array(256); for (let i = 0; i < 256; i++) t[i] = lin(i / 255) * 100; return t; })();
const labF = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);

/** sRGB (D65) -> CIELAB into out[0..2] (vivid-slide rgbToLab). */
function rgbToLab(r: number, g: number, b: number, out: Float64Array): void {
  const R = Number.isInteger(r) && r >= 0 && r <= 255 ? LIN8[r] : lin(r / 255) * 100;
  const G = Number.isInteger(g) && g >= 0 && g <= 255 ? LIN8[g] : lin(g / 255) * 100;
  const B = Number.isInteger(b) && b >= 0 && b <= 255 ? LIN8[b] : lin(b / 255) * 100;
  const x = labF((R * 0.4124 + G * 0.3576 + B * 0.1805) / 95.047);
  const y = labF((R * 0.2126 + G * 0.7152 + B * 0.0722) / 100.0);
  const z = labF((R * 0.0193 + G * 0.1192 + B * 0.9505) / 108.883);
  out[0] = 116 * y - 16;
  out[1] = 500 * (x - y);
  out[2] = 200 * (y - z);
}

const fi = (t: number) => (t * t * t > 0.008856 ? t * t * t : (t - 16 / 116) / 7.787);
const gam = (c: number) => (c > 0.0031308 ? 1.055 * Math.pow(c, 1 / 2.4) - 0.055 : 12.92 * c);

/** CIELAB -> sRGB (0..255, unclamped) into out[0..2] (vivid-slide labToRgb). */
function labToRgb(L: number, A: number, B: number, out: Float64Array): void {
  let y = (L + 16) / 116;
  let x = A / 500 + y;
  let z = y - B / 200;
  x = (fi(x) * 95.047) / 100; y = fi(y); z = (fi(z) * 108.883) / 100;
  out[0] = gam(x * 3.2406 + y * -1.5372 + z * -0.4986) * 255;
  out[1] = gam(x * -0.9689 + y * 1.8758 + z * 0.0415) * 255;
  out[2] = gam(x * 0.0557 + y * -0.2040 + z * 1.0570) * 255;
}

// ---------------------------------------------------------------------------
// Per-photo statistics
// ---------------------------------------------------------------------------

export interface FilmStats {
  /** B&W: fraction of sampled pixels that are dark AND textured. */
  shadowCoverage: number;
  /** B&W: automatic shadow lift derived from shadowCoverage. */
  shadowLift: number;
  /** Colour: 5th-95th percentile luminance spread and the resulting tone-curve strength. */
  spread: number;
  contrast: number;
}

/** The image scaled (never up) to the film's tuning long side -- where the prototype measured everything. */
function analysisPixels(src: CanvasImageSource & { width: number; height: number }, refLongSide: number): { data: Uint8ClampedArray; w: number; h: number } {
  const sw = src.width as number;
  const sh = src.height as number;
  const s = Math.min(1, refLongSide / Math.max(sw, sh));
  const w = Math.max(1, Math.round(sw * s));
  const h = Math.max(1, Math.round(sh * s));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h).data;
  c.width = 0; c.height = 0;
  return { data, w, h };
}

export function analyzeFilm(src: CanvasImageSource & { width: number; height: number }, film: FilmId): FilmStats {
  const spec = FILM_SPECS[film];
  const { data: sd, w: W } = analysisPixels(src, spec.refLongSide);
  if (spec.kind === 'bw') {
    // "Dark AND textured" -- a flat dark colour field (open blue sky, which also
    // reads dark) must not count as shadow, or the lift washes it out.
    const TEXTURE_THRESHOLD = 0.025;
    let n = 0;
    let deep = 0;
    for (let i = 0; i < sd.length; i += 4) {
      const px = i / 4;
      if (px % 7 !== 0) continue;
      const neutralV = (sd[i] * 0.2126 + sd[i + 1] * 0.7152 + sd[i + 2] * 0.0722) / 255;
      const x = px % W;
      const y = (px / W) | 0;
      const ni = (y * W + Math.min(W - 1, x + 15)) * 4;
      const neighborV = (sd[ni] * 0.2126 + sd[ni + 1] * 0.7152 + sd[ni + 2] * 0.0722) / 255;
      n++;
      if (neutralV < spec.toeLen && Math.abs(neutralV - neighborV) > TEXTURE_THRESHOLD) deep++;
    }
    const shadowCoverage = n ? deep / n : 0;
    return { shadowCoverage, shadowLift: Math.min(spec.autoShadowCeil, shadowCoverage * spec.autoShadowMult), spread: 0, contrast: spec.contrast };
  }
  const sample: number[] = [];
  for (let i = 0; i < sd.length; i += 4) {
    if ((i / 4) % 9 === 0) sample.push((sd[i] * 0.2126 + sd[i + 1] * 0.7152 + sd[i + 2] * 0.0722) / 255);
  }
  sample.sort((a, b) => a - b);
  const p05 = sample.length ? sample[Math.floor(sample.length * 0.05)] : 0.05;
  const p95 = sample.length ? sample[Math.floor(sample.length * 0.95)] : 0.95;
  const spread = Math.max(0.05, p95 - p05);
  // Adaptive contrast: a flat scene gets more of the curve, an already contrasty one less.
  const scale = Math.min(1.25, Math.max(0.5, 1.55 - spread * 1.1));
  const contrast = spec.autoContrast ? Math.min(1, spec.contrast * scale) : spec.contrast;
  return { shadowCoverage: 0, shadowLift: 0, spread, contrast };
}

// ---------------------------------------------------------------------------
// Processing
// ---------------------------------------------------------------------------

interface Region { data: Uint8ClampedArray; w: number; h: number; top: number }

/** Radii at the processed size; `k` is processedLongSide / tuningLongSide. */
function radii(spec: BwSpec | ColorSpec, k: number) {
  const r = (ref: number) => Math.max(1, Math.round(ref * k));
  const halation = spec.halation > 0 ? r(6 + Math.round(spec.halation * 10)) : 0;
  const pre = spec.kind === 'color' ? r(7) : spec.localContrast > 0 ? r(9) : 0;
  return { halation, pre, reach: pre + 2 * halation };
}

function processBw(spec: BwSpec, stats: FilmStats, k: number, reg: Region): Uint8ClampedArray {
  const { data: sd, w: W, h: H, top } = reg;
  const N = W * H;
  const rW = spec.redWeight;
  const gW = (1 - rW) * 0.7;
  const bW = (1 - rW) * 0.3;
  const sum = rW + gW + bW;
  const curve = spec.curve === 'classic' ? classicToneCurve : newsprintToneCurve;
  const inv = 1 / k === 1 ? 1 : 1 / k;
  const { halation: rh, pre: rl } = radii(spec, k);

  const lumMap = new Float32Array(N);
  // Classic writes gray from the curve's full-precision value (the prototype's
  // local `v`); Newsprint from the stored Float32 map after local contrast.
  const lumD = spec.localContrast > 0 ? null : new Float64Array(N);
  for (let px = 0; px < N; px++) {
    const i = px * 4;
    const raw = Math.fround((sd[i] * rW + sd[i + 1] * gW + sd[i + 2] * bW) / (sum * 255)); // prototype keeps it in a Float32Array
    const v = curve(Math.min(1, Math.max(0, raw + spec.exposureShift)), spec.contrast, stats.shadowLift);
    lumMap[px] = v;
    if (lumD) lumD[px] = v;
  }
  // Newsprint: adjacency-effect local contrast (large-radius unsharp mask on luminance).
  if (spec.localContrast > 0) {
    const blurred = boxBlur(lumMap, W, H, rl);
    for (let px = 0; px < N; px++) {
      const detail = lumMap[px] - blurred[px];
      lumMap[px] = Math.min(1, Math.max(0, lumMap[px] + detail * spec.localContrast * 1.8));
    }
  }
  const od = new Uint8ClampedArray(N * 4);
  for (let px = 0; px < N; px++) {
    const i = px * 4;
    const x = px % W;
    const y = top + ((px / W) | 0);
    // Always-on anti-banding dither, per output pixel (not a user option).
    const dither = (seededNoise(x, y, 213) - 0.5) * 2.2;
    const gray = Math.min(255, Math.max(0, (lumD ? lumD[px] : lumMap[px]) * 255 + dither));
    od[i] = gray; od[i + 1] = gray; od[i + 2] = gray; od[i + 3] = 255;
  }
  if (spec.grain > 0) {
    for (let px = 0; px < N; px++) {
      const i = px * 4;
      const x = px % W;
      const y = top + ((px / W) | 0);
      const n = (grainNoise(x, y, 1, inv) - 0.5) * 2;
      const visibility = Math.sin(Math.min(1, lumMap[px] * 1.15) * Math.PI);
      const amount = n * spec.grain * spec.grainGain * visibility;
      od[i] = Math.min(255, Math.max(0, od[i] + amount));
      od[i + 1] = Math.min(255, Math.max(0, od[i + 1] + amount));
      od[i + 2] = Math.min(255, Math.max(0, od[i + 2] + amount));
    }
  }
  if (rh > 0) halate(od, lumMap, W, H, rh, 0.86, spec.halation, 1.4, [180, 95, 40]);
  return od;
}

function processColor(spec: ColorSpec, stats: FilmStats, k: number, reg: Region): Uint8ClampedArray {
  const { data: sd, w: W, h: H, top } = reg;
  const N = W * H;
  const inv = 1 / k === 1 ? 1 : 1 / k;
  const { halation: rh, pre: rd } = radii(spec, k);
  const lab = new Float64Array(3);
  const rgb = new Float64Array(3);

  // Pass 1: raw (pre-curve) Lab for every pixel. Detail must come from the
  // ORIGINAL tone -- a curve applied first would already have crushed it.
  const rawL = new Float32Array(N);
  const rawA = new Float32Array(N);
  const rawB = new Float32Array(N);
  const ex = spec.exposureShift * 255;
  for (let px = 0; px < N; px++) {
    const i = px * 4;
    const r = Math.min(255, Math.max(0, sd[i] + ex + spec.warmth * 38));
    const g = Math.min(255, Math.max(0, sd[i + 1] + ex));
    const b = Math.min(255, Math.max(0, sd[i + 2] + ex - spec.warmth * 38));
    rgbToLab(r, g, b, lab);
    rawL[px] = lab[0] / 100;
    rawA[px] = (lab[1] + 128) / 256;
    rawB[px] = (lab[2] + 128) / 256;
  }
  // Pass 2: base (blurred L) / detail split. The tone curve touches only the
  // base; the original detail is added back on top afterwards.
  const baseL = boxBlur(rawL, W, H, rd);
  const detailAmt = 1.0 + spec.localContrast * 1.1;
  const lumForContrast = new Float32Array(N);
  const od = new Uint8ClampedArray(N * 4);
  for (let px = 0; px < N; px++) {
    const i = px * 4;
    const detail = rawL[px] - baseL[px];
    const shapedBase = curveShape(spec.L, Math.min(1, Math.max(0, baseL[px])));
    let vL = baseL[px] + (shapedBase - baseL[px]) * stats.contrast;
    vL = vL + detail * detailAmt;

    const shapedA = curveShape(spec.a, Math.min(1, Math.max(0, rawA[px])));
    const shapedB = curveShape(spec.b, Math.min(1, Math.max(0, rawB[px])));
    let vA = rawA[px] + (shapedA - rawA[px]) * spec.saturation * 1.1;
    let vB = rawB[px] + (shapedB - rawB[px]) * spec.saturation * 1.1;

    // Warm-colour priority: extra chroma only for red-orange-yellow hues.
    if (spec.warmPriority > 0) {
      const dA = vA - 0.5;
      const dB = vB - 0.5;
      const hueDeg = (Math.atan2(dB, dA) * 180) / Math.PI;
      if (hueDeg > -50 && hueDeg < 100) {
        const warmness = 1 - Math.abs(hueDeg - 25) / 75;
        const boost = 1 + spec.warmPriority * Math.max(0, warmness) * 0.9;
        vA = 0.5 + dA * boost;
        vB = 0.5 + dB * boost;
      }
    }
    vL = Math.min(1, Math.max(0, vL));
    labToRgb(vL * 100, vA * 256 - 128, vB * 256 - 128, rgb);
    lumForContrast[px] = (rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722) / 255;
    const x = px % W;
    const y = top + ((px / W) | 0);
    const dither = (seededNoise(x, y, 213) - 0.5) * 2.2;
    od[i] = Math.min(255, Math.max(0, rgb[0] + dither));
    od[i + 1] = Math.min(255, Math.max(0, rgb[1] + dither));
    od[i + 2] = Math.min(255, Math.max(0, rgb[2] + dither));
    od[i + 3] = 255;
  }
  if (spec.grain > 0) {
    for (let px = 0; px < N; px++) {
      const i = px * 4;
      const x = px % W;
      const y = top + ((px / W) | 0);
      const visibility = Math.sin(Math.min(1, lumForContrast[px] * 1.15) * Math.PI);
      const nr = (grainNoise(x, y, 1, inv) - 0.5) * 2;
      const ng = (grainNoise(x, y, 2, inv) - 0.5) * 2;
      const nb = (grainNoise(x, y, 3, inv) - 0.5) * 2;
      od[i] = Math.min(255, Math.max(0, od[i] + nr * spec.grain * 20 * visibility));
      od[i + 1] = Math.min(255, Math.max(0, od[i + 1] + ng * spec.grain * 20 * visibility));
      od[i + 2] = Math.min(255, Math.max(0, od[i + 2] + nb * spec.grain * 20 * visibility));
    }
  }
  if (rh > 0) halate(od, lumForContrast, W, H, rh, 0.95, spec.halation, 1.3, [190, 90, 30]);
  return od;
}

/** Warm glow from the brightest areas: threshold -> two box blurs -> additive tint. */
function halate(od: Uint8ClampedArray, lum: Float32Array, W: number, H: number, radius: number, threshold: number, amount: number, gain: number, tint: [number, number, number]): void {
  const N = W * H;
  const glowSrc = new Float32Array(N);
  for (let px = 0; px < N; px++) { const v = lum[px]; glowSrc[px] = v > threshold ? (v - threshold) / (1 - threshold) : 0; }
  const blurred2 = boxBlur(boxBlur(glowSrc, W, H, radius), W, H, radius);
  for (let px = 0; px < N; px++) {
    const i = px * 4;
    const g = blurred2[px] * amount * gain;
    od[i] = Math.min(255, od[i] + g * tint[0]);
    od[i + 1] = Math.min(255, od[i + 1] + g * tint[1]);
    od[i + 2] = Math.min(255, od[i + 2] + g * tint[2]);
  }
}

export interface ApplyFilmOptions {
  /** Pre-computed statistics (defaults to analyzeFilm on the source). */
  stats?: FilmStats;
  /** Target pixels per strip (incl. overlap); smaller = less memory. */
  stripPixels?: number;
  /** Called between strips; awaiting it lets the page stay responsive. */
  onStrip?: (done: number, total: number) => void | Promise<void>;
}

/**
 * Renders `film` onto a copy of `src` (any size/aspect -- nothing is cropped)
 * and returns the new canvas.
 */
export async function applyFilm(src: HTMLCanvasElement, film: FilmId, opts: ApplyFilmOptions = {}): Promise<HTMLCanvasElement> {
  const spec = FILM_SPECS[film];
  const W = src.width;
  const H = src.height;
  const stats = opts.stats ?? analyzeFilm(src, film);
  const k = Math.max(W, H) / spec.refLongSide;
  const { reach } = radii(spec, k);
  const sctx = src.getContext('2d', { willReadFrequently: true })!;

  const out = document.createElement('canvas');
  out.width = W; out.height = H;
  const octx = out.getContext('2d')!;

  // Strips: each computes rows [y0, y1) from rows [y0 - reach, y1 + reach], so every
  // blur sees exactly what it would see in the full frame (identical output).
  // Output rows per strip: within the pixel budget, but never thin next to the
  // overlap (at high resolution the overlap is hundreds of rows, and thin strips
  // would spend most of their time recomputing it).
  const budget = opts.stripPixels ?? 2_000_000;
  const rows = Math.max(32, 4 * reach, Math.floor(budget / W) - 2 * reach);
  const total = Math.ceil(H / rows);
  for (let s = 0, y0 = 0; y0 < H; s++, y0 += rows) {
    const y1 = Math.min(H, y0 + rows);
    const top = Math.max(0, y0 - reach);
    const bottom = Math.min(H, y1 + reach);
    const reg: Region = { data: sctx.getImageData(0, top, W, bottom - top).data, w: W, h: bottom - top, top };
    const od = spec.kind === 'bw' ? processBw(spec, stats, k, reg) : processColor(spec, stats, k, reg);
    const keep = new ImageData(od.subarray((y0 - top) * W * 4, (y1 - top) * W * 4).slice(), W, y1 - y0);
    octx.putImageData(keep, 0, y0);
    await opts.onStrip?.(s + 1, total);
  }
  return out;
}
