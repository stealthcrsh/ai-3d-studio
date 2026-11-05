import type { Garment, PartMesh } from './garment.ts';
import { FABRICS } from './params.ts';
import { mulberry32 } from './math.ts';
import type { ImageAnalysis, RGBAImage } from './vision.ts';

export interface PhotoSource {
  image: RGBAImage;
  analysis: ImageAnalysis;
}

export interface BakeSources {
  front?: PhotoSource;
  back?: PhotoSource;
}

const srgb = (hex: string): [number, number, number] => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];

function tile(size: number, seed: number) {
  const rand = mulberry32(seed);
  const t = new Float32Array(size * size);
  for (let i = 0; i < t.length; i++) t[i] = rand();
  // Two box passes give soft fibre clumps instead of pure salt noise.
  for (let pass = 0; pass < 2; pass++) {
    const c = t.slice();
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        const xm = (x + size - 1) % size;
        const xp = (x + 1) % size;
        const ym = (y + size - 1) % size;
        const yp = (y + 1) % size;
        t[y * size + x] = (c[y * size + x] * 2 + c[y * size + xm] + c[y * size + xp] + c[ym * size + x] + c[yp * size + x]) / 6;
      }
  }
  let min = 1;
  let max = 0;
  for (const v of t) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  for (let i = 0; i < t.length; i++) t[i] = ((t[i] - min) / (max - min)) * 2 - 1;
  return t;
}

/** Flat-field a photo so large-scale lighting does not bake into albedo. Prints and pocket edges survive. */
function lowFrequencyLuma(p: PhotoSource) {
  const size = 64;
  const { image } = p;
  const buf = new Float32Array(size * size);
  const wgt = new Float32Array(size * size);
  const m = p.analysis.mask;
  const mw = p.analysis.maskWidth;
  const mh = p.analysis.maskHeight;
  const step = Math.max(1, Math.floor(Math.max(image.width, image.height) / 512));
  for (let y = 0; y < image.height; y += step)
    for (let x = 0; x < image.width; x += step) {
      const mi = Math.floor((y / image.height) * mh) * mw + Math.floor((x / image.width) * mw);
      if (!m[mi]) continue;
      const i = (y * image.width + x) * 4;
      const l = 0.3 * image.data[i] + 0.59 * image.data[i + 1] + 0.11 * image.data[i + 2];
      const b = Math.floor((y / image.height) * size) * size + Math.floor((x / image.width) * size);
      buf[b] += l;
      wgt[b]++;
    }
  for (let i = 0; i < buf.length; i++) buf[i] = wgt[i] ? buf[i] / wgt[i] : -1;
  for (let pass = 0; pass < 4; pass++) {
    const c = buf.slice();
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        let s = 0;
        let n = 0;
        for (let dy = -2; dy <= 2; dy++)
          for (let dx = -2; dx <= 2; dx++) {
            const yy = y + dy;
            const xx = x + dx;
            if (yy < 0 || xx < 0 || yy >= size || xx >= size) continue;
            const v = c[yy * size + xx];
            if (v >= 0) {
              s += v;
              n++;
            }
          }
        if (n) buf[y * size + x] = s / n;
      }
  }
  return (u: number, v: number) => buf[Math.min(size - 1, Math.floor(v * size)) * size + Math.min(size - 1, Math.floor(u * size))];
}

export interface BakedTextures {
  baseColor: RGBAImage;
  normal: RGBAImage;
  size: number;
  /** Which image informed each part, so the UI can tag inferred surfaces truthfully. */
  sources: Record<string, 'reference-front' | 'reference-back' | 'inferred-colour'>;
}

export function bakeTextures(g: Garment, size: number, sources: BakeSources): BakedTextures {
  const color = new Uint8Array(size * size * 4);
  const normal = new Uint8Array(size * size * 4);
  const fabric = FABRICS[g.params.fabric] ?? FABRICS.fleece;
  const main = srgb(g.params.baseColor);
  const rib = srgb(g.params.ribColor);
  const cord = srgb(g.params.cordColor);
  for (let i = 0; i < size * size; i++) {
    color.set([main[0], main[1], main[2], 255], i * 4);
    normal.set([128, 128, 255, 255], i * 4);
  }
  const noise = tile(256, 7);
  const coarse = tile(128, 11);
  const provenance: BakedTextures['sources'] = {};
  const lumaFront = sources.front?.analysis.ok ? lowFrequencyLuma(sources.front) : null;
  const lumaBack = sources.back?.analysis.ok ? lowFrequencyLuma(sources.back) : null;
  const metersPerTexel = 2.4 / size;

  const samplePhoto = (src: PhotoSource, luma: (u: number, v: number) => number, u: number, v: number, base: [number, number, number]): [number, number, number] | null => {
    const a = src.analysis;
    const px = a.torso.x0 + (a.torso.x1 - a.torso.x0) * u;
    // The body panel stops at the rib seam, so skip the band of the photo that shows the rib itself.
    const ribShare = g.params.hemHeight / g.params.bodyLength;
    const py = a.torso.yHem + (a.torso.yShoulder - a.torso.yHem) * (ribShare + v * (1 - ribShare));
    if (px < 0 || py < 0 || px >= 1 || py >= 1) return null;
    // Stay a few pixels inside the outline, so background colour never bleeds onto the fabric.
    const mx = Math.floor(px * a.maskWidth);
    const my = Math.floor(py * a.maskHeight);
    for (const [dx, dy] of [[0, 0], [-4, 0], [4, 0], [0, -4], [0, 4]]) {
      const qx = mx + dx;
      const qy = my + dy;
      if (qx < 0 || qy < 0 || qx >= a.maskWidth || qy >= a.maskHeight || !a.mask[qy * a.maskWidth + qx]) return null;
    }
    const ix = Math.floor(px * src.image.width);
    const iy = Math.floor(py * src.image.height);
    const i = (iy * src.image.width + ix) * 4;
    const m = srgb(a.medianColor);
    const lumMedian = 0.3 * m[0] + 0.59 * m[1] + 0.11 * m[2];
    const low = luma(px, py);
    const flat = low > 0 ? Math.min(1.6, Math.max(0.6, lumMedian / low)) : 1;
    // Tint relative to the measured median, so a later colour edit recolours the print too.
    return [
      Math.min(255, (src.image.data[i] * flat * base[0]) / Math.max(8, m[0])),
      Math.min(255, (src.image.data[i + 1] * flat * base[1]) / Math.max(8, m[1])),
      Math.min(255, (src.image.data[i + 2] * flat * base[2]) / Math.max(8, m[2])),
    ];
  };

  const stitchMask = (d: number, along: number) => {
    let s = 0;
    for (const at of [0.0052, 0.0115]) {
      if (Math.abs(d - at) < 0.0009 && ((along / 0.0038) % 1) < 0.72) s = 1;
    }
    return s;
  };

  const bakePart = (p: PartMesh) => {
    const [rx, ry, rw, rh] = p.rect;
    const pad = 3;
    const x0 = Math.max(0, Math.floor(rx * size) - pad);
    const x1 = Math.min(size - 1, Math.ceil((rx + rw) * size) + pad);
    const y0 = Math.max(0, Math.floor(ry * size) - pad);
    const y1 = Math.min(size - 1, Math.ceil((ry + rh) * size) + pad);
    const pat = g.pattern.find((q) => q.part === p.id);
    const wM = pat?.width ?? 0.1;
    const hM = pat?.height ?? 0.1;
    if (p.material === 'cord') {
      for (let y = y0; y <= y1; y++)
        for (let x = x0; x <= x1; x++) {
          color.set([cord[0], cord[1], cord[2], 255], (y * size + x) * 4);
        }
      provenance[p.id] = 'inferred-colour';
      return;
    }
    const base = p.material === 'rib' ? rib : main;
    const src = p.id === 'Body_Front' || p.id === 'Pocket' ? sources.front : p.id === 'Body_Back' ? sources.back : undefined;
    const luma = p.id === 'Body_Back' ? lumaBack : lumaFront;
    provenance[p.id] = src?.analysis.ok ? (p.id === 'Body_Back' ? 'reference-back' : 'reference-front') : 'inferred-colour';
    const st = p.stitched;
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const s = Math.min(1, Math.max(0, (x + 0.5) / size - rx) / rw);
        const t = Math.min(1, Math.max(0, (y + 0.5) / size - ry) / rh);
        const mx = s * wM;
        const my = t * hM;
        let c: [number, number, number] = [base[0], base[1], base[2]];
        if (src?.analysis.ok && luma) {
          let u = s;
          let v = t;
          if (p.id === 'Pocket' && g.pocketMap) {
            const narrow = 1 - 0.4 * Math.min(1, Math.max(0, (t - 0.4) / 0.6));
            u = 0.5 + (s - 0.5) * 2 * g.pocketMap.halfU * narrow;
            v = (0.4 + t * g.pocketMap.hRows) / g.pocketMap.rows;
          }
          const ph = samplePhoto(src, luma, u, v, base);
          if (ph) c = ph;
        }
        const tx = Math.floor(x * 1.0) & 255;
        const ty = Math.floor(y * 1.0) & 255;
        const n0 = noise[ty * 256 + tx];
        const n1 = coarse[(Math.floor(y / 3) & 127) * 128 + (Math.floor(x / 3) & 127)];
        let lum = 1 + (0.045 * n0 + 0.03 * n1) * fabric.noiseScale;
        let nx = (noise[ty * 256 + ((tx + 1) & 255)] - n0) * 0.55 * fabric.noiseScale;
        let ny = (noise[((ty + 1) & 255) * 256 + tx] - n0) * 0.55 * fabric.noiseScale;
        if (p.material === 'rib') {
          const period = Math.max(0.0042, metersPerTexel * 4);
          const ph = (mx / period) * Math.PI * 2;
          nx += Math.cos(ph) * 0.6;
          lum *= 1 + 0.07 * Math.sin(ph);
        }
        const distances: [number, number][] = [];
        if (st.left) distances.push([mx, my]);
        if (st.right) distances.push([wM - mx, my]);
        if (st.bottom) distances.push([my, mx]);
        if (st.top) distances.push([hM - my, mx]);
        let seamShade = 1;
        for (const [d, along] of distances) {
          if (d < 0.0024) {
            seamShade = Math.min(seamShade, 0.72 + (d / 0.0024) * 0.28);
          }
          if (stitchMask(d, along)) {
            seamShade = Math.min(seamShade, 0.68);
            ny += 0.3;
          }
        }
        lum *= seamShade;
        const i = (y * size + x) * 4;
        color[i] = Math.min(255, c[0] * lum);
        color[i + 1] = Math.min(255, c[1] * lum);
        color[i + 2] = Math.min(255, c[2] * lum);
        color[i + 3] = 255;
        const nl = Math.hypot(nx, ny, 1);
        normal[i] = (nx / nl) * 127.5 + 127.5;
        normal[i + 1] = (ny / nl) * 127.5 + 127.5;
        normal[i + 2] = (1 / nl) * 127.5 + 127.5;
        normal[i + 3] = 255;
      }
  };
  for (const p of g.parts) bakePart(p);
  return {
    baseColor: { width: size, height: size, data: color },
    normal: { width: size, height: size, data: normal },
    size,
    sources: provenance,
  };
}
