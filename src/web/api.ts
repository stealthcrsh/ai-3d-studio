import type { Job, Project, Reference, Version } from '../server/store.ts';
import type { EditProposal } from '../core/edits.ts';
import type { HoodieParams } from '../core/params.ts';
import type { ReconstructionResult } from '../server/providers.ts';

export type { Job, Project, Reference, Version, EditProposal, HoodieParams, ReconstructionResult };
export type ProjectFull = Project & { jobs: Job[] };

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

export interface Health {
  ok: boolean;
  blender: { path: string | null; version: string | null };
  providers: { id: string; label: string; kind: string; status: string; note: string }[];
  editInterpreter: { id: string; kind: string; note: string };
  catalog: {
    quality: Record<string, { label: string; ds: number; texture: number; substeps: number; selfCollide: boolean }>;
    fabrics: Record<string, { id: string; label: string; gsm: number; note: string }>;
    bodies: Record<string, { id: string; label: string }>;
    clips: Record<string, { label: string; duration: number; note: string }>;
    params: Record<string, { label: string; min: number; max: number; parts: string[] }>;
    partLabels: Record<string, string>;
    uploads: { maxBytes: number; maxFiles: number; maxPixels: number };
  };
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`/api${path}`, init);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError(data.error ?? `Request failed (${r.status})`, data);
  return data as T;
}

export class ApiError extends Error {
  constructor(message: string, public data: Record<string, unknown>) {
    super(message);
  }
}

const post = <T,>(path: string, body?: unknown) => call<T>(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });

export const api = {
  health: () => call<Health>('/health'),
  list: () => call<ProjectCard[]>('/projects'),
  create: (name: string) => post<Project>('/projects', { name }),
  get: (id: string) => call<ProjectFull>(`/projects/${id}`),
  patch: (id: string, body: Record<string, unknown>) => call<Project>(`/projects/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  remove: (id: string) => call(`/projects/${id}`, { method: 'DELETE' }),
  duplicate: (id: string) => post<Project>(`/projects/${id}/duplicate`),
  upload: (id: string, files: File[]) => {
    const f = new FormData();
    for (const file of files) f.append('files', file);
    return call<{ added: Reference[]; errors: string[]; project: Project }>(`/projects/${id}/references`, { method: 'POST', body: f });
  },
  setView: (id: string, rid: string, view: string) => call<Project>(`/projects/${id}/references/${rid}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ view }) }),
  removeRef: (id: string, rid: string) => call<Project>(`/projects/${id}/references/${rid}`, { method: 'DELETE' }),
  infer: (id: string) => call<ReconstructionResult>(`/projects/${id}/infer`),
  generate: (id: string) => post<{ version: Version; job: Job }>(`/projects/${id}/generate`),
  previewEdit: (id: string, body: { text?: string; patch?: Partial<HoodieParams>; summary?: string }) => post<EditProposal>(`/projects/${id}/edits/preview`, body),
  applyEdit: (id: string, body: { patch: Partial<HoodieParams>; source: 'chat' | 'manual'; summary: string }) => post<{ version: Version; job: Job }>(`/projects/${id}/edits/apply`, body),
  restore: (id: string, vid: string) => post<Project>(`/projects/${id}/versions/${vid}/restore`),
  approve: (id: string, vid: string, on: boolean) => post<Project>(`/projects/${id}/versions/${vid}/${on ? 'approve' : 'unapprove'}`),
  regenerate: (id: string, vid: string, body: Record<string, unknown>) => post<{ version: Version; job: Job }>(`/projects/${id}/versions/${vid}/regenerate`, body),
  bakeMotion: (id: string, vid: string, clip: string) => post<{ job?: Job; alreadyBaked?: boolean }>(`/projects/${id}/versions/${vid}/motion`, { clip }),
  exportAsset: (id: string, vid: string, format: string, clip: string | null) => post<{ job: Job }>(`/projects/${id}/versions/${vid}/export`, { format, clip }),
  cancelJob: (id: string, jid: string) => post(`/projects/${id}/jobs/${jid}/cancel`),
  retryJob: (id: string, jid: string) => post<Job>(`/projects/${id}/jobs/${jid}/retry`),
};

export const fileUrl = (pid: string, rel: string) => `/files/${pid}/${rel.split('/').map(encodeURIComponent).join('/')}`;
export const cm = (m: number) => `${(m * 100).toFixed(1).replace(/\.0$/, '')} cm`;
export const bytes = (n: number) => (n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);
