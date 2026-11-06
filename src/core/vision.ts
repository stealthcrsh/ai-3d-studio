export interface RGBAImage {
  width: number;
  height: number;
  data: Uint8Array;
}

/** Upload limits. Header dimensions are read before decoding to block decompression bombs. */
export const MAX_PIXELS = 40_000_000;
/** Hem width as a share of body width, matching the share providers.ts uses when it infers hemWidth. */
export const HEM_TO_BODY = 0.83;

export type Sniffed = 'png' | 'jpeg' | 'webp' | 'gif' | 'glb' | 'pdf' | 'mp4' | 'text' | 'obj' | 'unknown';

export function sniff(bytes: Uint8Array, filename = ''): Sniffed {
  const b = bytes;
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.length >= 12 && String.fromCharCode(...b.slice(0, 4)) === 'RIFF' && String.fromCharCode(...b.slice(8, 12)) === 'WEBP') return 'webp';
  if (b.length >= 4 && String.fromCharCode(...b.slice(0, 4)) === 'glTF') return 'glb';
  if (b.length >= 5 && String.fromCharCode(...b.slice(0, 5)) === '%PDF-') return 'pdf';
  if (b.length >= 12 && String.fromCharCode(...b.slice(4, 8)) === 'ftyp') return 'mp4';
  const lower = filename.toLowerCase();
  const head = new TextDecoder().decode(b.slice(0, 2048));
  const isText = !/[\u0000-\u0008\u000e-\u001f]/.test(head);
  if (isText && lower.endsWith('.obj') && /^(#|v |o |g |mtllib)/m.test(head)) return 'obj';
  if (isText && (lower.endsWith('.txt') || lower.endsWith('.md'))) return 'text';
  return 'unknown';
}

export function readDimensions(bytes: Uint8Array, kind: 'png' | 'jpeg'): { width: number; height: number } | null {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (kind === 'png') {
    if (bytes.length < 24) return null;
    return { width: dv.getUint32(16), height: dv.getUint32(20) };
  }
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) {
      i++;
      continue;
    }
    const m = bytes[i + 1];
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { height: dv.getUint16(i + 5), width: dv.getUint16(i + 7) };
    i += 2 + dv.getUint16(i + 2);
  }
  return null;
}

/** Pixel access is supplied by the platform: canvas in the browser, pure JS libraries in the test runner. */
export interface ImageCodec {
  decode(bytes: Uint8Array, kind: 'png' | 'jpeg'): Promise<RGBAImage>;
  encodeJpeg(img: RGBAImage, quality: number): Promise<Uint8Array>;
  encodePng(img: RGBAImage): Promise<Uint8Array>;
}

export function checkImageHeader(bytes: Uint8Array, kind: 'png' | 'jpeg') {
  const dim = readDimensions(bytes, kind);
  if (!dim || dim.width < 16 || dim.height < 16) throw new Error('Image header is invalid or the image is too small.');
  if (dim.width * dim.height > MAX_PIXELS) throw new Error(`Image is ${dim.width}×${dim.height}. The limit is 40 megapixels.`);
  return dim;
}

function downscale(img: RGBAImage, maxSide: number): RGBAImage {
  const k = Math.min(1, maxSide / Math.max(img.width, img.height));
  if (k === 1) return img;
  const w = Math.max(1, Math.round(img.width * k));
  const h = Math.max(1, Math.round(img.height * k));
  const data = new Uint8Array(w * h * 4);
  const fx = img.width / w;
  const fy = img.height / h;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * fx);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * fx));
      const y0 = Math.floor(y * fy);
      const y1 = Math.max(y0 + 1, Math.floor((y + 1) * fy));
      const s = [0, 0, 0, 0];
      let n = 0;
      for (let yy = y0; yy < y1 && yy < img.height; yy++)
        for (let xx = x0; xx < x1 && xx < img.width; xx++) {
          const i = (yy * img.width + xx) * 4;
          for (let c = 0; c < 4; c++) s[c] += img.data[i + c];
          n++;
        }
      const o = (y * w + x) * 4;
      for (let c = 0; c < 4; c++) data[o + c] = s[c] / Math.max(1, n);
    }
  return { width: w, height: h, data };
}

export interface ImageAnalysis {
  ok: boolean;
  width: number;
  height: number;
  /** Bounding box and registration in analysis-image pixels, normalised to 0..1. */
  bbox: [number, number, number, number];
  torso: { x0: number; x1: number; yShoulder: number; yHem: number };
  sleeve: { left: number; right: number };
  hoodDetected: boolean;
  hoodHeightRatio: number;
  backgroundUniformity: number;
  maskCoverage: number;
  medianColor: string;
  lowerBandColor: string;
  ratios: { widthToLength: number; sleeveToLength: number; hoodToLength: number };
  confidence: number;
  warnings: string[];
  /** Mask stored row-major at analysis size, 1 byte per pixel. */
  mask: Uint8Array;
  maskWidth: number;
  maskHeight: number;
}

const hex = (r: number, g: number, b: number) => `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;

const median = (arr: number[]) => {
  const s = arr.slice().sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};

function otsu(values: Float32Array, maxV: number) {
  const bins = new Float64Array(256);
  for (let i = 0; i < values.length; i++) bins[Math.min(255, Math.floor((values[i] / maxV) * 255))]++;
  const total = values.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * bins[i];
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let threshold = 0;
  for (let i = 0; i < 256; i++) {
    wB += bins[i];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += i * bins[i];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) {
      best = between;
      threshold = i;
    }
  }
  return (threshold / 255) * maxV;
}

/** Classical segmentation and silhouette measurement. No machine learning model is involved. */
export function analyzeGarmentImage(source: RGBAImage): ImageAnalysis {
  const img = downscale(source, 640);
  const { width: w, height: h, data } = img;
  const warnings: string[] = [];
  // Background model from the image border.
  const border: number[][] = [[], [], []];
  const push = (x: number, y: number) => {
    const i = (y * w + x) * 4;
    for (let c = 0; c < 3; c++) border[c].push(data[i + c]);
  };
  for (let x = 0; x < w; x += 2) {
    push(x, 0);
    push(x, h - 1);
  }
  for (let y = 0; y < h; y += 2) {
    push(0, y);
    push(w - 1, y);
  }
  const bg = border.map(median);
  const dev = border.map((b, c) => {
    const d = b.map((v) => Math.abs(v - bg[c]));
    return median(d) + d.reduce((s, v) => s + v, 0) / d.length;
  });
  const uniformity = Math.max(0, 1 - (dev[0] + dev[1] + dev[2]) / 3 / 40);
  if (uniformity < 0.55) warnings.push('The background is busy, so the outline may be wrong. A plain background works best.');
  const dist = new Float32Array(w * h);
  let maxD = 1;
  for (let i = 0; i < w * h; i++) {
    const r = data[i * 4] - bg[0];
    const g = data[i * 4 + 1] - bg[1];
    const b = data[i * 4 + 2] - bg[2];
    dist[i] = Math.sqrt(0.3 * r * r + 0.59 * g * g + 0.11 * b * b);
    if (dist[i] > maxD) maxD = dist[i];
  }
  // On a plain background, anything clearly off the background colour is garment. This keeps pale stripes on dark
  // fabric, which a two-cluster Otsu split would throw away. Otsu is the fallback for busy backgrounds.
  const spread = (dev[0] + dev[1] + dev[2]) / 3;
  const thr = uniformity > 0.7 ? Math.max(18, spread * 3 + 12) : Math.max(14, otsu(dist, maxD));
  let mask = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) mask[i] = dist[i] > thr ? 1 : 0;
  // Close small gaps, keep the largest connected region, then fill holes.
  const dilate = (m: Uint8Array) => {
    const o = new Uint8Array(m.length);
    for (let y = 1; y < h - 1; y++)
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        o[i] = m[i] | m[i - 1] | m[i + 1] | m[i - w] | m[i + w];
      }
    return o;
  };
  const erode = (m: Uint8Array) => {
    const o = new Uint8Array(m.length);
    for (let y = 1; y < h - 1; y++)
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        o[i] = m[i] & m[i - 1] & m[i + 1] & m[i - w] & m[i + w];
      }
    return o;
  };
  mask = erode(erode(dilate(dilate(mask))));
  const labels = new Int32Array(w * h);
  const stack: number[] = [];
  let bestLabel = 0;
  let bestSize = 0;
  let label = 0;
  for (let i = 0; i < w * h; i++) {
    if (!mask[i] || labels[i]) continue;
    label++;
    let size = 0;
    stack.push(i);
    labels[i] = label;
    while (stack.length) {
      const p = stack.pop()!;
      size++;
      const x = p % w;
      for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p - w, p + w]) {
        if (q >= 0 && q < w * h && mask[q] && !labels[q]) {
          labels[q] = label;
          stack.push(q);
        }
      }
    }
    if (size > bestSize) {
      bestSize = size;
      bestLabel = label;
    }
  }
  const main = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) main[i] = labels[i] === bestLabel && bestLabel > 0 ? 1 : 0;
  // Holes are background regions that never touch the border.
  const outside = new Uint8Array(w * h);
  for (let x = 0; x < w; x++) {
    if (!main[x]) stack.push(x);
    if (!main[(h - 1) * w + x]) stack.push((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    if (!main[y * w]) stack.push(y * w);
    if (!main[y * w + w - 1]) stack.push(y * w + w - 1);
  }
  while (stack.length) {
    const p = stack.pop()!;
    if (outside[p] || main[p]) continue;
    outside[p] = 1;
    const x = p % w;
    if (x > 0) stack.push(p - 1);
    if (x < w - 1) stack.push(p + 1);
    if (p - w >= 0) stack.push(p - w);
    if (p + w < w * h) stack.push(p + w);
  }
  let coverage = 0;
  for (let i = 0; i < w * h; i++) {
    if (!outside[i]) {
      main[i] = 1;
      coverage++;
    }
  }
  const covFrac = coverage / (w * h);

  const empty = (reason: string): ImageAnalysis => ({
    ok: false, width: source.width, height: source.height,
    bbox: [0, 0, 1, 1], torso: { x0: 0.2, x1: 0.8, yShoulder: 0.15, yHem: 0.9 }, sleeve: { left: 0, right: 0 },
    hoodDetected: false, hoodHeightRatio: 0, backgroundUniformity: uniformity, maskCoverage: covFrac,
    medianColor: '#5f6670', lowerBandColor: '#5f6670', ratios: { widthToLength: 0, sleeveToLength: 0, hoodToLength: 0 },
    confidence: 0, warnings: [...warnings, reason], mask: main, maskWidth: w, maskHeight: h,
  });
  if (covFrac < 0.05) return empty('No clear garment was found. The outline covers under 5% of the image.');
  if (covFrac > 0.92) return empty('The garment and the background could not be separated.');

  // Silhouette measurements from row runs around the garment centre.
  let minX = w, maxX = 0, minY = h, maxY = 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (main[y * w + x]) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
  const lowerXs: number[] = [];
  for (let y = Math.floor(minY + (maxY - minY) * 0.55); y <= maxY; y++)
    for (let x = minX; x <= maxX; x += 2) if (main[y * w + x]) lowerXs.push(x);
  const cx = median(lowerXs);
  const runAt = (y: number) => {
    let l = Math.round(cx);
    let r = l;
    if (!main[y * w + l]) return { l: l, r: l, w: 0 };
    while (l > 0 && main[y * w + l - 1]) l--;
    while (r < w - 1 && main[y * w + r + 1]) r++;
    return { l, r, w: r - l + 1 };
  };
  const hH = maxY - minY + 1;
  // Hem: the lowest row whose central run is wide, which ignores sleeves that hang below the hem.
  const lowW = median(Array.from({ length: 24 }, (_, i) => runAt(Math.floor(minY + hH * (0.55 + i * 0.012))).w));
  let yHem = maxY;
  while (yHem > minY && runAt(yHem).w < lowW * 0.55) yHem--;
  // Torso width: narrowest stable run on the lower half, which rejects rows merged with the sleeves.
  const torsoRows: { l: number; r: number; w: number }[] = [];
  for (let k = 0.08; k < 0.42; k += 0.02) torsoRows.push(runAt(Math.floor(yHem - hH * k)));
  const widths = torsoRows.map((r) => r.w).filter((v) => v > 0);
  let torsoW = Math.max(1, percentile(widths, 0.3));
  let torsoRow = torsoRows.reduce((a, b) => (Math.abs(b.w - torsoW) < Math.abs(a.w - torsoW) ? b : a), torsoRows[0]);
  // Arms resting against the body merge with the torso, so every torso row is arm to arm. The hem band below the
  // cuffs is then the only clean width, and body width is scaled up from it by the template's hem share.
  const bottom = runAt(maxY - Math.max(2, Math.round(hH * 0.01)));
  const armsMerged = bottom.w > 0 && bottom.w < torsoW * 0.7;
  if (armsMerged) {
    yHem = maxY;
    torsoW = Math.round(bottom.w / HEM_TO_BODY);
    const mid = (bottom.l + bottom.r) / 2;
    torsoRow = { l: Math.round(mid - torsoW / 2), r: Math.round(mid + torsoW / 2), w: torsoW };
    warnings.push('The sleeves rest against the body, so chest width was estimated from the hem. Check it in the Garment tab.');
  }
  // Shoulder: first row from the top whose central run reaches 60% of the torso width.
  let yShoulder = minY;
  for (let y = minY; y < yHem; y++) {
    if (runAt(y).w > torsoW * 0.62) {
      yShoulder = y;
      break;
    }
  }
  const hoodPx = yShoulder - minY;
  const hoodWidth = median(Array.from({ length: 8 }, (_, i) => runAt(minY + Math.floor((hoodPx * (i + 1)) / 9)).w));
  const hoodDetected = hoodPx > hH * 0.08 && hoodWidth > torsoW * 0.22;
  if (!hoodDetected) warnings.push('No hood was found above the shoulders. The hood shape is entirely inferred.');
  const lengthPx = Math.max(1, yHem - yShoulder);
  // Sleeves: farthest silhouette point from the shoulder corner on each side.
  const shoulderLeft: [number, number] = [torsoRow.l, yShoulder + lengthPx * 0.06];
  const shoulderRight: [number, number] = [torsoRow.r, yShoulder + lengthPx * 0.06];
  let leftD = 0;
  let rightD = 0;
  for (let y = yShoulder; y <= maxY; y++)
    for (let x = minX; x <= maxX; x++) {
      if (!main[y * w + x]) continue;
      if (x < torsoRow.l) leftD = Math.max(leftD, Math.hypot(x - shoulderLeft[0], y - shoulderLeft[1]));
      if (x > torsoRow.r) rightD = Math.max(rightD, Math.hypot(x - shoulderRight[0], y - shoulderRight[1]));
    }
  const sleevePx = Math.max(leftD, rightD);
  if (sleevePx < lengthPx * 0.25) warnings.push('Sleeves could not be separated from the body. Sleeve length is inferred from the default.');
  if (Math.abs(leftD - rightD) > lengthPx * 0.2 && sleevePx > lengthPx * 0.25) warnings.push('Left and right sleeves look different lengths. This may be pose, not garment shape.');
  const cols: number[][] = [[], [], []];
  const bandCols: number[][] = [[], [], []];
  for (let y = yShoulder; y <= yHem; y += 2)
    for (let x = torsoRow.l; x <= torsoRow.r; x += 2) {
      if (!main[y * w + x]) continue;
      const i = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) cols[c].push(data[i + c]);
    }
  for (let y = Math.floor(yHem - lengthPx * 0.05); y <= yHem; y++)
    for (let x = torsoRow.l; x <= torsoRow.r; x += 2) {
      if (!main[y * w + x]) continue;
      const i = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) bandCols[c].push(data[i + c]);
    }
  const ratio = { widthToLength: torsoW / lengthPx, sleeveToLength: sleevePx / lengthPx, hoodToLength: hoodPx / lengthPx };
  const edgeTouch = minX <= 1 || maxX >= w - 2 || minY <= 1 || maxY >= h - 2;
  if (edgeTouch) warnings.push('The garment touches the image edge and may be cropped.');
  let confidence = 0.35 + uniformity * 0.35 + (hoodDetected ? 0.1 : 0) + (sleevePx > lengthPx * 0.25 ? 0.1 : 0) + (edgeTouch ? -0.2 : 0.05) - (armsMerged ? 0.15 : 0);
  confidence = Math.max(0.05, Math.min(0.9, confidence));
  return {
    ok: true,
    width: source.width,
    height: source.height,
    bbox: [minX / w, minY / h, maxX / w, maxY / h],
    torso: { x0: torsoRow.l / w, x1: torsoRow.r / w, yShoulder: yShoulder / h, yHem: yHem / h },
    sleeve: { left: leftD / lengthPx, right: rightD / lengthPx },
    hoodDetected,
    hoodHeightRatio: hoodPx / lengthPx,
    backgroundUniformity: uniformity,
    maskCoverage: covFrac,
    medianColor: hex(median(cols[0]), median(cols[1]), median(cols[2])),
    lowerBandColor: hex(median(bandCols[0]), median(bandCols[1]), median(bandCols[2])),
    ratios: ratio,
    confidence,
    warnings,
    mask: main,
    maskWidth: w,
    maskHeight: h,
  };
}

function percentile(values: number[], p: number) {
  const s = values.slice().sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length * p)] : 0;
}

export function colorDistance(a: string, b: string) {
  const parse = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [x, y] = [parse(a), parse(b)];
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
}
