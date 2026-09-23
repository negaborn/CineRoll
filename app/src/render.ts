import type { BorderStyle, TextPreset } from './state';
import { drawGrainOverlay } from './compose';

export interface FrameGeometry {
  bgColor: string;
  isMargin: boolean;
  marginScale: number; // 0..1
  border: BorderStyle;
  borderWeight: number;
}

export interface SlideSource {
  image: CanvasImageSource;
  naturalWidth: number; // width of the full composite (spans all slides for seamless/triptych)
  naturalHeight: number;
}

export interface SlideBaseParams {
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
  slideIndex: number;
  slidesCount: number;
  isPanned: boolean; // true for seamless/triptych (pans across `source`), false for single (draws it whole)
  source: SlideSource;
  filterString: string;
  frame: FrameGeometry;
  grain: { tile: HTMLCanvasElement | null; amountPct: number };
}

export interface DrawRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Draws background + image slice + border + grain for one slide. Returns the image's drawn rect (needed for margin-relative overlays). */
export function renderSlideBase(p: SlideBaseParams): DrawRect {
  const { ctx, width, height, frame } = p;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = frame.isMargin ? frame.bgColor : '#000000';
  ctx.fillRect(0, 0, width, height);

  let dx = 0;
  let dy = 0;
  let dw = width;
  let dh = height;
  if (frame.isMargin) {
    if (frame.border === 'instant') {
      const pS = frame.marginScale * 0.88;
      dw = width * pS;
      dh = height * pS;
      dx = (width - dw) / 2;
      dy = height * 0.06;
    } else {
      dw = width * frame.marginScale;
      dh = height * frame.marginScale;
      dx = (width - dw) / 2;
      dy = (height - dh) / 2;
    }
  }

  ctx.save();
  ctx.filter = p.filterString;
  const sliceW = p.source.naturalWidth / p.slidesCount;
  if (p.isPanned) {
    ctx.drawImage(p.source.image, p.slideIndex * sliceW, 0, sliceW, p.source.naturalHeight, dx, dy, dw, dh);
  } else {
    ctx.drawImage(p.source.image, 0, 0, p.source.naturalWidth, p.source.naturalHeight, dx, dy, dw, dh);
  }
  ctx.restore();

  if (frame.isMargin && frame.border === 'fineart') {
    ctx.save();
    const strokeW = Math.max(1, height * 0.001 * frame.borderWeight);
    ctx.strokeStyle = 'rgba(20,20,20,0.95)';
    ctx.lineWidth = strokeW;
    ctx.strokeRect(dx + strokeW / 2, dy + strokeW / 2, dw - strokeW, dh - strokeW);
    ctx.restore();
  } else if (frame.isMargin && frame.border === 'vnotch') {
    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';
    ctx.beginPath();
    const nTop = height * 0.45;
    const nHeight = height * 0.1;
    const notchW = width * 0.015;
    ctx.moveTo(0, nTop);
    ctx.lineTo(notchW, nTop + nHeight * 0.25);
    ctx.lineTo(0, nTop + nHeight * 0.4);
    ctx.lineTo(0, nTop + nHeight * 0.6);
    ctx.lineTo(notchW, nTop + nHeight * 0.75);
    ctx.lineTo(0, nTop + nHeight);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  if (p.grain.tile) {
    drawGrainOverlay(ctx, p.grain.tile, p.grain.amountPct, 0, 0, width, height);
  }

  return { x: dx, y: dy, width: dw, height: dh };
}

/** font-size in px for a slide of the given height, shared by preview (CSS px) and export (device px). */
export function computeFontSizePx(slideHeightPx: number, isSingleStrategy: boolean, fontScalePct: number): number {
  return Math.floor(slideHeightPx * (isSingleStrategy ? 0.025 : 0.018) * (fontScalePct / 100));
}

export function computeGlowPx(glowAmount: number, fontSizePx: number): number {
  return glowAmount * (fontSizePx / 50);
}

const GOLD_STOPS: [number, string][] = [
  [0, '#BF953F'],
  [0.25, '#FCF6BA'],
  [0.5, '#B38728'],
  [0.75, '#FBF5B7'],
  [1, '#AA771C'],
];
const SILVER_STOPS: [number, string][] = [
  [0, '#8A9097'],
  [0.25, '#E0E5EC'],
  [0.5, '#8A9097'],
  [0.75, '#B0B5BB'],
  [1, '#595F66'],
];

export interface WatermarkTextParams {
  ctx: CanvasRenderingContext2D;
  text: string;
  x: number; // center x, in the same pixel space as ctx's current transform
  y: number; // center y
  fontSizePx: number;
  fontFamily: string;
  bold: boolean;
  preset: TextPreset;
  plainColor: string;
  glow: boolean;
  glowPx: number;
}

/** Draws the caption/watermark text: gold/silver 135deg gradient fill (matching the CSS text-preset classes) or a plain solid color, with an optional glow. */
export function drawWatermarkText(p: WatermarkTextParams): void {
  const { ctx } = p;
  ctx.save();
  ctx.font = `${p.bold ? 'bold ' : ''}${p.fontSizePx}px '${p.fontFamily}', sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // 0.1em, matching the CSS `letter-spacing: 0.1em` on .draggable-text span.
  (ctx as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = `${p.fontSizePx * 0.1}px`;

  const metrics = ctx.measureText(p.text);
  const textW = metrics.width;
  const textH = p.fontSizePx;

  if (p.preset !== 'none') {
    // Approximates CSS `linear-gradient(135deg, ...)` clipped to the text's own box:
    // a gradient from the box's top-left to bottom-right corner.
    const gradient = ctx.createLinearGradient(p.x - textW / 2, p.y - textH / 2, p.x + textW / 2, p.y + textH / 2);
    const stops = p.preset === 'gold' ? GOLD_STOPS : SILVER_STOPS;
    for (const [offset, color] of stops) gradient.addColorStop(offset, color);
    ctx.fillStyle = gradient;
    if (p.glow) {
      ctx.shadowColor = 'rgba(0,0,0,0.8)';
      ctx.shadowBlur = p.glowPx;
    }
  } else {
    ctx.fillStyle = p.plainColor;
    if (p.glow) {
      ctx.shadowColor = p.plainColor;
      ctx.shadowBlur = p.glowPx;
    }
  }

  ctx.fillText(p.text, p.x, p.y);
  ctx.restore();
}

export interface LogoDrawParams {
  ctx: CanvasRenderingContext2D;
  image: CanvasImageSource;
  naturalWidth: number;
  naturalHeight: number;
  x: number; // center x
  y: number; // center y
  width: number; // drawn width; height derived from the logo's own aspect ratio
  opacityPct: number;
}

export function drawLogo(p: LogoDrawParams): void {
  const { ctx } = p;
  ctx.save();
  ctx.globalAlpha = p.opacityPct / 100;
  const h = (p.width / p.naturalWidth) * p.naturalHeight;
  ctx.drawImage(p.image, p.x - p.width / 2, p.y - h / 2, p.width, h);
  ctx.restore();
}

export interface AppWatermarkParams {
  ctx: CanvasRenderingContext2D;
  width: number; // slide width, for right-alignment
  height: number; // slide height, used to size/position the mark
}

export function drawAppWatermark(p: AppWatermarkParams): void {
  const { ctx } = p;
  ctx.save();
  const size = Math.max(16, p.height * 0.012);
  ctx.font = `700 ${size}px 'Outfit', sans-serif`;
  ctx.shadowColor = 'rgba(0,0,0,0.9)';
  ctx.shadowBlur = 8;
  ctx.shadowOffsetY = 1;
  ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'bottom';
  ctx.fillText('cineRoll.studio', p.width - p.height * 0.015, p.height - p.height * 0.015);
  ctx.restore();
}
