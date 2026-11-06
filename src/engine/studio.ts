import { BODY_SHAPES, buildSkeleton, CLIPS } from '../core/avatar.ts';
import { parseEdit, proposalFromPatch, restLocality, type EditProposal } from '../core/edits.ts';
import { DEFAULT_PARAMS, FABRICS, hashOf, PARAM_META, PART_LABEL, QUALITY, validateParams, type BodyShapeId, type ClipId, type HoodieParams, type PinGroup, type Quality } from '../core/params.ts';
import { checkImageHeader, isImageKind, MAX_PIXELS, sniff } from '../core/vision.ts';
import { JobEngine } from './jobs.ts';
import { readJson, type StageRunner, type Storage } from './platform.ts';
import { inferParams, PROVIDERS, type ReconstructionResult } from './providers.ts';
import { isSafeId, newId, projectDir, ProjectStore, type ExportFormat, type Job, type Project, type Reference, type ReferenceView, type Version } from './store.ts';

export const MAX_UPLOAD = 30 * 1024 * 1024;
export const MAX_REFS = 12;
const sk = buildSkeleton('regular');

export const CATALOG = {
  quality: QUALITY, fabrics: FABRICS, bodies: BODY_SHAPES, clips: CLIPS, params: PARAM_META, partLabels: PART_LABEL, defaults: DEFAULT_PARAMS,
  uploads: { maxBytes: MAX_UPLOAD, maxFiles: MAX_REFS, maxPixels: MAX_PIXELS },
};

export interface ProjectCard {
  id: string;
  name: string;
  updatedAt: string;
  references: number;
  cover: string | null;
  versions: number;
  tier: string;
  label: string | null;
  lastJob: { id: string; status: string; kind: string } | null;
}

export type ProjectFull = Project & { jobs: Job[] };

async function digest(bytes: Uint8Array) {
  const d = await crypto.subtle.digest('SHA-256', bytes.slice().buffer);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function classifyReference(kind: string, filename: string, project: Project): { view: ReferenceView; usage: Reference['usage'] } {
  const name = filename.toLowerCase();
  if (isImageKind(kind)) {
    const taken = new Set(project.references.map((r) => r.view));
    let view: ReferenceView = /back|rear/.test(name) ? 'back' : /front/.test(name) ? 'front' : /side/.test(name) ? 'side' : !taken.has('front') ? 'front' : !taken.has('back') ? 'back' : 'other';
    if (taken.has(view) && (view === 'front' || view === 'back')) view = 'other';
    return { view, usage: view === 'front' || view === 'back' ? 'used-by-pipeline' : 'stored-not-used' };
  }
  if (kind === 'mp4') return { view: 'video', usage: 'stored-not-used' };
  if (kind === 'pdf') return { view: 'blueprint', usage: 'stored-not-used' };
  if (kind === 'glb' || kind === 'obj') return { view: 'model', usage: 'stored-not-used' };
  if (kind === 'text') return { view: 'text', usage: 'stored-not-used' };
  return { view: 'other', usage: 'stored-not-used' };
}

/** The application surface. The UI calls this directly; everything runs on the user's own device. */
export class Studio {
  store: ProjectStore;
  jobs: JobEngine;

  constructor(public storage: Storage, runner: StageRunner) {
    this.store = new ProjectStore(storage);
    this.jobs = new JobEngine(this.store, runner);
  }

  start = () => this.jobs.recoverInterrupted();

  async list(): Promise<ProjectCard[]> {
    const cards: ProjectCard[] = [];
    for (const p of await this.store.list()) {
      const last = (await this.store.listJobs(p.id))[0];
      cards.push({
        id: p.id, name: p.name, updatedAt: p.updatedAt, references: p.references.length,
        cover: p.references.find((r) => isImageKind(r.kind))?.file ?? null,
        versions: p.versions.length, tier: p.versions.find((v) => v.id === p.currentVersionId)?.tier ?? 'none',
        label: p.versions.length ? 'DEMO BASELINE' : null, lastJob: last ? { id: last.id, status: last.status, kind: last.kind } : null,
      });
    }
    return cards;
  }

  create = (name: string) => this.store.create(name);

  async get(id: string): Promise<ProjectFull> {
    if (!isSafeId(id)) throw new Error('Invalid project id');
    const p = await this.store.read(id);
    if (!p) throw new Error('Project not found');
    return { ...p, jobs: (await this.store.listJobs(id)).slice(0, 30) };
  }

  patch(id: string, b: { name?: string; description?: string; measurements?: Record<string, unknown>; setup?: Partial<Project['setup']> }) {
    return this.store.mutate(id, (project) => {
      if (typeof b.name === 'string') project.name = b.name.trim().slice(0, 120) || project.name;
      if (typeof b.description === 'string') project.description = b.description.slice(0, 4000);
      if (b.measurements) {
        const m: Project['measurements'] = {};
        for (const k of ['bodyWidth', 'bodyLength', 'sleeveLength', 'shoulderWidth'] as const) {
          const raw = b.measurements[k];
          const v = Number(raw);
          if (raw != null && raw !== '' && Number.isFinite(v) && v > 0) {
            const meta = PARAM_META[k];
            if (v < meta.min || v > meta.max) throw new Error(`${meta.label} must be between ${Math.round(meta.min * 100)} and ${Math.round(meta.max * 100)} cm`);
            m[k] = v;
          }
        }
        project.measurements = m;
      }
      const s = b.setup;
      if (s) {
        if (s.quality && QUALITY[s.quality as Quality]) project.setup.quality = s.quality;
        if (s.avatar && BODY_SHAPES[s.avatar as BodyShapeId]) project.setup.avatar = s.avatar;
        if (s.clip === null || (s.clip && CLIPS[s.clip as ClipId])) project.setup.clip = s.clip;
        if (s.provider && PROVIDERS.some((p) => p.id === s.provider)) project.setup.provider = s.provider;
        if (Array.isArray(s.pins)) project.setup.pins = s.pins.filter((x) => ['collar', 'cuffs', 'hem'].includes(x));
        if (Number.isInteger(s.seed)) project.setup.seed = s.seed!;
      }
      return project;
    });
  }

  remove = (id: string) => this.store.remove(id);
  duplicate = (id: string) => this.store.duplicate(id);

  /** Each file is checked by its bytes, then decoded in a Worker so a hostile image cannot take down the page. */
  async upload(id: string, files: { name: string; bytes: Uint8Array }[]) {
    const added: Reference[] = [];
    const errors: string[] = [];
    for (const file of files) {
      try {
        added.push(await this.addReference(id, file));
      } catch (e) {
        errors.push(e instanceof Error ? e.message : String(e));
      }
    }
    return { added, errors, project: await this.get(id) };
  }

  private async addReference(id: string, file: { name: string; bytes: Uint8Array }) {
    const { name, bytes } = file;
    if (bytes.length > MAX_UPLOAD) throw new Error(`${name} is ${(bytes.length / 1e6).toFixed(0)} MB. The limit is 30 MB per file.`);
    if (bytes.length === 0) throw new Error(`${name} is empty.`);
    const project = (await this.store.read(id))!;
    if (project.references.length >= MAX_REFS) throw new Error(`A project can hold ${MAX_REFS} reference files.`);
    const kind = sniff(bytes, name);
    if (kind === 'unknown' || kind === 'gif') throw new Error(`${name} is not a supported file. Use PNG, JPEG or WebP for images. HEIC and GIF are not accepted yet.`);
    if (isImageKind(kind)) {
      try {
        checkImageHeader(bytes, kind);
      } catch (e) {
        throw new Error(`${name}: ${(e as Error).message}`);
      }
    }
    const refId = newId('ref');
    const hash = await digest(bytes);
    const stored = `refs/${refId}.${kind === 'jpeg' ? 'jpg' : kind}`;
    const root = projectDir(id);
    await this.storage.writeMany([[`${root}/${stored}`, bytes]]);
    const ref: Reference = { id: refId, filename: name.replace(/[^\w.\- ()]/g, '_').slice(0, 120), kind, view: 'other', sha256: hash, bytes: bytes.length, file: stored, usage: 'stored-not-used', addedAt: new Date().toISOString() };
    if (isImageKind(kind)) {
      const dirRel = `cache/analyze-${hash.slice(0, 16)}`;
      try {
        if (!(await this.storage.exists(`${root}/${dirRel}/done.json`))) {
          await this.jobs.runTask({ stage: 'analyze', outDir: `${root}/${dirRel}`, params: DEFAULT_PARAMS, quality: 'preview', avatar: 'regular', seed: 1, pins: [], label: 'DEMO BASELINE', referencePath: `${root}/${stored}` }, () => undefined, undefined, 60000);
        }
      } catch (e) {
        await this.storage.removePrefix(`${root}/${stored}`);
        throw new Error(`${name} could not be read as an image. ${e instanceof Error ? e.message : ''}`.trim());
      }
      ref.analysisDir = dirRel;
      const a = (await readJson<Record<string, unknown>>(this.storage, `${root}/${dirRel}/analysis.json`))!;
      const { confidence, ok, warnings, medianColor, hoodDetected, torso, bbox, ratios, backgroundUniformity, maskCoverage } = a;
      ref.analysis = { confidence, ok, warnings, medianColor, hoodDetected, torso, bbox, ratios, backgroundUniformity, maskCoverage, maskUrl: `${dirRel}/mask.png` };
    }
    return this.store.mutate(id, (p) => {
      const { view, usage } = classifyReference(kind, name, p);
      ref.view = view;
      ref.usage = usage;
      p.references.push(ref);
      return ref;
    });
  }

  setView(id: string, rid: string, view: ReferenceView) {
    return this.store.mutate(id, (project) => {
      const ref = project.references.find((r) => r.id === rid);
      if (!ref) throw new Error('Reference not found');
      if (ref.kind !== 'png' && ref.kind !== 'jpeg') throw new Error('Only images can be given a camera view.');
      for (const r of project.references) {
        if (r.id !== ref.id && r.view === view && (view === 'front' || view === 'back')) {
          r.view = 'other';
          r.usage = 'stored-not-used';
        }
      }
      ref.view = view;
      ref.usage = view === 'front' || view === 'back' ? 'used-by-pipeline' : 'stored-not-used';
      return project;
    });
  }

  async removeRef(id: string, rid: string) {
    const ref = (await this.store.read(id))?.references.find((r) => r.id === rid);
    if (!ref) throw new Error('Reference not found');
    await this.storage.removePrefix(`${projectDir(id)}/${ref.file}`);
    return this.store.mutate(id, (p) => {
      p.references = p.references.filter((r) => r.id !== rid);
      return p;
    });
  }

  async infer(id: string): Promise<ReconstructionResult> {
    const p = (await this.store.read(id))!;
    return inferParams(p, await this.jobs.loadAnalyses(p));
  }

  private addVersion(project: Project, partial: Partial<Version> & Pick<Version, 'source' | 'summary' | 'params'>): Version {
    const n = project.versions.reduce((m, v) => Math.max(m, v.n), 0) + 1;
    const v: Version = {
      id: newId('ver'), n, parentId: project.currentVersionId, createdAt: new Date().toISOString(), notes: {}, warnings: [], label: 'DEMO BASELINE',
      provider: { id: 'silhouette-parametric', kind: 'baseline', requested: project.setup.provider }, quality: project.setup.quality, avatar: project.setup.avatar,
      seed: project.setup.seed, pins: project.setup.pins, tier: 'none', status: 'building', jobId: null, artifacts: {}, validatedFormats: [], exports: [], metrics: {},
      ...partial,
    };
    project.versions.push(v);
    project.currentVersionId = v.id;
    return v;
  }

  /** Create a version and its job together, then start the job once both are saved. */
  private async startBuild(id: string, kind: Job['kind'], make: (p: Project) => Version) {
    if (this.jobs.activeJobId) {
      const active = await this.store.readJob(id, this.jobs.activeJobId);
      if (active) throw new Error('A job is already running for this project.');
    }
    const result = await this.store.mutate(id, async (project) => {
      const version = make(project);
      const job = await this.jobs.enqueue(project, version.id, kind, { clip: project.setup.clip });
      version.jobId = job.id;
      return { version, job };
    });
    this.jobs.kick();
    return result;
  }

  generate(id: string) {
    return this.startBuild(id, 'generate', (project) => this.addVersion(project, { source: 'generate', summary: project.references.length ? 'Generated from references' : 'Generated from template', params: DEFAULT_PARAMS }));
  }

  async previewEdit(id: string, b: { text?: string; patch?: Partial<HoodieParams>; summary?: string }): Promise<EditProposal> {
    const p = (await this.store.read(id))!;
    const current = p.versions.find((v) => v.id === p.currentVersionId);
    if (!current) throw new Error('Generate the garment before editing it.');
    return typeof b.text === 'string' ? parseEdit(b.text.slice(0, 500), current.params) : proposalFromPatch(current.params, b.patch ?? {}, b.summary ?? 'Manual change');
  }

  applyEdit(id: string, b: { patch: Partial<HoodieParams>; source: 'chat' | 'manual'; summary: string }) {
    return this.startBuild(id, 'edit', (project) => {
      const current = project.versions.find((v) => v.id === project.currentVersionId);
      if (!current) throw new Error('Generate the garment before editing it.');
      const allowed = new Set(Object.keys(DEFAULT_PARAMS));
      const patch = Object.fromEntries(Object.entries(b.patch).filter(([k]) => allowed.has(k))) as Partial<HoodieParams>;
      const next: HoodieParams = { ...current.params, ...patch };
      const issues = validateParams(next);
      if (issues.length) throw new Error(issues.join(' '));
      const check = restLocality(current.params, next, sk);
      if (!check.passed) throw new Error(`This edit changed parts it should not have touched: ${check.unexpected.map((p) => PART_LABEL[p]).join(', ')}. It was not applied.`);
      const notes = { ...current.notes };
      for (const k of Object.keys(patch)) notes[k] = { source: 'edited', note: b.source === 'chat' ? 'Changed through the edit command.' : 'Changed with a manual control.' };
      return this.addVersion(project, {
        source: b.source, summary: String(b.summary).slice(0, 300), params: next, notes, warnings: current.warnings.filter((w) => !/agree|disagree/.test(w)),
        avatar: current.avatar, quality: current.quality, seed: current.seed, pins: current.pins, provider: current.provider,
        editCheck: { perPart: check.perPart, unexpected: check.unexpected, passed: check.passed },
      });
    });
  }

  /** Restoring is a pointer change. History is kept, so restoring can itself be undone. */
  restore(id: string, vid: string) {
    return this.store.mutate(id, (p) => {
      if (!p.versions.some((v) => v.id === vid)) throw new Error('Version not found');
      p.currentVersionId = vid;
      return p;
    });
  }

  approve(id: string, vid: string, on: boolean) {
    return this.store.mutate(id, (p) => {
      const v = p.versions.find((x) => x.id === vid);
      if (!v) throw new Error('Version not found');
      if (on) v.approved = { at: new Date().toISOString() };
      else delete v.approved;
      return p;
    });
  }

  regenerate(id: string, vid: string, b: { quality?: Quality; reseed?: boolean; avatar?: BodyShapeId; pins?: PinGroup[] }) {
    return this.startBuild(id, 'edit', (project) => {
      const v = project.versions.find((x) => x.id === vid);
      if (!v) throw new Error('Version not found');
      const quality = b.quality && QUALITY[b.quality] ? b.quality : v.quality;
      const seed = b.reseed ? v.seed + 1 : v.seed;
      const avatar = b.avatar && BODY_SHAPES[b.avatar] ? b.avatar : v.avatar;
      const pins = Array.isArray(b.pins) ? b.pins.filter((x) => ['collar', 'cuffs', 'hem'].includes(x)) : v.pins;
      const changes = [quality !== v.quality && `quality ${QUALITY[quality].label}`, seed !== v.seed && `new drape seed ${seed}`, avatar !== v.avatar && `avatar ${BODY_SHAPES[avatar].label}`, hashOf(pins) !== hashOf(v.pins) && `pins: ${pins.join(', ') || 'none'}`].filter(Boolean);
      if (!changes.length) throw new Error('Nothing would change. Pick a new quality, avatar, pins or drape seed.');
      project.setup.quality = quality;
      project.setup.avatar = avatar;
      project.setup.pins = pins;
      project.setup.seed = seed;
      return this.addVersion(project, { source: 'regenerate', summary: `Regenerated with ${changes.join(', ')}`, params: v.params, notes: v.notes, warnings: v.warnings, quality, seed, avatar, pins, provider: v.provider });
    });
  }

  async bakeMotion(id: string, vid: string, clip: ClipId) {
    const p = (await this.store.read(id))!;
    const v = p.versions.find((x) => x.id === vid);
    if (!v) throw new Error('Version not found');
    if (!CLIPS[clip]) throw new Error('Unknown motion.');
    if (v.artifacts.motion?.[clip]) return { alreadyBaked: true as const };
    const job = await this.jobs.enqueue(p, v.id, 'motion', { clip });
    this.jobs.kick();
    return { job };
  }

  async exportAsset(id: string, vid: string, format: ExportFormat, clip: ClipId | null) {
    const p = (await this.store.read(id))!;
    const v = p.versions.find((x) => x.id === vid);
    if (!v) throw new Error('Version not found');
    if (!['glb', 'obj', 'blender'].includes(format)) throw new Error('Unknown format.');
    if (v.status !== 'ready') throw new Error('Wait for the refined asset before exporting.');
    if (clip && !CLIPS[clip]) throw new Error('Unknown motion.');
    if (clip && format === 'obj') throw new Error('OBJ cannot store animation. Export GLB for motion.');
    if (clip && !v.artifacts.motion?.[clip]) throw new Error('Bake that motion before exporting it.');
    const job = await this.jobs.enqueue(p, v.id, 'export', { format, clip });
    this.jobs.kick();
    return { job };
  }

  async cancelJob(id: string, jid: string) {
    const job = await this.store.readJob(id, jid);
    if (!job) throw new Error('Job not found');
    return this.jobs.cancel(job);
  }

  async retryJob(id: string, jid: string) {
    const job = await this.store.readJob(id, jid);
    if (!job) throw new Error('Job not found');
    if (job.status === 'running' || job.status === 'queued') throw new Error('The job is already active.');
    return this.jobs.retry(job);
  }

  readFile = (id: string, rel: string) => this.storage.read(`${projectDir(id)}/${rel}`);
}
