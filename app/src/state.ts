export type Strategy = 'seamless' | 'triptych' | 'single';
export type SqueezeFactor = 100 | 133 | 150 | 160 | 180 | 200;
export type BorderStyle = 'none' | 'fineart' | 'vnotch' | 'instant';
export type LutChoice = 'none' | 'kodak' | 'fuji' | 'cinematic' | 'custom';
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
    tone: { lut: 'none', lutIntensity: 100, highlights: 0, shadows: 0, brightness: 100, contrast: 100, saturation: 100, grain: 0 },
    typo: { text: '', target: 'all', font: 'Inter', bold: false, glow: true, glowAmount: 15, fontScale: 100, color: '#FFFFFF', preset: 'none', pos: { x: 50, y: 94 } },
    logo: { enabled: false, scale: 50, opacity: 100, pos: { x: 50, y: 80 } },
    appWatermark: false,
  };
}

type Listener = (state: EditState) => void;

class EditStateStore {
  private state: EditState;
  private listeners = new Set<Listener>();

  constructor(initial: EditState) {
    this.state = initial;
  }

  get(): EditState {
    return this.state;
  }

  update(patch: Partial<EditState> | ((s: EditState) => EditState)): EditState {
    this.state = typeof patch === 'function' ? patch(this.state) : { ...this.state, ...patch };
    this.listeners.forEach((l) => l(this.state));
    return this.state;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
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
}

declare global {
  interface Window {
    __CINEROLL_DEBUG__?: CineRollDebug;
  }
}

export function installDebugHook(setCropForTest: (rect: CropRect) => void): void {
  if (!import.meta.env.DEV) return;
  window.__CINEROLL_DEBUG__ = {
    getState: () => editState.get(),
    setCropForTest,
  };
}
