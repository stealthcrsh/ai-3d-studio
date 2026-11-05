import { blendPose, bindPose, clipPose, CLIPS, forwardKinematics, restPose, skinPoint, type Pose, type Skeleton, type WorldPose } from './avatar.ts';
import { add, mulberry32, qRot, sub, vertexNormals, type V3 } from './math.ts';
import { FABRICS, QUALITY, type ClipId, type PinGroup } from './params.ts';
import type { Garment } from './garment.ts';

/**
 * XPBD cloth with small substeps, capsule collision and hashed particle self-collision.
 * Thresholds follow docs/research/garment-physics.md and are engineering judgement, not measured standards.
 */
export class SolverDiverged extends Error {}

export interface SimOptions {
  substeps?: number;
  selfCollide?: boolean;
  pins?: PinGroup[];
  seed?: number;
  shouldStop?: () => boolean;
  onProgress?: (phase: string, frame: number, total: number) => void;
}

export interface Diagnostics {
  maxStretch: number;
  p99Stretch: number;
  meanStretch: number;
  /** Fraction of vertices deeper than half the collision thickness inside the avatar. */
  penetratingFraction: number;
  maxPenetrationMm: number;
  maxSpeed: number;
  selfCollisionEnabled: boolean;
  thicknessMm: number;
}

const THICKNESS = 0.005;

class ClothSolver {
  x: Float32Array;
  prev: Float32Array;
  v: Float32Array;
  w: Float32Array;
  extraAccel: Float32Array;
  /** Pinned verts stay kinematic and follow a joint. */
  pinJoint: Int16Array;
  pinLocal: Float32Array;
  maxSpeed = 0;
  private restNeighbour: Map<number, Set<number>> | null = null;
  selfRadius: number;
  private grid: Int32Array | null = null;
  private gridStart: Int32Array | null = null;
  private gridEntries: Int32Array | null = null;

  constructor(
    public g: Garment,
    public sk: Skeleton,
    public opts: Required<Pick<SimOptions, 'substeps' | 'selfCollide'>>,
  ) {
    this.x = g.simPositions.slice();
    this.prev = g.simPositions.slice();
    this.v = new Float32Array(this.x.length);
    this.w = g.invMass.slice();
    this.extraAccel = new Float32Array(this.x.length);
    this.pinJoint = new Int16Array(this.x.length / 3).fill(-1);
    this.pinLocal = new Float32Array(this.x.length);
    let mean = 0;
    for (let i = 0; i < g.edgeRest.length; i++) mean += g.edgeRest[i];
    mean /= Math.max(1, g.edgeRest.length);
    this.selfRadius = Math.max(0.004, mean * 0.4);
    if (opts.selfCollide) this.buildRestNeighbours(mean);
  }

  private buildRestNeighbours(mean: number) {
    // Vertices that begin close on the rest surface should not repel each other.
    const r = this.g.simRest;
    const n = r.length / 3;
    const cell = mean * 2.2;
    const hash = new Map<string, number[]>();
    const keyOf = (x: number, y: number, z: number) => `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;
    for (let i = 0; i < n; i++) {
      const k = keyOf(r[i * 3], r[i * 3 + 1], r[i * 3 + 2]);
      const a = hash.get(k);
      if (a) a.push(i);
      else hash.set(k, [i]);
    }
    const map = new Map<number, Set<number>>();
    const lim = cell * cell;
    for (let i = 0; i < n; i++) {
      const cx = Math.floor(r[i * 3] / cell);
      const cy = Math.floor(r[i * 3 + 1] / cell);
      const cz = Math.floor(r[i * 3 + 2] / cell);
      const s = new Set<number>();
      for (let dx = -1; dx <= 1; dx++)
        for (let dy = -1; dy <= 1; dy++)
          for (let dz = -1; dz <= 1; dz++) {
            const a = hash.get(`${cx + dx},${cy + dy},${cz + dz}`);
            if (!a) continue;
            for (const j of a) {
              const d = (r[i * 3] - r[j * 3]) ** 2 + (r[i * 3 + 1] - r[j * 3 + 1]) ** 2 + (r[i * 3 + 2] - r[j * 3 + 2]) ** 2;
              if (d < lim) s.add(j);
            }
          }
      map.set(i, s);
    }
    this.restNeighbour = map;
  }

  pin(groups: PinGroup[], wp: WorldPose) {
    const J = (name: string) => this.sk.parents.length && ['Hips', 'Spine', 'Chest', 'Neck', 'Head', 'Shoulder_L', 'UpperArm_L', 'Forearm_L', 'Hand_L', 'Shoulder_R', 'UpperArm_R', 'Forearm_R', 'Hand_R'].indexOf(name);
    const apply = (ids: number[], joint: number) => {
      for (const s of ids) {
        this.pinJoint[s] = joint;
        this.w[s] = 0;
        const p: V3 = [this.x[s * 3], this.x[s * 3 + 1], this.x[s * 3 + 2]];
        const local = qRot([-wp.q[joint][0], -wp.q[joint][1], -wp.q[joint][2], wp.q[joint][3]], sub(p, wp.t[joint]));
        this.pinLocal.set(local, s * 3);
      }
    };
    if (groups.includes('collar')) apply(this.g.groups.collar, J('Chest'));
    if (groups.includes('cuffs')) {
      apply(this.g.groups.cuffL, J('Forearm_L'));
      apply(this.g.groups.cuffR, J('Forearm_R'));
    }
    if (groups.includes('hem')) apply(this.g.groups.hem, J('Hips'));
  }

  private updatePins(wp: WorldPose) {
    for (let s = 0; s < this.pinJoint.length; s++) {
      const j = this.pinJoint[s];
      if (j < 0) continue;
      const p = add(wp.t[j], qRot(wp.q[j], [this.pinLocal[s * 3], this.pinLocal[s * 3 + 1], this.pinLocal[s * 3 + 2]]));
      this.x.set(p, s * 3);
    }
  }

  private buildSelfHash() {
    const x = this.x;
    const n = x.length / 3;
    const cell = this.selfRadius * 2;
    const size = n * 2;
    const start = this.gridStart && this.gridStart.length === size + 1 ? this.gridStart : new Int32Array(size + 1);
    start.fill(0);
    const hashFn = (ix: number, iy: number, iz: number) => Math.abs((ix * 92837111) ^ (iy * 689287499) ^ (iz * 283923481)) % size;
    for (let i = 0; i < n; i++) start[hashFn(Math.floor(x[i * 3] / cell), Math.floor(x[i * 3 + 1] / cell), Math.floor(x[i * 3 + 2] / cell))]++;
    let acc = 0;
    for (let i = 0; i < size; i++) {
      acc += start[i];
      start[i] = acc;
    }
    start[size] = acc;
    const entries = this.gridEntries && this.gridEntries.length === n ? this.gridEntries : new Int32Array(n);
    for (let i = 0; i < n; i++) {
      const h = hashFn(Math.floor(x[i * 3] / cell), Math.floor(x[i * 3 + 1] / cell), Math.floor(x[i * 3 + 2] / cell));
      entries[--start[h]] = i;
    }
    this.gridStart = start;
    this.gridEntries = entries;
    this.grid = start;
    return { hashFn, cell, size };
  }

  private solveSelf(h: { hashFn: (a: number, b: number, c: number) => number; cell: number; size: number }) {
    const x = this.x;
    const w = this.w;
    const r = this.selfRadius;
    const r2 = r * r;
    const n = x.length / 3;
    const start = this.gridStart!;
    const entries = this.gridEntries!;
    const near = this.restNeighbour!;
    for (let i = 0; i < n; i++) {
      if (w[i] === 0) continue;
      const cx = Math.floor(x[i * 3] / h.cell);
      const cy = Math.floor(x[i * 3 + 1] / h.cell);
      const cz = Math.floor(x[i * 3 + 2] / h.cell);
      const skip = near.get(i)!;
      for (let dx = -1; dx <= 1; dx++)
        for (let dy = -1; dy <= 1; dy++)
          for (let dz = -1; dz <= 1; dz++) {
            const b = h.hashFn(cx + dx, cy + dy, cz + dz);
            for (let e = start[b]; e < start[b + 1]; e++) {
              const j = entries[e];
              if (j <= i || skip.has(j)) continue;
              const ex = x[j * 3] - x[i * 3];
              const ey = x[j * 3 + 1] - x[i * 3 + 1];
              const ez = x[j * 3 + 2] - x[i * 3 + 2];
              const d2 = ex * ex + ey * ey + ez * ez;
              if (d2 >= r2 || d2 < 1e-12) continue;
              const d = Math.sqrt(d2);
              const corr = (0.5 * (r - d)) / d;
              x[i * 3] -= ex * corr;
              x[i * 3 + 1] -= ey * corr;
              x[i * 3 + 2] -= ez * corr;
              if (w[j] > 0) {
                x[j * 3] += ex * corr;
                x[j * 3 + 1] += ey * corr;
                x[j * 3 + 2] += ez * corr;
              }
            }
          }
    }
  }

  /** Advance one output step, interpolating the avatar pose across substeps. */
  step(dt: number, poseA: Pose, poseB: Pose, gravityScale = 1) {
    const { g, sk, x, prev, v, w, extraAccel } = this;
    const fabric = FABRICS[g.params.fabric] ?? FABRICS.fleece;
    const n = x.length / 3;
    const sub_ = dt / this.opts.substeps;
    const damp = Math.max(0, 1 - fabric.damping * sub_);
    const vMax = (0.2 * THICKNESS * 25) / sub_ > 8 ? 8 : (0.2 * THICKNESS * 25) / sub_;
    const G = -9.81 * gravityScale;
    const stretchA = fabric.stretchCompliance / (sub_ * sub_);
    const bendA = fabric.bendCompliance / (sub_ * sub_);
    const edges = g.edges;
    const rest = g.edgeRest;
    const stiff = g.edgeStiff;
    const bends = g.bends;
    const bendRest = g.bendRest;
    const caps = sk.capsules;
    const hash = this.opts.selfCollide ? this.buildSelfHash() : null;
    for (let s = 0; s < this.opts.substeps; s++) {
      const t = (s + 1) / this.opts.substeps;
      const wp = forwardKinematics(sk, blendPose(poseA, poseB, t));
      const capsA = caps.map((c) => skinPoint(sk, wp, c.ja, c.a));
      const capsB = caps.map((c) => skinPoint(sk, wp, c.jb, c.b));
      this.updatePins(wp);
      for (let i = 0; i < n; i++) {
        const ix = i * 3;
        if (w[i] === 0) continue;
        v[ix] = (v[ix] + extraAccel[ix] * sub_) * damp;
        v[ix + 1] = (v[ix + 1] + (G + extraAccel[ix + 1]) * sub_) * damp;
        v[ix + 2] = (v[ix + 2] + extraAccel[ix + 2] * sub_) * damp;
        const sp = Math.hypot(v[ix], v[ix + 1], v[ix + 2]);
        if (sp > vMax) {
          const k = vMax / sp;
          v[ix] *= k;
          v[ix + 1] *= k;
          v[ix + 2] *= k;
        }
        prev[ix] = x[ix];
        prev[ix + 1] = x[ix + 1];
        prev[ix + 2] = x[ix + 2];
        x[ix] += v[ix] * sub_;
        x[ix + 1] += v[ix + 1] * sub_;
        x[ix + 2] += v[ix + 2] * sub_;
      }
      for (let pass = 0; pass < 2; pass++) {
        for (let e = 0; e < rest.length; e++) {
          const a = edges[e * 2];
          const b = edges[e * 2 + 1];
          const wa = w[a];
          const wb = w[b];
          const ws = wa + wb;
          if (ws === 0) continue;
          const dx = x[b * 3] - x[a * 3];
          const dy = x[b * 3 + 1] - x[a * 3 + 1];
          const dz = x[b * 3 + 2] - x[a * 3 + 2];
          const l = Math.sqrt(dx * dx + dy * dy + dz * dz);
          if (l < 1e-9) continue;
          // Knit ribs compress easily but resist extension.
          const compliance = stretchA / stiff[e];
          const C = l - rest[e];
          const lam = -C / (ws + compliance) / l;
          x[a * 3] -= dx * lam * wa;
          x[a * 3 + 1] -= dy * lam * wa;
          x[a * 3 + 2] -= dz * lam * wa;
          x[b * 3] += dx * lam * wb;
          x[b * 3 + 1] += dy * lam * wb;
          x[b * 3 + 2] += dz * lam * wb;
        }
      }
      for (let e = 0; e < bendRest.length; e++) {
        const a = bends[e * 2];
        const b = bends[e * 2 + 1];
        const wa = w[a];
        const wb = w[b];
        const ws = wa + wb;
        if (ws === 0) continue;
        const dx = x[b * 3] - x[a * 3];
        const dy = x[b * 3 + 1] - x[a * 3 + 1];
        const dz = x[b * 3 + 2] - x[a * 3 + 2];
        const l = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (l < 1e-9) continue;
        const C = l - bendRest[e];
        const lam = -C / (ws + bendA) / l;
        x[a * 3] -= dx * lam * wa;
        x[a * 3 + 1] -= dy * lam * wa;
        x[a * 3 + 2] -= dz * lam * wa;
        x[b * 3] += dx * lam * wb;
        x[b * 3 + 1] += dy * lam * wb;
        x[b * 3 + 2] += dz * lam * wb;
      }
      if (hash && s % 2 === 0) this.solveSelf(hash);
      // Capsule collision with Coulomb-style friction relative to the moving surface.
      for (let c = 0; c < caps.length; c++) {
        const cap = caps[c];
        const A = capsA[c];
        const B = capsB[c];
        const bax = B[0] - A[0];
        const bay = B[1] - A[1];
        const baz = B[2] - A[2];
        const baba = bax * bax + bay * bay + baz * baz;
        const minX = Math.min(A[0], B[0]) - Math.max(cap.ra, cap.rb) - THICKNESS;
        const maxX = Math.max(A[0], B[0]) + Math.max(cap.ra, cap.rb) + THICKNESS;
        const minY = Math.min(A[1], B[1]) - Math.max(cap.ra, cap.rb) - THICKNESS;
        const maxY = Math.max(A[1], B[1]) + Math.max(cap.ra, cap.rb) + THICKNESS;
        for (let i = 0; i < n; i++) {
          const ix = i * 3;
          const px = x[ix];
          const py = x[ix + 1];
          if (w[i] === 0 || px < minX || px > maxX || py < minY || py > maxY) continue;
          const pz = x[ix + 2];
          const pax = px - A[0];
          const pay = py - A[1];
          const paz = pz - A[2];
          const tt = Math.min(1, Math.max(0, (pax * bax + pay * bay + paz * baz) / baba));
          const qx = pax - bax * tt;
          const qy = pay - bay * tt;
          const qz = paz - baz * tt;
          const d = Math.sqrt(qx * qx + qy * qy + qz * qz);
          const r = cap.ra + (cap.rb - cap.ra) * tt + THICKNESS;
          if (d >= r || d < 1e-9) continue;
          const nx = qx / d;
          const ny = qy / d;
          const nz = qz / d;
          const pen = r - d;
          x[ix] = px + nx * pen;
          x[ix + 1] = py + ny * pen;
          x[ix + 2] = pz + nz * pen;
          const mx = x[ix] - prev[ix];
          const my = x[ix + 1] - prev[ix + 1];
          const mz = x[ix + 2] - prev[ix + 2];
          const mn = mx * nx + my * ny + mz * nz;
          const f = fabric.friction;
          x[ix] -= (mx - mn * nx) * f;
          x[ix + 1] -= (my - mn * ny) * f;
          x[ix + 2] -= (mz - mn * nz) * f;
        }
      }
      this.updatePins(wp);
      const inv = 1 / sub_;
      let top = 0;
      for (let i = 0; i < n; i++) {
        const ix = i * 3;
        v[ix] = (x[ix] - prev[ix]) * inv;
        v[ix + 1] = (x[ix + 1] - prev[ix + 1]) * inv;
        v[ix + 2] = (x[ix + 2] - prev[ix + 2]) * inv;
        const sp = v[ix] * v[ix] + v[ix + 1] * v[ix + 1] + v[ix + 2] * v[ix + 2];
        if (sp > top) top = sp;
      }
      this.maxSpeed = Math.sqrt(top);
    }
    this.checkStable();
  }

  private checkStable() {
    const x = this.x;
    for (let i = 0; i < x.length; i++) {
      if (!Number.isFinite(x[i]) || Math.abs(x[i]) > 6) throw new SolverDiverged(`Solver diverged: vertex ${Math.floor(i / 3)} left the valid range`);
    }
    if (this.maxSpeed > 40) throw new SolverDiverged(`Solver diverged: speed ${this.maxSpeed.toFixed(1)} m/s`);
  }
}

export function diagnostics(g: Garment, sk: Skeleton, x: Float32Array, pose: Pose, selfCollisionEnabled: boolean, maxSpeed = 0): Diagnostics & { perVertex: { stretch: Float32Array; depth: Float32Array } } {
  const n = x.length / 3;
  const stretchPerVertex = new Float32Array(n);
  const ratios = new Float32Array(g.edgeRest.length);
  let sum = 0;
  for (let e = 0; e < g.edgeRest.length; e++) {
    const a = g.edges[e * 2];
    const b = g.edges[e * 2 + 1];
    const l = Math.hypot(x[a * 3] - x[b * 3], x[a * 3 + 1] - x[b * 3 + 1], x[a * 3 + 2] - x[b * 3 + 2]);
    const r = l / g.edgeRest[e];
    ratios[e] = r;
    sum += r;
    if (r > stretchPerVertex[a]) stretchPerVertex[a] = r;
    if (r > stretchPerVertex[b]) stretchPerVertex[b] = r;
  }
  const sorted = ratios.slice().sort();
  const wp = forwardKinematics(sk, pose);
  const depth = new Float32Array(n);
  let inside = 0;
  let maxPen = 0;
  const caps = sk.capsules.map((c) => ({ A: skinPoint(sk, wp, c.ja, c.a), B: skinPoint(sk, wp, c.jb, c.b), ra: c.ra, rb: c.rb }));
  for (let i = 0; i < n; i++) {
    let deepest = 0;
    for (const c of caps) {
      const ba = sub(c.B, c.A);
      const pa: V3 = [x[i * 3] - c.A[0], x[i * 3 + 1] - c.A[1], x[i * 3 + 2] - c.A[2]];
      const t = Math.min(1, Math.max(0, (pa[0] * ba[0] + pa[1] * ba[1] + pa[2] * ba[2]) / (ba[0] ** 2 + ba[1] ** 2 + ba[2] ** 2)));
      const d = Math.hypot(pa[0] - ba[0] * t, pa[1] - ba[1] * t, pa[2] - ba[2] * t) - (c.ra + (c.rb - c.ra) * t);
      if (-d > deepest) deepest = -d;
    }
    depth[i] = deepest;
    if (deepest > THICKNESS * 0.5) inside++;
    if (deepest > maxPen) maxPen = deepest;
  }
  return {
    maxStretch: sorted[sorted.length - 1],
    p99Stretch: sorted[Math.floor(sorted.length * 0.99)],
    meanStretch: sum / ratios.length,
    penetratingFraction: inside / n,
    maxPenetrationMm: maxPen * 1000,
    maxSpeed,
    selfCollisionEnabled,
    thicknessMm: THICKNESS * 1000,
    perVertex: { stretch: stretchPerVertex, depth },
  };
}

export interface DrapeResult {
  positions: Float32Array;
  velocities: Float32Array;
  diagnostics: ReturnType<typeof diagnostics>;
}

const FRAME = 1 / 30;

function pushOutOfBody(s: ClothSolver, sk: Skeleton) {
  const wp = forwardKinematics(sk, bindPose(sk));
  const caps = sk.capsules.map((c) => ({ A: skinPoint(sk, wp, c.ja, c.a), B: skinPoint(sk, wp, c.jb, c.b), ra: c.ra, rb: c.rb }));
  const x = s.x;
  for (let pass = 0; pass < 3; pass++)
    for (const c of caps) {
      const ba = sub(c.B, c.A);
      const bb = ba[0] ** 2 + ba[1] ** 2 + ba[2] ** 2;
      for (let i = 0; i < x.length; i += 3) {
        const pa: V3 = [x[i] - c.A[0], x[i + 1] - c.A[1], x[i + 2] - c.A[2]];
        const t = Math.min(1, Math.max(0, (pa[0] * ba[0] + pa[1] * ba[1] + pa[2] * ba[2]) / bb));
        const q: V3 = [pa[0] - ba[0] * t, pa[1] - ba[1] * t, pa[2] - ba[2] * t];
        const d = Math.hypot(q[0], q[1], q[2]);
        const r = c.ra + (c.rb - c.ra) * t + THICKNESS * 1.5;
        if (d < r && d > 1e-9) {
          x[i] += (q[0] / d) * (r - d);
          x[i + 1] += (q[1] / d) * (r - d);
          x[i + 2] += (q[2] / d) * (r - d);
        }
      }
    }
  s.prev.set(x);
}

/** Settle on the bind pose, ease into the relaxed standing pose, then hold until stable. */
export function drape(g: Garment, sk: Skeleton, options: SimOptions = {}): DrapeResult {
  const q = QUALITY[g.quality];
  const substeps = options.substeps ?? q.substeps;
  const selfCollide = options.selfCollide ?? q.selfCollide;
  const solver = new ClothSolver(g, sk, { substeps, selfCollide });
  // Small seeded jitter so perfect symmetry does not suppress buckling. Deterministic for a given seed.
  const rand = mulberry32(options.seed ?? 1);
  for (let i = 0; i < solver.x.length; i++) solver.x[i] += (rand() - 0.5) * 0.0006;
  pushOutOfBody(solver, sk);
  solver.prev.set(solver.x);
  const bind = bindPose(sk);
  const rest = restPose(sk);
  if (options.pins?.length) solver.pin(options.pins, forwardKinematics(sk, bind));
  // A gentle backward pull helps the hood fall behind the neck; it fades before the final hold.
  const hoodAssist = (scale: number) => {
    for (const s of g.groups.hood) {
      solver.extraAccel[s * 3 + 2] = -6 * scale;
      solver.extraAccel[s * 3 + 1] = -1 * scale;
    }
  };
  const settle = Math.round(1.0 / FRAME);
  const ease = Math.round(0.9 / FRAME);
  const hold = Math.round(1.4 / FRAME);
  const total = settle + ease + hold;
  let frame = 0;
  const tick = (a: Pose, b: Pose, phase: string, gravity = 1) => {
    if (options.shouldStop?.()) throw new Error('cancelled');
    solver.step(FRAME, a, b, gravity);
    frame++;
    if (frame % 3 === 0) options.onProgress?.(phase, frame, total);
  };
  for (let i = 0; i < settle; i++) {
    hoodAssist(1 - i / settle / 2);
    tick(bind, bind, 'settle', Math.min(1, 0.3 + (i / settle) * 0.9));
  }
  for (let i = 0; i < ease; i++) {
    const s0 = i / ease;
    const s1 = (i + 1) / ease;
    hoodAssist(0.5 * (1 - s0));
    const k = (v: number) => v * v * (3 - 2 * v);
    tick(blendPose(bind, rest, k(s0)), blendPose(bind, rest, k(s1)), 'lower arms');
  }
  solver.extraAccel.fill(0);
  for (let i = 0; i < hold; i++) tick(rest, rest, 'hold');
  options.onProgress?.('hold', total, total);
  return {
    positions: solver.x.slice(),
    velocities: solver.v.slice(),
    diagnostics: diagnostics(g, sk, solver.x, rest, selfCollide, solver.maxSpeed),
  };
}

export interface BakeResult {
  clip: ClipId;
  fps: number;
  frames: Float32Array[];
  frameDiagnostics: { worstStretch: number; worstPenetrationMm: number; penetratingFraction: number; maxSpeed: number };
}

/** Bake one loop of a clip from a draped state. One pre-roll loop removes the start transient. */
export function bake(g: Garment, sk: Skeleton, start: { positions: Float32Array; velocities: Float32Array }, clip: ClipId, options: SimOptions = {}): BakeResult {
  const q = QUALITY[g.quality];
  const substeps = options.substeps ?? Math.ceil(q.substeps * (clip === 'jog' ? 1.6 : 1));
  const selfCollide = options.selfCollide ?? q.selfCollide;
  const solver = new ClothSolver(g, sk, { substeps, selfCollide });
  solver.x.set(start.positions);
  solver.prev.set(start.positions);
  solver.v.set(start.velocities);
  const dur = CLIPS[clip].duration;
  const count = Math.round(dur / FRAME);
  const dt = dur / count;
  if (options.pins?.length) solver.pin(options.pins, forwardKinematics(sk, restPose(sk)));
  const rest = restPose(sk);
  const easeFrames = Math.round(0.5 / FRAME);
  const total = easeFrames + count * 2;
  let done = 0;
  const report = (phase: string) => {
    if (options.shouldStop?.()) throw new Error('cancelled');
    done++;
    if (done % 3 === 0) options.onProgress?.(phase, done, total);
  };
  for (let i = 0; i < easeFrames; i++) {
    const k = (v: number) => v * v * (3 - 2 * v);
    solver.step(FRAME, blendPose(rest, clipPose(sk, clip, 0), k(i / easeFrames)), blendPose(rest, clipPose(sk, clip, 0), k((i + 1) / easeFrames)));
    report('ease in');
  }
  for (let i = 0; i < count; i++) {
    solver.step(dt, clipPose(sk, clip, i * dt), clipPose(sk, clip, (i + 1) * dt));
    report('pre-roll');
  }
  const frames: Float32Array[] = [];
  let worstStretch = 0;
  let worstPen = 0;
  let worstFrac = 0;
  let topSpeed = 0;
  for (let i = 0; i < count; i++) {
    const d = diagnostics(g, sk, solver.x, clipPose(sk, clip, i * dt), selfCollide);
    worstStretch = Math.max(worstStretch, d.p99Stretch);
    worstPen = Math.max(worstPen, d.maxPenetrationMm);
    worstFrac = Math.max(worstFrac, d.penetratingFraction);
    frames.push(solver.x.slice());
    solver.step(dt, clipPose(sk, clip, i * dt), clipPose(sk, clip, (i + 1) * dt));
    topSpeed = Math.max(topSpeed, solver.maxSpeed);
    report('recording');
  }
  // Blend the loop point so the cycle restarts without a visible jump. Applied to the last few frames only.
  const blend = Math.min(6, Math.floor(count / 4));
  for (let b = 0; b < blend; b++) {
    const f = frames[count - blend + b];
    const k = (b + 1) / (blend + 1);
    const first = frames[0];
    const after = solver.x;
    for (let i = 0; i < f.length; i++) f[i] += (first[i] - after[i]) * k;
  }
  options.onProgress?.('recording', total, total);
  return { clip, fps: 1 / dt, frames, frameDiagnostics: { worstStretch, worstPenetrationMm: worstPen, penetratingFraction: worstFrac, maxSpeed: topSpeed } };
}

export const simNormals = (g: Garment, x: Float32Array) => vertexNormals(x, g.simIndices);
