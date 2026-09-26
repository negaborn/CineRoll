import Cropper from 'cropperjs';
import 'cropperjs/dist/cropper.css';
import { areaDownscale } from './resample';
import { editState, type CropRect } from './state';
import { findSnapTarget, type SnapTarget } from './snap';

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
  // Cap the longer side, not just the width: a tall portrait/scroll-shaped
  // photo would otherwise produce a proxy far over mobile canvas limits.
  const MAX_SIDE = 3500;
  const scale = Math.min(1, MAX_SIDE / (original.naturalWidth * sf), MAX_SIDE / original.naturalHeight);
  const tw = Math.round(original.naturalWidth * sf * scale);
  const th = Math.round(original.naturalHeight * scale);

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

/** Axis-aligned bounding box of a w x h rectangle rotated by deg. */
export function rotatedBounds(w: number, h: number, deg: number): { width: number; height: number } {
  const t = (deg * Math.PI) / 180;
  const c = Math.abs(Math.cos(t));
  const s = Math.abs(Math.sin(t));
  return { width: w * c + h * s, height: w * s + h * c };
}

/**
 * The frame the normalized crop rect lives in: the desqueezed, base-rotated
 * plane, further rotated by the fine (straighten) angle, as its bounding box.
 * This is exactly what Cropper.js crops within once the image is rotated, so
 * crop fractions stored against it round-trip through getData()/setData().
 * With fine = 0 it is just the plane.
 */
export function getCropFrameSize(original: HTMLImageElement, squeezePct: number, baseRotation: number, fineDeg: number): { width: number; height: number } {
  const plane = getDesqueezedPlaneSize(original, squeezePct, baseRotation);
  return rotatedBounds(plane.width, plane.height, fineDeg);
}

/**
 * Renders the normalized crop region of the desqueezed + base-rotated +
 * straightened source at targetWidth (height from the crop's own aspect), for
 * export -- when no live Cropper exists. Desqueeze, both rotations and the
 * crop are composed into a single transform and the original is drawn
 * straight onto an output-sized canvas, so the only canvas allocated is the
 * output itself: never the full desqueezed frame, which for a phone photo at
 * 2x easily exceeds the ~16.7 MP per-canvas limit on iOS Safari. Areas the
 * straightened image doesn't cover stay transparent, matching Cropper's own
 * getCroppedCanvas() used for the preview.
 */
export function renderCroppedRegionFromOriginal(
  original: HTMLImageElement,
  squeezePct: number,
  baseRotation: number,
  fineDeg: number,
  crop: CropRect,
  targetWidth: number,
): HTMLCanvasElement {
  const sf = squeezePct / 100;
  const frame = getCropFrameSize(original, squeezePct, baseRotation, fineDeg);
  const sx = crop.x * frame.width;
  const sy = crop.y * frame.height;
  const sw = crop.width * frame.width;
  const sh = crop.height * frame.height;

  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(targetWidth));
  out.height = Math.max(1, Math.round(targetWidth * (sh / sw)));
  const ctx = out.getContext('2d')!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  // frame space -> output space
  ctx.scale(out.width / sw, out.height / sh);
  ctx.translate(-sx, -sy);
  // original -> frame space: desqueeze, then rotate (base + straighten) about the frame's center
  ctx.translate(frame.width / 2, frame.height / 2);
  ctx.rotate(((baseRotation + fineDeg) * Math.PI) / 180);
  const dw = original.naturalWidth * sf;
  const dh = original.naturalHeight;
  const k = out.width / sw; // output px per frame px
  if (k >= 0.9) {
    ctx.drawImage(original, -dw / 2, -dh / 2, dw, dh);
    return out;
  }
  // Big downscale (the preview's working image, small exports): browsers resample
  // this very differently -- on WebKit the same photo came out ~2x "sharper"
  // (aliased) than in the film prototypes, and the film passes amplify that. So
  // first area-average just the source region we need (resample.ts, identical on
  // every engine), then rotate/crop that at ~1:1.
  const inv = ctx.getTransform().inverse();
  let u0 = Infinity; let v0 = Infinity; let u1 = -Infinity; let v1 = -Infinity;
  for (const [ox, oy] of [[0, 0], [out.width, 0], [0, out.height], [out.width, out.height]]) {
    const p = inv.transformPoint(new DOMPoint(ox, oy));
    const u = (p.x + dw / 2) / sf; // back to original pixels
    const v = p.y + dh / 2;
    u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
  }
  u0 = Math.max(0, Math.floor(u0) - 2); v0 = Math.max(0, Math.floor(v0) - 2);
  u1 = Math.min(original.naturalWidth, Math.ceil(u1) + 2); v1 = Math.min(original.naturalHeight, Math.ceil(v1) + 2);
  if (u1 <= u0 || v1 <= v0) return out; // crop lies entirely outside the photo
  // Reduce only (a desqueeze stretch beyond 1:1 is left to the final draw).
  const pw = Math.max(1, Math.round((u1 - u0) * Math.min(1, sf * k)));
  const ph = Math.max(1, Math.round((v1 - v0) * k));
  const pre = areaDownscale(original, u0, v0, u1 - u0, v1 - v0, pw, ph);
  ctx.drawImage(pre, -dw / 2 + u0 * sf, -dh / 2 + v0, (u1 - u0) * sf, v1 - v0);
  pre.width = 0; pre.height = 0;
  return out;
}

export class CropController {
  private container: HTMLElement;
  private options: CropControllerOptions;
  private cropper: any = null;
  private proxyNaturalWidth = 0;
  private proxyNaturalHeight = 0;
  private ready = false;
  /** Bumped by every mount() and destroy(); an in-flight mount whose number is stale abandons itself. */
  private mountSeq = 0;
  /** Settles the in-flight mount's promise (with false) if it gets superseded before Cropper is ready. */
  private settlePendingMount: ((ok: boolean) => void) | null = null;
  /** Touch pointers currently down (tracked in the capture phase, ahead of Cropper's own handlers). */
  private activeTouches = new Set<number>();
  /** True once a second finger joined the current touch gesture; cleared when the next gesture starts. */
  private multiTouch = false;
  /** Crop box when the current touch gesture began -- restored if it turns into a multi-finger gesture. */
  private gestureStartBox: { left: number; top: number; width: number; height: number } | null = null;

  constructor(container: HTMLElement, options: CropControllerOptions = {}) {
    this.container = container;
    this.options = options;
    window.addEventListener('pointerdown', (e) => { if (e.pointerType === 'touch') this.activeTouches.add(e.pointerId); }, true);
    const lift = (e: PointerEvent) => { if (e.pointerType === 'touch') this.activeTouches.delete(e.pointerId); };
    window.addEventListener('pointerup', lift, true);
    window.addEventListener('pointercancel', lift, true);
  }

  /**
   * Cropper's cropstart. A pinch must not edit the crop (photo zoom is off, and
   * Cropper would otherwise drag the box with one of the fingers): when a second
   * finger lands, put the box back where the gesture started and ignore the
   * gesture until every finger is lifted.
   */
  private onCropStart(e: CustomEvent): void {
    const pe = e.detail?.originalEvent as PointerEvent | undefined;
    if (!this.cropper || !pe || pe.pointerType !== 'touch') return;
    if (this.activeTouches.size > 1) {
      if (!this.multiTouch) {
        this.multiTouch = true;
        if (this.gestureStartBox) this.cropper.setCropBoxData(this.gestureStartBox);
      }
      e.preventDefault();
      return;
    }
    this.multiTouch = false;
    this.gestureStartBox = this.cropper.getCropBoxData();
  }

  get isReady(): boolean {
    return this.ready;
  }

  get instance(): any {
    return this.cropper;
  }

  /**
   * (Re)builds the proxy image for the current squeeze/base-rotation and mounts
   * Cropper on it. Resolves true once Cropper is ready, or false if a newer
   * mount() or a destroy() superseded this one first -- a superseded mount
   * never touches the DOM or creates a Cropper, so overlapping rebuilds (e.g.
   * two quick squeeze changes) can't leave a half-built instance behind.
   */
  async mount(original: HTMLImageElement, squeezePct: number): Promise<boolean> {
    this.destroy();
    const seq = this.mountSeq;
    const stale = () => seq !== this.mountSeq;

    const proxy = await buildProxyImage(original, squeezePct, editState.get().rotation.base);
    if (stale()) return false;
    proxy.style.display = 'block';
    proxy.style.maxWidth = '100%';
    this.proxyNaturalWidth = proxy.naturalWidth;
    this.proxyNaturalHeight = proxy.naturalHeight;

    this.container.innerHTML = '';
    this.container.appendChild(proxy);

    return new Promise<boolean>((resolve) => {
      this.settlePendingMount = resolve;
      requestAnimationFrame(() => {
        if (stale()) return; // destroy() already settled this promise
        this.cropper = new Cropper(proxy, {
          viewMode: 1,
          dragMode: 'none',
          // No photo zoom: a pinch or wheel/trackpad scroll would scale the photo
          // behind a fixed crop box and silently change the crop.
          zoomable: false,
          autoCrop: false,
          background: false,
          checkOrientation: true,
          ready: () => {
            if (stale()) return;
            // Snapshot the wanted crop *before* calling .crop()/setAspectRatio() below --
            // both fire their own 'crop' event with Cropper's transient default box, which
            // would otherwise clobber editState.crop before we get to restore it.
            const wanted = editState.get().crop;
            const isFresh = wanted.width <= 0 || wanted.height <= 0;

            this.cropper.crop();
            this.applyAspectFromState();
            // Straighten *before* placing the crop box: the stored rect is relative to
            // the straightened frame, which only exists once Cropper has rotated.
            this.cropper.rotateTo(editState.get().rotation.fine);

            if (isFresh) {
              this.centerDefaultCropBox();
            } else {
              this.restoreFromState(wanted);
            }

            this.ready = true;
            this.settlePendingMount = null;
            resolve(true);
          },
          crop: () => {
            this.onCropBoxChange();
            this.updateSmartSnapBadge();
          },
          cropstart: (e: CustomEvent) => this.onCropStart(e),
          cropmove: (e: CustomEvent) => { if (this.multiTouch) e.preventDefault(); },
          // Fires only on pointer release (never for programmatic setData/setCropBoxData).
          cropend: () => {
            if (stale() || this.multiTouch) return;
            this.snapOnRelease();
          },
        });
      });
    });
  }

  destroy(): void {
    this.mountSeq++;
    if (this.settlePendingMount) {
      this.settlePendingMount(false);
      this.settlePendingMount = null;
    }
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

  /** Applies EditState's straighten angle to the live Cropper (the base rotation is already baked into the proxy). */
  syncFineAngle(): void {
    if (this.cropper) this.cropper.rotateTo(editState.get().rotation.fine);
  }

  /** Re-applies the target aspect and centers a fresh default crop box (used by Reset framing). */
  resetCropBox(): void {
    if (!this.cropper) return;
    this.applyAspectFromState();
    this.centerDefaultCropBox();
  }

  /** The straightened proxy's bounding box, in proxy pixels -- the space getData()/setData() work in. */
  private frameSize(): { width: number; height: number } {
    return rotatedBounds(this.proxyNaturalWidth, this.proxyNaturalHeight, editState.get().rotation.fine);
  }

  /**
   * Rotates the base orientation by +/-90 in EditState, remapping the crop rect
   * exactly. The caller re-mounts (the proxy image has the base rotation baked in).
   */
  rotateBase(deltaDeg: 90 | -90 = 90): void {
    const s = editState.get();
    const nextBase = (((s.rotation.base + deltaDeg) % 360) + 360) % 360 as 0 | 90 | 180 | 270;
    const steps = ((deltaDeg / 90) % 4 + 4) % 4;
    let rect = s.crop;
    for (let i = 0; i < steps; i++) rect = rotateRect90CW(rect);
    editState.update((prev) => ({ ...prev, rotation: { ...prev.rotation, base: nextBase }, crop: rect }));
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
    // fractions only equal pixel ratios when the crop frame is square, so
    // convert through the (straightened) frame's own pixel aspect ratio.
    const f = this.frameSize();
    const imageAspect = f.width && f.height ? f.width / f.height : 1;
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
    const f = this.frameSize();
    this.cropper.setData({
      x: crop.x * f.width,
      y: crop.y * f.height,
      width: crop.width * f.width,
      height: crop.height * f.height,
    });
  }

  private onCropBoxChange(): void {
    if (!this.cropper || !this.proxyNaturalWidth || !this.proxyNaturalHeight) return;
    const data = this.cropper.getData();
    const f = this.frameSize();
    const rect: CropRect = {
      x: data.x / f.width,
      y: data.y / f.height,
      width: data.width / f.width,
      height: data.height / f.height,
    };
    editState.update((s) => ({ ...s, crop: rect }));
  }

  /** Smart snap only applies when no ratio is locked (Free mode). */
  private isFreeRatio(): boolean {
    return isNaN(this.computeTargetAspect());
  }

  /** The snap target the current crop box is within tolerance of (Free mode only). Display-px ratio == source-px ratio: Cropper scales uniformly. */
  private currentSnapTarget(): SnapTarget | null {
    if (!this.cropper || !this.isFreeRatio()) return null;
    const d = this.cropper.getCropBoxData();
    if (!d || !d.width || !d.height) return null;
    return findSnapTarget(d.width / d.height);
  }

  /** Live feedback while dragging: green frame + label when near a target. Never moves the box. */
  private updateSmartSnapBadge(): void {
    if (!this.cropper) return;
    const target = this.currentSnapTarget();
    this.container.querySelector('.cropper-container')?.classList.toggle('cropper-snap', !!target);
    if (!this.options.onSmartSnap) return;
    if (!target) {
      this.options.onSmartSnap({ label: null, box: null });
      return;
    }
    const d = this.cropper.getCropBoxData();
    this.options.onSmartSnap({ label: target.label, box: { top: d.top, left: d.left, width: d.width, height: d.height } });
  }

  /** On release: if the box is near a target, set it to that exact ratio, keeping its center and area where the frame allows. */
  private snapOnRelease(): void {
    const target = this.currentSnapTarget();
    if (!this.cropper || !target) return;
    const d = this.cropper.getCropBoxData();
    const cd = this.cropper.getCanvasData();
    const cont = this.cropper.getContainerData();
    // The crop box must stay inside the (straightened) image canvas and the viewport.
    const minL = Math.max(0, cd.left);
    const minT = Math.max(0, cd.top);
    const maxR = Math.min(cont.width, cd.left + cd.width);
    const maxB = Math.min(cont.height, cd.top + cd.height);

    const r = target.ratio;
    const area = d.width * d.height;
    let w = Math.sqrt(area * r);
    let h = Math.sqrt(area / r);
    if (w > maxR - minL) { w = maxR - minL; h = w / r; }
    if (h > maxB - minT) { h = maxB - minT; w = h * r; }
    const cx = d.left + d.width / 2;
    const cy = d.top + d.height / 2;
    const left = Math.min(Math.max(cx - w / 2, minL), maxR - w);
    const top = Math.min(Math.max(cy - h / 2, minT), maxB - h);
    this.cropper.setCropBoxData({ left, top, width: w, height: h });
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
