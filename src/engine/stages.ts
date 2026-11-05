/**
 * One pipeline stage. Runs in a Web Worker in the browser, so the page stays responsive and cancel can terminate it even
 * inside a solver loop. All output is written in one transaction, so an interrupted stage never leaves partial results.
 */
import { buildAvatarMesh, buildSkeleton, restPose } from '../core/avatar.ts';
import { bake, diagnostics, drape, simNormals, type Diagnostics } from '../core/cloth.ts';
import { appearanceVertexCount, buildGarment, writePart, type Garment } from '../core/garment.ts';
import { writeGlb, writeObj } from '../core/gltf.ts';
import { runGarmentQa } from '../core/qa.ts';
import { PART_LABEL, QUALITY, type BodyShapeId, type ClipId, type HoodieParams, type PinGroup, type Quality } from '../core/params.ts';
import { bakeTextures, type BakeSources } from '../core/texture.ts';
import { analyzeGarmentImage, checkImageHeader, sniff, type ImageAnalysis } from '../core/vision.ts';
import { readJson, textBytes, type ImageCodec, type Storage } from './platform.ts';
import { BLENDER_README, MAKE_BLEND_PY } from './blenderScript.ts';
import type { GlbExpectation } from './validate.ts';

export interface StageTask {
  stage: 'analyze' | 'coarse' | 'texture' | 'drape' | 'refined' | 'motion' | 'qa' | 'export-glb' | 'export-obj' | 'validate-glb' | 'validate-obj' | 'blender-kit';
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
  /** Parent drape for the report of how far other parts moved. */
  parentDrapeDir?: string;
  parentParams?: HoodieParams;
  sourceDir?: string;
  expectation?: GlbExpectation;
}

const floats = (b: Uint8Array) => new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
const bytesOf = (a: Float32Array) => new Uint8Array(a.buffer.slice(a.byteOffset, a.byteOffset + a.byteLength));

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
  return { parts, seams, pattern: g.pattern, appearanceVertices: cursor, simVertices: g.simPositions.length / 3, simTriangles: g.simIndices.length / 3, massKg: g.totalMassKg, ds: g.ds, quality: g.quality, ...extra };
}

export async function executeStage(task: StageTask, storage: Storage, codec: ImageCodec, onProgress: (p: { phase: string; frame: number; total: number }) => void) {
  const started = performance.now();
  const sk = buildSkeleton(task.avatar);
  const out: [string, Uint8Array][] = [];
  const put = (name: string, data: Uint8Array | string) => out.push([`${task.outDir}/${name}`, typeof data === 'string' ? textBytes(data) : data]);
  const read = async (path: string) => {
    const b = await storage.read(path);
    if (!b) throw new Error(`A required stage output is missing: ${path}`);
    return b;
  };
  const progress = (phase: string, frame: number, total: number) => onProgress({ phase, frame, total });
  const summary: Record<string, unknown> = {};
  const textures = async () => ({ baseColor: await read(`${task.textureDir}/base.jpg`), normal: await read(`${task.textureDir}/normal.jpg`) });

  if (task.stage === 'analyze') {
    const bytes = await read(task.referencePath!);
    const kind = sniff(bytes);
    if (kind !== 'png' && kind !== 'jpeg') throw new Error('Only PNG and JPEG images can be analysed.');
    checkImageHeader(bytes, kind);
    const a = analyzeGarmentImage(await codec.decode(bytes, kind));
    const { mask, ...rest } = a;
    put('mask.bin', mask);
    const pm = new Uint8Array(a.maskWidth * a.maskHeight * 4);
    for (let i = 0; i < mask.length; i++) {
      const v = mask[i] ? 255 : 0;
      pm[i * 4] = v;
      pm[i * 4 + 1] = v;
      pm[i * 4 + 2] = v;
      pm[i * 4 + 3] = 255;
    }
    put('mask.png', await codec.encodePng({ width: a.maskWidth, height: a.maskHeight, data: pm }));
    put('analysis.json', JSON.stringify(rest));
  }

  if (task.stage === 'coarse') {
    // A real, draped, low-resolution mesh. It is the first thing a user can orbit.
    const g = buildGarment(task.params, 'preview', sk);
    const d = drape(g, sk, { seed: task.seed, pins: task.pins, onProgress: progress });
    put('draft.glb', writeGlb({ garment: g, simPositions: d.positions, skeleton: sk, avatarMesh: buildAvatarMesh(sk, 0.016), extras: { tier: 'draft', label: task.label, ...task.extras } }));
    const { perVertex, ...diag } = d.diagnostics;
    void perVertex;
    put('scene.json', JSON.stringify(buildScene(g, d.positions, { tier: 'draft', diagnostics: diag })));
  }

  if (task.stage === 'texture') {
    const g = buildGarment(task.params, task.quality, sk);
    const sources: BakeSources = {};
    for (const view of ['front', 'back'] as const) {
      const ref = task.references?.[view];
      if (!ref) continue;
      const bytes = await read(ref.path);
      const kind = sniff(bytes);
      if (kind !== 'png' && kind !== 'jpeg') continue;
      const analysis = (await readJson<ImageAnalysis>(storage, `${ref.analysis}/analysis.json`))!;
      sources[view] = { image: await codec.decode(bytes, kind), analysis: { ...analysis, mask: await read(`${ref.analysis}/mask.bin`) } };
    }
    const t = bakeTextures(g, QUALITY[task.quality].texture, sources);
    const q = t.size > 2048 ? 0.82 : 0.88;
    put('base.jpg', await codec.encodeJpeg(t.baseColor, q));
    put('normal.jpg', await codec.encodeJpeg(t.normal, q));
    put('sources.json', JSON.stringify({ size: t.size, sources: t.sources }));
  }

  if (task.stage === 'drape') {
    const g = buildGarment(task.params, task.quality, sk);
    const d = drape(g, sk, { seed: task.seed, pins: task.pins, onProgress: progress });
    put('positions.bin', bytesOf(d.positions));
    put('velocities.bin', bytesOf(d.velocities));
    const { perVertex, ...diag } = d.diagnostics;
    void perVertex;
    put('diagnostics.json', JSON.stringify(diag));
    Object.assign(summary, diag);
  }

  if (task.stage === 'refined') {
    const g = buildGarment(task.params, task.quality, sk);
    const positions = floats(await read(`${task.drapeDir}/positions.bin`));
    const diag = (await readJson<Diagnostics>(storage, `${task.drapeDir}/diagnostics.json`))!;
    put('model.glb', writeGlb({ garment: g, simPositions: positions, skeleton: sk, avatarMesh: buildAvatarMesh(sk), textures: await textures(), skeletalClips: ['idle', 'walk', 'jog', 'armlift'], extras: { tier: 'refined', label: task.label, ...task.extras } }));
    // Per appearance vertex diagnostics, in part order, for the viewport heatmaps.
    const d = diagnostics(g, sk, positions, restPose(sk), diag.selfCollisionEnabled, diag.maxSpeed);
    const heat = new Float32Array(appearanceVertexCount(g) * 2);
    let c = 0;
    for (const p of g.parts) {
      for (let i = 0; i < p.vertexCount; i++) {
        const s = p.map.length ? p.map[i] : p.embed!.ids[i * 4];
        heat[c * 2] = d.perVertex.stretch[s];
        heat[c * 2 + 1] = d.perVertex.depth[s];
        c++;
      }
    }
    put('heat.bin', bytesOf(heat));
    const textureSources = await readJson(storage, `${task.textureDir}/sources.json`);
    put('scene.json', JSON.stringify(buildScene(g, positions, { tier: 'refined', diagnostics: diag, textureSources })));
    const parentBytes = task.parentDrapeDir ? await storage.read(`${task.parentDrapeDir}/positions.bin`) : null;
    if (parentBytes && task.parentParams) {
      const pg = buildGarment(task.parentParams, task.quality, sk);
      const pp = floats(parentBytes);
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
      put('shift.json', JSON.stringify(shift));
    }
  }

  if (task.stage === 'motion') {
    const g = buildGarment(task.params, task.quality, sk);
    const positions = floats(await read(`${task.drapeDir}/positions.bin`));
    const velocities = floats(await read(`${task.drapeDir}/velocities.bin`));
    const b = bake(g, sk, { positions, velocities }, task.clip!, { seed: task.seed, pins: task.pins, onProgress: progress });
    const sim = new Float32Array(b.frames.length * positions.length);
    b.frames.forEach((f, i) => sim.set(f, i * positions.length));
    put('simframes.bin', bytesOf(sim));
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
    put('frames.bin', bytesOf(frames));
    put('meta.json', JSON.stringify({ clip: b.clip, fps: b.fps, frames: b.frames.length, vertices: v, diagnostics: b.frameDiagnostics, mode: 'baked-offline' }));
    Object.assign(summary, b.frameDiagnostics);
  }

  if (task.stage === 'qa') {
    const g = buildGarment(task.params, task.quality, sk);
    const positions = floats(await read(`${task.drapeDir}/positions.bin`));
    const diag = (await readJson<Diagnostics>(storage, `${task.drapeDir}/diagnostics.json`))!;
    let clip = null;
    if (task.motionDir) {
      const meta = (await readJson<{ clip: string; diagnostics: Record<string, number> }>(storage, `${task.motionDir}/meta.json`))!;
      clip = { id: meta.clip, ...meta.diagnostics } as never;
    }
    put('qa.json', JSON.stringify(runGarmentQa(g, positions, diag, clip)));
  }

  if (task.stage === 'export-glb' || task.stage === 'blender-kit') {
    const g = buildGarment(task.params, task.quality, sk);
    const positions = floats(await read(`${task.drapeDir}/positions.bin`));
    let cloth: { clip: ClipId; fps: number; frames: Float32Array[] } | undefined;
    if (task.motionDir) {
      const meta = (await readJson<{ clip: ClipId; fps: number; frames: number }>(storage, `${task.motionDir}/meta.json`))!;
      const sim = floats(await read(`${task.motionDir}/simframes.bin`));
      const frames: Float32Array[] = [];
      for (let i = 0; i < meta.frames; i++) frames.push(sim.subarray(i * positions.length, (i + 1) * positions.length));
      cloth = { clip: meta.clip, fps: meta.fps, frames };
    }
    put('hoodie.glb', writeGlb({ garment: g, simPositions: positions, skeleton: sk, avatarMesh: buildAvatarMesh(sk), textures: await textures(), cloth, skeletalClips: cloth ? undefined : ['idle', 'walk', 'jog', 'armlift'], extras: { tier: 'refined', label: task.label, units: 'metres', ...task.extras } }));
    if (task.stage === 'blender-kit') {
      put('make_blend.py', MAKE_BLEND_PY);
      put('README.txt', BLENDER_README);
    }
  }

  if (task.stage === 'export-obj') {
    const g = buildGarment(task.params, task.quality, sk);
    const positions = floats(await read(`${task.drapeDir}/positions.bin`));
    const { obj, mtl } = writeObj(g, positions, 'hoodie.mtl', 'hoodie_basecolor.jpg');
    put('hoodie.obj', obj);
    put('hoodie.mtl', mtl);
    put('hoodie_basecolor.jpg', await read(`${task.textureDir}/base.jpg`));
  }

  if (task.stage === 'validate-glb' || task.stage === 'validate-obj') {
    // Loaded on demand, because the validator is large and most stages never need it.
    const { validateGlb, validateObj } = await import('./validate.ts');
    if (task.stage === 'validate-glb') {
      const glb = await read(`${task.sourceDir}/hoodie.glb`);
      const isKit = await storage.exists(`${task.sourceDir}/make_blend.py`);
      put('report.json', JSON.stringify(await validateGlb(glb, task.expectation!, isKit ? 'blender' : 'glb'), null, 1));
    } else {
      const obj = await read(`${task.sourceDir}/hoodie.obj`);
      put('report.json', JSON.stringify(await validateObj(obj, task.expectation!.parts, await storage.exists(`${task.sourceDir}/hoodie.mtl`), await storage.exists(`${task.sourceDir}/hoodie_basecolor.jpg`)), null, 1));
    }
  }

  put('done.json', JSON.stringify({ stage: task.stage, ms: performance.now() - started, ...summary }));
  await storage.writeMany(out);
}
