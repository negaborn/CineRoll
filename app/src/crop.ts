import Cropper from 'cropperjs';
import 'cropperjs/dist/cropper.css';
import { editState, type CropRect } from './state';

export interface SmartSnapInfo {
  label: string | null;
  box: { top: number; left: number; width: number; height: number } | null;
}

export interface CropControllerOptions {
  onSmartSnap?: (info: SmartSnapInfo) => void;
}

/** Rotates a normalized [0,1] crop rect 90 degrees clockwise within its image plane. */
export function rotateRect90CW(r: CropRect): CropRect {
  return { x: 1 - r.y - r.height, y: r.x, width: r.height, height: r.width };
}

/**
 * Renders the original image onto a canvas that has been desqueezed (horizontal
 * stretch by squeezePct/100) and pre-rotated by baseRotation (0/90/180/270),
 * capped to a modest working resolution. This is the "view" image Cropper.js
 * operates on -- normalized crop fractions are resolution independent, so this
 * proxy's absolute size never leaks into stored state.
 */
export async function buildProxyImage(original: HTMLImageElement, squeezePct: number, baseRotation: number): Promise<HTMLImageElement> {
  const sf = squeezePct / 100;
  let tw = original.naturalWidth * sf;
  let th = original.naturalHeight;
  const maxW = 3500;
  if (tw > maxW) {
    const scale = maxW / tw;
    th *= scale;
    tw = maxW;
  }

  const cvs = document.createElement('canvas');
  const rotated90 = baseRotation === 90 || baseRotation === 270;
  cvs.width = rotated90 ? th : tw;
  cvs.height = rotated90 ? tw : th;
  const ctx = cvs.getContext('2d')!;
  ctx.save();
  ctx.translate(cvs.width / 2, cvs.height / 2);
  ctx.rotate((baseRotation * Math.PI) / 180);
  ctx.drawImage(original, -tw / 2, -th / 2, tw, th);
  ctx.restore();

  const blob: Blob = await new Promise((resolve) => cvs.toBlob((b) => resolve(b!), 'image/jpeg', 0.95));
  cvs.width = 0;
  cvs.height = 0;

  const img = new Image();
  const url = URL.createObjectURL(blob);
  await new Promise<void>((resolve) => {
    img.onload = () => resolve();
    img.src = url;
  });
  return img;
}

export function getDesqueezedPlaneSize(original: HTMLImageElement, squeezePct: number, baseRotation: number): { width: number; height: number } {
  const sf = squeezePct / 100;
  const w = original.naturalWidth * sf;
  const h = original.naturalHeight;
  const rotated90 = baseRotation === 90 || baseRotation === 270;
  return rotated90 ? { width: h, height: w } : { width: w, height: h };
}

/**
 * Renders the full-resolution desqueezed+base-rotated source and extracts the
 * normalized crop region from it, scaled to targetWidth (height derived from
 * the crop's own aspect ratio). Used at export time, when no live Cropper
 * instance exists (Format tab is destroyed once the user navigates away).
 */
export function renderCroppedRegionFromOriginal(
  original: HTMLImageElement,
  squeezePct: number,
  baseRotation: number,
  crop: CropRect,
  targetWidth: number,
): HTMLCanvasElement {
  const sf = squeezePct / 100;
  const plane = getDesqueezedPlaneSize(original, squeezePct, baseRotation);

  const full = document.createElement('canvas');
  full.width = plane.width;
  full.height = plane.height;
  const fctx = full.getContext('2d')!;
  fctx.save();
  fctx.translate(full.width / 2, full.height / 2);
  fctx.rotate((baseRotation * Math.PI) / 180);
  fctx.drawImage(original, -(original.naturalWidth * sf) / 2, -original.naturalHeight / 2, original.naturalWidth * sf, original.naturalHeight);
  fctx.restore();

  const sx = crop.x * plane.width;
  const sy = crop.y * plane.height;
  const sw = crop.width * plane.width;
  const sh = crop.height * plane.height;
  const targetHeight = Math.max(1, Math.round(targetWidth * (sh / sw)));

  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(targetWidth));
  out.height = targetHeight;
  out.getContext('2d')!.drawImage(full, sx, sy, sw, sh, 0, 0, out.width, out.height);
  full.width = 0;
  full.height = 0;
  return out;
}

export class CropController {
  private container: HTMLElement;
  private options: CropControllerOptions;
  private cropper: any = null;
  private proxyNaturalWidth = 0;
  private proxyNaturalHeight = 0;
  private originalImg: HTMLImageElement | null = null;
  private squeezePct = 100;
  private ready = false;

  constructor(container: HTMLElement, options: CropControllerOptions = {}) {
    this.container = container;
    this.options = options;
  }

  get isReady(): boolean {
    return this.ready;
  }

  get instance(): any {
    return this.cropper;
  }

  /** (Re)builds the proxy image for the current squeeze/base-rotation and mounts Cropper on it. */
  async mount(original: HTMLImageElement, squeezePct: number): Promise<void> {
    this.destroy();
    this.originalImg = original;
    this.squeezePct = squeezePct;

    const state = editState.get();
    const proxy = await buildProxyImage(original, squeezePct, state.rotation.base);
    proxy.style.display = 'block';
    proxy.style.maxWidth = '100%';
    this.proxyNaturalWidth = proxy.naturalWidth;
    this.proxyNaturalHeight = proxy.naturalHeight;

    this.container.innerHTML = '';
    this.container.appendChild(proxy);

    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        this.cropper = new Cropper(proxy, {
          viewMode: 1,
          dragMode: 'none',
          autoCrop: false,
          background: false,
          checkOrientation: true,
          ready: () => {
            // Snapshot the wanted crop *before* calling .crop()/setAspectRatio() below --
            // both fire their own 'crop' event with Cropper's transient default box, which
            // would otherwise clobber editState.crop before we get to restore it.
            const wanted = editState.get().crop;
            const isFresh = wanted.width <= 0 || wanted.height <= 0;

            this.cropper.crop();
            this.applyAspectFromState();

            if (isFresh) {
              this.centerDefaultCropBox();
            } else {
              this.restoreFromState(wanted);
            }

            this.cropper.rotateTo(editState.get().rotation.fine);
            this.ready = true;
            resolve();
          },
          crop: () => {
            this.onCropBoxChange();
            this.updateSmartSnapBadge();
          },
        });
      });
    });
  }

  destroy(): void {
    // Null out the reference before calling the real destroy() so that any
    // crop/cropend event Cropper.js fires synchronously during its own
    // teardown is ignored by onCropBoxChange/updateSmartSnapBadge instead of
    // clobbering editState.crop with a stale/reset box.
    const c = this.cropper;
    this.cropper = null;
    this.ready = false;
    if (c) c.destroy();
  }

  resize(): void {
    if (this.cropper) this.cropper.resize();
  }

  setFineAngle(deg: number): void {
    editState.update((s) => ({ ...s, rotation: { ...s.rotation, fine: deg } }));
    if (this.cropper) this.cropper.rotateTo(editState.get().rotation.base + deg);
  }

  /** Rotates the base orientation by +/-90 and re-renders the proxy pre-rotated. */
  async rotateBase(deltaDeg: 90 | -90 = 90): Promise<void> {
    const s = editState.get();
    const nextBase = (((s.rotation.base + deltaDeg) % 360) + 360) % 360 as 0 | 90 | 180 | 270;
    const steps = ((deltaDeg / 90) % 4 + 4) % 4;
    let rect = s.crop;
    for (let i = 0; i < steps; i++) rect = rotateRect90CW(rect);

    editState.update((prev) => ({ ...prev, rotation: { ...prev.rotation, base: nextBase }, crop: rect }));

    if (this.originalImg) {
      await this.mount(this.originalImg, this.squeezePct);
    }
  }

  /**
   * Re-fits the crop box to a new *logical* (un-rotated) target aspect ratio
   * while preserving its center. Internally accounts for the proxy's
   * width/height swap under a 90/270 base rotation, same as computeTargetAspect().
   */
  retarget(newLogicalAspect: number): void {
    const s = editState.get();
    const rotated = s.rotation.base === 90 || s.rotation.base === 270;
    const newAspect = !isNaN(newLogicalAspect) && rotated ? 1 / newLogicalAspect : newLogicalAspect;

    const c = s.crop;
    const cx = c.x + c.width / 2;
    const cy = c.y + c.height / 2;

    // newAspect is a *pixel* aspect ratio (width_px/height_px); normalized
    // fractions only equal pixel ratios when the proxy image is square, so
    // convert through the proxy's own pixel aspect ratio.
    const imageAspect = this.proxyNaturalWidth && this.proxyNaturalHeight ? this.proxyNaturalWidth / this.proxyNaturalHeight : 1;
    const newFractionAspect = isNaN(newAspect) ? NaN : newAspect / imageAspect;

    let w = c.width;
    let h = c.height;
    if (!isNaN(newFractionAspect) && c.height > 0) {
      w = h * newFractionAspect;
      if (w > 1) {
        w = 1;
        h = w / newFractionAspect;
      }
    }

    let x = cx - w / 2;
    let y = cy - h / 2;
    x = Math.max(0, Math.min(1 - w, x));
    y = Math.max(0, Math.min(1 - h, y));

    const rect: CropRect = { x, y, width: w, height: h };
    editState.update((prev) => ({ ...prev, crop: rect }));

    if (this.cropper) {
      // setAspectRatio() synchronously resets Cropper's own crop box (firing a
      // 'crop' event that would clobber editState.crop via onCropBoxChange),
      // so pass `rect` explicitly rather than letting restoreFromState() re-read
      // editState after that reset has already happened.
      this.cropper.setAspectRatio(newAspect);
      this.restoreFromState(rect);
    }
  }

  /**
   * The target crop-box aspect ratio, in the *displayed proxy's* coordinate
   * frame. When the base rotation is 90/270 the proxy's width/height roles
   * are swapped relative to the un-rotated strategy/ratio settings, so the
   * target aspect must be inverted to match.
   */
  private computeTargetAspect(): number {
    const s = editState.get();
    let fr = NaN;
    if (s.strategy === 'seamless' && s.baseRatio != null) fr = s.baseRatio * s.slides;
    else fr = s.baseRatio ?? NaN;
    if (!isNaN(fr) && (s.rotation.base === 90 || s.rotation.base === 270)) fr = 1 / fr;
    return fr;
  }

  private applyAspectFromState(): void {
    if (!this.cropper) return;
    this.cropper.setAspectRatio(this.computeTargetAspect());
  }

  private centerDefaultCropBox(): void {
    if (!this.cropper) return;
    const cd = this.cropper.getCanvasData();
    // NOTE: this.cropper.options.aspectRatio reflects only the constructor-time
    // option, not a later setAspectRatio() call -- recompute instead of reading it.
    const fr = this.computeTargetAspect();
    let bw = cd.width * 0.85;
    let bh = cd.height * 0.85;
    if (!isNaN(fr)) {
      const cr = cd.width / cd.height;
      if (fr > cr) {
        bw = cd.width * 0.85;
        bh = bw / fr;
      } else {
        bh = cd.height * 0.85;
        bw = bh * fr;
      }
    }
    this.cropper.setCropBoxData({ left: cd.left + (cd.width - bw) / 2, top: cd.top + (cd.height - bh) / 2, width: bw, height: bh });
  }

  private restoreFromState(rect?: CropRect): void {
    if (!this.cropper || !this.proxyNaturalWidth) return;
    const crop = rect ?? editState.get().crop;
    this.cropper.setData({
      x: crop.x * this.proxyNaturalWidth,
      y: crop.y * this.proxyNaturalHeight,
      width: crop.width * this.proxyNaturalWidth,
      height: crop.height * this.proxyNaturalHeight,
    });
  }

  private onCropBoxChange(): void {
    if (!this.cropper || !this.proxyNaturalWidth || !this.proxyNaturalHeight) return;
    const data = this.cropper.getData();
    const rect: CropRect = {
      x: data.x / this.proxyNaturalWidth,
      y: data.y / this.proxyNaturalHeight,
      width: data.width / this.proxyNaturalWidth,
      height: data.height / this.proxyNaturalHeight,
    };
    editState.update((s) => ({ ...s, crop: rect }));
  }

  private updateSmartSnapBadge(): void {
    if (!this.options.onSmartSnap || !this.cropper) return;
    const isFree = isNaN(this.cropper.options.aspectRatio);
    if (!isFree) {
      this.options.onSmartSnap({ label: null, box: null });
      return;
    }
    const d = this.cropper.getCropBoxData();
    if (!d || d.width === 0 || d.height === 0) return;
    const r = d.width / d.height;
    let label: string | null = null;
    if (r > 0.78 && r < 0.82) label = '4:5 Vertical IG';
    else if (r > 0.98 && r < 1.02) label = '1:1 Square';
    else if (r > 1.75 && r < 1.8) label = '16:9 Landscape';
    else if (r > 0.65 && r < 0.68) label = '2:3 Vertical';
    else if (r > 1.45 && r < 1.55) label = '3:2 Horizontal';
    else if (r > 0.74 && r < 0.76) label = '3:4 Classic';
    this.options.onSmartSnap({ label, box: label ? { top: d.top, left: d.left, width: d.width, height: d.height } : null });
  }

  /** Test-only: force the normalized crop rect and reflect it onto the live Cropper instance if mounted. */
  setCropForTest(rect: CropRect): void {
    editState.update((s) => ({ ...s, crop: rect }));
    if (this.cropper) this.restoreFromState();
  }

  /** Reads the crop box in the *original* (pre-desqueeze, pre-base-rotation) image's pixel space, for cropping/export. */
  getCroppedCanvas(options: Record<string, unknown>): HTMLCanvasElement | null {
    if (!this.cropper) return null;
    return this.cropper.getCroppedCanvas(options);
  }
}
