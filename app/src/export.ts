import JSZip from 'jszip';
import type { BorderStyle, CropRect, LutChoice, SqueezeFactor, Strategy, TextPreset, WatermarkTarget } from './state';
import { getCropFrameSize, renderCroppedRegionFromOriginal } from './crop';
import { Engine3D, buildToneFilterString, createGrainTile } from './compose';
import { renderSlideBase, computeFontSizePx, computeGlowPx, drawWatermarkText, drawLogo, drawAppWatermark } from './render';

export type ExportQuality = 'ig' | 'web' | 'png';

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
}

export interface ExportedSlide {
  filename: string;
  blob: Blob;
}

export interface ExportResult {
  slides: ExportedSlide[];
  mimeType: string;
}

const SAFE_MAX_DIM = 16000;

/** Computes the composite's target width/height for the given quality mode, capped by the true source resolution (Lossless) and hard safety limits. */
function computeTargetDimensions(req: ExportRequest, cropPxW: number, cropPxH: number): { targetW: number; targetH: number; mimeType: string; encQual: number } {
  const activeRatio = cropPxW && cropPxH ? cropPxW / cropPxH : 1;
  const MAX_AREA = req.isMobile ? 16777216 : 67108864;

  let mimeType = 'image/jpeg';
  let encQual = 0.9;
  let targetW = 0;

  if (req.qualityMode === 'web') {
    const bW = req.isMobile ? 3000 : 6000;
    encQual = 1.0;
    targetW = req.strategy === 'seamless' ? bW * req.slides : bW;
  } else if (req.qualityMode === 'ig') {
    const bW = 2160;
    targetW = req.strategy === 'seamless' ? bW * req.slides : bW;
  } else {
    mimeType = 'image/png';
    // Lossless means "the true native resolution of the crop", not an
    // arbitrary upscale target -- cap by the actual desqueezed source
    // pixels rather than always reaching for SAFE_MAX_DIM.
    targetW = Math.min(cropPxW, SAFE_MAX_DIM);
  }

  let targetH = targetW / activeRatio;

  if (targetW > SAFE_MAX_DIM || targetH > SAFE_MAX_DIM) {
    const s = Math.min(SAFE_MAX_DIM / targetW, SAFE_MAX_DIM / targetH);
    targetW *= s;
    targetH *= s;
  }
  if (targetW * targetH > MAX_AREA) {
    const s = Math.sqrt(MAX_AREA / (targetW * targetH));
    targetW *= s;
    targetH *= s;
  }

  targetW = Math.floor(targetW);
  targetH = Math.floor(targetW / activeRatio);
  return { targetW, targetH, mimeType, encQual };
}

/**
 * Renders every slide at export resolution and returns the encoded blobs.
 * DOM-agnostic: the caller owns loading UI, gallery previews, and delivery
 * (download / zip / share) -- see packageAndDeliver().
 */
export async function runExport(req: ExportRequest, onProgress: (msg: string) => void): Promise<ExportResult> {
  const frame = getCropFrameSize(req.originalImg, req.squeeze, req.baseRotation, req.fineRotation);
  const cropPxW = req.crop.width * frame.width;
  const cropPxH = req.crop.height * frame.height;

  const { targetW, mimeType, encQual } = computeTargetDimensions(req, cropPxW, cropPxH);

  await new Promise((r) => setTimeout(r, 50));
  let mCvs: HTMLCanvasElement = renderCroppedRegionFromOriginal(req.originalImg, req.squeeze, req.baseRotation, req.fineRotation, req.crop, targetW);

  // brightness/contrast/saturation + the kodak/fuji/cinematic CSS-emulated LUTs are baked into
  // the base composite via the same filterString the live preview uses (renderSlideBase below);
  // only the WebGL-only custom-LUT/highlight-shadow pass needs a separate pre-processing step here.
  if (req.tone.hasCustomLut || req.tone.highlights !== 0 || req.tone.shadows !== 0) {
    const hlF = 1.0 + req.tone.highlights / 100.0;
    const shF = 1.0 + req.tone.shadows / 100.0;
    mCvs = await Engine3D.apply(mCvs, req.tone.lutIntensity / 100, hlF, shF, req.tone.hasCustomLut);
  }

  const filterString = buildToneFilterString(req.tone);
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
      filterString, frame: req.frame, grain: { tile: grainTile, amountPct: req.tone.grain },
    });

    const shouldShowTypo = isSingle || req.typo.target === 'all' || req.typo.target === i + 1;

    if (req.typo.text && shouldShowTypo) {
      drawWatermarkText({
        ctx, text: req.typo.text, x: finalSliceW * (req.typo.pos.x / 100), y: finalExportH * (req.typo.pos.y / 100),
        fontSizePx, fontFamily: req.typo.font, bold: req.typo.bold, preset: req.typo.preset,
        plainColor: req.typo.color, glow: req.typo.glow, glowPx,
      });
    }

    if (req.logo.image && req.logo.enabled && shouldShowTypo) {
      const logoWidth = finalSliceW * 0.2 * (req.logo.scale / 100);
      drawLogo({
        ctx, image: req.logo.image, naturalWidth: req.logo.image.naturalWidth, naturalHeight: req.logo.image.naturalHeight,
        x: finalSliceW * (req.logo.pos.x / 100), y: finalExportH * (req.logo.pos.y / 100), width: logoWidth, opacityPct: req.logo.opacity,
      });
    }

    if (req.appWatermark) drawAppWatermark({ ctx, width: finalSliceW, height: finalExportH });

    const ext = mimeType === 'image/png' ? 'png' : 'jpg';
    const filename = isPanned ? `cineRoll_pan_${i + 1}.${ext}` : `cineRoll_output.${ext}`;
    const blob: Blob | null = await new Promise((r) => wCv.toBlob(r, mimeType, encQual));
    if (!blob) throw new Error('Failed to generate image blob');
    slides.push({ filename, blob });

    wCv.width = 0;
    wCv.height = 0;
  }

  mCvs.width = 0;
  mCvs.height = 0;
  return { slides, mimeType };
}

export type DeliveryOutcome = 'downloaded-single' | 'downloaded-zip' | 'shared' | 'share-fallback';

/** Packages the rendered slides for delivery: a direct download (single file or zip) on desktop, or the native share sheet on mobile. */
export async function packageAndDeliver(result: ExportResult, isMobile: boolean, onProgress: (msg: string) => void): Promise<DeliveryOutcome> {
  const fArr = result.slides.map((s) => new File([s.blob], s.filename, { type: result.mimeType }));

  if (!isMobile) {
    if (result.slides.length === 1) {
      const l = document.createElement('a');
      l.href = URL.createObjectURL(result.slides[0].blob);
      l.download = `cineRoll_Output.${result.mimeType === 'image/png' ? 'png' : 'jpg'}`;
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
