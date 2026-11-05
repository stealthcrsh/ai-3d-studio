import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { Document, NodeIO } from '@gltf-transform/core';
import validator from 'gltf-validator';
import { ROOT } from './store.ts';

const BLENDER_CANDIDATES = [
  process.env.BLENDER_BIN,
  join(ROOT, 'tools/blender/Blender.app/Contents/MacOS/Blender'),
  '/Volumes/AI-Workspace/Tools/Blender/Blender.app/Contents/MacOS/Blender',
  '/Applications/Blender.app/Contents/MacOS/Blender',
].filter(Boolean) as string[];

export function findBlender(): string | null {
  for (const c of BLENDER_CANDIDATES) if (existsSync(c)) return c;
  return Bun.which('blender');
}

export async function blenderVersion(): Promise<string | null> {
  const bin = findBlender();
  if (!bin) return null;
  const r = await runProcess(bin, ['--version'], 20000);
  return r.code === 0 ? (r.stdout.split('\n')[0] ?? null) : null;
}

function runProcess(bin: string, args: string[], timeoutMs: number, onSpawn?: (kill: () => void) => void) {
  return new Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }>((res) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' } });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (d) => (stdout = (stdout + d).slice(-200000)));
    child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-200000)));
    child.on('close', (code) => {
      clearTimeout(timer);
      res({ code, stdout, stderr, timedOut });
    });
    onSpawn?.(() => child.kill('SIGKILL'));
  });
}

/** Flags chosen from docs/research/dcc-formats.md. Blender is not a sandbox: only files this app wrote are opened. */
const blenderArgs = (script: string, rest: string[]) => ['--background', '--factory-startup', '--disable-autoexec', '--offline-mode', '--python-exit-code', '1', '--python', resolve(import.meta.dir, 'blender', script), '--', ...rest];

export interface FormatReport {
  format: string;
  file: string;
  bytes: number;
  sha256: string;
  status: 'passed' | 'failed' | 'blocked';
  validators: { name: string; version?: string; passed: boolean; detail?: unknown; blocked?: boolean }[];
  expected: Record<string, unknown>;
  observed: Record<string, unknown>;
  warnings: string[];
  durationMs: number;
  checkedAt: string;
}

const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');

const report = (format: string, file: string, started: number, status: FormatReport['status'], rest: Partial<FormatReport>): FormatReport => ({
  format, file, bytes: existsSync(file) ? statSync(file).size : 0, sha256: existsSync(file) ? sha(file) : '', status,
  validators: [], expected: {}, observed: {}, warnings: [], durationMs: Math.round(performance.now() - started), checkedAt: new Date().toISOString(), ...rest,
});

export interface GlbExpectation {
  parts: string[];
  clip: string | null;
  frames: number | null;
  avatar: boolean;
}

export async function validateGlb(path: string, exp: GlbExpectation): Promise<FormatReport> {
  const started = performance.now();
  const bytes = new Uint8Array(readFileSync(path));
  const validators: FormatReport['validators'] = [];
  const warnings: string[] = [];
  const v = await validator.validateBytes(bytes, { maxIssues: 50 });
  const issues = v.issues as { numErrors: number; numWarnings: number; numInfos: number; messages: { code: string; message: string; severity: number; pointer?: string }[] };
  validators.push({
    name: 'Khronos glTF-Validator', version: validator.version(), passed: issues.numErrors === 0,
    detail: { errors: issues.numErrors, warnings: issues.numWarnings, infos: issues.numInfos, sample: issues.messages.slice(0, 8).map((m) => `${m.code}: ${m.message}`) },
  });
  if (issues.numWarnings) warnings.push(`${issues.numWarnings} validator warnings. See the report.`);

  // Independent loader: gltf-transform parses the file with no knowledge of this app's writer.
  const io = new NodeIO();
  let doc: Document;
  doc = await io.readBinary(bytes);
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
  const bounds = (() => {
    const gm = meshes.find((m) => m.getName() === 'Hem_Rib')?.listPrimitives()[0].getAttribute('POSITION');
    return gm ? { hemMinY: gm.getMin([0, 0, 0])[1], hemMaxY: gm.getMax([0, 0, 0])[1] } : null;
  })();
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
  const blender = findBlender();
  const observed: Record<string, unknown> = { nodes: nodeNames.length, missingParts: missing, materials, animations, morphCounts: [...new Set(morphCounts)], textures, skins, totalVerts, bounds };
  if (blender) {
    const r = await roundTrip(blender, path, 'glb');
    validators.push(r.validator);
    observed.blender = r.data;
  } else {
    validators.push({ name: 'Blender import', passed: false, blocked: true, detail: 'Blender is not installed on this machine.' });
    warnings.push('Not opened in Blender, because Blender is not installed.');
  }
  const passed = validators.every((x) => x.passed || x.blocked);
  return report('glb', path, started, passed ? 'passed' : 'failed', { validators, expected: exp as unknown as Record<string, unknown>, observed, warnings });
}

async function roundTrip(blender: string, path: string, kind: string) {
  const out = `${path}.blender-report.json`;
  const r = await runProcess(blender, blenderArgs('validate_import.py', [path, out]), 240000);
  if (r.code !== 0 || !existsSync(out)) {
    return { validator: { name: 'Blender headless open', passed: false, detail: { code: r.code, timedOut: r.timedOut, stderr: r.stderr.slice(-800), stdout: r.stdout.slice(-800) } }, data: null };
  }
  const data = JSON.parse(readFileSync(out, 'utf8'));
  const meshCount = data.objects.filter((o: { type: string }) => o.type === 'MESH').length;
  return { validator: { name: 'Blender headless open', version: data.blender, passed: meshCount > 0, detail: { kind, meshCount } }, data };
}

export function validateObj(path: string, parts: string[]): FormatReport {
  const started = performance.now();
  const text = readFileSync(path, 'utf8');
  let v = 0, vt = 0, vn = 0, f = 0;
  const names: string[] = [];
  let outOfRange = 0;
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
  const mtl = join(dirname(path), 'hoodie.mtl');
  const tex = join(dirname(path), 'hoodie_basecolor.jpg');
  const missing = parts.filter((p) => !names.includes(p));
  const passed = v > 0 && f > 0 && vt === v && missing.length === 0 && outOfRange === 0 && existsSync(mtl) && existsSync(tex);
  return report('obj', path, started, passed ? 'passed' : 'failed', {
    validators: [{ name: 'Independent OBJ line parser', passed, detail: { v, vt, vn, f, outOfRange } }],
    expected: { parts, note: 'Static geometry only. No rig, animation or physics.' },
    observed: { objects: names, missing, mtl: existsSync(mtl), texture: existsSync(tex) },
  });
}

export async function validateObjInBlender(r: FormatReport, path: string) {
  const blender = findBlender();
  if (!blender) {
    r.validators.push({ name: 'Blender import', passed: false, blocked: true, detail: 'Blender is not installed on this machine.' });
    return r;
  }
  const t = await roundTrip(blender, path, 'obj');
  r.validators.push(t.validator);
  r.observed.blender = t.data;
  if (!t.validator.passed) r.status = 'failed';
  return r;
}

export async function exportBlend(glbPath: string, outDir: string, exp: GlbExpectation): Promise<FormatReport> {
  const started = performance.now();
  const blender = findBlender();
  const blendPath = join(outDir, 'hoodie.blend');
  if (!blender) {
    return report('blend', blendPath, started, 'blocked', {
      validators: [{ name: 'Blender', passed: false, blocked: true, detail: 'Blender is not installed. No .blend was written, because only Blender can write a genuine one.' }],
      warnings: ['Install Blender, then export again.'],
    });
  }
  const writeReport = join(outDir, 'write-report.json');
  const write = await runProcess(blender, blenderArgs('export_blend.py', [glbPath, blendPath, writeReport]), 300000);
  if (write.code !== 0 || !existsSync(blendPath)) {
    return report('blend', blendPath, started, 'failed', { validators: [{ name: 'Blender write', passed: false, detail: { code: write.code, timedOut: write.timedOut, stderr: write.stderr.slice(-1200), stdout: write.stdout.slice(-1200) } }] });
  }
  // Reopen in a new process. Only that second process's view counts as evidence.
  const check = await roundTrip(blender, blendPath, 'blend');
  const data = check.data as null | { objects: { name: string; type: string; vertices?: number; shape_keys?: number; uv_layers?: number; materials?: string[] }[]; images: { packed: boolean }[]; motion: { checked: boolean; max_vertex_move_m?: number }; skeletal: { checked: boolean }; unit_system: string; unit_scale: number };
  const checks: Record<string, boolean> = {};
  if (data) {
    const names = data.objects.map((o) => o.name);
    checks.partsPresent = exp.parts.every((p) => names.includes(p));
    checks.avatarPresent = !exp.avatar || data.objects.some((o) => o.type === 'ARMATURE');
    checks.uvsPresent = data.objects.filter((o) => exp.parts.includes(o.name)).every((o) => (o.uv_layers ?? 0) > 0);
    checks.materialsAssigned = data.objects.filter((o) => exp.parts.includes(o.name)).every((o) => (o.materials?.length ?? 0) > 0);
    checks.texturesPacked = data.images.length >= 2 && data.images.every((i) => i.packed);
    checks.metricUnits = data.unit_system === 'METRIC' && data.unit_scale === 1;
    if (exp.clip) {
      checks.shapeKeysPresent = data.objects.filter((o) => exp.parts.includes(o.name)).every((o) => (o.shape_keys ?? 0) > 1);
      checks.motionPlays = data.motion.checked && (data.motion.max_vertex_move_m ?? 0) > 0.001;
      checks.skeletalPresent = data.skeletal.checked;
    }
  }
  const validators = [check.validator, { name: 'Blender contents check', passed: Boolean(data) && Object.values(checks).every(Boolean), detail: checks }];
  const passed = validators.every((v) => v.passed);
  return report('blend', blendPath, started, passed ? 'passed' : 'failed', { validators, expected: exp as unknown as Record<string, unknown>, observed: { blender: data } });
}

export const writeReport = (dir: string, r: FormatReport) => writeFileSync(join(dir, 'report.json'), JSON.stringify(r, null, 1));
