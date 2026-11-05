/** Measures the real pipeline on this machine and writes docs/reports/benchmark.json. No network. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { join } from 'node:path';
import { buildAvatarMesh, buildSkeleton, restPose } from '../src/core/avatar.ts';
import { bake, drape } from '../src/core/cloth.ts';
import { buildGarment } from '../src/core/garment.ts';
import { fnv1a } from '../src/core/math.ts';
import { DEFAULT_PARAMS, type BodyShapeId, type ClipId, type Quality } from '../src/core/params.ts';
import { bakeTextures } from '../src/core/texture.ts';
import { nodeCodec } from '../tests/support.ts';
import { writeGlb } from '../src/core/gltf.ts';

const peak = () => process.memoryUsage().rss / 1e6;
let maxRss = 0;
const timed = <T,>(fn: () => T): [T, number] => {
  const t = performance.now();
  const v = fn();
  maxRss = Math.max(maxRss, peak());
  return [v, Math.round(performance.now() - t)];
};
const rows: Record<string, unknown>[] = [];
// Runs headless in Bun. Browser Worker timings are recorded separately in docs/reports/browser-run.md.
for (const quality of ['preview', 'standard', 'high'] as Quality[]) {
  const sk = buildSkeleton('regular');
  const [g, buildMs] = timed(() => buildGarment(DEFAULT_PARAMS, quality, sk));
  const [d, drapeMs] = timed(() => drape(g, sk, { seed: 1 }));
  const [baked, textureMs] = timed(() => bakeTextures(g, { preview: 1024, standard: 2048, high: 4096 }[quality], {}));
  const tex = { baseColor: await nodeCodec.encodeJpeg(baked.baseColor, 0.88), normal: await nodeCodec.encodeJpeg(baked.normal, 0.88) };
  const [avatar, avatarMs] = timed(() => buildAvatarMesh(sk));
  const [glb, glbMs] = timed(() => writeGlb({ garment: g, simPositions: d.positions, skeleton: sk, avatarMesh: avatar, textures: tex, skeletalClips: ['walk'], extras: {} }));
  const [b, bakeMs] = timed(() => bake(g, sk, d, 'walk', { seed: 1 }));
  const { perVertex, ...s } = d.diagnostics;
  void perVertex;
  rows.push({ quality, simVertices: g.simPositions.length / 3, triangles: g.simIndices.length / 3, buildMs, drapeMs, textureMs, avatarMs, glbMs, bakeWalkMs: bakeMs, glbMB: +(glb.length / 1e6).toFixed(2), p99Stretch: +s.p99Stretch.toFixed(3), maxStretch: +s.maxStretch.toFixed(2), penetratingPct: +(s.penetratingFraction * 100).toFixed(3), walkWorstStretchP99: +b.frameDiagnostics.worstStretch.toFixed(3), walkPenetratingPct: +(b.frameDiagnostics.penetratingFraction * 100).toFixed(3), walkDeepestMm: +b.frameDiagnostics.worstPenetrationMm.toFixed(1), walkPeakSpeed: +b.frameDiagnostics.maxSpeed.toFixed(1) });
  console.log(rows.at(-1));
}
const matrix: Record<string, unknown>[] = [];
for (const body of ['slim', 'regular', 'broad'] as BodyShapeId[])
  for (const clip of ['walk', 'jog', 'armlift'] as ClipId[])
    for (const fabric of ['fleece', 'jersey', 'denim', 'nylon']) {
      if (fabric !== 'fleece' && (body !== 'regular' || clip === 'armlift')) continue;
      const sk = buildSkeleton(body);
      const g = buildGarment({ ...DEFAULT_PARAMS, fabric }, 'preview', sk);
      const d = drape(g, sk, { seed: 1 });
      const b = bake(g, sk, d, clip, { seed: 1 });
      matrix.push({ body, clip, fabric, drapeP99: +d.diagnostics.p99Stretch.toFixed(3), drapePenetratingPct: +(d.diagnostics.penetratingFraction * 100).toFixed(2), clipP99: +b.frameDiagnostics.worstStretch.toFixed(3), clipPenetratingPct: +(b.frameDiagnostics.penetratingFraction * 100).toFixed(2), deepestMm: +b.frameDiagnostics.worstPenetrationMm.toFixed(1), peakSpeed: +b.frameDiagnostics.maxSpeed.toFixed(1) });
      console.log(matrix.at(-1));
    }
const sk = buildSkeleton('regular');
const g = buildGarment(DEFAULT_PARAMS, 'preview', sk);
const repro = [1, 2].map(() => fnv1a(drape(g, sk, { seed: 7 }).positions));
void restPose;
const out = { generatedAt: new Date().toISOString(), hardware: { cpu: cpus()[0]?.model, cores: cpus().length, ramGB: Math.round(totalmem() / 1e9) }, runtime: `bun ${Bun.version}`, peakRssMB: Math.round(maxRss), reproducibleDrape: repro[0] === repro[1], fixtureHashes: Object.fromEntries(['hoodie_front.png', 'hoodie_back.png'].map((f) => [f, fnv1a(new Uint8Array(readFileSync(join(import.meta.dir, '..', 'fixtures', f))))])), quality: rows, stress: matrix };
mkdirSync(join(import.meta.dir, '..', 'docs', 'reports'), { recursive: true });
writeFileSync(join(import.meta.dir, '..', 'docs', 'reports', 'benchmark.json'), JSON.stringify(out, null, 1));
console.log('peak RSS MB', out.peakRssMB, 'reproducible', out.reproducibleDrape);
