// Minimal baseline TIFF writer: uncompressed RGB, 8 or 16 bits per sample,
// little-endian, one strip. The whole file is allocated up front and pixel rows
// are written into it band by band, so the image never has to exist as a single
// canvas (iOS caps a canvas at 16.7 MP; a 24 MP photo doesn't fit).

const TYPE_SHORT = 3;
const TYPE_LONG = 4;
const TYPE_RATIONAL = 5;
const TYPE_ASCII = 2;

export interface TiffWriter {
  readonly width: number;
  readonly height: number;
  readonly bits: 8 | 16;
  /** Writes `rows` rows starting at row `y` from 8-bit RGBA (canvas ImageData) pixels. */
  writeRgbaRows(y: number, rgba: Uint8ClampedArray, rows: number): void;
  /** Writes `rows` rows starting at row `y` from 16-bit RGB samples (3 per pixel). */
  writeRgb16Rows(y: number, rgb: Uint16Array, rows: number): void;
  /** The finished file. */
  blob(): Blob;
}

export function createTiff(width: number, height: number, bits: 8 | 16 = 8, software = 'cineRoll'): TiffWriter {
  const bps = bits / 8;
  const rowBytes = width * 3 * bps;
  const pixelBytes = rowBytes * height;

  const sw = new TextEncoder().encode(software + '\0');
  const entries: [number, number, number, number | number[]][] = []; // tag, type, count, value(s)
  // Extra values that don't fit in 4 bytes go after the IFD.
  const nEntries = 14;
  const ifdOffset = 8;
  const ifdSize = 2 + nEntries * 12 + 4;
  let extra = ifdOffset + ifdSize;
  const bpsOffset = extra; extra += 6;
  const xResOffset = extra; extra += 8;
  const yResOffset = extra; extra += 8;
  const swOffset = extra; extra += sw.length;
  const pixelOffset = Math.ceil(extra / 16) * 16;

  entries.push([256, TYPE_LONG, 1, width]);
  entries.push([257, TYPE_LONG, 1, height]);
  entries.push([258, TYPE_SHORT, 3, bpsOffset]); // BitsPerSample -> offset
  entries.push([259, TYPE_SHORT, 1, 1]); // no compression
  entries.push([262, TYPE_SHORT, 1, 2]); // RGB
  entries.push([273, TYPE_LONG, 1, pixelOffset]); // StripOffsets
  entries.push([277, TYPE_SHORT, 1, 3]); // SamplesPerPixel
  entries.push([278, TYPE_LONG, 1, height]); // RowsPerStrip: one strip
  entries.push([279, TYPE_LONG, 1, pixelBytes]); // StripByteCounts
  entries.push([282, TYPE_RATIONAL, 1, xResOffset]);
  entries.push([283, TYPE_RATIONAL, 1, yResOffset]);
  entries.push([284, TYPE_SHORT, 1, 1]); // chunky
  entries.push([296, TYPE_SHORT, 1, 2]); // inches
  entries.push([305, TYPE_ASCII, sw.length, swOffset]);
  if (entries.length !== nEntries) throw new Error('tiff: entry count');

  const bytes = new Uint8Array(pixelOffset + pixelBytes);
  const dv = new DataView(bytes.buffer);
  bytes[0] = 0x49; bytes[1] = 0x49; // "II"
  dv.setUint16(2, 42, true);
  dv.setUint32(4, ifdOffset, true);
  dv.setUint16(ifdOffset, nEntries, true);
  entries.forEach(([tag, type, count, value], i) => {
    const o = ifdOffset + 2 + i * 12;
    dv.setUint16(o, tag, true);
    dv.setUint16(o + 2, type, true);
    dv.setUint32(o + 4, count, true);
    if (type === TYPE_SHORT && count === 1) dv.setUint16(o + 8, value as number, true);
    else dv.setUint32(o + 8, value as number, true);
  });
  dv.setUint32(ifdOffset + 2 + nEntries * 12, 0, true); // no next IFD
  for (let i = 0; i < 3; i++) dv.setUint16(bpsOffset + i * 2, bits, true);
  dv.setUint32(xResOffset, 72, true); dv.setUint32(xResOffset + 4, 1, true);
  dv.setUint32(yResOffset, 72, true); dv.setUint32(yResOffset + 4, 1, true);
  bytes.set(sw, swOffset);

  return {
    width, height, bits,
    writeRgbaRows(y, rgba, rows) {
      if (bits !== 8) throw new Error('tiff: 8-bit rows into a 16-bit file');
      let o = pixelOffset + y * rowBytes;
      const n = width * rows;
      for (let p = 0, i = 0; p < n; p++, i += 4) {
        bytes[o++] = rgba[i]; bytes[o++] = rgba[i + 1]; bytes[o++] = rgba[i + 2];
      }
    },
    writeRgb16Rows(y, rgb, rows) {
      if (bits !== 16) throw new Error('tiff: 16-bit rows into an 8-bit file');
      let o = pixelOffset + y * rowBytes;
      const n = width * rows * 3;
      for (let i = 0; i < n; i++, o += 2) dv.setUint16(o, rgb[i], true);
    },
    blob: () => new Blob([bytes], { type: 'image/tiff' }),
  };
}
