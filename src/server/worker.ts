/**
 * Runs one pipeline stage in its own process. A job can be cancelled by killing this process, because Bun cannot
 * interrupt a synchronous loop in a Worker (docs/research/backend-security.md). Output goes to a temp directory and is
 * renamed into place on success, so an interrupted stage never leaves a half-written cache entry.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { buildAvatarMesh, buildSkeleton, restPose } from '../core/avatar.ts';
import { bake, diagnostics, drape, simNormals, type Diagnostics } from '../core/cloth.ts';
import { appearanceVertexCount, buildGarment, writePart, type Garment } from '../core/garment.ts';
import { writeGlb, writeObj } from '../core/gltf.ts';
import { runGarmentQa } from '../core/qa.ts';
import { PART_LABEL, type BodyShapeId, type ClipId, type HoodieParams, type PinGroup, type Quality } from '../core/params.ts';
import { bakeTextures, type BakeSources } from './texture.ts';
import { analyzeGarmentImage, decodeImage, encodePng, sniff, type ImageAnalysis } from './vision.ts';

export interface StageTask {
  stage: 'analyze' | 'coarse' | 'texture' | 'drape' | 'refined' | 'motion' | 'export-glb' | 'export-obj' | 'qa';
  outDir: string;
  params: HoodieParams;
  quality: Quality;
  avatar: BodyShapeId;
  seed: number;
  pins: PinGroup[];
  label: string;
  extras?: Record<string, unknown>;
  referencePath?: string;
  references?: { front?: { path: string; analysis: string }; back?: { path: string; analysis: string } };
  drapeDir?: string;
  textureDir?: string;
  motionDir?: string;
  clip?: ClipId;
  /** Parent drape for the "how far did other parts move" report. */
  parentDrapeDir?: string;
  parentParams?: HoodieParams;
}

const progress = (detail: Record<string, unknown>) => process.stdout.write(`${JSON.stringify({ type: 'progress', ...detail })}\n`);

const readFloat = (path: string) => {
  const b = readFileSync(path);
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
};
const bytesOf = (a: Float32Array) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);

function buildScene(g: Garment, positions: Float32Array, extra: Record<string, unknown>) {
  let cursor = 0;
  const parts = g.parts.map((p) => {
    const entry = { id: p.id, label: PART_LABEL[p.id], material: p.material, simulated: p.simulated, vertexCount: p.vertexCount, triangles: p.indices.length / 3, offset: cursor };
    cursor += p.vertexCount;
    return entry;
  });
  const seams = g.seams.map((s) => {
    const poly: number[] = [];
    for (const v of s.verts) poly.push(positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]);
    return { name: s.name, parts: s.parts, kind: s.kind, polyline: poly.map((v) => Math.round(v * 10000) / 10000) };
  });
  return {
    parts, seams, pattern: g.pattern, appearanceVertices: cursor,
    simVertices: g.simPositions.length / 3, simTriangles: g.simIndices.length / 3,
    massKg: g.totalMassKg, ds: g.ds, quality: g.quality, ...extra,
  };
}

async function run(task: StageTask) {
  const tmp = `${task.outDir}.tmp-${process.pid}`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  const started = performance.now();
  const sk = buildSkeleton(task.avatar);
  const out: Record<string, unknown> = {};

  if (task.stage === 'analyze') {
    const bytes = new Uint8Array(readFileSync(task.referencePath!));
    const kind = sniff(bytes);
    if (kind !== 'png' && kind !== 'jpeg') throw new Error('Only PNG and JPEG images can be analysed.');
    const img = decodeImage(bytes, kind);
    const a = analyzeGarmentImage(img);
    const { mask, ...summary } = a;
    writeFileSync(join(tmp, 'mask.bin'), mask);
    const pm = new Uint8Array(a.maskWidth * a.maskHeight * 4);
    for (let i = 0; i < mask.length; i++) {
      const v = mask[i] ? 255 : 0;
      pm.set([v, v, v, 255], i * 4);
    }
    writeFileSync(join(tmp, 'mask.png'), encodePng({ width: a.maskWidth, height: a.maskHeight, data: pm }));
    writeFileSync(join(tmp, 'analysis.json'), JSON.stringify(summary, null, 1));
    Object.assign(out, summary);
  }

  if (task.stage === 'coarse') {
    // A real, draped, low-resolution mesh. It is the first thing a user can orbit.
    const g = buildGarment(task.params, 'preview', sk);
    const d = drape(g, sk, { seed: task.seed, pins: task.pins, onProgress: (phase, frame, total) => progress({ phase, frame, total }) });
    const glb = writeGlb({ garment: g, simPositions: d.positions, skeleton: sk, avatarMesh: buildAvatarMesh(sk, 0.016), extras: { tier: 'draft', label: task.label, ...task.extras } });
    writeFileSync(join(tmp, 'draft.glb'), glb);
    const { perVertex, ...diag } = d.diagnostics;
    writeFileSync(join(tmp, 'scene.json'), JSON.stringify(buildScene(g, d.positions, { tier: 'draft', diagnostics: diag })));
  }

  if (task.stage === 'texture') {
    const g = buildGarment(task.params, task.quality, sk);
    const sources: BakeSources = {};
    for (const view of ['front', 'back'] as const) {
      const ref = task.references?.[view];
      if (!ref) continue;
      const bytes = new Uint8Array(readFileSync(ref.path));
      const kind = sniff(bytes);
      if (kind !== 'png' && kind !== 'jpeg') continue;
      const analysis = JSON.parse(readFileSync(join(ref.analysis, 'analysis.json'), 'utf8')) as ImageAnalysis;
      const maskBytes = new Uint8Array(readFileSync(join(ref.analysis, 'mask.bin')));
      sources[view] = { image: decodeImage(bytes, kind), analysis: { ...analysis, mask: maskBytes } };
    }
    const size = { preview: 1024, standard: 2048, high: 4096 }[task.quality];
    const t = bakeTextures(g, size, sources);
    writeFileSync(join(tmp, 'base.jpg'), t.baseColor);
    writeFileSync(join(tmp, 'normal.jpg'), t.normal);
    writeFileSync(join(tmp, 'sources.json'), JSON.stringify({ size: t.size, sources: t.sources }));
    Object.assign(out, { size: t.size });
  }

  if (task.stage === 'drape') {
    const g = buildGarment(task.params, task.quality, sk);
    const d = drape(g, sk, { seed: task.seed, pins: task.pins, onProgress: (phase, frame, total) => progress({ phase, frame, total }) });
    writeFileSync(join(tmp, 'positions.bin'), bytesOf(d.positions));
    writeFileSync(join(tmp, 'velocities.bin'), bytesOf(d.velocities));
    const { perVertex, ...diag } = d.diagnostics;
    writeFileSync(join(tmp, 'diagnostics.json'), JSON.stringify(diag, null, 1));
    Object.assign(out, diag);
  }

  if (task.stage === 'refined') {
    const g = buildGarment(task.params, task.quality, sk);
    const positions = readFloat(join(task.drapeDir!, 'positions.bin'));
    const diag = JSON.parse(readFileSync(join(task.drapeDir!, 'diagnostics.json'), 'utf8')) as Diagnostics;
    const textures = { baseColor: new Uint8Array(readFileSync(join(task.textureDir!, 'base.jpg'))), normal: new Uint8Array(readFileSync(join(task.textureDir!, 'normal.jpg'))) };
    const glb = writeGlb({ garment: g, simPositions: positions, skeleton: sk, avatarMesh: buildAvatarMesh(sk), textures, skeletalClips: ['idle', 'walk', 'jog', 'armlift'], extras: { tier: 'refined', label: task.label, ...task.extras } });
    writeFileSync(join(tmp, 'model.glb'), glb);
    // Per appearance vertex diagnostics, packed in part order, for the viewport heatmaps.
    const d = diagnostics(g, sk, positions, restPose(sk), diag.selfCollisionEnabled, diag.maxSpeed);
    const total = appearanceVertexCount(g);
    const heat = new Float32Array(total * 2);
    let c = 0;
    for (const p of g.parts) {
      for (let i = 0; i < p.vertexCount; i++) {
        const s = p.map.length ? p.map[i] : p.embed!.ids[i * 4];
        heat[c * 2] = d.perVertex.stretch[s];
        heat[c * 2 + 1] = d.perVertex.depth[s];
        c++;
      }
    }
    writeFileSync(join(tmp, 'heat.bin'), bytesOf(heat));
    const textureSources = JSON.parse(readFileSync(join(task.textureDir!, 'sources.json'), 'utf8'));
    writeFileSync(join(tmp, 'scene.json'), JSON.stringify(buildScene(g, positions, { tier: 'refined', diagnostics: diag, textureSources })));
    if (task.parentDrapeDir && task.parentParams && existsSync(join(task.parentDrapeDir, 'positions.bin'))) {
      const pg = buildGarment(task.parentParams, task.quality, sk);
      const pp = readFloat(join(task.parentDrapeDir, 'positions.bin'));
      const shift: Record<string, number | null> = {};
      for (const part of g.parts) {
        const other = pg.parts.find((q) => q.id === part.id);
        if (!other || other.vertexCount !== part.vertexCount || !part.map.length) {
          shift[part.id] = null;
          continue;
        }
        let sum = 0;
        for (let i = 0; i < part.vertexCount; i++) {
          const a = part.map[i] * 3;
          const b = other.map[i] * 3;
          sum += Math.hypot(positions[a] - pp[b], positions[a + 1] - pp[b + 1], positions[a + 2] - pp[b + 2]);
        }
        shift[part.id] = (sum / part.vertexCount) * 1000;
      }
      writeFileSync(join(tmp, 'shift.json'), JSON.stringify(shift));
    }
  }

  if (task.stage === 'motion') {
    const g = buildGarment(task.params, task.quality, sk);
    const positions = readFloat(join(task.drapeDir!, 'positions.bin'));
    const velocities = readFloat(join(task.drapeDir!, 'velocities.bin'));
    const b = bake(g, sk, { positions, velocities }, task.clip!, { seed: task.seed, pins: task.pins, onProgress: (phase, frame, total) => progress({ phase, frame, total }) });
    const sim = new Float32Array(b.frames.length * positions.length);
    b.frames.forEach((f, i) => sim.set(f, i * positions.length));
    writeFileSync(join(tmp, 'simframes.bin'), bytesOf(sim));
    // Appearance positions and normals per frame, for direct playback in the studio.
    const v = appearanceVertexCount(g);
    const frames = new Float32Array(b.frames.length * v * 6);
    b.frames.forEach((f, fi) => {
      const nrm = simNormals(g, f);
      let cursor = 0;
      for (const part of g.parts) {
        const base = fi * v * 6;
        const pos = new Float32Array(part.vertexCount * 3);
        const nor = new Float32Array(part.vertexCount * 3);
        writePart(part, f, nrm, pos, nor);
        for (let i = 0; i < part.vertexCount; i++) {
          const o = base + (cursor + i) * 6;
          frames.set(pos.subarray(i * 3, i * 3 + 3), o);
          frames.set(nor.subarray(i * 3, i * 3 + 3), o + 3);
        }
        cursor += part.vertexCount;
      }
    });
    writeFileSync(join(tmp, 'frames.bin'), bytesOf(frames));
    writeFileSync(join(tmp, 'meta.json'), JSON.stringify({ clip: b.clip, fps: b.fps, frames: b.frames.length, vertices: v, diagnostics: b.frameDiagnostics, mode: 'baked-offline' }, null, 1));
    Object.assign(out, b.frameDiagnostics);
  }

  if (task.stage === 'qa') {
    const g = buildGarment(task.params, task.quality, sk);
    const positions = readFloat(join(task.drapeDir!, 'positions.bin'));
    const diag = JSON.parse(readFileSync(join(task.drapeDir!, 'diagnostics.json'), 'utf8')) as Diagnostics;
    let clip = null;
    if (task.motionDir) {
      const meta = JSON.parse(readFileSync(join(task.motionDir, 'meta.json'), 'utf8'));
      clip = { id: meta.clip, ...meta.diagnostics };
    }
    writeFileSync(join(tmp, 'qa.json'), JSON.stringify(runGarmentQa(g, positions, diag, clip), null, 1));
  }

  if (task.stage === 'export-glb') {
    const g = buildGarment(task.params, task.quality, sk);
    const positions = readFloat(join(task.drapeDir!, 'positions.bin'));
    const textures = { baseColor: new Uint8Array(readFileSync(join(task.textureDir!, 'base.jpg'))), normal: new Uint8Array(readFileSync(join(task.textureDir!, 'normal.jpg'))) };
    let cloth: { clip: ClipId; fps: number; frames: Float32Array[] } | undefined;
    if (task.motionDir) {
      const meta = JSON.parse(readFileSync(join(task.motionDir, 'meta.json'), 'utf8'));
      const sim = readFloat(join(task.motionDir, 'simframes.bin'));
      const frames: Float32Array[] = [];
      for (let i = 0; i < meta.frames; i++) frames.push(sim.subarray(i * positions.length, (i + 1) * positions.length));
      cloth = { clip: meta.clip, fps: meta.fps, frames };
    }
    const glb = writeGlb({ garment: g, simPositions: positions, skeleton: sk, avatarMesh: buildAvatarMesh(sk), textures, cloth, skeletalClips: cloth ? undefined : ['idle', 'walk', 'jog', 'armlift'], extras: { tier: 'refined', label: task.label, units: 'metres', ...task.extras } });
    writeFileSync(join(tmp, 'hoodie.glb'), glb);
  }

  if (task.stage === 'export-obj') {
    const g = buildGarment(task.params, task.quality, sk);
    const positions = readFloat(join(task.drapeDir!, 'positions.bin'));
    const { obj, mtl } = writeObj(g, positions, 'hoodie.mtl', 'hoodie_basecolor.jpg');
    writeFileSync(join(tmp, 'hoodie.obj'), obj);
    writeFileSync(join(tmp, 'hoodie.mtl'), mtl);
    writeFileSync(join(tmp, 'hoodie_basecolor.jpg'), readFileSync(join(task.textureDir!, 'base.jpg')));
  }

  const ms = performance.now() - started;
  writeFileSync(join(tmp, 'done.json'), JSON.stringify({ stage: task.stage, ms, ...out }, null, 1));
  mkdirSync(dirname(task.outDir), { recursive: true });
  rmSync(task.outDir, { recursive: true, force: true });
  renameSync(tmp, task.outDir);
  process.stdout.write(`${JSON.stringify({ type: 'done', ms })}\n`);
}

const task = JSON.parse(readFileSync(process.argv[2], 'utf8')) as StageTask;
run(task).catch((e) => {
  process.stdout.write(`${JSON.stringify({ type: 'error', message: e instanceof Error ? e.message : String(e) })}\n`);
  process.exit(1);
});
