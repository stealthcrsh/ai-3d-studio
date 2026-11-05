import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { BODY_SHAPES, buildSkeleton, CLIPS } from '../core/avatar.ts';
import { parseEdit, proposalFromPatch, restLocality } from '../core/edits.ts';
import { DEFAULT_PARAMS, FABRICS, hashOf, PARAM_META, PART_LABEL, QUALITY, validateParams, type BodyShapeId, type ClipId, type HoodieParams, type PinGroup, type Quality } from '../core/params.ts';
import { activeJobId, cancelJob, enqueue, loadAnalyses, recoverInterrupted, retryJob, runWorkerTask, subscribe } from './jobs.ts';
import { inferParams, PROVIDERS } from './providers.ts';
import { createProject, deleteProject, duplicateProject, isSafeId, listJobs, listProjects, newId, projectDir, readJob, readProject, ROOT, safeProjectPath, saveProject, type Project, type Reference, type ReferenceView, type Version } from './store.ts';
import { blenderVersion, findBlender } from './validate.ts';
import { readDimensions, sniff, MAX_PIXELS } from './vision.ts';

const PORT = Number(process.env.PORT ?? 8787);
const MAX_UPLOAD = 30 * 1024 * 1024;
const MAX_REFS = 12;
const DIST = join(ROOT, 'dist');

recoverInterrupted();

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const fail = (message: string, status = 400, extra: Record<string, unknown> = {}) => json({ error: message, ...extra }, status);

const MIME: Record<string, string> = {
  '.glb': 'model/gltf-binary', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.bin': 'application/octet-stream',
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.svg': 'image/svg+xml',
  '.obj': 'text/plain', '.mtl': 'text/plain', '.blend': 'application/octet-stream',
};

function classifyReference(kind: string, filename: string, requested?: string, project?: Project): { view: ReferenceView; usage: Reference['usage'] } {
  const name = filename.toLowerCase();
  if (kind === 'png' || kind === 'jpeg') {
    const views: ReferenceView[] = ['front', 'back', 'side', 'detail', 'blueprint', 'other'];
    if (requested && views.includes(requested as ReferenceView)) {
      return { view: requested as ReferenceView, usage: requested === 'front' || requested === 'back' ? 'used-by-pipeline' : 'stored-not-used' };
    }
    const taken = new Set(project?.references.map((r) => r.view));
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

async function addReference(project: Project, file: File, requestedView?: string): Promise<Reference> {
  if (file.size > MAX_UPLOAD) throw new Error(`${file.name} is ${(file.size / 1e6).toFixed(0)} MB. The limit is 30 MB per file.`);
  if (file.size === 0) throw new Error(`${file.name} is empty.`);
  if (project.references.length >= MAX_REFS) throw new Error(`A project can hold ${MAX_REFS} reference files.`);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const kind = sniff(bytes, file.name);
  if (kind === 'unknown' || kind === 'webp' || kind === 'gif') {
    throw new Error(`${file.name} is not a supported file. Use PNG or JPEG for images. WebP, HEIC and GIF are not accepted yet.`);
  }
  if (kind === 'png' || kind === 'jpeg') {
    const dim = readDimensions(bytes, kind);
    if (!dim) throw new Error(`${file.name} looks like a ${kind.toUpperCase()} but its header is damaged.`);
    if (dim.width * dim.height > MAX_PIXELS) throw new Error(`${file.name} is ${dim.width}×${dim.height}. The limit is 40 megapixels.`);
  }
  const id = newId('ref');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const stored = `refs/${id}.${kind === 'jpeg' ? 'jpg' : kind}`;
  const abs = join(projectDir(project.id), stored);
  mkdirSync(join(projectDir(project.id), 'refs'), { recursive: true });
  writeFileSync(abs, bytes);
  const { view, usage } = classifyReference(kind, file.name, requestedView, project);
  const ref: Reference = { id, filename: file.name.replace(/[^\w.\- ()]/g, '_').slice(0, 120), kind, view, sha256, bytes: bytes.length, file: stored, usage, addedAt: new Date().toISOString() };
  if (kind === 'png' || kind === 'jpeg') {
    const dirRel = `cache/analyze-${sha256.slice(0, 16)}`;
    const dirAbs = join(projectDir(project.id), dirRel);
    try {
      if (!existsSync(join(dirAbs, 'done.json'))) {
        // Decoding happens in a child process, so a hostile file can take down that process but not the server.
        await runWorkerTask({ stage: 'analyze', outDir: dirAbs, params: DEFAULT_PARAMS, quality: 'preview', avatar: 'regular', seed: 1, pins: [], label: 'DEMO BASELINE', referencePath: abs }, undefined, undefined, 60000);
      }
    } catch (e) {
      rmSync(abs, { force: true });
      throw new Error(`${file.name} could not be read as an image. ${e instanceof Error ? e.message : ''}`.trim());
    }
    ref.analysisDir = dirRel;
    const { confidence, ok, warnings, medianColor, hoodDetected, torso, bbox, ratios, backgroundUniformity, maskCoverage } = JSON.parse(await Bun.file(join(dirAbs, 'analysis.json')).text());
    ref.analysis = { confidence, ok, warnings, medianColor, hoodDetected, torso, bbox, ratios, backgroundUniformity, maskCoverage, maskUrl: `${dirRel}/mask.png` };
  }
  project.references.push(ref);
  return ref;
}

function createVersion(project: Project, partial: Partial<Version> & Pick<Version, 'source' | 'summary' | 'params'>): Version {
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

const sk = buildSkeleton('regular');

async function applyEdit(project: Project, patch: Partial<HoodieParams>, source: 'manual' | 'chat', summary: string) {
  const current = project.versions.find((v) => v.id === project.currentVersionId);
  if (!current) throw new Error('Generate the garment before editing it.');
  const next: HoodieParams = { ...current.params, ...patch };
  const issues = validateParams(next);
  if (issues.length) throw new Error(issues.join(' '));
  const check = restLocality(current.params, next, sk);
  if (!check.passed) throw new Error(`This edit changed parts it should not have touched: ${check.unexpected.map((p) => PART_LABEL[p]).join(', ')}. It was not applied.`);
  const notes = { ...current.notes };
  for (const k of Object.keys(patch)) notes[k] = { source: 'edited', note: source === 'chat' ? 'Changed through the chat command.' : 'Changed with a manual control.' };
  const v = createVersion(project, { source, summary, params: next, notes, warnings: current.warnings.filter((w) => !/agree|disagree/.test(w)), avatar: current.avatar, quality: current.quality, seed: current.seed, pins: current.pins, provider: current.provider, editCheck: { perPart: check.perPart, unexpected: check.unexpected, passed: check.passed } });
  const job = enqueue(project, v.id, 'edit', { clip: project.setup.clip });
  v.jobId = job.id;
  saveProject(project);
  return { version: v, job };
}

async function handleApi(req: Request, url: URL): Promise<Response> {
  const parts = url.pathname.split('/').filter(Boolean).slice(1);
  const method = req.method;
  const body = async () => {
    try {
      return (await req.json()) as Record<string, any>;
    } catch {
      return {};
    }
  };
  if (parts[0] === 'health') {
    return json({
      ok: true, time: new Date().toISOString(), blender: { path: findBlender(), version: await blenderVersion() },
      providers: PROVIDERS.map(({ available, ...p }) => p),
      editInterpreter: { id: 'rule-based-v1', kind: 'rules', note: 'Deterministic command parser. No language model is connected.' },
      activeJob: activeJobId(),
      catalog: { quality: QUALITY, fabrics: FABRICS, bodies: BODY_SHAPES, clips: CLIPS, params: PARAM_META, partLabels: PART_LABEL, defaults: DEFAULT_PARAMS, uploads: { maxBytes: MAX_UPLOAD, maxFiles: MAX_REFS, maxPixels: MAX_PIXELS } },
    });
  }
  if (parts[0] === 'events') {
    let unsub: (() => void) | undefined;
    let timer: ReturnType<typeof setInterval>;
    const stream = new ReadableStream({
      start(controller) {
        const enc = new TextEncoder();
        const send = (e: Record<string, unknown>) => {
          try {
            controller.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
          } catch {
            unsub?.();
          }
        };
        send({ type: 'hello' });
        unsub = subscribe(send) as () => void;
        timer = setInterval(() => send({ type: 'ping' }), 15000);
      },
      cancel() {
        unsub?.();
        clearInterval(timer);
      },
    });
    return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' } });
  }
  if (parts[0] !== 'projects') return fail('Not found', 404);
  if (parts.length === 1) {
    if (method === 'GET') {
      return json(listProjects().map((p) => ({
        id: p.id, name: p.name, updatedAt: p.updatedAt, createdAt: p.createdAt,
        references: p.references.length,
        cover: p.references.find((r) => r.kind === 'png' || r.kind === 'jpeg')?.file ?? null,
        versions: p.versions.length,
        tier: p.versions.find((v) => v.id === p.currentVersionId)?.tier ?? 'none',
        label: p.versions.length ? 'DEMO BASELINE' : null,
        lastJob: listJobs(p.id)[0] ? { id: listJobs(p.id)[0].id, status: listJobs(p.id)[0].status, kind: listJobs(p.id)[0].kind } : null,
      })));
    }
    if (method === 'POST') return json(createProject(String((await body()).name ?? 'Untitled hoodie')), 201);
  }
  const id = parts[1];
  if (!id || !isSafeId(id)) return fail('Invalid project id');
  const project = readProject(id);
  if (!project) return fail('Project not found', 404);
  const sub = parts[2];

  if (!sub) {
    if (method === 'GET') return json({ ...project, jobs: listJobs(id).slice(0, 30) });
    if (method === 'PATCH') {
      const b = await body();
      if (typeof b.name === 'string') project.name = b.name.trim().slice(0, 120) || project.name;
      if (typeof b.description === 'string') project.description = b.description.slice(0, 4000);
      if (b.measurements && typeof b.measurements === 'object') {
        const m: Project['measurements'] = {};
        for (const k of ['bodyWidth', 'bodyLength', 'sleeveLength', 'shoulderWidth'] as const) {
          const v = Number(b.measurements[k]);
          if (b.measurements[k] != null && b.measurements[k] !== '' && Number.isFinite(v) && v > 0) {
            const meta = PARAM_META[k];
            if (v < meta.min || v > meta.max) return fail(`${meta.label} must be between ${meta.min * 100} and ${meta.max * 100} cm`);
            m[k] = v;
          }
        }
        project.measurements = m;
      }
      if (b.setup && typeof b.setup === 'object') {
        const s = b.setup;
        if (s.quality && QUALITY[s.quality as Quality]) project.setup.quality = s.quality;
        if (s.avatar && BODY_SHAPES[s.avatar as BodyShapeId]) project.setup.avatar = s.avatar;
        if (s.clip === null || CLIPS[s.clip as ClipId]) project.setup.clip = s.clip;
        if (s.provider && PROVIDERS.some((p) => p.id === s.provider)) project.setup.provider = s.provider;
        if (Array.isArray(s.pins)) project.setup.pins = s.pins.filter((x: string) => ['collar', 'cuffs', 'hem'].includes(x)) as PinGroup[];
        if (Number.isInteger(s.seed)) project.setup.seed = s.seed;
      }
      saveProject(project);
      return json(project);
    }
    if (method === 'DELETE') {
      deleteProject(id);
      return json({ deleted: true });
    }
  }
  if (sub === 'duplicate' && method === 'POST') return json(duplicateProject(id), 201);

  if (sub === 'references') {
    if (method === 'POST') {
      const form = await req.formData();
      const added: Reference[] = [];
      const errors: string[] = [];
      for (const [k, v] of form.entries()) {
        if (k !== 'files' || typeof v === 'string') continue;
        try {
          added.push(await addReference(project, v as File, form.get(`view:${(v as File).name}`)?.toString()));
        } catch (e) {
          errors.push(e instanceof Error ? e.message : String(e));
        }
      }
      saveProject(project);
      return json({ added, errors, project }, errors.length && !added.length ? 400 : 200);
    }
    const rid = parts[3];
    const ref = project.references.find((r) => r.id === rid);
    if (!ref) return fail('Reference not found', 404);
    if (method === 'PATCH') {
      const b = await body();
      const views: ReferenceView[] = ['front', 'back', 'side', 'detail', 'other'];
      if (!views.includes(b.view)) return fail('Unknown view');
      if (ref.kind !== 'png' && ref.kind !== 'jpeg') return fail('Only images can be given a camera view.');
      for (const r of project.references) {
        if (r.id !== ref.id && r.view === b.view && (b.view === 'front' || b.view === 'back')) {
          r.view = 'other';
          r.usage = 'stored-not-used';
        }
      }
      ref.view = b.view;
      ref.usage = b.view === 'front' || b.view === 'back' ? 'used-by-pipeline' : 'stored-not-used';
      saveProject(project);
      return json(project);
    }
    if (method === 'DELETE') {
      project.references = project.references.filter((r) => r.id !== rid);
      rmSync(join(projectDir(id), ref.file), { force: true });
      saveProject(project);
      return json(project);
    }
  }

  if (sub === 'infer' && method === 'GET') {
    return json(inferParams(project, loadAnalyses(project)));
  }

  if (sub === 'generate' && method === 'POST') {
    const b = await body();
    if (activeJobId() && listJobs(id).some((j) => j.id === activeJobId())) return fail('A job is already running for this project.', 409);
    if (b.setup) {
      if (QUALITY[b.setup.quality as Quality]) project.setup.quality = b.setup.quality;
      if (BODY_SHAPES[b.setup.avatar as BodyShapeId]) project.setup.avatar = b.setup.avatar;
    }
    const v = createVersion(project, { source: 'generate', summary: project.references.length ? 'Generated from references' : 'Generated from template', params: DEFAULT_PARAMS });
    const job = enqueue(project, v.id, 'generate', { clip: project.setup.clip });
    v.jobId = job.id;
    saveProject(project);
    return json({ version: v, job }, 202);
  }

  if (sub === 'edits') {
    const current = project.versions.find((v) => v.id === project.currentVersionId);
    if (!current) return fail('Generate the garment before editing it.', 409);
    if (parts[3] === 'preview' && method === 'POST') {
      const b = await body();
      const proposal = typeof b.text === 'string' ? parseEdit(b.text.slice(0, 500), current.params) : proposalFromPatch(current.params, (b.patch ?? {}) as Partial<HoodieParams>, String(b.summary ?? 'Manual change'));
      return json(proposal);
    }
    if (parts[3] === 'apply' && method === 'POST') {
      const b = await body();
      if (!b.patch || typeof b.patch !== 'object') return fail('Nothing to apply.');
      const allowed = new Set(Object.keys(DEFAULT_PARAMS));
      const patch = Object.fromEntries(Object.entries(b.patch).filter(([k]) => allowed.has(k))) as Partial<HoodieParams>;
      try {
        const r = await applyEdit(project, patch, b.source === 'chat' ? 'chat' : 'manual', String(b.summary ?? 'Edit').slice(0, 300));
        return json(r, 202);
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e), 422);
      }
    }
  }

  if (sub === 'versions') {
    const v = project.versions.find((x) => x.id === parts[3]);
    if (!v) return fail('Version not found', 404);
    const action = parts[4];
    if (action === 'restore' && method === 'POST') {
      // Restoring is a pointer change. History is kept, so restoring can itself be undone.
      project.currentVersionId = v.id;
      saveProject(project);
      return json(project);
    }
    if (action === 'approve' && method === 'POST') {
      v.approved = { at: new Date().toISOString() };
      saveProject(project);
      return json(project);
    }
    if (action === 'unapprove' && method === 'POST') {
      delete v.approved;
      saveProject(project);
      return json(project);
    }
    if (action === 'regenerate' && method === 'POST') {
      const b = await body();
      const quality = QUALITY[b.quality as Quality] ? (b.quality as Quality) : v.quality;
      const seed = b.reseed ? v.seed + 1 : v.seed;
      const avatar = BODY_SHAPES[b.avatar as BodyShapeId] ? (b.avatar as BodyShapeId) : v.avatar;
      const pins = Array.isArray(b.pins) ? (b.pins.filter((x: string) => ['collar', 'cuffs', 'hem'].includes(x)) as PinGroup[]) : v.pins;
      const changes = [quality !== v.quality && `quality ${QUALITY[quality].label}`, seed !== v.seed && `new drape seed ${seed}`, avatar !== v.avatar && `avatar ${BODY_SHAPES[avatar].label}`, hashOf(pins) !== hashOf(v.pins) && `pins: ${pins.join(', ') || 'none'}`].filter(Boolean);
      if (!changes.length) return fail('Nothing would change. Pick a new quality, avatar, pins or drape seed.');
      const nv = createVersion(project, { source: 'regenerate', summary: `Regenerated with ${changes.join(', ')}`, params: v.params, notes: v.notes, warnings: v.warnings, quality, seed, avatar, pins, provider: v.provider });
      project.setup.quality = quality;
      project.setup.avatar = avatar;
      project.setup.pins = pins;
      project.setup.seed = seed;
      const job = enqueue(project, nv.id, 'edit', { clip: project.setup.clip });
      nv.jobId = job.id;
      saveProject(project);
      return json({ version: nv, job }, 202);
    }
    if (action === 'motion' && method === 'POST') {
      const b = await body();
      if (!CLIPS[b.clip as ClipId]) return fail('Unknown motion.');
      if (v.artifacts.motion?.[b.clip]) return json({ alreadyBaked: true });
      const job = enqueue(project, v.id, 'motion', { clip: b.clip });
      return json({ job }, 202);
    }
    if (action === 'export' && method === 'POST') {
      const b = await body();
      if (!['glb', 'obj', 'blend'].includes(b.format)) return fail('Unknown format.');
      if (v.status !== 'ready') return fail('Wait for the refined asset before exporting.', 409);
      if (b.clip && !CLIPS[b.clip as ClipId]) return fail('Unknown motion.');
      if (b.clip && b.format === 'obj') return fail('OBJ cannot store animation. Export GLB or Blender for motion.');
      if (b.clip && !v.artifacts.motion?.[b.clip]) return fail('Bake that motion before exporting it.', 409);
      const job = enqueue(project, v.id, 'export', { format: b.format, clip: b.clip ?? null });
      return json({ job }, 202);
    }
  }

  if (sub === 'jobs') {
    const job = readJob(id, parts[3] ?? '');
    if (!job) return fail('Job not found', 404);
    if (parts[4] === 'cancel' && method === 'POST') return json({ cancelled: cancelJob(job) });
    if (parts[4] === 'retry' && method === 'POST') {
      if (job.status === 'running' || job.status === 'queued') return fail('The job is already active.', 409);
      return json(retryJob(job));
    }
    return json(job);
  }
  return fail('Not found', 404);
}

function fileResponse(path: string, download?: string) {
  const headers: Record<string, string> = { 'content-type': MIME[extname(path).toLowerCase()] ?? 'application/octet-stream', 'x-content-type-options': 'nosniff' };
  if (download) headers['content-disposition'] = `attachment; filename="${download.replace(/[^\w.\-]/g, '_')}"`;
  return new Response(Bun.file(path), { headers });
}

const server = Bun.serve({
  port: PORT,
  hostname: '127.0.0.1',
  maxRequestBodySize: MAX_UPLOAD * MAX_REFS + 1024 * 1024,
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url);
    // This server has no accounts, so it only answers local pages. This blocks DNS rebinding and cross-site writes.
    const host = (req.headers.get('host') ?? '').split(':')[0];
    if (!['127.0.0.1', 'localhost'].includes(host)) return fail('Local access only.', 403);
    const origin = req.headers.get('origin');
    if (origin && req.method !== 'GET' && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) return fail('Cross-origin writes are refused.', 403);
    try {
      if (url.pathname.startsWith('/api/')) return await handleApi(req, url);
      if (url.pathname.startsWith('/files/')) {
        const [, , pid, ...rest] = url.pathname.split('/');
        if (!pid || !isSafeId(pid)) return fail('Invalid project id');
        const path = safeProjectPath(pid, decodeURIComponent(rest.join('/')));
        if (!path || !existsSync(path) || !statSync(path).isFile()) return fail('File not found', 404);
        return fileResponse(path, url.searchParams.get('download') ?? undefined);
      }
      if (existsSync(DIST)) {
        const candidate = resolve(DIST, `.${url.pathname}`);
        if (candidate.startsWith(DIST) && existsSync(candidate) && statSync(candidate).isFile()) return fileResponse(candidate);
        return fileResponse(join(DIST, 'index.html'));
      }
      return new Response('The web app is not built. Run: bun run build', { status: 503 });
    } catch (e) {
      console.error(e);
      return fail(e instanceof Error ? e.message : 'Server error', 500);
    }
  },
});

console.log(`AI 3D Studio server on http://127.0.0.1:${server.port}`);
