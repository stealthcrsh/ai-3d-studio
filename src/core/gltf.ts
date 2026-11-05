import { clipPose, CLIPS, JOINT_NAMES, restPose, type AvatarMesh, type Skeleton } from './avatar.ts';
import { vertexNormals } from './math.ts';
import { FABRICS, type ClipId } from './params.ts';
import { writePart, type Garment } from './garment.ts';

/** Minimal, spec-following GLB 2.0 writer. Output is checked by Khronos glTF-Validator in tests. */
class Builder {
  chunks: Uint8Array[] = [];
  length = 0;
  bufferViews: Record<string, unknown>[] = [];
  accessors: Record<string, unknown>[] = [];

  private push(data: Uint8Array) {
    const pad = (4 - (this.length % 4)) % 4;
    if (pad) {
      this.chunks.push(new Uint8Array(pad));
      this.length += pad;
    }
    const offset = this.length;
    this.chunks.push(data);
    this.length += data.byteLength;
    return offset;
  }

  view(data: Uint8Array, target?: number) {
    const byteOffset = this.push(data);
    this.bufferViews.push({ buffer: 0, byteOffset, byteLength: data.byteLength, ...(target ? { target } : {}) });
    return this.bufferViews.length - 1;
  }

  accessor(arr: Float32Array | Uint32Array | Uint8Array | Uint16Array, type: 'SCALAR' | 'VEC2' | 'VEC3' | 'VEC4' | 'MAT4', componentType: number, opts: { target?: number; minmax?: boolean; normalized?: boolean } = {}) {
    const size = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }[type];
    const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength).slice();
    const bufferView = this.view(bytes, opts.target);
    const out: Record<string, unknown> = { bufferView, componentType, count: arr.length / size, type };
    if (opts.normalized) out.normalized = true;
    if (opts.minmax) {
      const min = new Array(size).fill(Infinity);
      const max = new Array(size).fill(-Infinity);
      for (let i = 0; i < arr.length; i++) {
        const c = i % size;
        if (arr[i] < min[c]) min[c] = arr[i];
        if (arr[i] > max[c]) max[c] = arr[i];
      }
      out.min = min;
      out.max = max;
    }
    this.accessors.push(out);
    return this.accessors.length - 1;
  }
}

const FLOAT = 5126;
const UINT = 5125;
const USHORT = 5123;
const UBYTE = 5121;
const ARRAY = 34962;
const ELEMENT = 34963;

export interface GlbInput {
  garment: Garment;
  simPositions: Float32Array;
  skeleton?: Skeleton;
  avatarMesh?: AvatarMesh;
  /** JPEG bytes. Omitted for draft assets, which use flat colours. */
  textures?: { baseColor: Uint8Array; normal: Uint8Array };
  /** Baked cloth, written as morph targets, plus the matching skeletal clip. */
  cloth?: { clip: ClipId; fps: number; frames: Float32Array[] };
  skeletalClips?: ClipId[];
  extras: Record<string, unknown>;
}

const hexToLinear = (hex: string): [number, number, number, number] => {
  const f = (i: number) => {
    const s = parseInt(hex.slice(i, i + 2), 16) / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return [f(1), f(3), f(5), 1];
};

export function writeGlb(input: GlbInput): Uint8Array {
  const { garment: g, simPositions, skeleton: sk, avatarMesh, textures, cloth } = input;
  const b = new Builder();
  const fabric = FABRICS[g.params.fabric] ?? FABRICS.fleece;

  const images: Record<string, unknown>[] = [];
  const glTextures: Record<string, unknown>[] = [];
  let baseTex = -1;
  let normalTex = -1;
  if (textures) {
    const a = b.view(textures.baseColor);
    images.push({ bufferView: a, mimeType: 'image/jpeg', name: 'Garment_BaseColor' });
    const n = b.view(textures.normal);
    images.push({ bufferView: n, mimeType: 'image/jpeg', name: 'Garment_Normal' });
    glTextures.push({ source: 0, sampler: 0 }, { source: 1, sampler: 0 });
    baseTex = 0;
    normalTex = 1;
  }
  const fabricMaterial = (name: string, color: string, roughness: number) => ({
    name,
    doubleSided: true,
    pbrMetallicRoughness: {
      ...(textures ? { baseColorTexture: { index: baseTex } } : { baseColorFactor: hexToLinear(color) }),
      metallicFactor: 0,
      roughnessFactor: roughness,
    },
    ...(textures ? { normalTexture: { index: normalTex, scale: 1 } } : {}),
  });
  const materials: Record<string, unknown>[] = [
    fabricMaterial('Fabric_Main', g.params.baseColor, fabric.roughness),
    fabricMaterial('Fabric_Rib', g.params.ribColor, Math.min(1, fabric.roughness + 0.03)),
    fabricMaterial('Drawcord', g.params.cordColor, 0.75),
    { name: 'Avatar_Mannequin', pbrMetallicRoughness: { baseColorFactor: [0.36, 0.36, 0.38, 1], metallicFactor: 0, roughnessFactor: 0.62 } },
  ];
  const slot = { main: 0, rib: 1, cord: 2 } as const;

  const meshes: Record<string, unknown>[] = [];
  const nodes: Record<string, unknown>[] = [];
  const animations: Record<string, unknown>[] = [];
  const partNodes: number[] = [];

  const baseSim = cloth ? cloth.frames[0] : simPositions;
  const baseNormals = vertexNormals(baseSim, g.simIndices);
  const frameNormals = cloth ? cloth.frames.map((f) => vertexNormals(f, g.simIndices)) : [];
  const weightChannels: { node: number }[] = [];

  for (const part of g.parts) {
    const pos = new Float32Array(part.vertexCount * 3);
    const nor = new Float32Array(part.vertexCount * 3);
    writePart(part, baseSim, baseNormals, pos, nor);
    const attributes: Record<string, number> = {
      POSITION: b.accessor(pos, 'VEC3', FLOAT, { target: ARRAY, minmax: true }),
      NORMAL: b.accessor(nor, 'VEC3', FLOAT, { target: ARRAY }),
      TEXCOORD_0: b.accessor(part.uv, 'VEC2', FLOAT, { target: ARRAY }),
    };
    const indices = b.accessor(part.indices, 'SCALAR', UINT, { target: ELEMENT });
    const primitive: Record<string, unknown> = { attributes, indices, material: slot[part.material], mode: 4 };
    const mesh: Record<string, unknown> = { name: part.id, primitives: [primitive] };
    if (cloth) {
      const targets: Record<string, number>[] = [];
      const fp = new Float32Array(part.vertexCount * 3);
      const fn = new Float32Array(part.vertexCount * 3);
      cloth.frames.forEach((frame, f) => {
        writePart(part, frame, frameNormals[f], fp, fn);
        const dp = fp.map((v, i) => v - pos[i]);
        const dn = fn.map((v, i) => v - nor[i]);
        targets.push({
          POSITION: b.accessor(dp, 'VEC3', FLOAT, { target: ARRAY, minmax: true }),
          NORMAL: b.accessor(dn, 'VEC3', FLOAT, { target: ARRAY }),
        });
      });
      primitive.targets = targets;
      mesh.weights = cloth.frames.map(() => 0);
      mesh.extras = { targetNames: cloth.frames.map((_, f) => `frame_${String(f).padStart(3, '0')}`) };
    }
    meshes.push(mesh);
    nodes.push({ name: part.id, mesh: meshes.length - 1, extras: { simulated: part.simulated, material: part.material } });
    partNodes.push(nodes.length - 1);
    if (cloth) weightChannels.push({ node: nodes.length - 1 });
  }
  nodes.push({ name: 'Garment_Hoodie', children: partNodes.slice(), extras: { kind: 'garment', generator: 'parametric-pattern-drape' } });
  const garmentNode = nodes.length - 1;
  const rootChildren = [garmentNode];

  let skin: number | undefined;
  const jointNode: number[] = [];
  if (sk && avatarMesh) {
    const base = nodes.length;
    // Joints default to the standing pose, so a static export matches the cloth that was draped on it.
    const standing = restPose(sk);
    sk.bind.forEach((p, i) => {
      const parent = sk.parents[i];
      const local = parent < 0 ? p : [p[0] - sk.bind[parent][0], p[1] - sk.bind[parent][1], p[2] - sk.bind[parent][2]];
      nodes.push({ name: JOINT_NAMES[i], translation: [...local], rotation: [...standing.rot[i]] });
      jointNode.push(base + i);
    });
    sk.parents.forEach((parent, i) => {
      if (parent >= 0) {
        const pn = nodes[base + parent];
        ((pn.children ??= []) as number[]).push(base + i);
      }
    });
    const ibm = new Float32Array(sk.bind.length * 16);
    sk.bind.forEach((p, i) => {
      ibm.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -p[0], -p[1], -p[2], 1], i * 16);
    });
    const ibmA = b.accessor(ibm, 'MAT4', FLOAT);
    const skins = [{ name: 'Avatar_Skin', joints: jointNode, skeleton: base, inverseBindMatrices: ibmA }];
    skin = 0;
    (input as unknown as { _skins: unknown })._skins = skins;
    const attributes = {
      POSITION: b.accessor(avatarMesh.positions, 'VEC3', FLOAT, { target: ARRAY, minmax: true }),
      NORMAL: b.accessor(avatarMesh.normals, 'VEC3', FLOAT, { target: ARRAY }),
      JOINTS_0: b.accessor(avatarMesh.joints, 'VEC4', UBYTE, { target: ARRAY }),
      WEIGHTS_0: b.accessor(avatarMesh.weights, 'VEC4', FLOAT, { target: ARRAY }),
    };
    const indices = b.accessor(avatarMesh.indices, 'SCALAR', UINT, { target: ELEMENT });
    meshes.push({ name: 'Avatar_Mannequin', primitives: [{ attributes, indices, material: 3, mode: 4 }] });
    nodes.push({ name: 'Avatar_Mesh', mesh: meshes.length - 1, skin });
    const avatarMeshNode = nodes.length - 1;
    nodes.push({ name: 'Avatar', children: [base, avatarMeshNode], extras: { kind: 'avatar', shape: sk.shape.id, note: 'Procedural mannequin, original to this project' } });
    rootChildren.push(nodes.length - 1);

    const clipsToWrite: ClipId[] = cloth ? [cloth.clip] : (input.skeletalClips ?? []);
    for (const clip of clipsToWrite) {
      const dur = CLIPS[clip].duration;
      const fps = 30;
      const count = Math.round(dur * fps);
      const times = new Float32Array(count);
      for (let i = 0; i < count; i++) times[i] = (i / count) * dur;
      const input_ = b.accessor(times, 'SCALAR', FLOAT, { minmax: true });
      const samplers: Record<string, unknown>[] = [];
      const channels: Record<string, unknown>[] = [];
      const rots = sk.bind.map(() => new Float32Array(count * 4));
      const hips = new Float32Array(count * 3);
      for (let f = 0; f < count; f++) {
        const pose = clipPose(sk, clip, times[f]);
        pose.rot.forEach((q, j) => rots[j].set(q, f * 4));
        hips.set([sk.bind[0][0] + pose.hips[0], sk.bind[0][1] + pose.hips[1], sk.bind[0][2] + pose.hips[2]], f * 3);
      }
      rots.forEach((r, j) => {
        samplers.push({ input: input_, output: b.accessor(r, 'VEC4', FLOAT), interpolation: 'LINEAR' });
        channels.push({ sampler: samplers.length - 1, target: { node: jointNode[j], path: 'rotation' } });
      });
      samplers.push({ input: input_, output: b.accessor(hips, 'VEC3', FLOAT), interpolation: 'LINEAR' });
      channels.push({ sampler: samplers.length - 1, target: { node: jointNode[0], path: 'translation' } });
      if (cloth && cloth.clip === clip) {
        const n = cloth.frames.length;
        const clothTimes = new Float32Array(n);
        for (let i = 0; i < n; i++) clothTimes[i] = i / cloth.fps;
        const tA = b.accessor(clothTimes, 'SCALAR', FLOAT, { minmax: true });
        const weights = new Float32Array(n * n);
        for (let i = 0; i < n; i++) weights[i * n + i] = 1;
        const wA = b.accessor(weights, 'SCALAR', FLOAT);
        samplers.push({ input: tA, output: wA, interpolation: 'LINEAR' });
        const s = samplers.length - 1;
        for (const c of weightChannels) channels.push({ sampler: s, target: { node: c.node, path: 'weights' } });
      }
      animations.push({ name: clip, samplers, channels });
    }
  }

  nodes.push({ name: 'Studio_Root', children: rootChildren });
  const root = nodes.length - 1;

  const json: Record<string, unknown> = {
    asset: { version: '2.0', generator: 'ai-3d-studio 0.1 (parametric pattern + XPBD baseline)' },
    extensionsUsed: undefined,
    scene: 0,
    scenes: [{ name: 'Scene', nodes: [root] }],
    nodes,
    meshes,
    materials,
    accessors: b.accessors,
    bufferViews: b.bufferViews,
    extras: input.extras,
  };
  if (images.length) {
    json.images = images;
    json.textures = glTextures;
    json.samplers = [{ magFilter: 9729, minFilter: 9987, wrapS: 33071, wrapT: 33071 }];
  }
  const skins = (input as unknown as { _skins?: unknown[] })._skins;
  if (skins) json.skins = skins;
  if (animations.length) json.animations = animations;

  const binTotal = (() => {
    const pad = (4 - (b.length % 4)) % 4;
    return b.length + pad;
  })();
  json.buffers = [{ byteLength: binTotal }];
  delete json.extensionsUsed;
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonPad = (4 - (jsonBytes.length % 4)) % 4;
  const totalLen = 12 + 8 + jsonBytes.length + jsonPad + 8 + binTotal;
  const out = new Uint8Array(totalLen);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, totalLen, true);
  dv.setUint32(12, jsonBytes.length + jsonPad, true);
  dv.setUint32(16, 0x4e4f534a, true);
  out.set(jsonBytes, 20);
  out.fill(0x20, 20 + jsonBytes.length, 20 + jsonBytes.length + jsonPad);
  let offset = 20 + jsonBytes.length + jsonPad;
  dv.setUint32(offset, binTotal, true);
  dv.setUint32(offset + 4, 0x004e4942, true);
  offset += 8;
  let cursor = offset;
  for (const c of b.chunks) {
    out.set(c, cursor);
    cursor += c.byteLength;
  }
  return out;
}

export const USHORT_COMPONENT = USHORT;

/** Static OBJ + MTL. Geometry, UVs, named groups and one material library only. */
export function writeObj(g: Garment, simPositions: Float32Array, mtlName: string, textureFile: string | null): { obj: string; mtl: string } {
  const normals = vertexNormals(simPositions, g.simIndices);
  const lines: string[] = ['# AI 3D Studio static OBJ. Units: metres, +Y up. No rig, animation or physics.', `mtllib ${mtlName}`];
  let vOffset = 1;
  for (const part of g.parts) {
    const pos = new Float32Array(part.vertexCount * 3);
    const nor = new Float32Array(part.vertexCount * 3);
    writePart(part, simPositions, normals, pos, nor);
    lines.push(`o ${part.id}`, `usemtl ${part.material === 'rib' ? 'Fabric_Rib' : part.material === 'cord' ? 'Drawcord' : 'Fabric_Main'}`);
    for (let i = 0; i < part.vertexCount; i++) lines.push(`v ${pos[i * 3].toFixed(5)} ${pos[i * 3 + 1].toFixed(5)} ${pos[i * 3 + 2].toFixed(5)}`);
    for (let i = 0; i < part.vertexCount; i++) lines.push(`vt ${part.uv[i * 2].toFixed(5)} ${(1 - part.uv[i * 2 + 1]).toFixed(5)}`);
    for (let i = 0; i < part.vertexCount; i++) lines.push(`vn ${nor[i * 3].toFixed(4)} ${nor[i * 3 + 1].toFixed(4)} ${nor[i * 3 + 2].toFixed(4)}`);
    for (let t = 0; t < part.indices.length; t += 3) {
      const a = part.indices[t] + vOffset;
      const b = part.indices[t + 1] + vOffset;
      const c = part.indices[t + 2] + vOffset;
      lines.push(`f ${a}/${a}/${a} ${b}/${b}/${b} ${c}/${c}/${c}`);
    }
    vOffset += part.vertexCount;
  }
  const mat = (name: string, kd: string) => [`newmtl ${name}`, `Kd ${kd}`, 'Ks 0.02 0.02 0.02', 'Ns 10', ...(textureFile ? [`map_Kd ${textureFile}`] : [])].join('\n');
  const toKd = (hex: string) => [1, 3, 5].map((i) => (parseInt(hex.slice(i, i + 2), 16) / 255).toFixed(4)).join(' ');
  const mtl = [mat('Fabric_Main', toKd(g.params.baseColor)), mat('Fabric_Rib', toKd(g.params.ribColor)), mat('Drawcord', toKd(g.params.cordColor))].join('\n\n');
  return { obj: lines.join('\n') + '\n', mtl: mtl + '\n' };
}
