export type Strategy = 'seamless' | 'triptych' | 'single';
export type SqueezeFactor = 100 | 133 | 150 | 160 | 180 | 200;
export type BorderStyle = 'none' | 'fineart' | 'vnotch' | 'instant';
/** 'none', one of the film simulations (film.ts), or a user-loaded .cube LUT. */
export type LutChoice = 'none' | 'classic-pan-400' | 'newsprint-400' | 'velvia-50' | 'provia-100f' | 'custom';
export type TextPreset = 'none' | 'gold' | 'silver';
export type WatermarkTarget = 'all' | 1 | 2 | 3 | 4;

export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface EditState {
  strategy: Strategy;
  baseRatio: number | null;
  slides: 2 | 3 | 4;
  squeeze: SqueezeFactor;
  rotation: { base: 0 | 90 | 180 | 270; fine: number };
  crop: CropRect;
  frame: { margin: boolean; marginScale: number; bgColor: string; border: BorderStyle; borderWeight: number };
  tone: {
    lut: LutChoice;
    lutIntensity: number;
    highlights: number;
    shadows: number;
    brightness: number;
    contrast: number;
    saturation: number;
    grain: number;
    /** Bumped when a .cube file is (re)loaded, so the tone engine re-runs even if other tone values are unchanged. */
    customLutRev: number;
  };
  typo: {
    text: string;
    target: WatermarkTarget;
    font: string;
    bold: boolean;
    glow: boolean;
    glowAmount: number;
    fontScale: number;
    color: string;
    preset: TextPreset;
    pos: { x: number; y: number };
  };
  logo: { enabled: boolean; scale: number; opacity: number; pos: { x: number; y: number } };
  appWatermark: boolean;
}

export function defaultEditState(): EditState {
  return {
    strategy: 'seamless',
    baseRatio: 0.8,
    slides: 3,
    squeeze: 100,
    rotation: { base: 0, fine: 0 },
    crop: { x: 0, y: 0, width: 0, height: 0 },
    frame: { margin: false, marginScale: 0.85, bgColor: '#000000', border: 'none', borderWeight: 3 },
    tone: { lut: 'none', lutIntensity: 100, highlights: 0, shadows: 0, brightness: 100, contrast: 100, saturation: 100, grain: 0, customLutRev: 0 },
    typo: { text: '', target: 'all', font: 'Inter', bold: false, glow: true, glowAmount: 15, fontScale: 100, color: '#ffffff', preset: 'none', pos: { x: 50, y: 94 } },
    logo: { enabled: false, scale: 50, opacity: 100, pos: { x: 50, y: 80 } },
    appWatermark: false,
  };
}

type Listener = (state: EditState, prev: EditState) => void;

/**
 * The single store for every edit setting. Listeners receive (state, prev) so
 * they can react to exactly what changed. Updates made *by* a listener are
 * applied immediately but notified in a follow-up round (never re-entrantly),
 * so every listener sees each state transition exactly once, in order.
 */
class EditStateStore {
  private state: EditState;
  private notified: EditState;
  private notifying = false;
  private listeners = new Set<Listener>();

  constructor(initial: EditState) {
    this.state = initial;
    this.notified = initial;
  }

  get(): EditState {
    return this.state;
  }

  update(patch: Partial<EditState> | ((s: EditState) => EditState)): EditState {
    this.state = typeof patch === 'function' ? patch(this.state) : { ...this.state, ...patch };
    if (this.notifying) return this.state;
    this.notifying = true;
    try {
      while (this.notified !== this.state) {
        const prev = this.notified;
        const cur = this.state;
        this.notified = cur;
        this.listeners.forEach((l) => l(cur, prev));
      }
    } finally {
      this.notifying = false;
    }
    return this.state;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

type Group = 'frame' | 'tone' | 'typo' | 'logo';

/** Merges `values` into one settings group, e.g. patchGroup('frame', { margin: true }). */
export function patchGroup<K extends Group>(group: K, values: Partial<EditState[K]>): void {
  editState.update((s) => ({ ...s, [group]: { ...s[group], ...values } }));
}

export const editState = new EditStateStore(defaultEditState());

// --- Custom text-style preset persistence (localStorage) ---

export interface TextPresetRecord {
  id: number;
  text: string;
  color: string;
  bold: boolean;
  glow: boolean;
  font: string;
  glowAmt: string | number;
  type: TextPreset;
}

const PRESETS_KEY = 'cineroll_presets_v4';

export function loadPresets(): TextPresetRecord[] {
  const stored = localStorage.getItem(PRESETS_KEY);
  if (!stored) return [];
  try {
    return JSON.parse(stored);
  } catch (_e) {
    return [];
  }
}

export function savePresets(presets: TextPresetRecord[]): void {
  localStorage.setItem(PRESETS_KEY, JSON.stringify(presets));
}

// --- Test-only debug hook: exposes normalized crop/rotation state to Playwright. ---
// Tree-shaken out of production builds because it is gated behind import.meta.env.DEV.

export interface CineRollDebug {
  getState(): EditState;
  setCropForTest(rect: CropRect): void;
  /** Merges a per-group partial state, e.g. { frame: { margin: true }, strategy: 'single' }. */
  updateState(patch: Record<string, unknown>): void;
  /** Extra test-only probes supplied by the UI layer (film engine, preview info). */
  [extra: string]: unknown;
}

declare global {
  interface Window {
    __CINEROLL_DEBUG__?: CineRollDebug;
  }
}

export function installDebugHook(setCropForTest: (rect: CropRect) => void, extras: Record<string, unknown> = {}): void {
  if (!import.meta.env.DEV) return;
  window.__CINEROLL_DEBUG__ = {
    ...extras,
    getState: () => editState.get(),
    setCropForTest,
    updateState: (patch) =>
      editState.update((s) => {
        const next: Record<string, unknown> = { ...s };
        for (const [k, v] of Object.entries(patch)) {
          const cur = (s as unknown as Record<string, unknown>)[k];
          next[k] = v && typeof v === 'object' && !Array.isArray(v) && cur && typeof cur === 'object' ? { ...cur, ...v } : v;
        }
        return next as unknown as EditState;
      }),
  };
}
