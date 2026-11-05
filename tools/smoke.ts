/**
 * API smoke test against a running server: upload, generate, edit, export.
 * Usage: bun run tools/smoke.ts [baseUrl]
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.argv[2] ?? 'http://127.0.0.1:8787';
const FIX = join(import.meta.dir, '..', 'fixtures');
const call = async (path: string, init?: RequestInit) => {
  const r = await fetch(BASE + path, init);
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${path}: ${r.status} ${JSON.stringify(d)}`);
  return d;
};
const post = (path: string, body?: unknown) => call(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
const waitJob = async (pid: string, jid: string) => {
  const t = performance.now();
  for (;;) {
    const j = await call(`/api/projects/${pid}/jobs/${jid}`);
    if (!['queued', 'running'].includes(j.status)) {
      console.log(`  job ${j.kind} ${j.status} in ${((performance.now() - t) / 1000).toFixed(1)} s`);
      for (const s of j.stages) console.log(`    ${s.name.padEnd(9)} ${s.status.padEnd(8)} ${s.ms ?? ''} ${s.detail ?? ''}`);
      if (j.status !== 'completed') throw new Error(j.error ?? j.status);
      return j;
    }
    await Bun.sleep(150);
  }
};

const p = await post('/api/projects', { name: 'Smoke test hoodie' });
console.log('project', p.id);
const form = new FormData();
for (const f of ['hoodie_front.png', 'hoodie_back.png']) form.append('files', new File([readFileSync(join(FIX, f))], f));
const up = await call(`/api/projects/${p.id}/references`, { method: 'POST', body: form });
console.log('uploaded', up.added.map((r: any) => `${r.filename} ${r.view} ratio=${r.analysis?.ratios?.widthToLength?.toFixed(3)}`));
const gen = await post(`/api/projects/${p.id}/generate`);
await waitJob(p.id, gen.job.id);
let full = await call(`/api/projects/${p.id}`);
let v = full.versions.at(-1);
console.log('params', v.params.bodyWidth, v.params.sleeveLength, v.params.baseColor, 'tier', v.tier, 'metrics', v.metrics, 'qa', v.qaSummary);
if (process.env.SMOKE_QUICK) {
  console.log(`PROJECT=${p.id}`);
  process.exit(0);
}
const edit = await post(`/api/projects/${p.id}/edits/preview`, { text: 'make the sleeves 3 cm shorter' });
console.log('proposal', edit.understood, edit.affectedParts);
const applied = await post(`/api/projects/${p.id}/edits/apply`, { patch: edit.patch, source: 'chat', summary: edit.understood });
await waitJob(p.id, applied.job.id);
full = await call(`/api/projects/${p.id}`);
v = full.versions.at(-1);
console.log('edit check', v.editCheck.passed, v.editCheck.perPart.filter((x: any) => x.changed).map((x: any) => x.part));
for (const [format, clip] of [['glb', null], ['glb', 'walk'], ['obj', null], ['blend', 'walk']] as const) {
  const e = await post(`/api/projects/${p.id}/versions/${v.id}/export`, { format, clip });
  try {
    await waitJob(p.id, e.job.id);
  } catch (err) {
    console.log('  export error:', (err as Error).message);
  }
}
full = await call(`/api/projects/${p.id}`);
v = full.versions.at(-1);
for (const e of v.exports) console.log('export', e.format, e.clip, e.status, e.files.map((f: any) => `${f.name} ${(f.bytes / 1e6).toFixed(2)}MB`));
console.log('final tier', v.tier, 'validated', v.validatedFormats);
console.log(`PROJECT=${p.id}`);
