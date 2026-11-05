import type { BodyShapeId, ClipId, HoodieParams, PinGroup, Quality } from '../core/params.ts';
import type { QaReport } from '../core/qa.ts';
import { readJson, textBytes, type Storage } from './platform.ts';

export const newId = (prefix: string) => `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
const SAFE_ID = /^[a-z]+_[a-z0-9]{4,32}$/;
export const isSafeId = (id: string) => SAFE_ID.test(id);

export type ReferenceView = 'front' | 'back' | 'side' | 'detail' | 'video' | 'blueprint' | 'model' | 'text' | 'other';

export interface Reference {
  id: string;
  filename: string;
  kind: string;
  view: ReferenceView;
  sha256: string;
  bytes: number;
  file: string;
  usage: 'used-by-pipeline' | 'stored-not-used';
  analysisDir?: string;
  analysis?: Record<string, unknown>;
  addedAt: string;
}

export interface Setup {
  category: 'hoodie';
  quality: Quality;
  avatar: BodyShapeId;
  clip: ClipId | null;
  provider: 'silhouette-parametric' | 'remote-ai';
  pins: PinGroup[];
  seed: number;
}

export interface ParamNote {
  source: 'measured' | 'inferred' | 'default' | 'edited';
  note: string;
  confidence?: number;
}

export type ExportFormat = 'glb' | 'obj' | 'blender';

export interface ExportRecord {
  id: string;
  format: ExportFormat;
  clip: ClipId | null;
  /** "unverified" means the file is valid but its target application has not opened it. */
  status: 'passed' | 'failed' | 'unverified';
  dir: string;
  files: { name: string; bytes: number }[];
  report: string;
  createdAt: string;
  message?: string;
}

export interface Version {
  id: string;
  n: number;
  parentId: string | null;
  createdAt: string;
  source: 'generate' | 'manual' | 'chat' | 'restore' | 'regenerate';
  summary: string;
  params: HoodieParams;
  notes: Record<string, ParamNote>;
  warnings: string[];
  label: 'DEMO BASELINE';
  provider: { id: string; kind: 'baseline'; requested: string; fallbackReason?: string };
  quality: Quality;
  avatar: BodyShapeId;
  seed: number;
  pins: PinGroup[];
  tier: 'none' | 'draft' | 'refined' | 'validated';
  status: 'building' | 'ready' | 'failed';
  jobId: string | null;
  artifacts: {
    draft?: string;
    draftScene?: string;
    model?: string;
    scene?: string;
    heat?: string;
    drapeDir?: string;
    textureDir?: string;
    qa?: string;
    motion?: Record<string, string>;
  };
  qaSummary?: QaReport['summary'];
  editCheck?: { perPart: unknown[]; unexpected: string[]; passed: boolean; drapedShiftMm?: Record<string, number | null> };
  validatedFormats: string[];
  exports: ExportRecord[];
  approved?: { at: string };
  metrics: Record<string, number>;
}

export interface Project {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  description: string;
  measurements: Partial<Record<'bodyWidth' | 'bodyLength' | 'sleeveLength' | 'shoulderWidth', number>>;
  references: Reference[];
  setup: Setup;
  versions: Version[];
  currentVersionId: string | null;
}

export type StageStatus = 'pending' | 'running' | 'done' | 'cached' | 'failed' | 'cancelled' | 'skipped';
export interface StageRecord {
  name: string;
  label: string;
  status: StageStatus;
  detail?: string;
  startedAt?: number;
  finishedAt?: number;
  ms?: number;
}

export interface Job {
  id: string;
  projectId: string;
  versionId: string;
  kind: 'generate' | 'edit' | 'motion' | 'export';
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  stages: StageRecord[];
  options: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  error?: string;
  /** Measured progress for the running stage, such as simulated frames. Never an estimate. */
  progress?: { phase: string; frame: number; total: number };
}

export const projectDir = (id: string) => {
  if (!isSafeId(id)) throw new Error('Invalid project id');
  return `projects/${id}`;
};

export class ProjectStore {
  /** Writes to one project run in order, so a job and a UI action cannot overwrite each other. */
  private locks = new Map<string, Promise<unknown>>();

  constructor(public storage: Storage) {}

  private serial<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(id) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.locks.set(id, next.catch(() => undefined));
    return next;
  }

  async list(): Promise<Project[]> {
    const paths = (await this.storage.list('projects/')).filter((p) => /^projects\/[^/]+\/project\.json$/.test(p));
    const out: Project[] = [];
    for (const p of paths) {
      try {
        const v = await readJson<Project>(this.storage, p);
        if (v) out.push(v);
      } catch {
        // One damaged project should not take the library down.
      }
    }
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  read(id: string) {
    return readJson<Project>(this.storage, `${projectDir(id)}/project.json`);
  }

  private async write(p: Project) {
    p.updatedAt = new Date().toISOString();
    await this.storage.writeMany([[`${projectDir(p.id)}/project.json`, textBytes(JSON.stringify(p))]]);
  }

  async create(name: string): Promise<Project> {
    const id = newId('prj');
    const now = new Date().toISOString();
    const p: Project = {
      id, name: name.trim().slice(0, 120) || 'Untitled hoodie', createdAt: now, updatedAt: now, description: '', measurements: {}, references: [],
      setup: { category: 'hoodie', quality: 'standard', avatar: 'regular', clip: 'walk', provider: 'silhouette-parametric', pins: [], seed: 1 },
      versions: [], currentVersionId: null,
    };
    await this.write(p);
    return p;
  }

  /** Read, change and save one project as a single step. */
  mutate<T>(id: string, fn: (p: Project) => T | Promise<T>): Promise<T> {
    return this.serial(id, async () => {
      const p = await this.read(id);
      if (!p) throw new Error('Project not found');
      const r = await fn(p);
      await this.write(p);
      return r;
    });
  }

  async duplicate(id: string): Promise<Project | null> {
    const src = await this.read(id);
    if (!src) return null;
    const next = newId('prj');
    const from = `${projectDir(id)}/`;
    const entries: [string, Uint8Array][] = [];
    for (const path of await this.storage.list(from)) {
      if (path.startsWith(`${from}jobs/`) || path === `${from}project.json`) continue;
      entries.push([`${projectDir(next)}/${path.slice(from.length)}`, (await this.storage.read(path))!]);
    }
    const copy: Project = JSON.parse(JSON.stringify(src));
    copy.id = next;
    copy.name = `${src.name} copy`;
    copy.createdAt = new Date().toISOString();
    for (const v of copy.versions) v.jobId = null;
    await this.storage.writeMany(entries);
    await this.write(copy);
    return copy;
  }

  remove(id: string) {
    return this.storage.removePrefix(`${projectDir(id)}/`);
  }

  async saveJob(j: Job) {
    j.updatedAt = new Date().toISOString();
    const { progress, ...rest } = j;
    void progress;
    await this.storage.writeMany([[`${projectDir(j.projectId)}/jobs/${j.id}.json`, textBytes(JSON.stringify(rest))]]);
  }

  async listJobs(projectId: string): Promise<Job[]> {
    const paths = await this.storage.list(`${projectDir(projectId)}/jobs/`);
    const out: Job[] = [];
    for (const p of paths) {
      const j = await readJson<Job>(this.storage, p);
      if (j) out.push(j);
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  readJob(projectId: string, jobId: string) {
    if (!isSafeId(jobId)) return Promise.resolve(null);
    return readJson<Job>(this.storage, `${projectDir(projectId)}/jobs/${jobId}.json`);
  }
}
