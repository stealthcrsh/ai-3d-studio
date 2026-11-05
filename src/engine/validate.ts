import { WebIO } from '@gltf-transform/core';
import * as validator from 'gltf-validator';

export interface FormatReport {
  format: string;
  bytes: number;
  sha256: string;
  status: 'passed' | 'failed' | 'unverified';
  validators: { name: string; version?: string; passed: boolean; detail?: unknown; notRun?: boolean }[];
  expected: Record<string, unknown>;
  observed: Record<string, unknown>;
  warnings: string[];
  durationMs: number;
  checkedAt: string;
}

export async function sha256(bytes: Uint8Array) {
  const d = await crypto.subtle.digest('SHA-256', bytes.slice().buffer);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export interface GlbExpectation {
  parts: string[];
  clip: string | null;
  frames: number | null;
  avatar: boolean;
}

/** Two checks that share no code with the writer: the Khronos validator, and gltf-transform as a separate parser. */
export async function validateGlb(bytes: Uint8Array, exp: GlbExpectation, format = 'glb'): Promise<FormatReport> {
  const started = performance.now();
  const validators: FormatReport['validators'] = [];
  const warnings: string[] = [];
  const v = await validator.validateBytes(bytes, { maxIssues: 50 });
  const issues = v.issues as { numErrors: number; numWarnings: number; numInfos: number; messages: { code: string; message: string }[] };
  validators.push({
    name: 'Khronos glTF Validator', version: validator.version(), passed: issues.numErrors === 0,
    detail: { errors: issues.numErrors, warnings: issues.numWarnings, infos: issues.numInfos, sample: issues.messages.slice(0, 8).map((m) => `${m.code}: ${m.message}`) },
  });
  if (issues.numWarnings) warnings.push(`${issues.numWarnings} validator warnings. See the report.`);

  const doc = await new WebIO().readBinary(bytes);
  const root = doc.getRoot();
  const nodeNames = root.listNodes().map((n) => n.getName());
  const materials = root.listMaterials().map((m) => m.getName());
  const animations = root.listAnimations().map((a) => ({ name: a.getName(), channels: a.listChannels().length, weightChannels: a.listChannels().filter((c) => c.getTargetPath() === 'weights').length }));
  const meshes = root.listMeshes();
  const morphCounts = meshes.filter((m) => exp.parts.includes(m.getName())).map((m) => m.listPrimitives()[0].listTargets().length);
  const textures = root.listTextures().map((t) => ({ name: t.getName(), mime: t.getMimeType(), size: t.getSize() }));
  const missing = exp.parts.filter((p) => !nodeNames.includes(p));
  const skins = root.listSkins().length;
  let nonEmpty = true;
  let totalVerts = 0;
  let uvMissing = 0;
  for (const m of meshes)
    for (const prim of m.listPrimitives()) {
      const pos = prim.getAttribute('POSITION');
      if (!pos || pos.getCount() === 0) nonEmpty = false;
      totalVerts += pos?.getCount() ?? 0;
      if (exp.parts.includes(m.getName()) && !prim.getAttribute('TEXCOORD_0')) uvMissing++;
    }
  const hem = meshes.find((m) => m.getName() === 'Hem_Rib')?.listPrimitives()[0].getAttribute('POSITION');
  const checks: Record<string, boolean> = {
    partsPresent: missing.length === 0,
    nonEmptyGeometry: nonEmpty,
    uvsPresent: uvMissing === 0,
    materialsPresent: ['Fabric_Main', 'Fabric_Rib'].every((m) => materials.includes(m)),
    texturesEmbedded: textures.length >= 2 && textures.every((t) => (t.size?.[0] ?? 0) > 0),
    avatarSkinned: !exp.avatar || skins === 1,
  };
  if (exp.clip) {
    const anim = animations.find((a) => a.name === exp.clip);
    checks.clipPresent = Boolean(anim);
    checks.morphFramesMatch = morphCounts.length > 0 && morphCounts.every((c) => c === exp.frames);
    checks.weightChannelsPresent = (anim?.weightChannels ?? 0) === exp.parts.length;
  }
  validators.push({ name: 'gltf-transform independent parse', passed: Object.values(checks).every(Boolean), detail: checks });
  validators.push({ name: 'Opened in Blender', passed: false, notRun: true, detail: 'Blender is not part of this browser-only product. It has not opened this file.' });
  warnings.push('This file has not been opened in Blender.');
  const observed = { nodes: nodeNames.length, missingParts: missing, materials, animations, morphCounts: [...new Set(morphCounts)], textures, skins, totalVerts, hemBoundsY: hem ? [hem.getMin([0, 0, 0])[1], hem.getMax([0, 0, 0])[1]] : null };
  const ran = validators.filter((x) => !x.notRun);
  const ok = ran.every((x) => x.passed);
  return {
    format, bytes: bytes.length, sha256: await sha256(bytes), status: ok ? (format === 'blender' ? 'unverified' : 'passed') : 'failed',
    validators, expected: exp as unknown as Record<string, unknown>, observed, warnings, durationMs: Math.round(performance.now() - started), checkedAt: new Date().toISOString(),
  };
}

export async function validateObj(objBytes: Uint8Array, parts: string[], hasMtl: boolean, hasTexture: boolean): Promise<FormatReport> {
  const started = performance.now();
  const text = new TextDecoder().decode(objBytes);
  let v = 0, vt = 0, vn = 0, f = 0, outOfRange = 0;
  const names: string[] = [];
  for (const line of text.split('\n')) {
    if (line.startsWith('v ')) v++;
    else if (line.startsWith('vt ')) vt++;
    else if (line.startsWith('vn ')) vn++;
    else if (line.startsWith('o ')) names.push(line.slice(2));
    else if (line.startsWith('f ')) {
      f++;
      for (const tok of line.slice(2).split(' ')) if (Number(tok.split('/')[0]) > v) outOfRange++;
    }
  }
  const missing = parts.filter((p) => !names.includes(p));
  const passed = v > 0 && f > 0 && vt === v && missing.length === 0 && outOfRange === 0 && hasMtl && hasTexture;
  return {
    format: 'obj', bytes: objBytes.length, sha256: await sha256(objBytes), status: passed ? 'passed' : 'failed',
    validators: [{ name: 'Independent OBJ line parser', passed, detail: { v, vt, vn, f, outOfRange } }, { name: 'Opened in Blender', passed: false, notRun: true, detail: 'Not run in this browser-only product.' }],
    expected: { parts, note: 'Static geometry only. No rig, animation or physics.' },
    observed: { objects: names, missing, mtl: hasMtl, texture: hasTexture },
    warnings: ['This file has not been opened in Blender or another 3D application.'], durationMs: Math.round(performance.now() - started), checkedAt: new Date().toISOString(),
  };
}
