import { buildSkeleton } from '../core/avatar.ts';
import { buildGarment } from '../core/garment.ts';
import { appearanceKey, hashOf, physicsKey, type ClipId, type HoodieParams } from '../core/params.ts';
import type { ImageAnalysis } from '../core/vision.ts';
import { readJson, type StageHandle, type StageRunner, type Storage } from './platform.ts';
import { inferParams, pickReferences } from './providers.ts';
import type { StageTask } from './stages.ts';
import { newId, projectDir, type ExportRecord, type Job, type Project, type ProjectStore, type StageRecord, type Version } from './store.ts';
import type { FormatReport, GlbExpectation } from './validate.ts';

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
  validate: 'Validate the file',
};

interface Active {
  job: Job;
  handle: StageHandle | null;
  cancel: boolean;
}

const drapeKeyOf = (v: Version) => hashOf({ p: physicsKey(v.params), q: v.quality, av: v.avatar, s: v.seed, pins: v.pins });
const partNames = (params: HoodieParams) => buildGarment(params, 'preview', buildSkeleton('regular')).parts.map((p) => p.id as string);

export class JobEngine {
  private active: Active | null = null;
  private queue: Job[] = [];
  private listeners = new Set<(e: Record<string, unknown>) => void>();
  private storage: Storage;
  /** Stage time limit. Solver runs are bounded by frame count, so this only catches a stuck stage. */
  stageTimeoutMs = 15 * 60 * 1000;

  constructor(private store: ProjectStore, private runner: StageRunner) {
    this.storage = store.storage;
  }

  subscribe(l: (e: Record<string, unknown>) => void) {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  }

  private emit(e: Record<string, unknown>) {
    for (const l of this.listeners) l(e);
  }

  get activeJobId() {
    return this.active?.job.id ?? null;
  }

  private async persist(job: Job) {
    await this.store.saveJob(job);
    this.emit({ type: 'job', job });
  }

  /** Runs one stage to completion with a time limit. */
  runTask(task: StageTask, onProgress: (p: { phase: string; frame: number; total: number }) => void, register?: (h: StageHandle) => void, timeoutMs = this.stageTimeoutMs) {
    const h = this.runner.start(task, onProgress);
    register?.(h);
    return new Promise<void>((res, rej) => {
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        h.kill();
        rej(new Error(`The stage exceeded the ${Math.round(timeoutMs / 60000)} minute limit and was stopped.`));
      }, timeoutMs);
      h.done.then(
        () => {
          clearTimeout(timer);
          if (!timedOut) res();
        },
        (e) => {
          clearTimeout(timer);
          if (!timedOut) rej(e);
        },
      );
    });
  }

  private async updateVersion(projectId: string, versionId: string, fn: (v: Version, p: Project) => void) {
    const v = await this.store.mutate(projectId, (p) => {
      const x = p.versions.find((y) => y.id === versionId);
      if (!x) throw new Error('Version not found');
      fn(x, p);
      return x;
    });
    this.emit({ type: 'project', projectId, version: v });
    return v;
  }

  private async runCached(job: Job, act: Active, project: Project, stage: string, key: string, task: Omit<StageTask, 'stage' | 'outDir'>, workerStage: StageTask['stage'] = stage as StageTask['stage']) {
    const rec = job.stages.find((s) => s.name === stage)!;
    const dir = `${projectDir(project.id)}/cache/${workerStage}-${key}`;
    rec.startedAt = Date.now();
    const finished = await readJson<{ ms: number } & Record<string, unknown>>(this.storage, `${dir}/done.json`);
    if (finished) {
      rec.status = 'cached';
      rec.finishedAt = Date.now();
      rec.detail = 'Reused an identical earlier result';
      await this.persist(job);
      return { dir, cached: true, done: finished };
    }
    if (act.cancel) throw new Error('cancelled');
    rec.status = 'running';
    await this.persist(job);
    let last = 0;
    await this.runTask({ ...task, stage: workerStage, outDir: dir }, (m) => {
      job.progress = m;
      const now = Date.now();
      if (now - last > 120) {
        last = now;
        this.emit({ type: 'job', job });
      }
    }, (h) => (act.handle = h));
    act.handle = null;
    job.progress = undefined;
    const done = (await readJson<{ ms: number } & Record<string, unknown>>(this.storage, `${dir}/done.json`))!;
    rec.status = 'done';
    rec.finishedAt = Date.now();
    rec.ms = Math.round(done.ms);
    await this.persist(job);
    return { dir, cached: false, done };
  }

  private async simpleStage(job: Job, name: string, status: StageRecord['status'], detail?: string, ms?: number) {
    const rec = job.stages.find((s) => s.name === name)!;
    rec.status = status;
    if (detail) rec.detail = detail;
    if (ms !== undefined) rec.ms = ms;
    if (status === 'running') rec.startedAt = Date.now();
    else rec.finishedAt = Date.now();
    await this.persist(job);
  }

  async loadAnalyses(project: Project) {
    const r = pickReferences(project);
    const out: Partial<Record<'front' | 'back', ImageAnalysis>> = {};
    for (const view of ['front', 'back'] as const) {
      const ref = r[view];
      if (ref?.analysisDir) {
        const a = await readJson<ImageAnalysis>(this.storage, `${projectDir(project.id)}/${ref.analysisDir}/analysis.json`);
        if (a) out[view] = a;
      }
    }
    return out;
  }

  private async runBuild(job: Job, act: Active) {
    let project = (await this.store.read(job.projectId))!;
    const root = projectDir(project.id);
    const abs = (p: string) => `${root}/${p}`;
    const rel = (p: string) => p.slice(root.length + 1);
    const startedAll = performance.now();
    const refs = pickReferences(project);
    const refsTask = {
      ...(refs.front ? { front: { path: abs(refs.front.file), analysis: abs(refs.front.analysisDir!) } } : {}),
      ...(refs.back ? { back: { path: abs(refs.back.file), analysis: abs(refs.back.analysisDir!) } } : {}),
    };
    const refsHash = hashOf({ f: refs.front?.sha256, b: refs.back?.sha256 });

    if (job.stages.some((s) => s.name === 'ingest')) {
      await this.simpleStage(job, 'ingest', 'running');
      for (const r of project.references) if (!(await this.storage.exists(abs(r.file)))) throw new Error(`Reference ${r.filename} is missing from storage.`);
      const used = project.references.filter((r) => r.usage === 'used-by-pipeline').length;
      await this.simpleStage(job, 'ingest', 'done', `${project.references.length} files, ${used} usable by the pipeline`);
      await this.simpleStage(job, 'analyze', 'done', refs.front || refs.back ? 'Measured when added' : 'No usable image supplied');
      await this.simpleStage(job, 'infer', 'running');
      const inferred = inferParams(project, await this.loadAnalyses(project));
      await this.updateVersion(project.id, job.versionId, (v) => {
        v.params = inferred.params;
        v.notes = inferred.notes;
        v.warnings = inferred.warnings;
        v.provider = inferred.provider;
      });
      await this.simpleStage(job, 'infer', 'done', inferred.provider.fallbackReason ?? 'Silhouette fit. Local baseline, not AI reconstruction.');
      project = (await this.store.read(job.projectId))!;
    }
    const v = project.versions.find((x) => x.id === job.versionId)!;
    const base = { params: v.params, quality: v.quality, avatar: v.avatar, seed: v.seed, pins: v.pins, label: v.label, extras: { provider: v.provider.id, source: v.source, version: v.n, seed: v.seed } };

    const coarse = await this.runCached(job, act, project, 'coarse', hashOf({ a: appearanceKey(v.params), p: physicsKey(v.params), av: v.avatar, s: v.seed, pins: v.pins, l: v.label, ve: v.n }), base);
    await this.updateVersion(project.id, v.id, (x) => {
      x.artifacts.draft = rel(`${coarse.dir}/draft.glb`);
      x.artifacts.draftScene = rel(`${coarse.dir}/scene.json`);
      if (x.tier === 'none') x.tier = 'draft';
      x.metrics.timeToFirstMeshMs = Math.round(performance.now() - startedAll);
    });

    const texKey = hashOf({ a: appearanceKey(v.params), q: v.quality, r: refsHash });
    const texture = await this.runCached(job, act, project, 'texture', texKey, { ...base, references: refsTask });
    const drapeKey = drapeKeyOf(v);
    const drape = await this.runCached(job, act, project, 'drape', drapeKey, base);

    const parent = v.parentId ? project.versions.find((x) => x.id === v.parentId) : null;
    const refined = await this.runCached(job, act, project, 'refined', hashOf({ d: drapeKey, t: texKey, g: appearanceKey(v.params), l: v.label, pa: parent?.artifacts.drapeDir ?? null, ve: v.n }), {
      ...base, drapeDir: drape.dir, textureDir: texture.dir,
      ...(parent?.artifacts.drapeDir ? { parentDrapeDir: abs(parent.artifacts.drapeDir), parentParams: parent.params } : {}),
    });
    const shift = await readJson<Record<string, number | null>>(this.storage, `${refined.dir}/shift.json`);
    await this.updateVersion(project.id, v.id, (x) => {
      x.artifacts.model = rel(`${refined.dir}/model.glb`);
      x.artifacts.scene = rel(`${refined.dir}/scene.json`);
      x.artifacts.heat = rel(`${refined.dir}/heat.bin`);
      x.artifacts.drapeDir = rel(drape.dir);
      x.artifacts.textureDir = rel(texture.dir);
      x.tier = 'refined';
      x.metrics.timeToRefinedMs = Math.round(performance.now() - startedAll);
      if (x.editCheck && shift) x.editCheck.drapedShiftMm = shift;
    });

    let motionDir: string | undefined;
    const clip = job.options.clip as ClipId | null;
    if (clip) {
      const motion = await this.runCached(job, act, project, 'motion', hashOf({ d: drapeKey, c: clip }), { ...base, drapeDir: drape.dir, clip });
      motionDir = motion.dir;
      await this.updateVersion(project.id, v.id, (x) => {
        x.artifacts.motion = { ...x.artifacts.motion, [clip]: rel(motion.dir) };
      });
    } else {
      await this.simpleStage(job, 'motion', 'skipped', 'No motion selected');
    }

    const qa = await this.runCached(job, act, project, 'qa', hashOf({ d: drapeKey, m: clip ?? null, g: appearanceKey(v.params) }), { ...base, drapeDir: drape.dir, ...(motionDir ? { motionDir } : {}) });
    const qaData = (await readJson<{ summary: Version['qaSummary'] }>(this.storage, `${qa.dir}/qa.json`))!;
    await this.updateVersion(project.id, v.id, (x) => {
      x.artifacts.qa = rel(`${qa.dir}/qa.json`);
      x.qaSummary = qaData.summary;
      x.status = 'ready';
      x.metrics.totalMs = Math.round(performance.now() - startedAll);
    });
  }

  private async runMotionJob(job: Job, act: Active) {
    const project = (await this.store.read(job.projectId))!;
    const root = projectDir(project.id);
    const v = project.versions.find((x) => x.id === job.versionId)!;
    const clip = job.options.clip as ClipId;
    if (!v.artifacts.drapeDir) throw new Error('This version has no draped result yet.');
    const base = { params: v.params, quality: v.quality, avatar: v.avatar, seed: v.seed, pins: v.pins, label: v.label };
    const drapeDir = `${root}/${v.artifacts.drapeDir}`;
    const motion = await this.runCached(job, act, project, 'motion', hashOf({ d: drapeKeyOf(v), c: clip }), { ...base, drapeDir, clip });
    await this.updateVersion(project.id, v.id, (x) => {
      x.artifacts.motion = { ...x.artifacts.motion, [clip]: motion.dir.slice(root.length + 1) };
    });
    const qa = await this.runCached(job, act, project, 'qa', hashOf({ d: drapeKeyOf(v), m: clip, g: appearanceKey(v.params) }), { ...base, drapeDir, motionDir: motion.dir });
    const qaData = (await readJson<{ summary: Version['qaSummary'] }>(this.storage, `${qa.dir}/qa.json`))!;
    await this.updateVersion(project.id, v.id, (x) => {
      x.artifacts.qa = `${qa.dir.slice(root.length + 1)}/qa.json`;
      x.qaSummary = qaData.summary;
    });
  }

  private async runExport(job: Job, act: Active) {
    const project = (await this.store.read(job.projectId))!;
    const root = projectDir(project.id);
    const v = project.versions.find((x) => x.id === job.versionId)!;
    const format = job.options.format as ExportRecord['format'];
    const clip = (job.options.clip ?? null) as ClipId | null;
    if (!v.artifacts.drapeDir || !v.artifacts.textureDir) throw new Error('Finish the refined asset before exporting.');
    const base = { params: v.params, quality: v.quality, avatar: v.avatar, seed: v.seed, pins: v.pins, label: v.label, extras: { provider: v.provider.id, source: v.source, version: v.n, seed: v.seed } };
    const drapeDir = `${root}/${v.artifacts.drapeDir}`;
    const textureDir = `${root}/${v.artifacts.textureDir}`;
    let motionDir: string | undefined;
    if (clip) {
      if (!v.artifacts.motion?.[clip]) throw new Error(`Bake the ${clip} motion before exporting it.`);
      motionDir = `${root}/${v.artifacts.motion[clip]}`;
    }
    const key = hashOf({ d: drapeKeyOf(v), t: v.artifacts.textureDir, clip, ve: v.n, l: v.label, f: format });
    const meta = motionDir ? await readJson<{ frames: number }>(this.storage, `${motionDir}/meta.json`) : null;
    const expectation: GlbExpectation = { parts: partNames(v.params), clip, frames: meta?.frames ?? null, avatar: true };
    const workerStage: StageTask['stage'] = format === 'obj' ? 'export-obj' : format === 'blender' ? 'blender-kit' : 'export-glb';
    const write = await this.runCached(job, act, project, 'write', key, { ...base, drapeDir, textureDir, ...(motionDir ? { motionDir } : {}) }, workerStage);
    const validate = await this.runCached(job, act, project, 'validate', key, { ...base, sourceDir: write.dir, expectation }, format === 'obj' ? 'validate-obj' : 'validate-glb');
    const report = (await readJson<FormatReport>(this.storage, `${validate.dir}/report.json`))!;
    const names = (await this.storage.list(`${write.dir}/`)).map((p) => p.slice(write.dir.length + 1)).filter((n) => n !== 'done.json');
    const files = [];
    for (const name of names) files.push({ name, bytes: (await this.storage.read(`${write.dir}/${name}`))!.length });
    const rec: ExportRecord = {
      id: newId('exp'), format, clip, status: report.status, dir: write.dir.slice(root.length + 1), files, report: `${validate.dir.slice(root.length + 1)}/report.json`, createdAt: new Date().toISOString(),
      message: report.status === 'unverified' ? 'The GLB passed its checks. It has not been opened in Blender.' : report.status === 'failed' ? 'Validation failed. See the report.' : undefined,
    };
    await this.updateVersion(project.id, v.id, (x) => {
      x.exports = [rec, ...x.exports.filter((e) => !(e.format === format && e.clip === clip))];
      if (report.status === 'passed' && !x.validatedFormats.includes(format)) x.validatedFormats.push(format);
      if (x.validatedFormats.length && (x.qaSummary?.fail ?? 1) === 0) x.tier = 'validated';
    });
    const vRec = job.stages.find((s) => s.name === 'validate')!;
    const ran = report.validators.filter((x) => !x.notRun);
    vRec.detail = `${ran.filter((x) => x.passed).length} of ${ran.length} checks passed. Not opened in Blender.`;
    await this.persist(job);
    if (report.status === 'failed') throw new Error(`${format.toUpperCase()} validation failed. The report has the details.`);
  }

  private async pump() {
    if (this.active || !this.queue.length) return;
    const job = this.queue.shift()!;
    const act: Active = { job, handle: null, cancel: false };
    this.active = act;
    job.status = 'running';
    job.error = undefined;
    try {
      await this.persist(job);
      if (job.kind === 'generate' || job.kind === 'edit') await this.runBuild(job, act);
      else if (job.kind === 'motion') await this.runMotionJob(job, act);
      else await this.runExport(job, act);
      job.status = 'completed';
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const cancelled = act.cancel || message === 'cancelled';
      job.status = cancelled ? 'cancelled' : 'failed';
      job.error = cancelled ? undefined : message;
      for (const s of job.stages) {
        if (s.status === 'running') {
          s.status = cancelled ? 'cancelled' : 'failed';
          s.finishedAt = Date.now();
        }
      }
      if (job.kind === 'generate' || job.kind === 'edit') {
        try {
          await this.updateVersion(job.projectId, job.versionId, (x) => {
            if (x.status === 'building') x.status = 'failed';
          });
        } catch {
          // The project may have been deleted while this ran.
        }
      }
    }
    job.progress = undefined;
    try {
      await this.persist(job);
    } catch {
      // Project deleted during the job.
    }
    this.active = null;
    void this.pump();
  }

  async enqueue(project: Project, versionId: string, kind: Job['kind'], options: Record<string, unknown>) {
    const names =
      kind === 'generate' ? ['ingest', 'analyze', 'infer', 'coarse', 'texture', 'drape', 'refined', 'motion', 'qa']
      : kind === 'edit' ? ['coarse', 'texture', 'drape', 'refined', 'motion', 'qa']
      : kind === 'motion' ? ['motion', 'qa']
      : ['write', 'validate'];
    const now = new Date().toISOString();
    const job: Job = { id: newId('job'), projectId: project.id, versionId, kind, status: 'queued', stages: names.map((name) => ({ name, label: STAGE_LABEL[name] ?? name, status: 'pending' })), options, createdAt: now, updatedAt: now };
    await this.store.saveJob(job);
    this.queue.push(job);
    this.emit({ type: 'job', job });
    return job;
  }

  /** Starts queued work. Called after the caller has saved the version the job reads. */
  kick() {
    void this.pump();
  }

  async cancel(job: Job) {
    if (this.active?.job.id === job.id) {
      this.active.cancel = true;
      this.active.handle?.kill();
      return true;
    }
    const i = this.queue.findIndex((j) => j.id === job.id);
    if (i >= 0) {
      this.queue.splice(i, 1);
      job.status = 'cancelled';
      await this.persist(job);
      return true;
    }
    return false;
  }

  /** Retry or resume. Finished stages are cached by content, so only unfinished work runs. */
  async retry(job: Job) {
    for (const s of job.stages) {
      s.status = 'pending';
      s.detail = undefined;
      s.ms = undefined;
    }
    job.status = 'queued';
    job.error = undefined;
    await this.store.saveJob(job);
    this.queue.push(job);
    this.emit({ type: 'job', job });
    this.kick();
    return job;
  }

  /** Called at start. Anything mid-flight when the page closed is marked interrupted, never silently lost. */
  async recoverInterrupted() {
    for (const p of await this.store.list()) {
      for (const j of await this.store.listJobs(p.id)) {
        if (j.status === 'running' || j.status === 'queued') {
          j.status = 'interrupted';
          for (const s of j.stages) if (s.status === 'running') s.status = 'pending';
          await this.store.saveJob(j);
        }
      }
    }
  }
}
