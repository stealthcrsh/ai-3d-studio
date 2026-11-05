import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type { BodyShapeId, ClipId, HoodieParams, PinGroup, Quality } from '../core/params.ts';
import type { QaReport } from '../core/qa.ts';

export const ROOT = resolve(import.meta.dir, '../..');
export const DATA_DIR = resolve(process.env.STUDIO_DATA ?? join(ROOT, 'data'));
export const PROJECTS_DIR = join(DATA_DIR, 'projects');
mkdirSync(PROJECTS_DIR, { recursive: true });

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

export interface ExportRecord {
  id: string;
  format: 'glb' | 'obj' | 'blend';
  clip: ClipId | null;
  status: 'passed' | 'failed' | 'blocked';
  dir: string;
  files: { name: string; bytes: number }[];
  report: string;
  createdAt: string;
  message?: string;
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
  /** Measured real progress for the running stage, such as simulated frames. */
  progress?: { phase: string; frame: number; total: number };
}

export const projectDir = (id: string) => {
  if (!isSafeId(id)) throw new Error('Invalid project id');
  return join(PROJECTS_DIR, id);
};

function writeJsonAtomic(path: string, value: unknown) {
  const tmp = `${path}.tmp${process.pid}`;
  writeFileSync(tmp, JSON.stringify(value, null, 1));
  renameSync(tmp, path);
}

export function listProjects(): Project[] {
  const out: Project[] = [];
  for (const id of readdirSync(PROJECTS_DIR)) {
    const p = join(PROJECTS_DIR, id, 'project.json');
    if (isSafeId(id) && existsSync(p)) {
      try {
        out.push(JSON.parse(readFileSync(p, 'utf8')));
      } catch {
        // A damaged project should not take the library down.
      }
    }
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function readProject(id: string): Project | null {
  const p = join(projectDir(id), 'project.json');
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
}

export function saveProject(p: Project) {
  p.updatedAt = new Date().toISOString();
  writeJsonAtomic(join(projectDir(p.id), 'project.json'), p);
}

export function createProject(name: string): Project {
  const id = newId('prj');
  const now = new Date().toISOString();
  const p: Project = {
    id, name: name.trim().slice(0, 120) || 'Untitled hoodie', createdAt: now, updatedAt: now, description: '', measurements: {}, references: [],
    setup: { category: 'hoodie', quality: 'standard', avatar: 'regular', clip: 'walk', provider: 'silhouette-parametric', pins: [], seed: 1 },
    versions: [], currentVersionId: null,
  };
  for (const d of ['refs', 'cache', 'exports', 'jobs']) mkdirSync(join(projectDir(id), d), { recursive: true });
  saveProject(p);
  return p;
}

export function duplicateProject(id: string): Project | null {
  const src = readProject(id);
  if (!src) return null;
  const next = newId('prj');
  cpSync(projectDir(id), projectDir(next), { recursive: true, filter: (s) => !s.includes(`${sep}jobs${sep}`) });
  mkdirSync(join(projectDir(next), 'jobs'), { recursive: true });
  const copy: Project = { ...JSON.parse(readFileSync(join(projectDir(next), 'project.json'), 'utf8')), id: next, name: `${src.name} copy`, createdAt: new Date().toISOString() };
  for (const v of copy.versions) v.jobId = null;
  saveProject(copy);
  return copy;
}

export const deleteProject = (id: string) => rmSync(projectDir(id), { recursive: true, force: true });

export const saveJob = (j: Job) => {
  j.updatedAt = new Date().toISOString();
  writeJsonAtomic(join(projectDir(j.projectId), 'jobs', `${j.id}.json`), j);
};

export function listJobs(projectId: string): Job[] {
  const dir = join(projectDir(projectId), 'jobs');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as Job)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function readJob(projectId: string, jobId: string): Job | null {
  if (!isSafeId(jobId)) return null;
  const p = join(projectDir(projectId), 'jobs', `${jobId}.json`);
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
}

/** Resolve a request path inside a project, refusing anything that escapes it. */
export function safeProjectPath(projectId: string, rel: string): string | null {
  const base = projectDir(projectId);
  const target = resolve(base, rel);
  return target === base || !target.startsWith(base + sep) ? null : target;
}
