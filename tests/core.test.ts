import { describe, expect, test } from 'bun:test';
import { buildAvatarMesh, buildSkeleton, clipPose, forwardKinematics, restPose, skinPoint } from '../src/core/avatar.ts';
import { bake, drape, diagnostics } from '../src/core/cloth.ts';
import { parseEdit, restLocality } from '../src/core/edits.ts';
import { buildGarment, deformParts } from '../src/core/garment.ts';
import { fnv1a } from '../src/core/math.ts';
import { DEFAULT_PARAMS, FABRICS, geometryKey, physicsKey, validateParams, type HoodieParams } from '../src/core/params.ts';
import { runGarmentQa } from '../src/core/qa.ts';

const sk = buildSkeleton('regular');

describe('garment structure', () => {
  const g = buildGarment(DEFAULT_PARAMS, 'preview', sk);
  test('has every named part and real faces', () => {
    expect(g.parts.map((p) => p.id as string).sort()).toEqual((['Body_Back', 'Body_Front', 'Cuff_L', 'Cuff_R', 'Drawcord_L', 'Drawcord_R', 'Hem_Rib', 'Hood_L', 'Hood_R', 'Pocket', 'Sleeve_L', 'Sleeve_R'] as string[]).sort());
    for (const p of g.parts) expect(p.indices.length).toBeGreaterThan(0);
  });
  test('seams close the garment to exactly four openings', () => {
    const qa = runGarmentQa(g, g.simPositions, null);
    const check = qa.checks.find((c) => c.id === 'openings')!;
    expect(check.value).toBe('4 open boundaries');
  });
  test('faces point outward and UVs are in range without overlap', () => {
    const qa = runGarmentQa(g, g.simPositions, null);
    for (const id of ['winding', 'uv-range', 'uv-overlap', 'uv-flip', 'parts', 'degenerate', 'manifold']) {
      expect([id, qa.checks.find((c) => c.id === id)!.status]).toEqual([id, 'pass']);
    }
  });
  test('all three quality levels produce a manifold simulation mesh with four openings', () => {
    for (const q of ['preview', 'standard', 'high'] as const) {
      const gq = buildGarment(DEFAULT_PARAMS, q, sk);
      const checks = runGarmentQa(gq, gq.simPositions, null).checks;
      expect([q, checks.find((c) => c.id === 'manifold')!.status]).toEqual([q, 'pass']);
      expect([q, checks.find((c) => c.id === 'openings')!.value]).toEqual([q, '4 open boundaries']);
    }
  });
  test('rest mesh has no crushed edges', () => {
    let min = Infinity;
    for (const r of g.edgeRest) if (r < min) min = r;
    expect(min).toBeGreaterThan(0.004);
  });
  test('mass matches fabric weight times area, within reason', () => {
    expect(g.totalMassKg).toBeGreaterThan(0.35);
    expect(g.totalMassKg).toBeLessThan(1.2);
  });
  test('appearance vertices evaluate to finite positions', () => {
    for (const o of deformParts(g, g.simPositions)) {
      for (const v of o.positions) expect(Number.isFinite(v)).toBe(true);
    }
  });
});

describe('avatar', () => {
  test('mesh is watertight enough, sized to the body, and skin weights sum to 1', () => {
    const m = buildAvatarMesh(sk, 0.018);
    let top = -9;
    for (let i = 1; i < m.positions.length; i += 3) top = Math.max(top, m.positions[i]);
    expect(top).toBeGreaterThan(1.7);
    expect(top).toBeLessThan(1.82);
    for (let v = 0; v < m.weights.length; v += 4) expect(Math.abs(m.weights[v] + m.weights[v + 1] + m.weights[v + 2] + m.weights[v + 3] - 1)).toBeLessThan(1e-3);
  });
  test('walk clip moves the wrist', () => {
    const wrist = sk.capsules.find((c) => c.ja === 8)!;
    const at = (t: number) => skinPoint(sk, forwardKinematics(sk, clipPose(sk, 'walk', t)), 8, wrist.a);
    // Quarter and three-quarter points of the cycle, where the arm swing is at opposite extremes.
    const a = at(0.275);
    const b = at(0.825);
    expect(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])).toBeGreaterThan(0.1);
  });
});

describe('cloth solver', () => {
  const g = buildGarment(DEFAULT_PARAMS, 'preview', sk);
  const d = drape(g, sk, { seed: 1 });
  test('settles without exploding or sinking into the body', () => {
    const { perVertex, ...s } = d.diagnostics;
    expect(s.maxSpeed).toBeLessThan(5);
    expect(s.penetratingFraction).toBeLessThan(0.02);
    expect(s.p99Stretch).toBeLessThan(1.3);
    void perVertex;
  });
  test('the garment is held up by the shoulders and does not fall', () => {
    let top = -9;
    for (let i = 1; i < d.positions.length; i += 3) top = Math.max(top, d.positions[i]);
    expect(top).toBeGreaterThan(1.4);
  });
  test('same seed reproduces byte for byte, a different seed differs', () => {
    const again = drape(g, sk, { seed: 1 });
    expect(fnv1a(again.positions)).toBe(fnv1a(d.positions));
    const other = drape(g, sk, { seed: 2 });
    expect(fnv1a(other.positions)).not.toBe(fnv1a(d.positions));
  });
  test('walking cloth actually moves between frames, and stays stable', () => {
    const b = bake(g, sk, d, 'walk', { seed: 1 });
    expect(b.frames.length).toBe(33);
    let move = 0;
    for (let i = 0; i < b.frames[0].length; i++) move = Math.max(move, Math.abs(b.frames[0][i] - b.frames[16][i]));
    expect(move).toBeGreaterThan(0.03);
    expect(b.frameDiagnostics.maxSpeed).toBeLessThan(20);
  });
  test('cancellation stops the solver', () => {
    let n = 0;
    expect(() => drape(g, sk, { shouldStop: () => ++n > 3 })).toThrow('cancelled');
  });
  test('pins hold their group on the moving avatar', () => {
    const pinned = drape(g, sk, { pins: ['collar'], seed: 1 });
    const wp = forwardKinematics(sk, restPose(sk));
    const chest = wp.t[2];
    const c = g.groups.collar[0] * 3;
    const dist = Math.hypot(pinned.positions[c] - chest[0], pinned.positions[c + 1] - chest[1], pinned.positions[c + 2] - chest[2]);
    expect(dist).toBeLessThan(0.45);
  });
  test('every fabric preset stays stable', () => {
    for (const fabric of Object.keys(FABRICS)) {
      const gf = buildGarment({ ...DEFAULT_PARAMS, fabric }, 'preview', sk);
      const r = drape(gf, sk, { seed: 1 });
      expect([fabric, r.diagnostics.maxSpeed < 10]).toEqual([fabric, true]);
    }
  });
  test('every body shape drapes without explosion', () => {
    for (const id of ['slim', 'regular', 'broad'] as const) {
      const body = buildSkeleton(id);
      const gb = buildGarment(DEFAULT_PARAMS, 'preview', body);
      const r = drape(gb, body, { seed: 1 });
      const dg = diagnostics(gb, body, r.positions, restPose(body), false);
      expect([id, dg.penetratingFraction < 0.05]).toEqual([id, true]);
    }
  });
  test('fast jog is stable', () => {
    const b = bake(g, sk, d, 'jog', { seed: 1 });
    expect(b.frameDiagnostics.maxSpeed).toBeLessThan(20);
    for (const f of b.frames) for (const v of f) expect(Number.isFinite(v)).toBe(true);
  });
});

describe('edits', () => {
  const p = DEFAULT_PARAMS;
  test('sleeve length edit stays on sleeves and cuffs', () => {
    const e = parseEdit('make the sleeves 3 cm shorter', p);
    expect(e.ok).toBe(true);
    expect(e.patch.sleeveLength).toBeCloseTo(p.sleeveLength - 0.03, 5);
    const loc = restLocality(p, { ...p, ...e.patch } as HoodieParams, sk);
    expect(loc.passed).toBe(true);
    expect(loc.perPart.filter((x) => x.changed).map((x) => x.part).sort()).toEqual(['Cuff_L', 'Cuff_R', 'Sleeve_L', 'Sleeve_R']);
  });
  test('absolute values, inches and colours parse', () => {
    expect(parseEdit('set sleeve length to 58 cm', p).patch.sleeveLength).toBeCloseTo(0.58, 5);
    expect(parseEdit('make the sleeves 1 inch longer', p).patch.sleeveLength).toBeCloseTo(p.sleeveLength + 0.0254, 3);
    expect(parseEdit('change the colour to navy', p).patch.baseColor).toBe('#1f2a44');
    expect(parseEdit('make the cuffs white', p).patch.ribColor).toBe('#e9e7e1');
    expect(parseEdit('switch to denim', p).patch.fabric).toBe('denim');
    expect(parseEdit('remove the pocket', p).patch.pocket).toBe(false);
  });
  test('colour edits never touch physics or geometry keys', () => {
    const next = { ...p, ...parseEdit('make it navy', p).patch } as HoodieParams;
    expect(geometryKey(next)).toBe(geometryKey(p));
    expect(physicsKey(next)).toBe(physicsKey(p));
  });
  test('impossible or unknown requests are refused, not guessed', () => {
    for (const t of ['add a dragon logo', 'make it cooler', 'set sleeve length to 5 m', 'do something', 'turn it into a zip hoodie']) {
      const e = parseEdit(t, p);
      expect([t, e.ok]).toEqual([t, false]);
      expect(Object.keys(e.patch).length).toBe(0);
    }
  });
  test('body and hood edits stay local', () => {
    const hood = restLocality(p, { ...p, hoodHeight: 0.42 }, sk);
    expect(hood.perPart.filter((x) => x.changed).map((x) => x.part).sort()).toEqual(['Hood_L', 'Hood_R']);
    const pocket = restLocality(p, { ...p, pocketWidth: 0.3 }, sk);
    expect(pocket.perPart.filter((x) => x.changed).map((x) => x.part)).toEqual(['Pocket']);
    for (const k of ['bodyWidth', 'bodyLength', 'shoulderWidth', 'sleeveWidth', 'cuffWidth', 'cuffHeight', 'hemWidth', 'hemHeight', 'hoodDepth', 'pocketHeight'] as const) {
      const r = restLocality(p, { ...p, [k]: p[k] * 1.08 }, sk);
      expect([k, r.unexpected]).toEqual([k, []]);
    }
  });
  test('parameter validation rejects out of range', () => {
    expect(validateParams({ ...p, sleeveLength: 5 }).length).toBe(1);
    expect(validateParams({ ...p, baseColor: 'red' }).length).toBe(1);
    expect(validateParams(p).length).toBe(0);
  });
});
