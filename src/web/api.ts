import { useEffect, useState } from 'react';
import { CLIPS } from '../core/avatar.ts';
import { makeZip } from '../core/zip.ts';
import type { EditProposal } from '../core/edits.ts';
import type { HoodieParams } from '../core/params.ts';
import { bytesText } from '../engine/platform.ts';
import { PROVIDERS, type ReconstructionResult } from '../engine/providers.ts';
import type { ExportFormat, Job, Project, Reference, Version } from '../engine/store.ts';
import { CATALOG, Studio, type ProjectCard, type ProjectFull } from '../engine/studio.ts';
import { IndexedDbStorage, MemoryStorage, WorkerStageRunner } from './platform.ts';

export type { EditProposal, ExportFormat, HoodieParams, Job, Project, ProjectCard, ProjectFull, ReconstructionResult, Reference, Version };

export interface Health {
  storage: { kind: string; durable: boolean };
  webgl: boolean;
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

let studio: Studio;
let health: Health;

function hasWebgl() {
  try {
    return Boolean(document.createElement('canvas').getContext('webgl2'));
  } catch {
    return false;
  }
}

/** Opens local storage and recovers any job that was running when the page last closed. */
export async function bootStudio() {
  let storage: IndexedDbStorage | MemoryStorage;
  let runner: WorkerStageRunner;
  try {
    storage = await IndexedDbStorage.open();
    runner = new WorkerStageRunner(null);
    void navigator.storage?.persist?.().catch(() => false);
  } catch {
    storage = new MemoryStorage();
    runner = new WorkerStageRunner(storage);
  }
  studio = new Studio(storage, runner);
  await studio.start();
  (globalThis as unknown as { __studio: Studio }).__studio = studio;
  health = {
    storage: { kind: storage.kind, durable: storage.durable },
    webgl: hasWebgl(),
    providers: PROVIDERS.map(({ available, ...p }) => {
      void available;
      return p;
    }),
    editInterpreter: { id: 'rule-based-v1', kind: 'rules', note: 'Deterministic command parser. No language model is connected.' },
    catalog: CATALOG as unknown as Health['catalog'],
  };
  return health;
}

export const getHealth = () => health;
export const onStudioEvent = (l: (e: Record<string, unknown>) => void) => studio.jobs.subscribe(l);

export const api = {
  list: () => studio.list(),
  create: (name: string) => studio.create(name),
  get: (id: string) => studio.get(id),
  patch: (id: string, body: Parameters<Studio['patch']>[1]) => studio.patch(id, body),
  remove: (id: string) => studio.remove(id),
  duplicate: (id: string) => studio.duplicate(id),
  upload: async (id: string, files: File[]) => studio.upload(id, await Promise.all(files.map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })))),
  setView: (id: string, rid: string, view: string) => studio.setView(id, rid, view as never),
  removeRef: (id: string, rid: string) => studio.removeRef(id, rid),
  infer: (id: string) => studio.infer(id),
  generate: (id: string) => studio.generate(id),
  previewEdit: (id: string, body: Parameters<Studio['previewEdit']>[1]) => studio.previewEdit(id, body),
  applyEdit: (id: string, body: Parameters<Studio['applyEdit']>[1]) => studio.applyEdit(id, body),
  restore: (id: string, vid: string) => studio.restore(id, vid),
  approve: (id: string, vid: string, on: boolean) => studio.approve(id, vid, on),
  regenerate: (id: string, vid: string, body: Parameters<Studio['regenerate']>[2]) => studio.regenerate(id, vid, body),
  bakeMotion: (id: string, vid: string, clip: string) => studio.bakeMotion(id, vid, clip as keyof typeof CLIPS),
  exportAsset: (id: string, vid: string, format: ExportFormat, clip: string | null) => studio.exportAsset(id, vid, format, clip as never),
  cancelJob: (id: string, jid: string) => studio.cancelJob(id, jid),
  retryJob: (id: string, jid: string) => studio.retryJob(id, jid),
};

const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', glb: 'model/gltf-binary', json: 'application/json', txt: 'text/plain', py: 'text/plain', obj: 'text/plain', mtl: 'text/plain' };
const mimeOf = (name: string) => MIME[name.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream';

interface HostDownloads {
  save(req: { filename: string; data: Blob }): Promise<unknown>;
}

/** Inside a hosted viewer, saves go through its confirmed download prompt. On a plain website, a normal link. */
async function saveBytes(name: string, data: Uint8Array) {
  const blob = new Blob([data.slice()], { type: mimeOf(name) });
  const host = (globalThis as unknown as { claude?: { use(n: string): Promise<HostDownloads | null> } }).claude;
  const downloads = host ? await host.use('downloads') : null;
  if (downloads) {
    await downloads.save({ filename: name, data: blob });
    return;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

export const files = {
  bytes: async (pid: string, rel: string) => {
    const b = await studio.readFile(pid, rel);
    if (!b) throw new Error(`Missing file: ${rel}`);
    return b;
  },
  json: async <T,>(pid: string, rel: string) => JSON.parse(bytesText(await files.bytes(pid, rel))) as T,
  floats: async (pid: string, rel: string) => {
    const b = await files.bytes(pid, rel);
    return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
  },
  url: async (pid: string, rel: string) => URL.createObjectURL(new Blob([(await files.bytes(pid, rel)).slice()], { type: mimeOf(rel) })),
  download: async (pid: string, rel: string, name: string) => saveBytes(name, await files.bytes(pid, rel)),
  downloadZip: async (pid: string, dir: string, names: string[], zipName: string) => {
    const entries = await Promise.all(names.map(async (name) => ({ name, data: await files.bytes(pid, `${dir}/${name}`) })));
    await saveBytes(zipName, makeZip(entries));
  },
};

/** Temporary browser URL for a stored file, released when the component goes away. */
export function useFileUrl(pid: string, rel: string | null | undefined) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!rel) {
      setUrl(null);
      return;
    }
    let made: string | null = null;
    let stop = false;
    files.url(pid, rel).then((u) => {
      if (stop) URL.revokeObjectURL(u);
      else {
        made = u;
        setUrl(u);
      }
    }).catch(() => setUrl(null));
    return () => {
      stop = true;
      if (made) URL.revokeObjectURL(made);
    };
  }, [pid, rel]);
  return url;
}

export const cm = (m: number) => `${(m * 100).toFixed(1).replace(/\.0$/, '')} cm`;
export const bytes = (n: number) => (n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);
