import { deformParts, type Garment } from './garment.ts';
import { PART_IDS } from './params.ts';
import type { Diagnostics } from './cloth.ts';

export type CheckStatus = 'pass' | 'warn' | 'fail';
export interface QaCheck {
  id: string;
  group: 'geometry' | 'uv' | 'structure' | 'fit' | 'simulation';
  label: string;
  status: CheckStatus;
  value: string;
  /** All thresholds are PROPOSED until the owner approves them. */
  threshold: string;
  detail?: string;
}

export interface QaReport {
  checks: QaCheck[];
  summary: { pass: number; warn: number; fail: number };
  thresholdsStatus: 'PROPOSED';
}

export function runGarmentQa(g: Garment, positions: Float32Array, diag: Diagnostics | null, clip?: { id: string; worstStretch: number; worstPenetrationMm: number; penetratingFraction: number; maxSpeed: number } | null): QaReport {
  const checks: QaCheck[] = [];
  const add = (c: QaCheck) => checks.push(c);
  const tri = g.simIndices;
  add({ id: 'faces', group: 'geometry', label: 'Mesh has faces', status: tri.length > 0 ? 'pass' : 'fail', value: `${tri.length / 3} simulation triangles`, threshold: '> 0' });
  let bad = 0;
  for (let i = 0; i < positions.length; i++) if (!Number.isFinite(positions[i])) bad++;
  add({ id: 'finite', group: 'geometry', label: 'All coordinates are finite', status: bad ? 'fail' : 'pass', value: `${bad} invalid values`, threshold: '0' });
  let degenerate = 0;
  for (let t = 0; t < tri.length; t += 3) {
    const [a, b, c] = [tri[t] * 3, tri[t + 1] * 3, tri[t + 2] * 3];
    const ux = positions[b] - positions[a];
    const uy = positions[b + 1] - positions[a + 1];
    const uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a];
    const vy = positions[c + 1] - positions[a + 1];
    const vz = positions[c + 2] - positions[a + 2];
    if (Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) < 2e-9) degenerate++;
  }
  add({ id: 'degenerate', group: 'geometry', label: 'Degenerate triangles', status: degenerate === 0 ? 'pass' : degenerate < tri.length / 3 / 200 ? 'warn' : 'fail', value: String(degenerate), threshold: '0, warn below 0.5%' });

  const edgeUse = new Map<number, number>();
  const n = positions.length / 3;
  const key = (a: number, b: number) => (a < b ? a * n + b : b * n + a);
  for (let t = 0; t < tri.length; t += 3) {
    for (const [a, b] of [[tri[t], tri[t + 1]], [tri[t + 1], tri[t + 2]], [tri[t + 2], tri[t]]]) {
      const k = key(a, b);
      edgeUse.set(k, (edgeUse.get(k) ?? 0) + 1);
    }
  }
  let nonManifold = 0;
  const boundary: [number, number][] = [];
  for (const [k, v] of edgeUse) {
    if (v > 2) nonManifold++;
    if (v === 1) boundary.push([Math.floor(k / n), k % n]);
  }
  add({ id: 'manifold', group: 'geometry', label: 'Non-manifold edges on the simulation mesh', status: nonManifold === 0 ? 'pass' : 'warn', value: String(nonManifold), threshold: '0' });
  const adj = new Map<number, number[]>();
  for (const [a, b] of boundary) {
    (adj.get(a) ?? adj.set(a, []).get(a)!).push(b);
    (adj.get(b) ?? adj.set(b, []).get(b)!).push(a);
  }
  const seen = new Set<number>();
  let loops = 0;
  for (const s of adj.keys()) {
    if (seen.has(s)) continue;
    loops++;
    const st = [s];
    while (st.length) {
      const c = st.pop()!;
      if (seen.has(c)) continue;
      seen.add(c);
      for (const nb of adj.get(c)!) st.push(nb);
    }
  }
  add({ id: 'openings', group: 'structure', label: 'Garment openings', status: loops === 4 ? 'pass' : 'warn', value: `${loops} open boundaries`, threshold: '4: hem, two cuffs, hood face opening', detail: 'A hoodie should have exactly four openings when all seams are sewn. Other counts indicate a seam that did not close.' });

  const names = new Set(g.parts.map((p) => p.id));
  const requiredParts = PART_IDS.filter((p) => (p !== 'Pocket' || g.params.pocket) && (!p.startsWith('Drawcord') || g.params.drawcords));
  const missing = requiredParts.filter((p) => !names.has(p));
  add({ id: 'parts', group: 'structure', label: 'Named parts present', status: missing.length ? 'fail' : 'pass', value: `${names.size} parts`, threshold: `${requiredParts.length} expected`, detail: missing.join(', ') });
  add({ id: 'seams', group: 'structure', label: 'Seams encoded in topology', status: g.seams.length >= 14 ? 'pass' : 'warn', value: `${g.seams.length} seams`, threshold: '14 or more', detail: 'Structural seams, not production-grade sewing instructions.' });

  // Faces should point away from the body in the rest pose.
  const axis = (x: number, y: number, z: number) => [x, y, z];
  void axis;
  const wrong: string[] = [];
  for (const p of g.parts) {
    if (!p.simulated) continue;
    const rest = g.restParts[p.id];
    let score = 0;
    let cx = 0, cy = 0, cz = 0;
    for (let i = 0; i < rest.length; i += 3) {
      cx += rest[i];
      cy += rest[i + 1];
      cz += rest[i + 2];
    }
    const vc = rest.length / 3;
    cx /= vc;
    cy /= vc;
    cz /= vc;
    const isHood = p.id.startsWith('Hood');
    for (let t = 0; t < p.indices.length; t += 3) {
      const [a, b, c] = [p.indices[t] * 3, p.indices[t + 1] * 3, p.indices[t + 2] * 3];
      const ux = rest[b] - rest[a];
      const uy = rest[b + 1] - rest[a + 1];
      const uz = rest[b + 2] - rest[a + 2];
      const vx = rest[c] - rest[a];
      const vy = rest[c + 1] - rest[a + 1];
      const vz = rest[c + 2] - rest[a + 2];
      const nx = uy * vz - uz * vy;
      const ny = uz * vx - ux * vz;
      const nz = ux * vy - uy * vx;
      // Compare with the outward direction: from the torso axis for body, from the part centreline for tubes.
      const mx = (rest[a] + rest[b] + rest[c]) / 3;
      const my = (rest[a + 1] + rest[b + 1] + rest[c + 1]) / 3;
      const mz = (rest[a + 2] + rest[b + 2] + rest[c + 2]) / 3;
      if (p.id.startsWith('Body') || p.id === 'Hem_Rib') score += nx * mx + nz * mz;
      else if (isHood) score += nx * (mx - 0) + ny * (my - cy) + nz * (mz - cz);
      else score += ny * (my - cy) * 0.5 + nz * mz + 0 * nx;
    }
    if (score <= 0) wrong.push(p.id);
  }
  add({ id: 'winding', group: 'geometry', label: 'Faces point outward', status: wrong.length ? 'fail' : 'pass', value: wrong.length ? wrong.join(', ') : 'All simulated parts', threshold: 'Every simulated part' });

  let uvOut = 0;
  let uvMixed = 0;
  for (const p of g.parts) {
    for (let i = 0; i < p.uv.length; i++) if (p.uv[i] < 0 || p.uv[i] > 1) uvOut++;
    if (p.material === 'cord') continue;
    let pos = 0;
    let neg = 0;
    for (let t = 0; t < p.indices.length; t += 3) {
      const [a, b, c] = [p.indices[t] * 2, p.indices[t + 1] * 2, p.indices[t + 2] * 2];
      const area = (p.uv[b] - p.uv[a]) * (p.uv[c + 1] - p.uv[a + 1]) - (p.uv[c] - p.uv[a]) * (p.uv[b + 1] - p.uv[a + 1]);
      if (area > 0) pos++;
      else if (area < 0) neg++;
    }
    if (pos && neg) uvMixed++;
  }
  add({ id: 'uv-range', group: 'uv', label: 'UVs inside the atlas', status: uvOut ? 'fail' : 'pass', value: `${uvOut} out of range`, threshold: '0' });
  add({ id: 'uv-flip', group: 'uv', label: 'UV islands consistent', status: uvMixed ? 'warn' : 'pass', value: `${uvMixed} islands with flipped triangles`, threshold: '0' });
  let overlaps = 0;
  for (let i = 0; i < g.parts.length; i++)
    for (let j = i + 1; j < g.parts.length; j++) {
      const a = g.parts[i].rect;
      const b = g.parts[j].rect;
      if (a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3]) overlaps++;
    }
  add({ id: 'uv-overlap', group: 'uv', label: 'UV islands do not overlap', status: overlaps ? 'fail' : 'pass', value: `${overlaps} overlaps`, threshold: '0' });

  let minY = Infinity, maxY = -Infinity, minX = Infinity, maxX = -Infinity;
  for (const o of deformParts(g, positions)) {
    for (let i = 0; i < o.positions.length; i += 3) {
      if (o.positions[i] < minX) minX = o.positions[i];
      if (o.positions[i] > maxX) maxX = o.positions[i];
      if (o.positions[i + 1] < minY) minY = o.positions[i + 1];
      if (o.positions[i + 1] > maxY) maxY = o.positions[i + 1];
    }
  }
  const heightM = maxY - minY;
  add({ id: 'scale', group: 'fit', label: 'Plausible real-world scale', status: heightM > 0.45 && heightM < 1.5 ? 'pass' : 'fail', value: `${(heightM * 100).toFixed(0)} cm tall, ${((maxX - minX) * 100).toFixed(0)} cm wide`, threshold: '45 to 150 cm tall' });

  if (diag) {
    add({ id: 'stretch-p99', group: 'simulation', label: 'Fabric stretch, 99th percentile', status: diag.p99Stretch <= 1.1 ? 'pass' : diag.p99Stretch <= 1.25 ? 'warn' : 'fail', value: `${((diag.p99Stretch - 1) * 100).toFixed(1)}%`, threshold: 'Pass ≤ 10%, warn ≤ 25%' });
    add({ id: 'stretch-max', group: 'simulation', label: 'Worst single edge stretch', status: diag.maxStretch <= 1.5 ? 'pass' : diag.maxStretch <= 2.5 ? 'warn' : 'fail', value: `${((diag.maxStretch - 1) * 100).toFixed(0)}%`, threshold: 'Pass ≤ 50%, warn ≤ 150%', detail: 'A local peak, often at a seam junction.' });
    add({ id: 'penetration', group: 'fit', label: 'Vertices inside the avatar', status: diag.penetratingFraction <= 0.01 ? 'pass' : diag.penetratingFraction <= 0.05 ? 'warn' : 'fail', value: `${(diag.penetratingFraction * 100).toFixed(2)}%, deepest ${diag.maxPenetrationMm.toFixed(1)} mm`, threshold: 'Pass ≤ 1%, warn ≤ 5%' });
    add({ id: 'self-collision', group: 'simulation', label: 'Self-collision', status: diag.selfCollisionEnabled ? 'pass' : 'warn', value: diag.selfCollisionEnabled ? 'Particle-based, on' : 'Off at this quality', threshold: 'On', detail: 'Particle-to-particle only. It reduces fabric layers passing through each other but does not guarantee it.' });
  }
  if (clip) {
    add({ id: 'clip-stretch', group: 'simulation', label: `Motion stretch, ${clip.id}`, status: clip.worstStretch <= 1.2 ? 'pass' : clip.worstStretch <= 1.5 ? 'warn' : 'fail', value: `${((clip.worstStretch - 1) * 100).toFixed(1)}% worst frame, 99th percentile`, threshold: 'Pass ≤ 20%, warn ≤ 50%' });
    add({ id: 'clip-collision', group: 'simulation', label: `Motion collisions, ${clip.id}`, status: clip.penetratingFraction <= 0.02 ? 'pass' : clip.penetratingFraction <= 0.08 ? 'warn' : 'fail', value: `${(clip.penetratingFraction * 100).toFixed(2)}% worst frame, deepest ${clip.worstPenetrationMm.toFixed(1)} mm`, threshold: 'Pass ≤ 2%, warn ≤ 8%' });
    add({ id: 'clip-speed', group: 'simulation', label: `Solver speed, ${clip.id}`, status: clip.maxSpeed < 20 ? 'pass' : 'fail', value: `${clip.maxSpeed.toFixed(1)} m/s peak`, threshold: 'Under 20 m/s' });
  }
  const summary = { pass: 0, warn: 0, fail: 0 };
  for (const c of checks) summary[c.status]++;
  return { checks, summary, thresholdsStatus: 'PROPOSED' };
}
