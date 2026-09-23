import type { LutChoice } from './state';

const CSS_LUT_FILTERS: Record<Exclude<LutChoice, 'none' | 'custom'>, (intensity: number) => string> = {
  kodak: (i) => `sepia(${50 * i}%) contrast(${100 + 15 * i}%) saturate(${100 + 20 * i}%) hue-rotate(${-10 * i}deg)`,
  fuji: (i) => `sepia(${30 * i}%) hue-rotate(${10 * i}deg) saturate(${100 - 10 * i}%) contrast(${100 - 5 * i}%)`,
  cinematic: (i) => `contrast(${100 + 20 * i}%) saturate(${100 + 10 * i}%) sepia(${40 * i}%) hue-rotate(${-15 * i}deg)`,
};

/** The CSS-filter-emulated LUT string ('none' for the WebGL-only 'custom' LUT, which has no CSS equivalent). */
export function buildCssLutFilter(lut: LutChoice, intensityPct: number): string {
  if (lut === 'none' || lut === 'custom') return 'none';
  const i = intensityPct / 100;
  return CSS_LUT_FILTERS[lut](i);
}

export interface ToneFilterInput {
  lut: LutChoice;
  lutIntensity: number;
  brightness: number;
  contrast: number;
  saturation: number;
}

/** Combined CSS filter string (LUT + brightness/contrast/saturation), shared by the preview canvas and export. */
export function buildToneFilterString(tone: ToneFilterInput): string {
  let f = buildCssLutFilter(tone.lut, tone.lutIntensity);
  if (tone.brightness !== 100 || tone.contrast !== 100 || tone.saturation !== 100) {
    if (f === 'none') f = '';
    f += ` brightness(${tone.brightness}%) contrast(${tone.contrast}%) saturate(${tone.saturation}%)`;
  }
  return f === '' ? 'none' : f;
}

/** A tileable black/white noise canvas used as a soft-light grain overlay. */
export function createGrainTile(size = 512): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d')!;
  const id = ctx.createImageData(size, size);
  for (let i = 0; i < id.data.length; i += 4) {
    const v = Math.random() < 0.5 ? 0 : 255;
    id.data[i] = id.data[i + 1] = id.data[i + 2] = v;
    id.data[i + 3] = 255;
  }
  ctx.putImageData(id, 0, 0);
  return c;
}

/** Draws a grain overlay (soft-light blend) across the given rect. Matches the export encoder's grain math exactly. */
export function drawGrainOverlay(ctx: CanvasRenderingContext2D, tile: HTMLCanvasElement, grainAmountPct: number, x: number, y: number, width: number, height: number): void {
  if (grainAmountPct <= 0) return;
  ctx.save();
  ctx.globalAlpha = (grainAmountPct / 100) * 1.5;
  ctx.globalCompositeOperation = 'soft-light';
  ctx.fillStyle = ctx.createPattern(tile, 'repeat')!;
  ctx.translate(x, y);
  ctx.fillRect(0, 0, width, height);
  ctx.restore();
}

// --- Engine3D: WebGL 3D-LUT + highlight/shadow tone engine (moved from legacy.ts, unchanged) ---

export const Engine3D = {
  canvas: document.createElement('canvas'),
  gl: null as WebGL2RenderingContext | null,
  program: null as WebGLProgram | null,
  posBuf: null as WebGLBuffer | null,
  lutData: null as { size: number; data: Uint8Array } | null,
  identityLut: null as { size: number; data: Uint8Array } | null,

  initIdentityLut: function () {
    const size = 16;
    const data = new Uint8Array(size * size * size * 4);
    let i = 0;
    for (let z = 0; z < size; z++) {
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          data[i++] = Math.round((x / (size - 1)) * 255);
          data[i++] = Math.round((y / (size - 1)) * 255);
          data[i++] = Math.round((z / (size - 1)) * 255);
          data[i++] = 255;
        }
      }
    }
    this.identityLut = { size, data };
  },

  parseCube: function (text: string) {
    const lines = text.split('\n');
    let size = 0;
    const vals: number[] = [];
    for (let line of lines) {
      line = line.trim();
      if (line.startsWith('LUT_3D_SIZE')) {
        size = parseInt(line.split(/\s+/)[1]);
      } else if (line && !line.startsWith('#') && /^[0-9.-]/.test(line)) {
        const parts = line.split(/\s+/).map(Number);
        vals.push(parts[0], parts[1], parts[2]);
      }
    }
    const data = new Uint8Array(size * size * size * 4);
    let vIdx = 0;
    for (let i = 0; i < data.length; i += 4) {
      data[i] = Math.max(0, Math.min(255, Math.round(vals[vIdx] * 255)));
      data[i + 1] = Math.max(0, Math.min(255, Math.round(vals[vIdx + 1] * 255)));
      data[i + 2] = Math.max(0, Math.min(255, Math.round(vals[vIdx + 2] * 255)));
      data[i + 3] = 255;
      vIdx += 3;
    }
    this.lutData = { size, data };
  },

  apply: async function (sourceCanvas: HTMLCanvasElement, intensity: number, hl: number, sh: number, hasCustomLut: boolean): Promise<HTMLCanvasElement> {
    if (!this.gl) {
      this.gl = this.canvas.getContext('webgl2', { preserveDrawingBuffer: true });
      this.initIdentityLut();
    }
    const gl = this.gl;
    if (!gl) return sourceCanvas;

    if (!this.program) {
      const vsSource = `#version 300 es\n in vec2 a_position; out vec2 v_texCoord; void main() { gl_Position = vec4(a_position, 0.0, 1.0); v_texCoord = vec2((a_position.x + 1.0) / 2.0, 1.0 - (a_position.y + 1.0) / 2.0); }`;
      const fsSource = `#version 300 es\n precision highp float; precision highp sampler3D; in vec2 v_texCoord; uniform sampler2D u_image; uniform sampler3D u_lut; uniform float u_intensity; uniform float u_hl; uniform float u_sh; uniform int u_hasLut; out vec4 outColor; float getLum(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); } void main() { vec4 texColor = texture(u_image, v_texCoord); vec3 color = texColor.rgb; float lum = getLum(color); float shadowMask = pow(clamp(1.0 - (lum / 0.5), 0.0, 1.0), 1.5); float hlMask = pow(clamp((lum - 0.5) / 0.5, 0.0, 1.0), 1.5); color *= 1.0 + (u_sh - 1.0) * shadowMask; color *= 1.0 + (u_hl - 1.0) * hlMask; color = clamp(color, 0.0, 1.0); vec3 finalColor = color; if (u_hasLut == 1) { vec3 lutColor = texture(u_lut, color).rgb; finalColor = mix(color, lutColor, u_intensity); } outColor = vec4(finalColor, texColor.a); }`;
      const createShader = (type: number, source: string) => {
        const s = gl.createShader(type)!;
        gl.shaderSource(s, source);
        gl.compileShader(s);
        return s;
      };
      this.program = gl.createProgram()!;
      gl.attachShader(this.program, createShader(gl.VERTEX_SHADER, vsSource));
      gl.attachShader(this.program, createShader(gl.FRAGMENT_SHADER, fsSource));
      gl.linkProgram(this.program);
      this.posBuf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
    }

    gl.useProgram(this.program);
    const posLoc = gl.getAttribLocation(this.program, 'a_position');
    gl.enableVertexAttribArray(posLoc);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuf);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

    const lutTex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_3D, lutTex);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    const activeLut = hasCustomLut && this.lutData ? this.lutData : this.identityLut!;
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA, activeLut.size, activeLut.size, activeLut.size, 0, gl.RGBA, gl.UNSIGNED_BYTE, activeLut.data);

    gl.uniform1i(gl.getUniformLocation(this.program, 'u_lut'), 1);
    gl.uniform1f(gl.getUniformLocation(this.program, 'u_intensity'), intensity);
    gl.uniform1f(gl.getUniformLocation(this.program, 'u_hl'), hl);
    gl.uniform1f(gl.getUniformLocation(this.program, 'u_sh'), sh);
    gl.uniform1i(gl.getUniformLocation(this.program, 'u_hasLut'), hasCustomLut ? 1 : 0);

    const isHuge = sourceCanvas.width > 4096 || sourceCanvas.height > 4096;

    if (!isHuge) {
      this.canvas.width = sourceCanvas.width;
      this.canvas.height = sourceCanvas.height;
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);

      const imgTex = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, imgTex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, sourceCanvas);
      gl.uniform1i(gl.getUniformLocation(this.program, 'u_image'), 0);

      gl.drawArrays(gl.TRIANGLES, 0, 6);

      const outCvs = document.createElement('canvas');
      outCvs.width = this.canvas.width;
      outCvs.height = this.canvas.height;
      outCvs.getContext('2d')!.drawImage(this.canvas, 0, 0);

      gl.deleteTexture(imgTex);
      gl.deleteTexture(lutTex);
      return outCvs;
    } else {
      const outCvs = document.createElement('canvas');
      outCvs.width = sourceCanvas.width;
      outCvs.height = sourceCanvas.height;
      const outCtx = outCvs.getContext('2d')!;
      const TILE_SIZE = 2048;

      for (let y = 0; y < sourceCanvas.height; y += TILE_SIZE) {
        for (let x = 0; x < sourceCanvas.width; x += TILE_SIZE) {
          const w = Math.min(TILE_SIZE, sourceCanvas.width - x);
          const h = Math.min(TILE_SIZE, sourceCanvas.height - y);

          const tileCvs = document.createElement('canvas');
          tileCvs.width = w;
          tileCvs.height = h;
          tileCvs.getContext('2d')!.drawImage(sourceCanvas, x, y, w, h, 0, 0, w, h);

          this.canvas.width = w;
          this.canvas.height = h;
          gl.viewport(0, 0, w, h);

          const imgTex = gl.createTexture();
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, imgTex);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, tileCvs);
          gl.uniform1i(gl.getUniformLocation(this.program, 'u_image'), 0);

          gl.drawArrays(gl.TRIANGLES, 0, 6);

          outCtx.drawImage(this.canvas, x, y);
          gl.deleteTexture(imgTex);
          tileCvs.width = 0;
          tileCvs.height = 0;
        }
      }
      gl.deleteTexture(lutTex);
      return outCvs;
    }
  },
};
