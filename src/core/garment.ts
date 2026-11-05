import { add, lerp, lerp3, normalize, scale, smoothstep, sub, vertexNormals, type V3 } from './math.ts';
import { FABRICS, QUALITY, type HoodieParams, type PartId, type Quality } from './params.ts';
import type { Skeleton } from './avatar.ts';

export type MaterialSlot = 'main' | 'rib' | 'cord';

export interface PartMesh {
  id: PartId;
  material: MaterialSlot;
  vertexCount: number;
  /** Appearance vertex to simulation vertex. Empty when the part is surface-embedded. */
  map: Int32Array;
  embed?: { ids: Int32Array; w: Float32Array; offs: Float32Array; nrm: Float32Array };
  uv: Float32Array;
  indices: Uint32Array;
  rows: number;
  cols: number;
  rect: [number, number, number, number];
  /** Panel edges that carry stitching, used for the texture bake. */
  stitched: { left: boolean; right: boolean; bottom: boolean; top: boolean };
  /** How the part relates to the simulation. */
  simulated: boolean;
}

export interface Seam {
  name: string;
  parts: [PartId, PartId];
  /** Ordered simulation vertices along the seam. */
  verts: number[];
  /** Structural: encoded in topology. Not production-grade sewing data. */
  kind: 'structural';
}

export interface Garment {
  params: HoodieParams;
  quality: Quality;
  ds: number;
  simPositions: Float32Array;
  simRest: Float32Array;
  simIndices: Uint32Array;
  invMass: Float32Array;
  edges: Uint32Array;
  edgeRest: Float32Array;
  edgeStiff: Float32Array;
  bends: Uint32Array;
  bendRest: Float32Array;
  groups: { hood: number[]; collar: number[]; cuffL: number[]; cuffR: number[]; hem: number[] };
  parts: PartMesh[];
  seams: Seam[];
  /** Flat 2D pattern outlines in metres, derived from the 3D rest shape. */
  pattern: { part: PartId; width: number; height: number; outline: [number, number][] }[];
  totalMassKg: number;
  /** Rest-pose appearance positions per part, used by edit-locality checks. */
  restParts: Record<string, Float32Array>;
  /** Mapping from pocket grid to the front panel, used when projecting a reference image. */
  pocketMap: { halfU: number; hRows: number; rows: number } | null;
}

interface RawPanel {
  part: PartId;
  material: MaterialSlot;
  rows: number;
  cols: number;
  base: number;
  flip: boolean;
  stitched: PartMesh['stitched'];
}

class UF {
  p: Int32Array;
  constructor(n: number) {
    this.p = new Int32Array(n).map((_, i) => i);
  }
  find(a: number): number {
    while (this.p[a] !== a) {
      this.p[a] = this.p[this.p[a]];
      a = this.p[a];
    }
    return a;
  }
  union(a: number, b: number) {
    const x = this.find(a);
    const y = this.find(b);
    if (x !== y) this.p[Math.max(x, y)] = Math.min(x, y);
  }
}

const NECK_RX = 0.102;

export function buildGarment(params: HoodieParams, quality: Quality, sk: Skeleton): Garment {
  const ds = QUALITY[quality].ds;
  const fabric = FABRICS[params.fabric] ?? FABRICS.fleece;
  const h = sk.shape.height / 1.78;

  const rest: number[] = [];
  const init: number[] = [];
  const panels: RawPanel[] = [];
  const addPanel = (
    part: PartId,
    material: MaterialSlot,
    rows: number,
    cols: number,
    flip: boolean,
    stitched: PartMesh['stitched'],
    fn: (i: number, j: number) => { rest: V3; init?: V3 },
  ) => {
    const base = rest.length / 3;
    for (let i = 0; i <= rows; i++)
      for (let j = 0; j <= cols; j++) {
        const v = fn(i, j);
        rest.push(...v.rest);
        init.push(...(v.init ?? v.rest));
      }
    const p: RawPanel = { part, material, rows, cols, base, flip, stitched };
    panels.push(p);
    return p;
  };
  const id = (p: RawPanel, i: number, j: number) => p.base + i * (p.cols + 1) + j;
  const P = (raw: number): V3 => [rest[raw * 3], rest[raw * 3 + 1], rest[raw * 3 + 2]];

  // Landmarks from the avatar, so garment and body share one frame and one scale.
  const yHPS = 1.545 * h;
  const halfS = params.shoulderWidth / 2;
  const armTan = Math.tan((40 * Math.PI) / 180);
  const yTip = 1.43 * h - (halfS - sk.bind[6][0]) * armTan + 0.105;
  const yBottom = yHPS - params.bodyLength;
  const yHemSeam = yBottom + params.hemHeight;
  const armhole = Math.min(0.36, params.sleeveWidth * 1.08);
  const yUnder = Math.max(yHemSeam + 0.08, yTip - armhole);
  const a0 = params.bodyWidth * 0.41;
  const b0 = Math.max(params.bodyWidth * 0.212, 0.125);

  const nSide = Math.max(3, Math.round((yUnder - yHemSeam) / ds));
  const nArm = Math.max(3, Math.round((yTip - yUnder) / ds));
  const rows = nSide + nArm;
  let nNeck = Math.max(4, Math.round(0.3 / ds));
  if (nNeck % 2) nNeck++;
  let nShoulder = Math.max(2, Math.round((halfS - NECK_RX) * 1.15 / ds));
  const cols = 2 * nShoulder + nNeck;

  const topPoint = (j: number, sign: 1 | -1): V3 => {
    if (j <= nShoulder || j >= cols - nShoulder) {
      const side = j <= nShoulder ? -1 : 1;
      const f = side < 0 ? 1 - j / nShoulder : 1 - (cols - j) / nShoulder;
      const x = lerp(NECK_RX, halfS, f);
      return [side * x, lerp(yHPS, yTip, f ** 1.15), sign * -0.004];
    }
    const phi = ((j - nShoulder) / nNeck - 0.5) * Math.PI;
    const drop = sign > 0 ? 0.095 : 0.022;
    const zr = sign > 0 ? 0.112 : 0.088;
    return [NECK_RX * Math.sin(phi), yHPS - drop * Math.cos(phi) ** 2, sign * zr * Math.cos(phi)];
  };

  // Columns are spaced evenly by arc length on every row, so the rest mesh has no crushed edges near the side seams.
  const resampleByArc = (curve: V3[], n: number): V3[] => {
    const lens = [0];
    for (let k = 1; k < curve.length; k++) lens.push(lens[k - 1] + Math.hypot(curve[k][0] - curve[k - 1][0], curve[k][1] - curve[k - 1][1], curve[k][2] - curve[k - 1][2]));
    const total = lens[lens.length - 1];
    const out: V3[] = [];
    let seg = 0;
    for (let j = 0; j <= n; j++) {
      const target = (j / n) * total;
      while (seg < curve.length - 2 && lens[seg + 1] < target) seg++;
      const f = (target - lens[seg]) / Math.max(1e-9, lens[seg + 1] - lens[seg]);
      out.push(lerp3(curve[seg], curve[seg + 1], Math.min(1, Math.max(0, f))));
    }
    return out;
  };
  const rowCache = new Map<string, V3[]>();
  const bodyRow = (i: number, sign: 1 | -1): V3[] => {
    const key = `${i}:${sign}`;
    const hit = rowCache.get(key);
    if (hit) return hit;
    const t = i <= nSide ? 0 : (i - nSide) / nArm;
    const y = i <= nSide ? lerp(yHemSeam, yUnder, i / nSide) : lerp(yUnder, yTip, t);
    const a = lerp(a0, halfS, t);
    const b = lerp(b0, 0.1, t * t);
    const zSide = t > 0 ? 0.105 * Math.sin(Math.PI * t) ** 0.8 : 0;
    const samples: V3[] = [];
    for (let k = 0; k <= 96; k++) {
      const theta = (k / 96 - 0.5) * Math.PI;
      const c = Math.cos(theta);
      samples.push([a * Math.sin(theta), y, sign * (b * c + zSide * (1 - c))]);
    }
    const row = resampleByArc(samples, cols);
    rowCache.set(key, row);
    return row;
  };
  const bodyPoint = (i: number, j: number, sign: 1 | -1): V3 => {
    const surface = bodyRow(i, sign)[j];
    if (i <= nSide) return surface;
    const t = (i - nSide) / nArm;
    // Linear blend, so rows keep even spacing all the way up to the shoulder seam.
    return lerp3(surface, topPoint(j, sign), Math.max(0, (t - 0.12) / 0.88));
  };

  const front = addPanel('Body_Front', 'main', rows, cols, false, { left: true, right: true, bottom: true, top: true }, (i, j) => ({ rest: bodyPoint(i, j, 1) }));
  const back = addPanel('Body_Back', 'main', rows, cols, true, { left: true, right: true, bottom: true, top: true }, (i, j) => ({ rest: bodyPoint(i, j, -1) }));

  // Sleeves start from the armhole ring so topology is shared with the body.
  const M = 2 * nArm;
  const sleeveLen = params.sleeveLength - params.cuffHeight;
  const nSleeve = Math.max(4, Math.round(sleeveLen / ds));
  const rU = params.sleeveWidth / Math.PI;
  const rC = params.cuffWidth / Math.PI;
  const nCuff = Math.max(2, Math.round(params.cuffHeight / ds));

  const makeSleeve = (side: 1 | -1) => {
    const sideCol = side > 0 ? cols : 0;
    const ringRaw: number[] = [];
    for (let k = 0; k <= nArm; k++) ringRaw.push(id(front, nSide + k, sideCol));
    for (let k = nArm - 1; k >= 0; k--) ringRaw.push(id(back, nSide + k, sideCol));
    const ring = ringRaw.map(P);
    const center: V3 = scale(ring.slice(0, M).reduce((s, p) => add(s, p), [0, 0, 0] as V3), 1 / M);
    const wrist: V3 = sk.bind[side > 0 ? 8 : 12];
    const dir = normalize(sub(wrist, center));
    const e1 = normalize(sub([0, 1, 0], scale(dir, dir[1])));
    const e2: V3 = [0, 0, 1];
    const circle = (c: V3, r: number, k: number): V3 => {
      const phi = -Math.PI / 2 + (k / M) * Math.PI * 2;
      return add(c, add(scale(e1, r * Math.sin(phi)), scale(e2, r * Math.cos(phi) * 1)));
    };
    const rEnd = rC * 1.42;
    const sleeve = addPanel(side > 0 ? 'Sleeve_L' : 'Sleeve_R', 'main', nSleeve, M, side > 0, { left: true, right: true, bottom: true, top: true }, (i, k) => {
      const v = i / nSleeve;
      const c = add(center, scale(dir, v * sleeveLen));
      const r = lerp(rU, rEnd, v ** 0.85);
      // Ease-out, so the first rows leave the armhole at full spacing instead of bunching on it.
      const x = Math.min(1, v / 0.24);
      return { rest: lerp3(ring[k], circle(c, r, k), 1 - (1 - x) * (1 - x)) };
    });
    const cuffStart = add(center, scale(dir, sleeveLen));
    const cuff = addPanel(side > 0 ? 'Cuff_L' : 'Cuff_R', 'rib', nCuff, M, side > 0, { left: true, right: true, bottom: false, top: false }, (i, k) => {
      const v = i / nCuff;
      const c = add(cuffStart, scale(dir, v * params.cuffHeight));
      const r = i === 0 ? rEnd : rC * (1 + 0.04 * Math.sin(Math.PI * v));
      return { rest: circle(c, r, k) };
    });
    return { sleeve, cuff, ringRaw };
  };
  const sleeveL = makeSleeve(1);
  const sleeveR = makeSleeve(-1);

  // Hem rib is a closed tube around front and back.
  const nHem = Math.max(2, Math.round(params.hemHeight / ds));
  const aR = params.hemWidth * 0.41;
  const bR = Math.max(params.hemWidth * 0.212, 0.115);
  const ringPos = (k: number): V3 => (k <= cols ? P(id(front, 0, k)) : P(id(back, 0, 2 * cols - k)));
  const ribCurve = (sign: 1 | -1, y: number) => {
    const samples: V3[] = [];
    for (let k = 0; k <= 96; k++) {
      const theta = (k / 96 - 0.5) * Math.PI;
      samples.push([aR * Math.sin(theta), y, sign * bR * Math.cos(theta)]);
    }
    return resampleByArc(samples, cols);
  };
  const hem = addPanel('Hem_Rib', 'rib', nHem, 2 * cols, true, { left: false, right: false, bottom: false, top: false }, (i, k) => {
    if (i === 0) return { rest: ringPos(k) };
    const y = lerp(yHemSeam, yBottom, i / nHem);
    return { rest: k <= cols ? ribCurve(1, y)[k] : ribCurve(-1, y)[2 * cols - k] };
  });

  // Hood: two halves. Rest shape is hood-up; initial state is folded back so it settles down behind the neck.
  const nHoodRows = Math.max(4, Math.round((params.hoodHeight * 1.15) / ds));
  const neckRaw = (side: 1 | -1, c: number) => {
    const half = nNeck / 2;
    const mid = cols / 2;
    if (c <= half) return id(front, rows, mid + side * c);
    return id(back, rows, mid + side * (nNeck - c));
  };
  const yNB = P(id(back, rows, cols / 2))[1];
  const zNB = P(id(back, rows, cols / 2))[2];
  const makeHood = (side: 1 | -1) =>
    addPanel(side > 0 ? 'Hood_L' : 'Hood_R', 'main', nHoodRows, nNeck, side < 0, { left: false, right: true, bottom: true, top: true }, (i, c) => {
      const u = c / nNeck;
      const v = i / nHoodRows;
      const N = P(neckRaw(side, c));
      const H = params.hoodHeight;
      const D = params.hoodDepth;
      const cy = yNB + H * 0.56;
      const cz = -0.035;
      const g = ((62 + u * 150) * Math.PI) / 180;
      const crown: V3 = [0, cy + H * 0.4 * Math.sin(g), cz + (D * 0.58) * Math.cos(g)];
      const ve = v ** 0.85;
      const bulge = (D * 0.42) * Math.sin(Math.PI * v) ** 0.8 * (0.62 + 0.38 * Math.sin(Math.PI * Math.min(1, u * 1.1))) * (u >= 1 ? 0 : 1) * Math.cos(u * Math.PI * 0.5) ** 0.4;
      const restP: V3 = [side * (N[0] * side * (1 - ve) + bulge), lerp(N[1], crown[1], ve), lerp(N[2], crown[2], ve) - 0.035 * u * Math.sin(Math.PI * v)];
      // Fold back about the neck axis. The solver removes the small distortion near the seam.
      const phi = ((78 * Math.PI) / 180) * smoothstep(0.02, 0.42, v);
      const dy = restP[1] - yNB;
      const dz = restP[2] - zNB;
      const initP: V3 = [restP[0], yNB + dy * Math.cos(phi) + dz * Math.sin(phi), zNB + dz * Math.cos(phi) - dy * Math.sin(phi)];
      return { rest: restP, init: initP };
    });
  const hoodL = makeHood(1);
  const hoodR = makeHood(-1);

  // Weld seams structurally.
  const total = rest.length / 3;
  const uf = new UF(total);
  const seamDefs: { name: string; parts: [PartId, PartId]; pairs: [number, number][] }[] = [];
  const seam = (name: string, parts: [PartId, PartId], pairs: [number, number][]) => {
    for (const [a, b] of pairs) uf.union(a, b);
    seamDefs.push({ name, parts, pairs });
  };
  const range = (n: number, f: (i: number) => [number, number]) => Array.from({ length: n }, (_, i) => f(i));
  seam('Side seam, left', ['Body_Front', 'Body_Back'], range(nSide + 1, (i) => [id(front, i, cols), id(back, i, cols)]));
  seam('Side seam, right', ['Body_Front', 'Body_Back'], range(nSide + 1, (i) => [id(front, i, 0), id(back, i, 0)]));
  seam('Shoulder seam, left', ['Body_Front', 'Body_Back'], range(nShoulder + 1, (j) => [id(front, rows, cols - j), id(back, rows, cols - j)]));
  seam('Shoulder seam, right', ['Body_Front', 'Body_Back'], range(nShoulder + 1, (j) => [id(front, rows, j), id(back, rows, j)]));
  for (const [s, side, label, part, cuffPart] of [
    [sleeveL, 'left', 'L', 'Sleeve_L', 'Cuff_L'],
    [sleeveR, 'right', 'R', 'Sleeve_R', 'Cuff_R'],
  ] as const) {
    seam(`Armhole, ${side}`, ['Body_Front', part], range(M + 1, (k) => [s.ringRaw[k], id(s.sleeve, 0, k)]));
    seam(`Underarm seam, ${side}`, [part, part], range(nSleeve + 1, (i) => [id(s.sleeve, i, 0), id(s.sleeve, i, M)]));
    seam(`Cuff join, ${side}`, [part, cuffPart], range(M + 1, (k) => [id(s.sleeve, nSleeve, k), id(s.cuff, 0, k)]));
    seam(`Cuff seam, ${side}`, [cuffPart, cuffPart], range(nCuff + 1, (i) => [id(s.cuff, i, 0), id(s.cuff, i, M)]));
    void label;
  }
  seam('Hem join', ['Body_Front', 'Hem_Rib'], range(2 * cols + 1, (k) => [k <= cols ? id(front, 0, k) : id(back, 0, 2 * cols - k), id(hem, 0, k)]));
  seam('Hem seam', ['Hem_Rib', 'Hem_Rib'], range(nHem + 1, (i) => [id(hem, i, 0), id(hem, i, 2 * cols)]));
  seam('Neckline, left', ['Body_Front', 'Hood_L'], range(nNeck + 1, (c) => [neckRaw(1, c), id(hoodL, 0, c)]));
  seam('Neckline, right', ['Body_Front', 'Hood_R'], range(nNeck + 1, (c) => [neckRaw(-1, c), id(hoodR, 0, c)]));
  seam('Hood centre seam, back', ['Hood_L', 'Hood_R'], range(nHoodRows + 1, (i) => [id(hoodL, i, nNeck), id(hoodR, i, nNeck)]));
  seam('Hood centre seam, crown', ['Hood_L', 'Hood_R'], range(nNeck + 1, (c) => [id(hoodL, nHoodRows, c), id(hoodR, nHoodRows, c)]));

  // Compact raw vertices into simulation vertices.
  const simOf = new Int32Array(total).fill(-1);
  let nSim = 0;
  for (let i = 0; i < total; i++) {
    const r = uf.find(i);
    if (simOf[r] < 0) simOf[r] = nSim++;
    simOf[i] = simOf[r];
  }
  const simPositions = new Float32Array(nSim * 3);
  const simRest = new Float32Array(nSim * 3);
  const counts = new Float32Array(nSim);
  for (let i = 0; i < total; i++) {
    const s = simOf[i];
    counts[s]++;
    for (let c = 0; c < 3; c++) {
      simPositions[s * 3 + c] += init[i * 3 + c];
      simRest[s * 3 + c] += rest[i * 3 + c];
    }
  }
  for (let s = 0; s < nSim; s++)
    for (let c = 0; c < 3; c++) {
      simPositions[s * 3 + c] /= counts[s];
      simRest[s * 3 + c] /= counts[s];
    }

  // Triangles, edges and bending pairs.
  const simTris: number[] = [];
  const edgeMap = new Map<number, { rest: number; n: number; stiff: number; opp: number[] }>();
  const key = (a: number, b: number) => (a < b ? a * nSim + b : b * nSim + a);
  const massAcc = new Float64Array(nSim);
  const dist = (a: number, b: number) => Math.hypot(rest[a * 3] - rest[b * 3], rest[a * 3 + 1] - rest[b * 3 + 1], rest[a * 3 + 2] - rest[b * 3 + 2]);
  const gsm = fabric.gsm / 1000;
  const addTri = (a: number, b: number, c: number, stiff: number) => {
    const A = simOf[a];
    const B = simOf[b];
    const C = simOf[c];
    if (A === B || B === C || A === C) return;
    simTris.push(A, B, C);
    const pa = P(a);
    const pb = P(b);
    const pc = P(c);
    const u = sub(pb, pa);
    const v = sub(pc, pa);
    const area = 0.5 * Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]);
    for (const s of [A, B, C]) massAcc[s] += (area * gsm) / 3;
    for (const [x, y, ox, rx, ry] of [[A, B, C, a, b], [B, C, A, b, c], [C, A, B, c, a]] as const) {
      const k = key(x, y);
      const e = edgeMap.get(k);
      const d = dist(rx, ry);
      if (e) {
        e.rest += d;
        e.n++;
        e.opp.push(ox);
        e.stiff = Math.min(e.stiff, stiff);
      } else edgeMap.set(k, { rest: d, n: 1, stiff, opp: [ox] });
    }
  };
  for (const p of panels) {
    const stiff = p.material === 'rib' ? 0.35 : 1;
    for (let i = 0; i < p.rows; i++)
      for (let j = 0; j < p.cols; j++) {
        const a = id(p, i, j);
        const b = id(p, i, j + 1);
        const c = id(p, i + 1, j + 1);
        const d = id(p, i + 1, j);
        const alt = (i + j) % 2 === 0;
        const tris = alt ? [[a, b, c], [a, c, d]] : [[a, b, d], [b, c, d]];
        for (const [x, y, z] of tris) (p.flip ? addTri(x, z, y, stiff) : addTri(x, y, z, stiff));
      }
  }
  const edges = new Uint32Array(edgeMap.size * 2);
  const edgeRest = new Float32Array(edgeMap.size);
  const edgeStiff = new Float32Array(edgeMap.size);
  const bendsTmp: number[] = [];
  const bendRestTmp: number[] = [];
  let e = 0;
  for (const [k, v] of edgeMap) {
    edges[e * 2] = Math.floor(k / nSim);
    edges[e * 2 + 1] = k % nSim;
    edgeRest[e] = v.rest / v.n;
    edgeStiff[e] = v.stiff;
    e++;
    if (v.opp.length === 2 && v.opp[0] !== v.opp[1]) {
      const [p, q] = v.opp;
      // Rest distance is measured with the two triangles unfolded flat. Real fabric has no memory of the
      // shape it was cut into, so a seam ridge in the initial layout should not persist after draping.
      const A = edges[(e - 1) * 2];
      const B = edges[(e - 1) * 2 + 1];
      const d = (i: number, j: number) => Math.hypot(simRest[i * 3] - simRest[j * 3], simRest[i * 3 + 1] - simRest[j * 3 + 1], simRest[i * 3 + 2] - simRest[j * 3 + 2]);
      const base = Math.max(1e-6, d(A, B));
      const place = (o: number) => {
        const a = d(o, A);
        const b = d(o, B);
        const x = (a * a - b * b + base * base) / (2 * base);
        return [x, Math.sqrt(Math.max(0, a * a - x * x))];
      };
      const [x1, y1] = place(p);
      const [x2, y2] = place(q);
      bendsTmp.push(p, q);
      bendRestTmp.push(Math.hypot(x1 - x2, y1 + y2));
    }
  }
  const invMass = new Float32Array(nSim);
  let totalMass = 0;
  for (let s = 0; s < nSim; s++) {
    totalMass += massAcc[s];
    invMass[s] = massAcc[s] > 0 ? 1 / massAcc[s] : 0;
  }

  // Appearance parts.
  const parts: PartMesh[] = [];
  const pattern: Garment['pattern'] = [];
  const restParts: Record<string, Float32Array> = {};
  for (const p of panels) {
    const count = (p.rows + 1) * (p.cols + 1);
    const map = new Int32Array(count);
    const uv = new Float32Array(count * 2);
    const positions = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      map[i] = simOf[p.base + i];
      const raw = P(p.base + i);
      positions.set(raw, i * 3);
    }
    restParts[p.part] = positions;
    const tris: number[] = [];
    for (let i = 0; i < p.rows; i++)
      for (let j = 0; j < p.cols; j++) {
        const q = (a: number, b: number) => a * (p.cols + 1) + b;
        const [a, b, c, d] = [q(i, j), q(i, j + 1), q(i + 1, j + 1), q(i + 1, j)];
        const alt = (i + j) % 2 === 0;
        const t = alt ? [a, b, c, a, c, d] : [a, b, d, b, c, d];
        if (p.flip) for (let n = 0; n < t.length; n += 3) tris.push(t[n], t[n + 2], t[n + 1]);
        else tris.push(...t);
      }
    // Pattern metrics from rest edge lengths along the middle row and column.
    let width = 0;
    const midRow = Math.floor(p.rows / 2);
    for (let j = 0; j < p.cols; j++) width += dist(id(p, midRow, j), id(p, midRow, j + 1));
    let height = 0;
    const midCol = Math.floor(p.cols / 2);
    for (let i = 0; i < p.rows; i++) height += dist(id(p, i, midCol), id(p, i + 1, midCol));
    const rowW = (r: number) => {
      let w = 0;
      for (let j = 0; j < p.cols; j++) w += dist(id(p, r, j), id(p, r, j + 1));
      return w;
    };
    const outline: [number, number][] = [];
    const steps = Math.min(p.rows, 14);
    const rowY = (r: number) => {
      let y = 0;
      for (let i = 0; i < r; i++) y += dist(id(p, i, midCol), id(p, i + 1, midCol));
      return y;
    };
    for (let n = 0; n <= steps; n++) {
      const r = Math.round((n / steps) * p.rows);
      outline.push([-rowW(r) / 2, rowY(r)]);
    }
    for (let n = steps; n >= 0; n--) {
      const r = Math.round((n / steps) * p.rows);
      outline.push([rowW(r) / 2, rowY(r)]);
    }
    pattern.push({ part: p.part, width, height, outline });
    parts.push({ id: p.part, material: p.material, vertexCount: count, map, uv, indices: new Uint32Array(tris), rows: p.rows, cols: p.cols, rect: [0, 0, 1, 1], stitched: p.stitched, simulated: true });
  }

  // Surface-embedded parts follow the front panel. They add appearance detail without extra solver cost.
  const frontBilerp = (fi: number, fj: number) => {
    const i0 = Math.max(0, Math.min(rows - 1, Math.floor(fi)));
    const j0 = Math.max(0, Math.min(cols - 1, Math.floor(fj)));
    const s = fi - i0;
    const t = fj - j0;
    const ids = [simOf[id(front, i0, j0)], simOf[id(front, i0, j0 + 1)], simOf[id(front, i0 + 1, j0)], simOf[id(front, i0 + 1, j0 + 1)]];
    const w = [(1 - s) * (1 - t), (1 - s) * t, s * (1 - t), s * t];
    return { ids, w };
  };
  if (params.pocket) {
    const rowH = (yUnder - yHemSeam) / nSide;
    const hRows = Math.min(nSide - 1, params.pocketHeight / rowH);
    const pr = Math.max(3, Math.round(params.pocketHeight / ds));
    const pc = Math.max(4, Math.round(params.pocketWidth / ds));
    const halfU = Math.min(0.46, params.pocketWidth / (2 * params.bodyWidth));
    const count = (pr + 1) * (pc + 1);
    const ids = new Int32Array(count * 4);
    const w = new Float32Array(count * 4);
    const offs = new Float32Array(count * 3);
    const nrm = new Float32Array(count * 3);
    const uv = new Float32Array(count * 2);
    const tris: number[] = [];
    const restPos = new Float32Array(count * 3);
    for (let i = 0; i <= pr; i++)
      for (let j = 0; j <= pc; j++) {
        const v = i / pr;
        const su = j / pc;
        // Slanted kangaroo opening: full width low down, narrowing above 40% of the height.
        const narrow = lerp(1, 0.6, smoothstep(0.4, 1, v));
        const u = 0.5 + (su - 0.5) * 2 * halfU * narrow;
        const fi = 0.4 + v * hRows;
        const fj = u * cols;
        const b = frontBilerp(fi, fj);
        const n = i * (pc + 1) + j;
        ids.set(b.ids, n * 4);
        w.set(b.w, n * 4);
        const edge = Math.min(su, 1 - su, v * 3, (1 - v) * 3);
        const off = 0.0015 + 0.0045 * smoothstep(0, 0.1, edge);
        offs.set([off, 0, 0], n * 3);
        nrm.set([1, 0, 0], n * 3);
        const pp: V3 = [0, 0, 0];
        for (let q = 0; q < 4; q++) for (let c = 0; c < 3; c++) pp[c] += simRest[b.ids[q] * 3 + c] * b.w[q];
        restPos.set(pp, n * 3);
      }
    for (let i = 0; i < pr; i++)
      for (let j = 0; j < pc; j++) {
        const q = (a: number, b: number) => a * (pc + 1) + b;
        tris.push(q(i, j), q(i, j + 1), q(i + 1, j + 1), q(i, j), q(i + 1, j + 1), q(i + 1, j));
      }
    restParts.Pocket = restPos;
    parts.push({ id: 'Pocket', material: 'main', vertexCount: count, map: new Int32Array(0), embed: { ids, w, offs, nrm }, uv, indices: new Uint32Array(tris), rows: pr, cols: pc, rect: [0, 0, 1, 1], stitched: { left: true, right: true, bottom: true, top: true }, simulated: false });
    pattern.push({ part: 'Pocket', width: params.pocketWidth, height: params.pocketHeight, outline: [[-params.pocketWidth / 2, 0], [-params.pocketWidth * 0.3, params.pocketHeight], [params.pocketWidth * 0.3, params.pocketHeight], [params.pocketWidth / 2, 0]] });
  }
  if (params.drawcords) {
    const rowH = (yUnder - yHemSeam) / nSide;
    for (const [part, sgn] of [['Drawcord_L', 1], ['Drawcord_R', -1]] as const) {
      const segs = 14;
      const ring = 6;
      const rho = 0.0032;
      const count = (segs + 1) * ring + 2;
      const ids = new Int32Array(count * 4);
      const w = new Float32Array(count * 4);
      const offs = new Float32Array(count * 3);
      const nrm = new Float32Array(count * 3);
      const uv = new Float32Array(count * 2);
      const restPos = new Float32Array(count * 3);
      const tris: number[] = [];
      const fj0 = cols / 2 + (sgn * 0.034 * cols) / (params.bodyWidth * 0.8);
      const len = 0.24;
      const setV = (n: number, fi: number, fj: number, o0: number, o1: number, n0: number, n1: number) => {
        const b = frontBilerp(fi, fj);
        ids.set(b.ids, n * 4);
        w.set(b.w, n * 4);
        offs.set([o0, o1, 0], n * 3);
        nrm.set([n0, n1, 0], n * 3);
        const pp: V3 = [0, 0, 0];
        for (let q = 0; q < 4; q++) for (let c = 0; c < 3; c++) pp[c] += simRest[b.ids[q] * 3 + c] * b.w[q];
        restPos.set([pp[0] + o1, pp[1], pp[2] + o0], n * 3);
      };
      const topFi = rows - 1.5;
      for (let s = 0; s <= segs; s++) {
        const v = s / segs;
        const fi = topFi - (v * len) / rowH;
        const wob = (sgn * 0.012 * cols * Math.sin(v * 2.4)) / (params.bodyWidth * 0.8);
        const r = s === segs ? rho * 1.5 : rho;
        for (let k = 0; k < ring; k++) {
          const ang = (k / ring) * Math.PI * 2;
          setV(s * ring + k, fi, fj0 + wob, 0.008 + r * Math.cos(ang), r * Math.sin(ang), Math.cos(ang), Math.sin(ang));
        }
      }
      const capA = (segs + 1) * ring;
      const capB = capA + 1;
      setV(capA, topFi, fj0, 0.008, 0, 1, 0);
      setV(capB, topFi - len / rowH - 0.1, fj0 + (sgn * 0.012 * cols * Math.sin(2.4)) / (params.bodyWidth * 0.8), 0.008, 0, 1, 0);
      for (let s = 0; s < segs; s++)
        for (let k = 0; k < ring; k++) {
          const a = s * ring + k;
          const b = s * ring + (k + 1) % ring;
          const c = (s + 1) * ring + (k + 1) % ring;
          const d = (s + 1) * ring + k;
          tris.push(a, b, c, a, c, d);
        }
      for (let k = 0; k < ring; k++) {
        tris.push(capA, (k + 1) % ring, k);
        tris.push(capB, segs * ring + k, segs * ring + (k + 1) % ring);
      }
      restParts[part] = restPos;
      parts.push({ id: part, material: 'cord', vertexCount: count, map: new Int32Array(0), embed: { ids, w, offs, nrm }, uv, indices: new Uint32Array(tris), rows: segs, cols: ring, rect: [0, 0, 1, 1], stitched: { left: false, right: false, bottom: false, top: false }, simulated: false });
    }
  }

  packAtlas(parts, pattern);

  // Grid UVs inside each packed rectangle.
  for (const p of parts) {
    const [x, y, w, hh] = p.rect;
    if (p.material === 'cord') {
      for (let i = 0; i < p.vertexCount; i++) {
        p.uv[i * 2] = x + w * 0.5;
        p.uv[i * 2 + 1] = y + hh * 0.5;
      }
      continue;
    }
    for (let i = 0; i <= p.rows; i++)
      for (let j = 0; j <= p.cols; j++) {
        const n = i * (p.cols + 1) + j;
        p.uv[n * 2] = x + (j / p.cols) * w;
        p.uv[n * 2 + 1] = y + (i / p.rows) * hh;
      }
  }

  const seams: Seam[] = seamDefs.map((s) => ({ name: s.name, parts: s.parts, kind: 'structural', verts: s.pairs.map(([a]) => simOf[a]) }));

  const uniq = (a: number[]) => [...new Set(a)];
  const groups: Garment['groups'] = {
    hood: uniq([hoodL, hoodR].flatMap((p) => Array.from({ length: (p.rows + 1) * (p.cols + 1) }, (_, i) => simOf[p.base + i]))),
    collar: uniq([...range(nNeck + 1, (c) => [neckRaw(1, c), neckRaw(-1, c)]).flat()].map((r) => simOf[r])),
    cuffL: uniq(range(M + 1, (k) => id(sleeveL.cuff, nCuff, k) as unknown as [number, number]).map((r) => simOf[r as unknown as number])),
    cuffR: uniq(range(M + 1, (k) => id(sleeveR.cuff, nCuff, k) as unknown as [number, number]).map((r) => simOf[r as unknown as number])),
    hem: uniq(range(2 * cols + 1, (k) => id(hem, nHem, k) as unknown as [number, number]).map((r) => simOf[r as unknown as number])),
  };

  return {
    params, quality, ds, simPositions, simRest,
    simIndices: new Uint32Array(simTris), invMass,
    edges, edgeRest, edgeStiff,
    bends: new Uint32Array(bendsTmp), bendRest: new Float32Array(bendRestTmp),
    groups, parts, seams, pattern, totalMassKg: totalMass, restParts,
    pocketMap: params.pocket ? { halfU: Math.min(0.46, params.pocketWidth / (2 * params.bodyWidth)), hRows: Math.min(nSide - 1, params.pocketHeight / ((yUnder - yHemSeam) / nSide)), rows } : null,
  };
}

function packAtlas(parts: PartMesh[], pattern: Garment['pattern']) {
  const size = (p: PartMesh): [number, number] => {
    if (p.material === 'cord') return [0.03, 0.03];
    const pat = pattern.find((x) => x.part === p.id)!;
    return [Math.max(0.05, pat.width), Math.max(0.05, pat.height)];
  };
  const order = [...parts].sort((a, b) => size(b)[1] - size(a)[1]);
  const margin = 0.02;
  const fits = (k: number, commit: boolean) => {
    let x = margin * k;
    let y = margin * k;
    let shelf = 0;
    for (const p of order) {
      const [w, h] = size(p);
      const pw = w * k;
      const ph = h * k;
      if (x + pw + margin * k > 1) {
        x = margin * k;
        y += shelf + margin * k;
        shelf = 0;
      }
      if (x + pw > 1 || y + ph > 1) return false;
      if (commit) p.rect = [x, y, pw, ph];
      x += pw + margin * k;
      shelf = Math.max(shelf, ph);
    }
    return true;
  };
  let lo = 0.05;
  let hi = 2;
  for (let n = 0; n < 24; n++) {
    const m = (lo + hi) / 2;
    if (fits(m, false)) lo = m;
    else hi = m;
  }
  fits(lo, true);
}

/** Evaluate appearance positions and normals for every part from solver positions. */
export function deformParts(g: Garment, simPos: Float32Array, simNormals?: Float32Array) {
  const nrm = simNormals ?? vertexNormals(simPos, g.simIndices);
  const out = g.parts.map((p) => ({ part: p, positions: new Float32Array(p.vertexCount * 3), normals: new Float32Array(p.vertexCount * 3) }));
  for (const o of out) writePart(o.part, simPos, nrm, o.positions, o.normals);
  return out;
}

export function writePart(p: PartMesh, simPos: Float32Array, nrm: Float32Array, pos: Float32Array, nor: Float32Array, posOffset = 0, norOffset = 0) {
  if (!p.embed) {
    for (let i = 0; i < p.vertexCount; i++) {
      const s = p.map[i] * 3;
      const a = posOffset + i * 3;
      const b = norOffset + i * 3;
      pos[a] = simPos[s];
      pos[a + 1] = simPos[s + 1];
      pos[a + 2] = simPos[s + 2];
      nor[b] = nrm[s];
      nor[b + 1] = nrm[s + 1];
      nor[b + 2] = nrm[s + 2];
    }
    return;
  }
  const { ids, w, offs, nrm: nm } = p.embed;
  for (let i = 0; i < p.vertexCount; i++) {
    let px = 0, py = 0, pz = 0, nx = 0, ny = 0, nz = 0;
    for (let q = 0; q < 4; q++) {
      const s = ids[i * 4 + q] * 3;
      const ww = w[i * 4 + q];
      px += simPos[s] * ww;
      py += simPos[s + 1] * ww;
      pz += simPos[s + 2] * ww;
      nx += nrm[s] * ww;
      ny += nrm[s + 1] * ww;
      nz += nrm[s + 2] * ww;
    }
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l;
    ny /= l;
    nz /= l;
    const o0 = offs[i * 3];
    const o1 = offs[i * 3 + 1];
    const a = posOffset + i * 3;
    const b = norOffset + i * 3;
    // Tangent offset uses world X, enough for cords hanging on the chest.
    pos[a] = px + nx * o0 + o1;
    pos[a + 1] = py + ny * o0;
    pos[a + 2] = pz + nz * o0;
    const n0 = nm[i * 3];
    const n1 = nm[i * 3 + 1];
    const mx = nx * n0 + n1;
    const my = ny * n0;
    const mz = nz * n0;
    const ml = Math.hypot(mx, my, mz) || 1;
    nor[b] = mx / ml;
    nor[b + 1] = my / ml;
    nor[b + 2] = mz / ml;
  }
}

export const appearanceVertexCount = (g: Garment) => g.parts.reduce((s, p) => s + p.vertexCount, 0);
