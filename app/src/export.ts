import JSZip from 'jszip';
import type { BorderStyle, CropRect, LutChoice, SqueezeFactor, Strategy, TextPreset, WatermarkTarget } from './state';
import { getCropFrameSize, renderCroppedRegionFromOriginal } from './crop';
import { Engine3D, createGrainTile, colorAdjustFromTone, isNeutralColor } from './compose';
import { applyFilm, analyzeFilm, filmReach, mixFilmInPlace, FILM_IDS, type FilmId } from './film';
import { areaResampleBand } from './resample';
import { renderSlideBase, slideImageRectPx, computeFontSizePx, computeGlowPx, drawWatermarkText, drawLogo, drawAppWatermark } from './render';
import { createTiff, type TiffWriter } from './tiff';
import type { Raw16 } from './raw';

/** 'tiff' = Lossless: the crop's full resolution as an uncompressed TIFF, on every device. */
export type ExportQuality = 'ig' | 'web' | 'tiff' | 'tiff16';

export interface ExportRequest {
  originalImg: HTMLImageElement;
  squeeze: SqueezeFactor;
  baseRotation: 0 | 90 | 180 | 270;
  /** Straighten angle in degrees; the crop rect is relative to the frame straightened by it. */
  fineRotation: number;
  crop: CropRect;
  strategy: Strategy;
  slides: number;
  qualityMode: ExportQuality;
  isMobile: boolean;
  tone: {
    lut: LutChoice;
    lutIntensity: number;
    highlights: number;
    shadows: number;
    brightness: number;
    contrast: number;
    saturation: number;
    grain: number;
    hasCustomLut: boolean;
  };
  frame: { bgColor: string; isMargin: boolean; marginScale: number; border: BorderStyle; borderWeight: number };
  typo: {
    text: string;
    target: WatermarkTarget;
    font: string;
    bold: boolean;
    preset: TextPreset;
    color: string;
    glow: boolean;
    glowAmount: number;
    fontScale: number;
    pos: { x: number; y: number };
  };
  logo: { image: HTMLImageElement | null; enabled: boolean; scale: number; opacity: number; pos: { x: number; y: number } };
  appWatermark: boolean;
  /** Lossless: rows per band (testing only; default fits a band in ~4 MP). */
  bandRows?: number;
  /** RAW sources: the 16-bit decode, fetched on demand for the 16-bit TIFF master. */
  raw16?: () => Promise<Raw16>;
}

export interface ExportedSlide {
  filename: string;
  blob: Blob;
  /** A small viewable JPEG when the file itself isn't displayable in a browser (TIFF). */
  preview?: Blob;
}

export interface ExportResult {
  slides: ExportedSlide[];
  mimeType: string;
  /** Set when the output is smaller than the mode's size because the crop has fewer pixels (never upscaled). */
  sourceLimited?: { slideWidth: number; slideHeight: number; modeSlideWidth: number };
  /** 16-bit TIFF master: geometry only (no looks / frame / caption / logo). */
  geometryOnly16?: boolean;
}

const SAFE_MAX_DIM = 16000;

/**
 * The composite's target width/height for the quality mode. The crop's own
 * (desqueezed) pixels are always the ceiling: IG/Web downscale to their size
 * but never upscale a smaller crop (that would invent pixels); Lossless is
 * exactly the crop. Hard safety limits apply on top.
 */
function computeTargetDimensions(req: ExportRequest, cropPxW: number, cropPxH: number): { targetW: number; targetH: number; mimeType: string; encQual: number; sourceLimited?: ExportResult['sourceLimited'] } {
  const activeRatio = cropPxW && cropPxH ? cropPxW / cropPxH : 1;
  const MAX_AREA = req.isMobile ? 16777216 : 67108864;
  // Float crop fractions put a full-frame crop at e.g. 6007.9999px: snap to whole pixels.
  const srcW = Math.max(1, Math.round(cropPxW));

  let mimeType = 'image/jpeg';
  let encQual = 0.9;
  let targetW = 0;
  let sourceLimited: ExportResult['sourceLimited'];

  if (req.qualityMode === 'web' || req.qualityMode === 'ig') {
    const bW = req.qualityMode === 'web' ? (req.isMobile ? 3000 : 6000) : 2160;
    if (req.qualityMode === 'web') encQual = 1.0;
    const modeW = req.strategy === 'seamless' ? bW * req.slides : bW;
    targetW = Math.min(modeW, srcW);
    if (srcW < modeW) {
      const slideW = Math.floor(srcW / req.slides);
      sourceLimited = { slideWidth: slideW, slideHeight: Math.round(srcW / activeRatio), modeSlideWidth: Math.floor(modeW / req.slides) };
    }
  } else {
    mimeType = 'image/tiff';
    targetW = Math.min(srcW, SAFE_MAX_DIM);
    if (targetW < srcW) sourceLimited = undefined; // reported by the caller (safety cap, not the source)
  }

  let targetH = targetW / activeRatio;

  if (targetW > SAFE_MAX_DIM || targetH > SAFE_MAX_DIM) {
    const s = Math.min(SAFE_MAX_DIM / targetW, SAFE_MAX_DIM / targetH);
    targetW *= s;
    targetH *= s;
  }
  // Lossless is written band by band (no whole-image canvas), so the per-canvas
  // area limit doesn't apply to it.
  if (req.qualityMode !== 'tiff' && req.qualityMode !== 'tiff16' && targetW * targetH > MAX_AREA) {
    const s = Math.sqrt(MAX_AREA / (targetW * targetH));
    targetW *= s;
    targetH *= s;
  }

  targetW = Math.floor(targetW + 1e-6);
  targetH = Math.round(targetW / activeRatio);
  return { targetW, targetH, mimeType, encQual, sourceLimited };
}

/**
 * Renders every slide at export resolution and returns the encoded blobs.
 * DOM-agnostic: the caller owns loading UI, gallery previews, and delivery
 * (download / zip / share) -- see packageAndDeliver().
 */
export async function runExport(req: ExportRequest, onProgress: (msg: string) => void): Promise<ExportResult> {
  if (req.qualityMode === 'tiff') return runLosslessExport(req, onProgress);
  if (req.qualityMode === 'tiff16') return runRaw16Export(req, onProgress);
  const frame = getCropFrameSize(req.originalImg, req.squeeze, req.baseRotation, req.fineRotation);
  const cropPxW = req.crop.width * frame.width;
  const cropPxH = req.crop.height * frame.height;

  const { targetW, mimeType, encQual, sourceLimited } = computeTargetDimensions(req, cropPxW, cropPxH);

  await new Promise((r) => setTimeout(r, 50));
  let mCvs: HTMLCanvasElement = renderCroppedRegionFromOriginal(req.originalImg, req.squeeze, req.baseRotation, req.fineRotation, req.crop, targetW);

  // Same order as the live preview: film simulation (film.ts, on the whole
  // composite so panorama slides share one development) mixed by Intensity,
  // then the tone pass (custom LUT, highlights/shadows, brightness/contrast/
  // saturation).
  if ((FILM_IDS as string[]).includes(req.tone.lut)) {
    onProgress('Developing Film...');
    const developed = await applyFilm(mCvs, req.tone.lut as FilmId, { onStrip: () => new Promise((r) => setTimeout(r, 0)) });
    mixFilmInPlace(developed, mCvs, req.tone.lutIntensity / 100);
    mCvs.width = 0; mCvs.height = 0;
    mCvs = developed;
  }
  const color = colorAdjustFromTone(req.tone);
  if (req.tone.hasCustomLut || req.tone.highlights !== 0 || req.tone.shadows !== 0 || !isNeutralColor(color)) {
    const hlF = 1.0 + req.tone.highlights / 100.0;
    const shF = 1.0 + req.tone.shadows / 100.0;
    const toned = await Engine3D.apply(mCvs, req.tone.lutIntensity / 100, hlF, shF, req.tone.hasCustomLut, color);
    if (toned !== mCvs) { mCvs.width = 0; mCvs.height = 0; }
    mCvs = toned;
  }

  const isSingle = req.strategy === 'single';
  const isPanned = req.strategy === 'seamless' || req.strategy === 'triptych';
  const eH = mCvs.height;
  const sliceW = mCvs.width / req.slides;
  const fontSizePx = computeFontSizePx(eH, isSingle, req.typo.fontScale);
  const glowPx = computeGlowPx(req.typo.glowAmount, fontSizePx);

  const slides: ExportedSlide[] = [];
  const grainTile = req.tone.grain > 0 ? createGrainTile() : null;

  for (let i = 0; i < req.slides; i++) {
    onProgress(`Encoding File ${i + 1} / ${req.slides}...`);
    await new Promise((r) => setTimeout(r, 50));

    const finalSliceW = Math.floor(sliceW);
    const finalExportH = Math.floor(eH);
    const wCv = document.createElement('canvas');
    wCv.width = finalSliceW;
    wCv.height = finalExportH;
    const ctx = wCv.getContext('2d')!;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    renderSlideBase({
      ctx, width: finalSliceW, height: finalExportH, slideIndex: i, slidesCount: req.slides, isPanned,
      source: { image: mCvs, naturalWidth: mCvs.width, naturalHeight: mCvs.height },
      frame: req.frame, grain: { tile: grainTile, amountPct: req.tone.grain },
    });

    drawSlideOverlays(ctx, req, i, finalSliceW, finalExportH, fontSizePx, glowPx);

    const ext = 'jpg';
    const filename = isPanned ? `cineRoll_pan_${i + 1}.${ext}` : `cineRoll_output.${ext}`;
    const blob: Blob | null = await new Promise((r) => wCv.toBlob(r, mimeType, encQual));
    if (!blob) throw new Error('Failed to generate image blob');
    slides.push({ filename, blob });

    wCv.width = 0;
    wCv.height = 0;
  }

  mCvs.width = 0;
  mCvs.height = 0;
  return { slides, mimeType, sourceLimited };
}

/** Caption, logo and app watermark for slide `i` (in slide coordinates). */
function drawSlideOverlays(ctx: CanvasRenderingContext2D, req: ExportRequest, i: number, slideW: number, slideH: number, fontSizePx: number, glowPx: number): void {
  const isSingle = req.strategy === 'single';
  const shouldShowTypo = isSingle || req.typo.target === 'all' || req.typo.target === i + 1;
  if (req.typo.text && shouldShowTypo) {
    drawWatermarkText({
      ctx, text: req.typo.text, x: slideW * (req.typo.pos.x / 100), y: slideH * (req.typo.pos.y / 100),
      fontSizePx, fontFamily: req.typo.font, bold: req.typo.bold, preset: req.typo.preset,
      plainColor: req.typo.color, glow: req.typo.glow, glowPx,
    });
  }
  if (req.logo.image && req.logo.enabled && shouldShowTypo) {
    const logoWidth = slideW * 0.2 * (req.logo.scale / 100);
    drawLogo({
      ctx, image: req.logo.image, naturalWidth: req.logo.image.naturalWidth, naturalHeight: req.logo.image.naturalHeight,
      x: slideW * (req.logo.pos.x / 100), y: slideH * (req.logo.pos.y / 100), width: logoWidth, opacityPct: req.logo.opacity,
    });
  }
  if (req.appWatermark) drawAppWatermark({ ctx, width: slideW, height: slideH });
}

/**
 * Lossless: an uncompressed TIFF per slide at the crop's full resolution, built
 * band by band -- each band renders only the composite rows it needs (from the
 * original), develops the film on them with enough context rows for its blurs,
 * runs the tone pass, draws the slide's frame/caption/logo for those rows, and
 * writes them into the TIFF. No canvas ever holds the whole image, so iOS's
 * 16.7 MP canvas limit no longer shrinks the output, and the result matches a
 * one-piece render.
 */
async function runLosslessExport(req: ExportRequest, onProgress: (msg: string) => void): Promise<ExportResult> {
  const frame = getCropFrameSize(req.originalImg, req.squeeze, req.baseRotation, req.fineRotation);
  const cropPxW = req.crop.width * frame.width;
  const cropPxH = req.crop.height * frame.height;
  const { targetW: CW, targetH: CH } = computeTargetDimensions(req, cropPxW, cropPxH);
  const isSingle = req.strategy === 'single';
  const isPanned = req.strategy === 'seamless' || req.strategy === 'triptych';
  const slideW = Math.floor(CW / req.slides);
  const slideH = CH;
  const fontSizePx = computeFontSizePx(slideH, isSingle, req.typo.fontScale);
  const glowPx = computeGlowPx(req.typo.glowAmount, fontSizePx);
  const grainTile = req.tone.grain > 0 ? createGrainTile() : null;
  const isFilm = (FILM_IDS as string[]).includes(req.tone.lut);
  const film = req.tone.lut as FilmId;
  const color = colorAdjustFromTone(req.tone);
  const needsTone = req.tone.hasCustomLut || req.tone.highlights !== 0 || req.tone.shadows !== 0 || !isNeutralColor(color);
  const longSide = Math.max(CW, CH);
  const yield_ = () => new Promise<void>((r) => setTimeout(r, 0));

  // Film statistics come from the whole image (as the one-piece render measures them).
  let filmStats: ReturnType<typeof analyzeFilm> | undefined;
  let reach = 0;
  if (isFilm) {
    onProgress('Developing Film...');
    const s = Math.min(1, 2600 / longSide);
    const small = renderCroppedRegionFromOriginal(req.originalImg, req.squeeze, req.baseRotation, req.fineRotation, req.crop, CW * s);
    filmStats = analyzeFilm(small, film);
    small.width = 0; small.height = 0;
    reach = filmReach(film, longSide);
  }

  /** Composite rows [r0, r1), fully developed (film + intensity + tone), as a CW-wide canvas. */
  const developRows = async (r0: number, r1: number): Promise<HTMLCanvasElement> => {
    const h0 = isFilm ? Math.max(0, r0 - reach) : r0;
    const h1 = isFilm ? Math.min(CH, r1 + reach) : r1;
    const sub = { x: req.crop.x, width: req.crop.width, y: req.crop.y + req.crop.height * (h0 / CH), height: req.crop.height * ((h1 - h0) / CH) };
    let rows = renderCroppedRegionFromOriginal(req.originalImg, req.squeeze, req.baseRotation, req.fineRotation, sub, CW, h1 - h0);
    if (isFilm) {
      const developed = await applyFilm(rows, film, { stats: filmStats, longSide, yOffset: h0, onStrip: yield_ });
      mixFilmInPlace(developed, rows, req.tone.lutIntensity / 100);
      rows.width = 0; rows.height = 0;
      rows = developed;
    }
    if (h0 !== r0 || h1 !== r1) { // drop the context rows
      const c = document.createElement('canvas'); c.width = CW; c.height = r1 - r0;
      c.getContext('2d')!.drawImage(rows, 0, r0 - h0, CW, r1 - r0, 0, 0, CW, r1 - r0);
      rows.width = 0; rows.height = 0;
      rows = c;
    }
    if (needsTone) {
      const toned = await Engine3D.apply(rows, req.tone.lutIntensity / 100, 1 + req.tone.highlights / 100, 1 + req.tone.shadows / 100, req.tone.hasCustomLut, color);
      if (toned !== rows) { rows.width = 0; rows.height = 0; }
      rows = toned;
    }
    return rows;
  };

  const tiffs: TiffWriter[] = [];
  for (let i = 0; i < req.slides; i++) tiffs.push(createTiff(slideW, slideH, 8));
  const pvScale = Math.min(1, 1600 / Math.max(slideW, slideH));
  const previews = tiffs.map(() => { const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(slideW * pvScale)); c.height = Math.max(1, Math.round(slideH * pvScale)); return c; });

  // The photo is placed pixel-exactly and resampled here (area average, one global
  // mapping) rather than by a scaled drawImage, which engines sample differently
  // for different source rects (WebKit) -- so bands join seamlessly everywhere.
  const imgRect = slideImageRectPx(slideW, slideH, req.frame);
  const srcPerDest = CH / imgRect.height;
  const sliceW = CW / req.slides;
  const tmp = document.createElement('canvas');
  const bandRows = Math.max(16, req.bandRows ?? Math.floor(4_000_000 / Math.max(slideW, CW / 2)));
  const bandCvs = document.createElement('canvas');
  bandCvs.width = slideW;
  const total = Math.ceil(slideH / bandRows);

  for (let top = 0, n = 1; top < slideH; top += bandRows, n++) {
    onProgress(`Writing Lossless TIFF ${Math.round((n / total) * 100)}%...`);
    await yield_();
    const bottom = Math.min(slideH, top + bandRows);
    // Slide rows of the photo inside this band, and the composite rows they average.
    const a = Math.max(imgRect.y, top);
    const b = Math.min(imgRect.y + imgRect.height, bottom);
    let rows: HTMLCanvasElement | null = null;
    let rowsData: Uint8ClampedArray | null = null;
    let r0 = 0;
    if (b > a) {
      r0 = Math.max(0, Math.floor((a - imgRect.y) * srcPerDest));
      const r1 = Math.min(CH, Math.ceil((b - imgRect.y) * srcPerDest));
      rows = await developRows(r0, r1);
      rowsData = rows.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, CW, rows.height).data;
    }
    bandCvs.height = bottom - top;
    const ctx = bandCvs.getContext('2d', { willReadFrequently: true })!;
    for (let i = 0; i < req.slides; i++) {
      ctx.setTransform(1, 0, 0, 1, 0, -top);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      renderSlideBase({
        ctx, width: slideW, height: slideH, slideIndex: i, slidesCount: req.slides, isPanned,
        source: { image: bandCvs, naturalWidth: CW, naturalHeight: CH }, // unused: drawPhoto places the photo
        frame: req.frame, grain: { tile: grainTile, amountPct: req.tone.grain },
        drawPhoto: (c, rect) => {
          if (!rows || !rowsData) return;
          const x0 = isPanned ? i * sliceW : 0;
          const img = areaResampleBand(rowsData, CW, r0, rows.height, x0, x0 + (isPanned ? sliceW : CW), rect.width, srcPerDest, a - rect.y, b - rect.y);
          tmp.width = img.width; tmp.height = img.height;
          tmp.getContext('2d')!.putImageData(img, 0, 0);
          c.drawImage(tmp, rect.x, a); // 1:1, whole pixels; composites over the frame colour
        },
      });
      drawSlideOverlays(ctx, req, i, slideW, slideH, fontSizePx, glowPx);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      tiffs[i].writeRgbaRows(top, ctx.getImageData(0, 0, slideW, bottom - top).data, bottom - top);
      const pv = previews[i].getContext('2d')!;
      pv.imageSmoothingQuality = 'high';
      pv.drawImage(bandCvs, 0, top * pvScale, previews[i].width, (bottom - top) * pvScale);
    }
    if (rows) { rows.width = 0; rows.height = 0; }
  }
  bandCvs.width = 0; bandCvs.height = 0; tmp.width = 0; tmp.height = 0;

  const slides: ExportedSlide[] = [];
  for (let i = 0; i < req.slides; i++) {
    onProgress(`Encoding File ${i + 1} / ${req.slides}...`);
    const preview: Blob | null = await new Promise((r) => previews[i].toBlob(r, 'image/jpeg', 0.85));
    previews[i].width = 0; previews[i].height = 0;
    slides.push({ filename: isPanned ? `cineRoll_pan_${i + 1}.tif` : 'cineRoll_output.tif', blob: tiffs[i].blob(), preview: preview ?? undefined });
  }
  return { slides, mimeType: 'image/tiff' };
}

/**
 * 16-bit TIFF master from a RAW source (geometry only): LibRaw's 16-bit decode
 * put through the same desqueeze / base rotation / straighten / crop / slide
 * split as every other export -- computed directly on the 16-bit samples
 * (bilinear), no canvas, written band by band. Looks, frames, caption and logo
 * are 8-bit canvas work and are deliberately not applied.
 */
async function runRaw16Export(req: ExportRequest, onProgress: (msg: string) => void): Promise<ExportResult> {
  if (!req.raw16) throw new Error('16-bit TIFF needs a RAW source');
  onProgress('Decoding RAW (16-bit)...');
  const src = await req.raw16();
  const W = src.width;
  const H = src.height;
  const S = src.data;
  if (W !== req.originalImg.naturalWidth || H !== req.originalImg.naturalHeight) throw new Error('16-bit decode does not match the photo');

  const frame = getCropFrameSize(req.originalImg, req.squeeze, req.baseRotation, req.fineRotation);
  const sxF = req.crop.x * frame.width;
  const syF = req.crop.y * frame.height;
  const swF = req.crop.width * frame.width;
  const shF = req.crop.height * frame.height;
  const { targetW: CW, targetH: CH } = computeTargetDimensions(req, swF, shF);
  const isPanned = req.strategy === 'seamless' || req.strategy === 'triptych';
  const slides = isPanned ? req.slides : 1;
  const slideW = isPanned ? Math.floor(CW / slides) : CW;
  const sliceW = CW / slides;
  const sf = req.squeeze / 100;
  const th = ((req.baseRotation + req.fineRotation) * Math.PI) / 180;
  const cos = Math.cos(th);
  const sin = Math.sin(th);

  // Output pixel (X, Y) of slide i -> source sample position (u, v): the inverse of
  // renderCroppedRegionFromOriginal's transform, evaluated at pixel centres.
  const mapper = (i: number) => (X: number, Y: number): [number, number] => {
    const cx = i * sliceW + (X + 0.5) * (sliceW / slideW);
    const fx = sxF + cx * (swF / CW) - frame.width / 2;
    const fy = syF + (Y + 0.5) * (shF / CH) - frame.height / 2;
    const qx = cos * fx + sin * fy;
    const qy = -sin * fx + cos * fy;
    return [(qx + (W * sf) / 2) / sf - 0.5, qy + H / 2 - 0.5];
  };

  const sample = (u: number, v: number, out: Uint16Array, o: number) => {
    if (u < -0.5 || v < -0.5 || u > W - 0.5 || v > H - 0.5) { out[o] = 0; out[o + 1] = 0; out[o + 2] = 0; return; }
    const x0 = Math.min(W - 1, Math.max(0, Math.floor(u)));
    const y0 = Math.min(H - 1, Math.max(0, Math.floor(v)));
    const x1 = Math.min(W - 1, x0 + 1);
    const y1 = Math.min(H - 1, y0 + 1);
    const tx = Math.min(1, Math.max(0, u - x0));
    const ty = Math.min(1, Math.max(0, v - y0));
    const i00 = (y0 * W + x0) * 3; const i10 = (y0 * W + x1) * 3; const i01 = (y1 * W + x0) * 3; const i11 = (y1 * W + x1) * 3;
    for (let c = 0; c < 3; c++) {
      const top = S[i00 + c] + (S[i10 + c] - S[i00 + c]) * tx;
      const bot = S[i01 + c] + (S[i11 + c] - S[i01 + c]) * tx;
      out[o + c] = Math.round(top + (bot - top) * ty);
    }
  };

  const slidesOut: ExportedSlide[] = [];
  const BAND = 256;
  const pvScale = Math.min(1, 1600 / Math.max(slideW, CH));
  for (let i = 0; i < slides; i++) {
    const map = mapper(i);
    // The map is affine: origin + per-X and per-Y steps.
    const [u0, v0] = map(0, 0);
    const [uX, vX] = map(1, 0);
    const [uY, vY] = map(0, 1);
    const du = [uX - u0, uY - u0];
    const dv = [vX - v0, vY - v0];
    const tiff = createTiff(slideW, CH, 16);
    const band = new Uint16Array(slideW * BAND * 3);
    for (let y0 = 0; y0 < CH; y0 += BAND) {
      onProgress(`Writing 16-bit TIFF ${i + 1}/${slides} -- ${Math.round((y0 / CH) * 100)}%`);
      await new Promise((r) => setTimeout(r, 0));
      const rows = Math.min(BAND, CH - y0);
      for (let r = 0; r < rows; r++) {
        const Y = y0 + r;
        let u = u0 + du[1] * Y;
        let v = v0 + dv[1] * Y;
        let o = r * slideW * 3;
        for (let X = 0; X < slideW; X++, o += 3, u += du[0], v += dv[0]) sample(u, v, band, o);
      }
      tiff.writeRgb16Rows(y0, band, rows);
    }
    // Small 8-bit preview for the gallery (TIFF isn't displayable).
    const pw = Math.max(1, Math.round(slideW * pvScale));
    const ph = Math.max(1, Math.round(CH * pvScale));
    const pv = new ImageData(pw, ph);
    const px = new Uint16Array(3);
    for (let y = 0; y < ph; y++) for (let x = 0; x < pw; x++) {
      const [u, v] = map((x + 0.5) / pvScale - 0.5, (y + 0.5) / pvScale - 0.5);
      sample(u, v, px, 0);
      const j = (y * pw + x) * 4; pv.data[j] = px[0] >> 8; pv.data[j + 1] = px[1] >> 8; pv.data[j + 2] = px[2] >> 8; pv.data[j + 3] = 255;
    }
    const pc = document.createElement('canvas'); pc.width = pw; pc.height = ph; pc.getContext('2d')!.putImageData(pv, 0, 0);
    const preview: Blob | null = await new Promise((r) => pc.toBlob(r, 'image/jpeg', 0.85));
    pc.width = 0;
    slidesOut.push({ filename: isPanned ? `cineRoll_pan_${i + 1}_16bit.tif` : 'cineRoll_output_16bit.tif', blob: tiff.blob(), preview: preview ?? undefined });
  }
  return { slides: slidesOut, mimeType: 'image/tiff', geometryOnly16: true };
}

export type DeliveryOutcome = 'downloaded-single' | 'downloaded-zip' | 'shared' | 'share-fallback';

/** Packages the rendered slides for delivery: a direct download (single file or zip) on desktop, or the native share sheet on mobile. */
export async function packageAndDeliver(result: ExportResult, isMobile: boolean, onProgress: (msg: string) => void): Promise<DeliveryOutcome> {
  const fArr = result.slides.map((s) => new File([s.blob], s.filename, { type: result.mimeType }));

  if (!isMobile) {
    if (result.slides.length === 1) {
      const l = document.createElement('a');
      l.href = URL.createObjectURL(result.slides[0].blob);
      l.download = result.slides[0].filename;
      l.click();
      return 'downloaded-single';
    }
    onProgress('Packaging Gallery (ZIP)...');
    await new Promise((r) => setTimeout(r, 100));
    const zip = new JSZip();
    for (const s of result.slides) zip.file(s.filename, s.blob);
    const c = await zip.generateAsync({ type: 'blob' });
    const l = document.createElement('a');
    l.href = URL.createObjectURL(c);
    l.download = 'cineRoll_Gallery.zip';
    l.click();
    return 'downloaded-zip';
  }

  try {
    if ((navigator as any).canShare && (navigator as any).canShare({ files: fArr })) {
      await (navigator as any).share({ files: fArr });
      return 'shared';
    }
    throw new Error('share unsupported');
  } catch (_e) {
    return 'share-fallback';
  }
}
