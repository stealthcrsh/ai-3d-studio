import { buildSkeleton, buildAvatarMesh } from '../src/core/avatar.ts';
import { buildGarment, appearanceVertexCount } from '../src/core/garment.ts';
import { DEFAULT_PARAMS, type Quality } from '../src/core/params.ts';
import { bake, drape } from '../src/core/cloth.ts';

const quality = (process.argv[2] ?? 'standard') as Quality;
const sk = buildSkeleton('regular');
let t = performance.now();
const av = buildAvatarMesh(sk);
console.log('avatar', av.positions.length / 3, 'verts', av.indices.length / 3, 'tris', (performance.now() - t).toFixed(0), 'ms');
t = performance.now();
const g = buildGarment(DEFAULT_PARAMS, quality, sk);
console.log('garment sim verts', g.simPositions.length / 3, 'tris', g.simIndices.length / 3, 'edges', g.edgeRest.length, 'bends', g.bendRest.length, 'appearance', appearanceVertexCount(g), 'mass kg', g.totalMassKg.toFixed(3), (performance.now() - t).toFixed(0), 'ms');
t = performance.now();
const d = drape(g, sk, {});
const { perVertex, ...stats } = d.diagnostics;
console.log('drape', (performance.now() - t).toFixed(0), 'ms', stats);
let minY = 9, maxY = -9, minZ = 9, maxZ = -9;
for (let i = 0; i < d.positions.length; i += 3) { minY = Math.min(minY, d.positions[i + 1]); maxY = Math.max(maxY, d.positions[i + 1]); minZ = Math.min(minZ, d.positions[i + 2]); maxZ = Math.max(maxZ, d.positions[i + 2]); }
console.log({ minY, maxY, minZ, maxZ });
t = performance.now();
const b = bake(g, sk, d, 'walk', {});
console.log('bake walk', (performance.now() - t).toFixed(0), 'ms frames', b.frames.length, b.frameDiagnostics);
