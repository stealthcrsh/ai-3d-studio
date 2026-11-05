import { add, cross, lerp, normalize, QI, qAxis, qMul, qNlerp, qRot, sub, vertexNormals, type Q, type V3 } from './math.ts';
import type { BodyShapeId, ClipId } from './params.ts';

/** Procedural mannequin with a known skeleton. Original to this project, so no licence obligations. */
export interface BodyShape {
  id: BodyShapeId;
  label: string;
  height: number;
  chest: number;
  waist: number;
  hip: number;
  shoulder: number;
  limb: number;
}

export const BODY_SHAPES: Record<BodyShapeId, BodyShape> = {
  slim: { id: 'slim', label: 'Slim, 172 cm', height: 1.72, chest: 0.86, waist: 0.78, hip: 0.9, shoulder: 0.92, limb: 0.86 },
  regular: { id: 'regular', label: 'Regular, 178 cm', height: 1.78, chest: 1, waist: 1, hip: 1, shoulder: 1, limb: 1 },
  broad: { id: 'broad', label: 'Broad, 186 cm', height: 1.86, chest: 1.22, waist: 1.28, hip: 1.14, shoulder: 1.12, limb: 1.2 },
};

export const ARM_DROP = (40 * Math.PI) / 180;

export const JOINT_NAMES = [
  'Hips', 'Spine', 'Chest', 'Neck', 'Head',
  'Shoulder_L', 'UpperArm_L', 'Forearm_L', 'Hand_L',
  'Shoulder_R', 'UpperArm_R', 'Forearm_R', 'Hand_R',
  'UpperLeg_L', 'LowerLeg_L', 'Foot_L',
  'UpperLeg_R', 'LowerLeg_R', 'Foot_R',
] as const;
export type JointName = (typeof JOINT_NAMES)[number];
const J = Object.fromEntries(JOINT_NAMES.map((n, i) => [n, i])) as Record<JointName, number>;

export interface Capsule {
  a: V3;
  b: V3;
  ra: number;
  rb: number;
  ja: number;
  jb: number;
}

export interface Skeleton {
  parents: number[];
  bind: V3[];
  capsules: Capsule[];
  shape: BodyShape;
}

const PARENTS: Record<JointName, JointName | null> = {
  Hips: null, Spine: 'Hips', Chest: 'Spine', Neck: 'Chest', Head: 'Neck',
  Shoulder_L: 'Chest', UpperArm_L: 'Shoulder_L', Forearm_L: 'UpperArm_L', Hand_L: 'Forearm_L',
  Shoulder_R: 'Chest', UpperArm_R: 'Shoulder_R', Forearm_R: 'UpperArm_R', Hand_R: 'Forearm_R',
  UpperLeg_L: 'Hips', LowerLeg_L: 'UpperLeg_L', Foot_L: 'LowerLeg_L',
  UpperLeg_R: 'Hips', LowerLeg_R: 'UpperLeg_R', Foot_R: 'LowerLeg_R',
};

export function buildSkeleton(id: BodyShapeId = 'regular'): Skeleton {
  const shape = BODY_SHAPES[id];
  const h = shape.height / 1.78;
  const sw = shape.shoulder;
  const armDir: V3 = [Math.cos(ARM_DROP), -Math.sin(ARM_DROP), 0];
  const shoulderX = 0.19 * sw;
  const upperArm: V3 = [shoulderX, 1.43 * h, 0];
  const elbow = add(upperArm, scaleV(armDir, 0.29 * h));
  const wrist = add(elbow, scaleV(armDir, 0.26 * h));
  const mirror = (p: V3): V3 => [-p[0], p[1], p[2]];
  const hipX = 0.095 * shape.hip;
  const bind: Record<JointName, V3> = {
    Hips: [0, 0.98 * h, 0], Spine: [0, 1.1 * h, 0], Chest: [0, 1.28 * h, 0], Neck: [0, 1.48 * h, -0.005], Head: [0, 1.58 * h, 0],
    Shoulder_L: [0.03, 1.44 * h, 0], UpperArm_L: upperArm, Forearm_L: elbow, Hand_L: wrist,
    Shoulder_R: [-0.03, 1.44 * h, 0], UpperArm_R: mirror(upperArm), Forearm_R: mirror(elbow), Hand_R: mirror(wrist),
    UpperLeg_L: [hipX, 0.93 * h, 0], LowerLeg_L: [0.1 * shape.hip, 0.5 * h, 0.005], Foot_L: [0.1 * shape.hip, 0.085 * h, -0.01],
    UpperLeg_R: [-hipX, 0.93 * h, 0], LowerLeg_R: [-0.1 * shape.hip, 0.5 * h, 0.005], Foot_R: [-0.1 * shape.hip, 0.085 * h, -0.01],
  };
  const c = shape.chest;
  const w = shape.waist;
  const hp = shape.hip;
  const l = shape.limb;
  const caps: Capsule[] = [];
  const both = (a: V3, b: V3, ra: number, rb: number, ja: JointName, jb: JointName) => {
    caps.push({ a, b, ra, rb, ja: J[ja], jb: J[jb] });
    const swap = (n: JointName) => (n.endsWith('_L') ? (n.replace('_L', '_R') as JointName) : n);
    caps.push({ a: mirror(a), b: mirror(b), ra, rb, ja: J[swap(ja)], jb: J[swap(jb)] });
  };
  const one = (a: V3, b: V3, ra: number, rb: number, ja: JointName, jb: JointName) => caps.push({ a, b, ra, rb, ja: J[ja], jb: J[jb] });
  // Torso, built from paired capsules so the cross-section is an oval, not a circle.
  both([0.078 * hp, 0.93 * h, 0], [0.066 * w, 1.06 * h, 0], 0.112 * hp, 0.098 * w, 'Hips', 'Spine');
  both([0.066 * w, 1.06 * h, 0], [0.078 * c, 1.27 * h, 0.004], 0.098 * w, 0.112 * c, 'Spine', 'Chest');
  both([0.078 * c, 1.27 * h, 0.004], [0.112 * sw, 1.405 * h, -0.006], 0.112 * c, 0.078, 'Chest', 'Chest');
  // Centre line. Without it the cloth sinks into the gap between the paired capsules, which the visible mesh fills.
  one([0, 0.93 * h, 0.004], [0, 1.08 * h, 0.006], 0.108 * hp, 0.1 * w, 'Hips', 'Spine');
  one([0, 1.08 * h, 0.006], [0, 1.28 * h, 0.014], 0.1 * w, 0.112 * c, 'Spine', 'Chest');
  one([0, 1.28 * h, 0.014], [0, 1.42 * h, 0.002], 0.112 * c, 0.082, 'Chest', 'Chest');
  both([0.1 * sw, 1.40 * h, 0], [0.19 * sw, 1.425 * h, 0], 0.07, 0.062, 'Chest', 'UpperArm_L');
  both([0.03, 1.47 * h, -0.012], [0.17 * sw, 1.445 * h, -0.006], 0.058, 0.05, 'Chest', 'UpperArm_L');
  // Neck and head.
  one([0, 1.44 * h, -0.008], [0, 1.57 * h, 0.002], 0.058, 0.05, 'Chest', 'Head');
  one([0, 1.62 * h, 0.012], [0, 1.685 * h, 0.004], 0.078, 0.09, 'Head', 'Head');
  // Arms and hands.
  both(upperArm, elbow, 0.052 * l, 0.04 * l, 'UpperArm_L', 'Forearm_L');
  both(elbow, wrist, 0.04 * l, 0.029 * l, 'Forearm_L', 'Hand_L');
  const palm = add(wrist, scaleV(armDir, 0.07));
  const fingertip = add(wrist, scaleV(armDir, 0.175));
  both(wrist, palm, 0.03, 0.038, 'Hand_L', 'Hand_L');
  both(palm, fingertip, 0.034, 0.018, 'Hand_L', 'Hand_L');
  // Legs and feet.
  both(bind.UpperLeg_L, bind.LowerLeg_L, 0.086 * hp, 0.054 * l, 'UpperLeg_L', 'LowerLeg_L');
  both(bind.LowerLeg_L, bind.Foot_L, 0.054 * l, 0.036, 'LowerLeg_L', 'Foot_L');
  both([bind.Foot_L[0], 0.05, -0.04], [bind.Foot_L[0] + 0.012, 0.035, 0.15], 0.048, 0.032, 'Foot_L', 'Foot_L');
  return {
    parents: JOINT_NAMES.map((n) => (PARENTS[n] ? J[PARENTS[n]!] : -1)),
    bind: JOINT_NAMES.map((n) => bind[n]),
    capsules: caps,
    shape,
  };
}

function scaleV(a: V3, s: number): V3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}

export interface Pose {
  rot: Q[];
  hips: V3;
}

/** World transforms for a pose. Joint rest rotations are identity, so local deltas compose directly. */
export interface WorldPose {
  q: Q[];
  t: V3[];
}

export function forwardKinematics(sk: Skeleton, pose: Pose): WorldPose {
  const q: Q[] = new Array(sk.bind.length);
  const t: V3[] = new Array(sk.bind.length);
  for (let i = 0; i < sk.bind.length; i++) {
    const p = sk.parents[i];
    if (p < 0) {
      q[i] = pose.rot[i];
      t[i] = add(sk.bind[i], pose.hips);
    } else {
      q[i] = qMul(q[p], pose.rot[i]);
      t[i] = add(t[p], qRot(q[p], sub(sk.bind[i], sk.bind[p])));
    }
  }
  return { q, t };
}

export const skinPoint = (sk: Skeleton, wp: WorldPose, joint: number, p: V3): V3 =>
  add(wp.t[joint], qRot(wp.q[joint], sub(p, sk.bind[joint])));

export const bindPose = (sk: Skeleton): Pose => ({ rot: sk.bind.map(() => QI), hips: [0, 0, 0] });

const DEG = Math.PI / 180;
/** Axis that swings a bound arm forward (+Z) for a given side. */
const armForwardAxis = (side: 1 | -1): V3 => cross([side * Math.cos(ARM_DROP), -Math.sin(ARM_DROP), 0], [0, 0, 1]);
const armLower = (side: 1 | -1, deg: number): Q => qAxis([0, 0, 1], -side * deg * DEG);

function basePose(sk: Skeleton, lowerDeg = 40, elbowDeg = 12): Pose {
  const rot = sk.bind.map(() => QI) as Q[];
  for (const side of [1, -1] as const) {
    const s = side === 1 ? 'L' : 'R';
    rot[J[`UpperArm_${s}`]] = armLower(side, lowerDeg);
    rot[J[`Forearm_${s}`]] = qAxis(armForwardAxis(side), elbowDeg * DEG);
  }
  return { rot, hips: [0, 0, 0] };
}

export const restPose = (sk: Skeleton): Pose => basePose(sk);

export const CLIPS: Record<ClipId, { label: string; duration: number; note: string }> = {
  idle: { label: 'Idle breathing', duration: 3, note: 'Very low motion. Useful for checking settling.' },
  walk: { label: 'Walk, in place', duration: 1.1, note: 'Procedural in-place cycle, not motion capture.' },
  jog: { label: 'Fast jog, in place', duration: 0.68, note: 'Stress test for cloth stability and tunnelling.' },
  armlift: { label: 'Arm lift', duration: 2.4, note: 'Lifts both arms. Stress test for sleeves and hem.' },
};

export function clipPose(sk: Skeleton, clip: ClipId, time: number): Pose {
  const dur = CLIPS[clip].duration;
  const ph = ((time % dur) / dur) * Math.PI * 2;
  const pose = basePose(sk);
  const R = pose.rot;
  if (clip === 'idle') {
    pose.hips = [0, 0.002 * Math.sin(ph), 0];
    R[J.Chest] = qAxis([1, 0, 0], 0.8 * DEG * Math.sin(ph));
    return pose;
  }
  if (clip === 'armlift') {
    const lift = 0.5 - 0.5 * Math.cos(ph);
    for (const side of [1, -1] as const) {
      const s = side === 1 ? 'L' : 'R';
      R[J[`UpperArm_${s}`]] = armLower(side, 40 - 95 * lift);
      R[J[`Forearm_${s}`]] = qAxis(armForwardAxis(side), (12 + 30 * lift) * DEG);
    }
    return pose;
  }
  const amp = clip === 'jog' ? 1.35 : 1;
  const thigh = (off: number) => -26 * amp * Math.sin(ph + off);
  const knee = (off: number) => (6 + 48 * amp * Math.max(0, Math.sin(ph + off + 1.9)) ** 1.4) * 1;
  for (const [s, off] of [['L', 0], ['R', Math.PI]] as const) {
    R[J[`UpperLeg_${s}`]] = qAxis([1, 0, 0], thigh(off) * DEG);
    R[J[`LowerLeg_${s}`]] = qAxis([1, 0, 0], knee(off) * DEG);
    // Mostly cancels thigh and knee, so the sole stays near level through the stride.
    R[J[`Foot_${s}`]] = qAxis([1, 0, 0], -(thigh(off) + knee(off)) * 0.8 * DEG);
  }
  const armAmp = (clip === 'jog' ? 44 : 20) * 1;
  const elbow = clip === 'jog' ? 72 : 16;
  for (const [s, side, off] of [['L', 1, Math.PI], ['R', -1, 0]] as const) {
    const swing = armAmp * -Math.sin(ph + off);
    const baseArm = qMul(armLower(side, 40), qAxis(armForwardAxis(side), swing * DEG));
    R[J[`UpperArm_${s}`]] = baseArm;
    R[J[`Forearm_${s}`]] = qAxis(armForwardAxis(side), (elbow + Math.max(0, swing) * 0.5) * DEG);
  }
  pose.hips = [0.012 * amp * Math.sin(ph), 0.016 * amp * Math.cos(2 * ph) - 0.012, 0];
  R[J.Hips] = qMul(qAxis([0, 1, 0], 5 * amp * Math.sin(ph) * DEG), qAxis([1, 0, 0], (clip === 'jog' ? 5 : 2) * DEG));
  R[J.Spine] = qAxis([0, 1, 0], -5 * amp * Math.sin(ph) * DEG);
  R[J.Chest] = qAxis([0, 1, 0], -5 * amp * Math.sin(ph) * DEG);
  R[J.Neck] = qAxis([0, 1, 0], 4 * amp * Math.sin(ph) * DEG);
  return pose;
}

export function blendPose(a: Pose, b: Pose, t: number): Pose {
  return {
    rot: a.rot.map((q, i) => qNlerp(q, b.rot[i], t)),
    hips: [lerp(a.hips[0], b.hips[0], t), lerp(a.hips[1], b.hips[1], t), lerp(a.hips[2], b.hips[2], t)],
  };
}

const smin = (a: number, b: number, k: number) => {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
};

/** The visible body sits a few millimetres inside the colliders, so cloth triangles spanning a contact do not cut it. */
const VISUAL_INSET = 0.011;

function bodySdf(sk: Skeleton, x: number, y: number, z: number): number {
  let d = 1e9;
  for (const c of sk.capsules) {
    const bax = c.b[0] - c.a[0];
    const bay = c.b[1] - c.a[1];
    const baz = c.b[2] - c.a[2];
    const pax = x - c.a[0];
    const pay = y - c.a[1];
    const paz = z - c.a[2];
    const t = Math.min(1, Math.max(0, (pax * bax + pay * bay + paz * baz) / (bax * bax + bay * bay + baz * baz)));
    const dist = Math.hypot(pax - bax * t, pay - bay * t, paz - baz * t) - (c.ra + (c.rb - c.ra) * t);
    d = smin(d, dist, 0.014);
  }
  return d + VISUAL_INSET;
}

export interface AvatarMesh {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  joints: Uint8Array;
  weights: Float32Array;
}

/** Naive surface nets over the capsule SDF, then distance-based skin weights. */
export function buildAvatarMesh(sk: Skeleton, cell = 0.011): AvatarMesh {
  let min: V3 = [1e9, 1e9, 1e9];
  let max: V3 = [-1e9, -1e9, -1e9];
  for (const c of sk.capsules) {
    for (const [p, r] of [[c.a, c.ra], [c.b, c.rb]] as [V3, number][]) {
      min = [Math.min(min[0], p[0] - r), Math.min(min[1], p[1] - r), Math.min(min[2], p[2] - r)];
      max = [Math.max(max[0], p[0] + r), Math.max(max[1], p[1] + r), Math.max(max[2], p[2] + r)];
    }
  }
  const pad = cell * 3;
  const nx = Math.ceil((max[0] - min[0] + pad * 2) / cell);
  const ny = Math.ceil((max[1] - min[1] + pad * 2) / cell);
  const nz = Math.ceil((max[2] - min[2] + pad * 2) / cell);
  const idx = (i: number, j: number, k: number) => i + nx * (j + ny * k);
  const f = new Float32Array(nx * ny * nz);
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++)
        f[idx(i, j, k)] = bodySdf(sk, min[0] - pad + i * cell, min[1] - pad + j * cell, min[2] - pad + k * cell);
  const verts: number[] = [];
  const cellVert = new Int32Array(nx * ny * nz).fill(-1);
  const corners = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]];
  const edges = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
  for (let k = 0; k < nz - 1; k++)
    for (let j = 0; j < ny - 1; j++)
      for (let i = 0; i < nx - 1; i++) {
        let sx = 0, sy = 0, sz = 0, n = 0;
        for (const [a, b] of edges) {
          const ca = corners[a];
          const cb = corners[b];
          const fa = f[idx(i + ca[0], j + ca[1], k + ca[2])];
          const fb = f[idx(i + cb[0], j + cb[1], k + cb[2])];
          if (fa < 0 !== fb < 0) {
            const t = fa / (fa - fb);
            sx += ca[0] + (cb[0] - ca[0]) * t;
            sy += ca[1] + (cb[1] - ca[1]) * t;
            sz += ca[2] + (cb[2] - ca[2]) * t;
            n++;
          }
        }
        if (n > 0) {
          cellVert[idx(i, j, k)] = verts.length / 3;
          verts.push(min[0] - pad + (i + sx / n) * cell, min[1] - pad + (j + sy / n) * cell, min[2] - pad + (k + sz / n) * cell);
        }
      }
  const tris: number[] = [];
  const quad = (a: number, b: number, c: number, d: number, flip: boolean) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    if (flip) tris.push(a, c, b, a, d, c);
    else tris.push(a, b, c, a, c, d);
  };
  for (let k = 1; k < nz - 1; k++)
    for (let j = 1; j < ny - 1; j++)
      for (let i = 1; i < nx - 1; i++) {
        const v = f[idx(i, j, k)] < 0;
        if (v !== f[idx(i + 1, j, k)] < 0) quad(cellVert[idx(i, j - 1, k - 1)], cellVert[idx(i, j, k - 1)], cellVert[idx(i, j, k)], cellVert[idx(i, j - 1, k)], !v);
        if (v !== f[idx(i, j + 1, k)] < 0) quad(cellVert[idx(i - 1, j, k - 1)], cellVert[idx(i - 1, j, k)], cellVert[idx(i, j, k)], cellVert[idx(i, j, k - 1)], !v);
        if (v !== f[idx(i, j, k + 1)] < 0) quad(cellVert[idx(i - 1, j - 1, k)], cellVert[idx(i, j - 1, k)], cellVert[idx(i, j, k)], cellVert[idx(i - 1, j, k)], !v);
      }
  const positions = new Float32Array(verts);
  const indices = new Uint32Array(tris);
  const normals = vertexNormals(positions, indices);
  // Skin weights: each capsule votes for its two end joints, falling off with distance to its surface.
  const nv = positions.length / 3;
  const joints = new Uint8Array(nv * 4);
  const weights = new Float32Array(nv * 4);
  const acc = new Float32Array(sk.bind.length);
  for (let v = 0; v < nv; v++) {
    acc.fill(0);
    const x = positions[v * 3];
    const y = positions[v * 3 + 1];
    const z = positions[v * 3 + 2];
    for (const c of sk.capsules) {
      const ba = sub(c.b, c.a);
      const pa: V3 = [x - c.a[0], y - c.a[1], z - c.a[2]];
      const t = Math.min(1, Math.max(0, (pa[0] * ba[0] + pa[1] * ba[1] + pa[2] * ba[2]) / (ba[0] ** 2 + ba[1] ** 2 + ba[2] ** 2)));
      const d = Math.hypot(pa[0] - ba[0] * t, pa[1] - ba[1] * t, pa[2] - ba[2] * t) - (c.ra + (c.rb - c.ra) * t);
      const w = Math.exp(-Math.max(0, d) / 0.012);
      acc[c.ja] += w * (1 - t);
      acc[c.jb] += w * t;
    }
    const order = [...acc.keys()].sort((a, b) => acc[b] - acc[a]).slice(0, 4);
    const sum = order.reduce((s, i) => s + acc[i], 0) || 1;
    order.forEach((j, slot) => {
      joints[v * 4 + slot] = j;
      weights[v * 4 + slot] = acc[j] / sum;
    });
  }
  return { positions, normals, indices, joints, weights };
}

export const normalizeBind = normalize;
