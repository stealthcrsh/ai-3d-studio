import { spawn, type ChildProcess } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { hashOf, physicsKey, appearanceKey, type ClipId, type HoodieParams } from '../core/params.ts';
import { buildGarment } from '../core/garment.ts';
import { buildSkeleton } from '../core/avatar.ts';
import { DATA_DIR, listJobs, listProjects, newId, projectDir, readProject, saveJob, saveProject, type ExportRecord, type Job, type Project, type StageRecord, type Version } from './store.ts';
import { inferParams, pickReferences } from './providers.ts';
import type { StageTask } from './worker.ts';
import type { ImageAnalysis } from './vision.ts';
import { exportBlend, validateGlb, validateObj, validateObjInBlender, writeReport, type GlbExpectation } from './validate.ts';

type Listener = (event: Record<string, unknown>) => void;
const listeners = new Set<Listener>();
export const subscribe = (l: Listener) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const emit = (event: Record<string, unknown>) => {
  for (const l of listeners) l(event);
};

const STAGE_TIMEOUT_MS = 15 * 60 * 1000;
const STAGE_LABEL: Record<string, string> = {
  ingest: 'Check reference files',
  analyze: 'Measure reference images',
  infer: 'Infer shape and scale',
  coarse: 'Build and drape coarse mesh',
  texture: 'Bake UVs and textures',
  drape: 'Drape on avatar',
  refined: 'Assemble refined asset',
  motion: 'Bake cloth motion',
  qa: 'Run quality checks',
  write: 'Write export file',
  validate: 'Reopen and validate',
};

class Cancelled extends Error {}

interface Active {
  job: Job;
  child: ChildProcess | null;
  cancel: boolean;
}

let active: Active | null = null;
const queue: Job[] = [];
const WORKER = resolve(import.meta.dir, 'worker.ts');

const initStages = (names: string[]): StageRecord[] => names.map((name) => ({ name, label: STAGE_LABEL[name] ?? name, status: 'pending' }));

function persist(job: Job) {
  saveJob(job);
  emit({ type: 'job', job });
}

export function runWorkerTask(task: StageTask, onLine?: (l: Record<string, unknown>) => void, register?: (c: ChildProcess) => void, timeoutMs = STAGE_TIMEOUT_MS): Promise<void> {
  mkdirSync(join(DATA_DIR, 'tasks'), { recursive: true });
  const file = join(DATA_DIR, 'tasks', `${newId('task')}.json`);
  writeFileSync(file, JSON.stringify(task));
  return new Promise((res, rej) => {
    const child = spawn(process.execPath, ['run', WORKER, file], { stdio: ['ignore', 'pipe', 'pipe'] });
    register?.(child);
    let buffer = '';
    let errorMessage = '';
    let stderr = '';
    const timer = setTimeout(() => {
      errorMessage = `Stage exceeded the ${Math.round(timeoutMs / 60000)} minute limit and was stopped.`;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout!.on('data', (d) => {
      buffer += d;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        try {
          const msg = JSON.parse(line);
          if (msg.type === 'error') errorMessage = msg.message;
          else onLine?.(msg);
        } catch {
          // Non-JSON output from a dependency is ignored.
        }
      }
    });
    child.stderr!.on('data', (d) => (stderr = (stderr + d).slice(-2000)));
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) res();
      else if (signal === 'SIGKILL' && !errorMessage) rej(new Cancelled('cancelled'));
      else rej(new Error(errorMessage || `Stage process failed (${code}). ${stderr.slice(-300)}`));
    });
  });
}

const cacheDir = (project: Project, name: string, key: string) => join(projectDir(project.id), 'cache', `${name}-${key}`);
const rel = (project: Project, p: string) => relative(projectDir(project.id), p);
const abs = (project: Project, p: string) => join(projectDir(project.id), p);

export function ensureProjectVersion(project: Project, versionId: string) {
  const v = project.versions.find((x) => x.id === versionId);
  if (!v) throw new Error('Version not found');
  return v;
}

function updateVersion(projectId: string, versionId: string, fn: (v: Version, p: Project) => void) {
  const p = readProject(projectId)!;
  const v = p.versions.find((x) => x.id === versionId)!;
  fn(v, p);
  saveProject(p);
  emit({ type: 'project', projectId, version: v });
  return v;
}

async function runCached(job: Job, act: Active, project: Project, stage: string, key: string, task: Omit<StageTask, 'stage' | 'outDir'>, workerStage: StageTask['stage'] = stage as StageTask['stage']): Promise<{ dir: string; cached: boolean; done: Record<string, unknown> }> {
  const rec = job.stages.find((s) => s.name === stage)!;
  const dir = cacheDir(project, stage, key);
  rec.startedAt = Date.now();
  if (existsSync(join(dir, 'done.json'))) {
    rec.status = 'cached';
    rec.finishedAt = Date.now();
    rec.detail = 'Reused an identical earlier result';
    persist(job);
    return { dir, cached: true, done: JSON.parse(readFileSync(join(dir, 'done.json'), 'utf8')) };
  }
  if (act.cancel) throw new Cancelled('cancelled');
  rec.status = 'running';
  persist(job);
  let last = 0;
  await runWorkerTask(
    { ...task, stage: workerStage, outDir: dir },
    (m) => {
      if (m.type === 'progress') {
        job.progress = { phase: String(m.phase), frame: Number(m.frame), total: Number(m.total) };
        const now = Date.now();
        if (now - last > 150) {
          last = now;
          emit({ type: 'job', job });
        }
      }
    },
    (c) => (act.child = c),
  );
  act.child = null;
  job.progress = undefined;
  const done = JSON.parse(readFileSync(join(dir, 'done.json'), 'utf8'));
  rec.status = 'done';
  rec.finishedAt = Date.now();
  rec.ms = Math.round(done.ms);
  persist(job);
  return { dir, cached: false, done };
}

const refsHash = (p: Project) => {
  const r = pickReferences(p);
  return hashOf({ f: r.front?.sha256, b: r.back?.sha256 });
};

function simpleStage(job: Job, name: string, status: StageRecord['status'], detail?: string, ms?: number) {
  const rec = job.stages.find((s) => s.name === name)!;
  rec.status = status;
  if (detail) rec.detail = detail;
  if (ms !== undefined) rec.ms = ms;
  if (status === 'running') rec.startedAt = Date.now();
  else rec.finishedAt = Date.now();
  persist(job);
}

export function loadAnalyses(project: Project) {
  const r = pickReferences(project);
  const out: Partial<Record<'front' | 'back', ImageAnalysis>> = {};
  for (const view of ['front', 'back'] as const) {
    const ref = r[view];
    if (ref?.analysisDir) out[view] = JSON.parse(readFileSync(join(abs(project, ref.analysisDir), 'analysis.json'), 'utf8'));
  }
  return out;
}

async function runBuild(job: Job, act: Active) {
  let project = readProject(job.projectId)!;
  const version = ensureProjectVersion(project, job.versionId);
  const startedAll = performance.now();
  const refs = pickReferences(project);
  const refsTask = {
    ...(refs.front ? { front: { path: abs(project, refs.front.file), analysis: abs(project, refs.front.analysisDir!) } } : {}),
    ...(refs.back ? { back: { path: abs(project, refs.back.file), analysis: abs(project, refs.back.analysisDir!) } } : {}),
  };

  if (job.stages.some((s) => s.name === 'ingest')) {
    simpleStage(job, 'ingest', 'running');
    for (const r of project.references) if (!existsSync(abs(project, r.file))) throw new Error(`Reference ${r.filename} is missing from storage.`);
    const used = project.references.filter((r) => r.usage === 'used-by-pipeline').length;
    simpleStage(job, 'ingest', 'done', `${project.references.length} files, ${used} usable by the pipeline`);
    simpleStage(job, 'analyze', 'done', refs.front || refs.back ? 'Measured when uploaded' : 'No usable image supplied');
    simpleStage(job, 'infer', 'running');
    const inferred = inferParams(project, loadAnalyses(project));
    updateVersion(project.id, version.id, (v) => {
      v.params = inferred.params;
      v.notes = inferred.notes;
      v.warnings = inferred.warnings;
      v.provider = inferred.provider;
    });
    simpleStage(job, 'infer', 'done', inferred.provider.fallbackReason ?? 'Silhouette fit. Local baseline, not AI reconstruction.');
    project = readProject(job.projectId)!;
  }
  const v = ensureProjectVersion(project, job.versionId);
  const base = { params: v.params, quality: v.quality, avatar: v.avatar, seed: v.seed, pins: v.pins, label: v.label, extras: { provider: v.provider.id, source: v.source, version: v.n, seed: v.seed } };

  const coarseKey = hashOf({ a: appearanceKey(v.params), p: physicsKey(v.params), av: v.avatar, s: v.seed, pins: v.pins, l: v.label, ve: v.n });
  const coarse = await runCached(job, act, project, 'coarse', coarseKey, base);
  updateVersion(project.id, v.id, (x) => {
    x.artifacts.draft = rel(project, join(coarse.dir, 'draft.glb'));
    x.artifacts.draftScene = rel(project, join(coarse.dir, 'scene.json'));
    if (x.tier === 'none') x.tier = 'draft';
    x.metrics.timeToFirstMeshMs = Math.round(performance.now() - startedAll);
  });
  emit({ type: 'artifact', projectId: project.id, versionId: v.id, artifact: 'draft' });

  const texKey = hashOf({ a: appearanceKey(v.params), q: v.quality, r: refsHash(project) });
  const texture = await runCached(job, act, project, 'texture', texKey, { ...base, references: refsTask });

  const drapeKey = hashOf({ p: physicsKey(v.params), q: v.quality, av: v.avatar, s: v.seed, pins: v.pins });
  const drape = await runCached(job, act, project, 'drape', drapeKey, base);

  const parent = v.parentId ? project.versions.find((x) => x.id === v.parentId) : null;
  const refinedKey = hashOf({ d: drapeKey, t: texKey, g: appearanceKey(v.params), l: v.label, pa: parent?.artifacts.drapeDir ?? null, ve: v.n });
  const refined = await runCached(job, act, project, 'refined', refinedKey, {
    ...base, drapeDir: drape.dir, textureDir: texture.dir,
    ...(parent?.artifacts.drapeDir ? { parentDrapeDir: abs(project, parent.artifacts.drapeDir), parentParams: parent.params } : {}),
  });
  updateVersion(project.id, v.id, (x) => {
    x.artifacts.model = rel(project, join(refined.dir, 'model.glb'));
    x.artifacts.scene = rel(project, join(refined.dir, 'scene.json'));
    x.artifacts.heat = rel(project, join(refined.dir, 'heat.bin'));
    x.artifacts.drapeDir = rel(project, drape.dir);
    x.artifacts.textureDir = rel(project, texture.dir);
    x.tier = 'refined';
    x.metrics.timeToRefinedMs = Math.round(performance.now() - startedAll);
    const shiftFile = join(refined.dir, 'shift.json');
    if (x.editCheck && existsSync(shiftFile)) x.editCheck.drapedShiftMm = JSON.parse(readFileSync(shiftFile, 'utf8'));
  });
  emit({ type: 'artifact', projectId: project.id, versionId: v.id, artifact: 'model' });

  let motionDir: string | undefined;
  const clip = job.options.clip as ClipId | null;
  if (clip) {
    const motion = await runCached(job, act, project, 'motion', hashOf({ d: drapeKey, c: clip }), { ...base, drapeDir: drape.dir, clip });
    motionDir = motion.dir;
    updateVersion(project.id, v.id, (x) => {
      x.artifacts.motion = { ...x.artifacts.motion, [clip]: rel(project, motion.dir) };
    });
    emit({ type: 'artifact', projectId: project.id, versionId: v.id, artifact: 'motion', clip });
  } else {
    simpleStage(job, 'motion', 'skipped', 'No motion selected');
  }

  const qa = await runCached(job, act, project, 'qa', hashOf({ d: drapeKey, m: clip ?? null, ...{ g: appearanceKey(v.params) } }), { ...base, drapeDir: drape.dir, ...(motionDir ? { motionDir } : {}) });
  const qaPath = join(qa.dir, 'qa.json');
  const qaData = JSON.parse(readFileSync(qaPath, 'utf8'));
  updateVersion(project.id, v.id, (x) => {
    x.artifacts.qa = rel(project, qaPath);
    x.qaSummary = qaData.summary;
    x.status = 'ready';
    x.metrics.totalMs = Math.round(performance.now() - startedAll);
  });
}

async function runMotionJob(job: Job, act: Active) {
  const project = readProject(job.projectId)!;
  const v = ensureProjectVersion(project, job.versionId);
  const clip = job.options.clip as ClipId;
  if (!v.artifacts.drapeDir) throw new Error('This version has no draped result yet.');
  const base = { params: v.params, quality: v.quality, avatar: v.avatar, seed: v.seed, pins: v.pins, label: v.label };
  const drapeDir = abs(project, v.artifacts.drapeDir);
  const motion = await runCached(job, act, project, 'motion', hashOf({ d: drapeKeyOf(v), c: clip }), { ...base, drapeDir, clip });
  updateVersion(project.id, v.id, (x) => {
    x.artifacts.motion = { ...x.artifacts.motion, [clip]: rel(project, motion.dir) };
  });
  emit({ type: 'artifact', projectId: project.id, versionId: v.id, artifact: 'motion', clip });
  const qa = await runCached(job, act, project, 'qa', hashOf({ d: drapeKeyOf(v), m: clip, g: appearanceKey(v.params) }), { ...base, drapeDir, motionDir: motion.dir });
  const qaPath = join(qa.dir, 'qa.json');
  updateVersion(project.id, v.id, (x) => {
    x.artifacts.qa = rel(project, qaPath);
    x.qaSummary = JSON.parse(readFileSync(qaPath, 'utf8')).summary;
  });
}

const drapeKeyOf = (v: Version) => hashOf({ p: physicsKey(v.params), q: v.quality, av: v.avatar, s: v.seed, pins: v.pins });

async function runExport(job: Job, act: Active) {
  const project = readProject(job.projectId)!;
  const v = ensureProjectVersion(project, job.versionId);
  const format = job.options.format as ExportRecord['format'];
  const clip = (job.options.clip ?? null) as ClipId | null;
  if (!v.artifacts.drapeDir || !v.artifacts.textureDir) throw new Error('Finish the refined asset before exporting.');
  const base = { params: v.params, quality: v.quality, avatar: v.avatar, seed: v.seed, pins: v.pins, label: v.label, extras: { provider: v.provider.id, source: v.source, version: v.n, seed: v.seed, exported: new Date().toISOString().slice(0, 10) } };
  const drapeDir = abs(project, v.artifacts.drapeDir);
  const textureDir = abs(project, v.artifacts.textureDir);
  let motionDir: string | undefined;
  if (clip) {
    if (!v.artifacts.motion?.[clip]) throw new Error(`Bake the ${clip} motion before exporting it.`);
    motionDir = abs(project, v.artifacts.motion[clip]);
  }
  const key = hashOf({ d: drapeKeyOf(v), t: v.artifacts.textureDir, clip, ve: v.n, l: v.label });
  const parts = g_parts(v.params);
  const meta = motionDir ? JSON.parse(readFileSync(join(motionDir, 'meta.json'), 'utf8')) : null;
  const exp: GlbExpectation = { parts, clip, frames: meta?.frames ?? null, avatar: true };
  const outRoot = join(projectDir(project.id), 'exports', v.id, `${format}${clip ? `-${clip}` : ''}-${key}`);
  mkdirSync(outRoot, { recursive: true });

  let report;
  if (format === 'glb' || format === 'blend') {
    const w = await runCached(job, act, project, 'write', hashOf({ k: key, f: 'glb' }), { ...base, drapeDir, textureDir, ...(motionDir ? { motionDir } : {}) }, 'export-glb');
    const glb = join(w.dir, 'hoodie.glb');
    simpleStage(job, 'validate', 'running');
    if (format === 'glb') {
      copyFileSync(glb, join(outRoot, 'hoodie.glb'));
      report = await validateGlb(join(outRoot, 'hoodie.glb'), exp);
    } else {
      report = await exportBlend(glb, outRoot, exp);
    }
  } else {
    const w = await runCached(job, act, project, 'write', hashOf({ k: key, f: 'obj' }), { ...base, drapeDir, textureDir }, 'export-obj');
    for (const f of ['hoodie.obj', 'hoodie.mtl', 'hoodie_basecolor.jpg']) copyFileSync(join(w.dir, f), join(outRoot, f));
    simpleStage(job, 'validate', 'running');
    report = validateObj(join(outRoot, 'hoodie.obj'), parts);
    report = await validateObjInBlender(report, join(outRoot, 'hoodie.obj'));
  }
  writeReport(outRoot, report);
  const files = readdirSync(outRoot)
    .filter((f) => !f.endsWith('.blender-report.json') && f !== 'write-report.json' && f !== 'report.json' && !f.endsWith('.blend1'))
    .map((name) => ({ name, bytes: statSync(join(outRoot, name)).size }));
  const rec: ExportRecord = {
    id: newId('exp'), format, clip, status: report.status, dir: rel(project, outRoot), files, report: rel(project, join(outRoot, 'report.json')), createdAt: new Date().toISOString(),
    message: report.status === 'blocked' ? 'Blender is not installed, so no .blend was created.' : report.status === 'failed' ? 'Validation failed. See the report.' : undefined,
  };
  updateVersion(project.id, v.id, (x) => {
    x.exports = [rec, ...x.exports.filter((e) => !(e.format === format && e.clip === clip))];
    if (report.status === 'passed' && !x.validatedFormats.includes(format)) x.validatedFormats.push(format);
    if (x.validatedFormats.length && (x.qaSummary?.fail ?? 1) === 0) x.tier = 'validated';
  });
  simpleStage(job, 'validate', report.status === 'passed' ? 'done' : report.status === 'blocked' ? 'skipped' : 'failed', report.status === 'blocked' ? 'Blender is not installed' : `${report.validators.filter((x) => x.passed).length} of ${report.validators.length} validators passed`, report.durationMs);
  if (report.status === 'failed') throw new Error(`${format.toUpperCase()} validation failed. The report has the details.`);
}

function g_parts(params: HoodieParams) {
  return buildGarment(params, 'preview', buildSkeleton('regular')).parts.map((p) => p.id as string);
}

async function pump() {
  if (active || !queue.length) return;
  const job = queue.shift()!;
  const act: Active = { job, child: null, cancel: false };
  active = act;
  job.status = 'running';
  job.error = undefined;
  persist(job);
  try {
    if (job.kind === 'generate' || job.kind === 'edit') await runBuild(job, act);
    else if (job.kind === 'motion') await runMotionJob(job, act);
    else await runExport(job, act);
    job.status = 'completed';
  } catch (e) {
    const cancelled = e instanceof Cancelled || act.cancel;
    job.status = cancelled ? 'cancelled' : 'failed';
    job.error = cancelled ? undefined : e instanceof Error ? e.message : String(e);
    for (const s of job.stages) {
      if (s.status === 'running') {
        s.status = cancelled ? 'cancelled' : 'failed';
        s.finishedAt = Date.now();
      }
    }
    if (job.kind === 'generate' || job.kind === 'edit') {
      try {
        updateVersion(job.projectId, job.versionId, (x) => {
          if (x.tier === 'none' || x.status === 'building') x.status = 'failed';
        });
      } catch {
        // The project may have been deleted while this ran.
      }
    }
  }
  job.progress = undefined;
  try {
    persist(job);
  } catch {
    // Project deleted during the job.
  }
  active = null;
  void pump();
}

export function enqueue(project: Project, versionId: string, kind: Job['kind'], options: Record<string, unknown>) {
  const stageNames =
    kind === 'generate' ? ['ingest', 'analyze', 'infer', 'coarse', 'texture', 'drape', 'refined', 'motion', 'qa']
    : kind === 'edit' ? ['coarse', 'texture', 'drape', 'refined', 'motion', 'qa']
    : kind === 'motion' ? ['motion', 'qa']
    : ['write', 'validate'];
  const now = new Date().toISOString();
  const job: Job = { id: newId('job'), projectId: project.id, versionId, kind, status: 'queued', stages: initStages(stageNames), options, createdAt: now, updatedAt: now };
  saveJob(job);
  queue.push(job);
  emit({ type: 'job', job });
  // Deferred so the caller can save the version that this job reads.
  setTimeout(() => void pump(), 0);
  return job;
}

export function cancelJob(job: Job) {
  if (active?.job.id === job.id) {
    active.cancel = true;
    active.child?.kill('SIGKILL');
    return true;
  }
  const i = queue.findIndex((j) => j.id === job.id);
  if (i >= 0) {
    queue.splice(i, 1);
    job.status = 'cancelled';
    persist(job);
    return true;
  }
  return false;
}

/** Retry or resume. Stages already finished are cached by content, so only unfinished work runs. */
export function retryJob(job: Job) {
  for (const s of job.stages) {
    s.status = 'pending';
    s.detail = undefined;
    s.ms = undefined;
  }
  job.status = 'queued';
  job.error = undefined;
  saveJob(job);
  queue.push(job);
  emit({ type: 'job', job });
  void pump();
  return job;
}

/** Called at boot. Anything that was mid-flight when the server stopped is marked interrupted, never silently lost. */
export function recoverInterrupted() {
  for (const p of listProjects()) {
    for (const j of listJobs(p.id)) {
      if (j.status === 'running' || j.status === 'queued') {
        j.status = 'interrupted';
        for (const s of j.stages) if (s.status === 'running') s.status = 'pending';
        j.progress = undefined;
        saveJob(j);
      }
    }
  }
}

export const activeJobId = () => active?.job.id ?? null;
