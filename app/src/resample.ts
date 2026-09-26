// Engine-independent downscaling.
//
// Browsers resample drawImage very differently, and WebKit (iPhone Safari) in
// particular: a canvas source is sampled coarsely (aliasing), and an <img> that
// was already drawn at one size is later resampled differently at another. The
// film passes amplify such fine-texture differences, so the images feeding and
// showing them are downscaled here instead, the same way on every engine.

/** Box-filter (area-average) weights: for each output index, the source indices it covers and how much. */
function areaWeights(srcLen: number, outLen: number): { start: Int32Array; count: Int32Array; w: Float32Array; stride: number } {
  const scale = srcLen / outLen;
  const stride = Math.ceil(scale) + 2;
  const start = new Int32Array(outLen);
  const count = new Int32Array(outLen);
  const w = new Float32Array(outLen * stride);
  for (let o = 0; o < outLen; o++) {
    const a = o * scale;
    const b = Math.min(srcLen, (o + 1) * scale);
    const s0 = Math.floor(a);
    start[o] = s0;
    let n = 0;
    for (let s = s0; s < b && n < stride; s++, n++) w[o * stride + n] = (Math.min(b, s + 1) - Math.max(a, s)) / scale;
    count[o] = n;
  }
  return { start, count, w, stride };
}

/**
 * Area-average downscale of the region (sx, sy, sw, sh) of `src` to outW x outH
 * (each axis scaled by <= 1). The source is read at 1:1 in horizontal bands, so
 * no engine resampling is involved and memory stays bounded (never the whole
 * source at once -- a 48 MP photo exceeds iOS's per-canvas limit).
 */
export function areaDownscale(src: CanvasImageSource, sx: number, sy: number, sw: number, sh: number, outW: number, outH: number): HTMLCanvasElement {
  const out = document.createElement('canvas');
  out.width = outW; out.height = outH;
  const hx = areaWeights(sw, outW);
  const vy = areaWeights(sh, outH);
  const band = document.createElement('canvas');
  const bandRows = Math.max(1, Math.min(sh, Math.floor(4_000_000 / sw)));
  band.width = sw; band.height = bandRows;
  const bctx = band.getContext('2d', { willReadFrequently: true })!;
  const octx = out.getContext('2d')!;

  // Horizontally reduced source rows are accumulated into output rows as they arrive.
  const rowH = new Float32Array(outW * 4);
  const acc = new Float32Array(outW * 4 * 2); // output rows in progress (a source row touches at most 2)
  let accFirst = 0; // output row held in acc[0]
  const outRow = new ImageData(outW, 1);
  const flush = (o: number, slot: number) => {
    const base = slot * outW * 4;
    for (let i = 0; i < outW * 4; i++) outRow.data[i] = acc[base + i]; // Uint8ClampedArray rounds
    octx.putImageData(outRow, 0, o);
  };
  // For each source row: which output rows it contributes to, and with what weight.
  const contrib: { o: number; w: number }[][] = Array.from({ length: sh }, () => []);
  for (let o = 0; o < outH; o++) for (let n = 0; n < vy.count[o]; n++) contrib[vy.start[o] + n].push({ o, w: vy.w[o * vy.stride + n] });

  for (let y0 = 0; y0 < sh; y0 += bandRows) {
    const rows = Math.min(bandRows, sh - y0);
    bctx.clearRect(0, 0, sw, bandRows);
    bctx.drawImage(src, sx, sy + y0, sw, rows, 0, 0, sw, rows);
    const d = bctx.getImageData(0, 0, sw, rows).data;
    for (let r = 0; r < rows; r++) {
      const srow = y0 + r;
      const off = r * sw * 4;
      for (let o = 0; o < outW; o++) {
        let R = 0; let G = 0; let B = 0; let A = 0;
        const s0 = hx.start[o];
        for (let n = 0; n < hx.count[o]; n++) {
          const wt = hx.w[o * hx.stride + n];
          const i = off + (s0 + n) * 4;
          R += d[i] * wt; G += d[i + 1] * wt; B += d[i + 2] * wt; A += d[i + 3] * wt;
        }
        const j = o * 4;
        rowH[j] = R; rowH[j + 1] = G; rowH[j + 2] = B; rowH[j + 3] = A;
      }
      for (const { o, w } of contrib[srow]) {
        while (o > accFirst + 1) { // output row accFirst is complete
          flush(accFirst, 0);
          acc.copyWithin(0, outW * 4, outW * 8);
          acc.fill(0, outW * 4);
          accFirst++;
        }
        const base = (o - accFirst) * outW * 4;
        for (let i = 0; i < outW * 4; i++) acc[base + i] += rowH[i] * w;
      }
    }
  }
  for (let o = accFirst; o < outH; o++) flush(o, o - accFirst);
  band.width = 0; band.height = 0;
  return out;
}

/**
 * GPU-cheap high-quality reduction of a canvas for display: exact halvings
 * (each a 2x2 average) while the remaining factor is >= 2, then one small
 * bilinear step. Much better than a single large drawImage on WebKit.
 */
export function halvingDownscale(src: HTMLCanvasElement, outW: number, outH: number): HTMLCanvasElement {
  let cur: HTMLCanvasElement = src;
  while (cur.width >= outW * 2 && cur.height >= outH * 2) {
    const next = document.createElement('canvas');
    next.width = Math.max(outW, Math.floor(cur.width / 2));
    next.height = Math.max(outH, Math.floor(cur.height / 2));
    const x = next.getContext('2d')!;
    x.imageSmoothingEnabled = true;
    x.imageSmoothingQuality = 'high';
    x.drawImage(cur, 0, 0, next.width, next.height);
    if (cur !== src) { cur.width = 0; cur.height = 0; }
    cur = next;
  }
  if (cur.width === outW && cur.height === outH) return cur;
  const fin = document.createElement('canvas');
  fin.width = outW; fin.height = outH;
  const x = fin.getContext('2d')!;
  x.imageSmoothingEnabled = true;
  x.imageSmoothingQuality = 'high';
  x.drawImage(cur, 0, 0, outW, outH);
  if (cur !== src) { cur.width = 0; cur.height = 0; }
  return fin;
}
