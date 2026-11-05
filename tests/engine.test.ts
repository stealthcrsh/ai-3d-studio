import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import * as validator from 'gltf-validator';
import { PROVIDERS } from '../src/engine/providers.ts';
import { Studio } from '../src/engine/studio.ts';
import type { Job, Project } from '../src/engine/store.ts';
import { InlineRunner, MapStorage } from './support.ts';

const FIX = join(resolve(import.meta.dir, '..'), 'fixtures');
const file = (name: string) => ({ name, bytes: new Uint8Array(readFileSync(join(FIX, name))) });

function makeStudio(storage = new MapStorage()) {
  const runner = new InlineRunner(storage);
  return { studio: new Studio(storage, runner), storage, runner };
}

async function waitJob(studio: Studio, pid: string, jid: string, until = ['completed', 'failed', 'cancelled', 'interrupted']): Promise<Job> {
  for (let i = 0; i < 6000; i++) {
    const j = await studio.store.readJob(pid, jid);
    if (j && until.includes(j.status)) return j;
    await Bun.sleep(20);
  }
  throw new Error('timeout');
}

const preview = async (studio: Studio, name = 'test', setup: Partial<Project['setup']> = {}) => {
  const p = await studio.create(name);
  await studio.patch(p.id, { setup: { quality: 'preview', ...setup } });
  return p;
};
const current = async (studio: Studio, id: string) => {
  const p = await studio.get(id);
  return p.versions.find((v) => v.id === p.currentVersionId)!;
};

describe('adding references', () => {
  test('fake, truncated and bomb files are rejected and leave nothing behind', async () => {
    const { studio, storage } = makeStudio();
    const p = await preview(studio);
    for (const f of ['fake_image.png', 'corrupt_truncated.png', 'bomb_header.png']) {
      const r = await studio.upload(p.id, [file(f)]);
      expect([f, r.errors.length, r.added.length]).toEqual([f, 1, 0]);
    }
    expect((await studio.get(p.id)).references.length).toBe(0);
    expect((await storage.list(`projects/${p.id}/refs/`)).length).toBe(0);
  }, 30000);
  test('text is stored and marked unused', async () => {
    const { studio } = makeStudio();
    const p = await preview(studio);
    const r = await studio.upload(p.id, [file('measurements.txt')]);
    expect(r.added[0].usage).toBe('stored-not-used');
  });
  test('views come from file names and can be changed; a second front displaces the first', async () => {
    const { studio } = makeStudio();
    const p = await preview(studio);
    const r = await studio.upload(p.id, [file('hoodie_front.png'), file('hoodie_back.png')]);
    expect(r.added.map((a) => a.view)).toEqual(['front', 'back']);
    await studio.setView(p.id, r.added[1].id, 'front');
    const after = await studio.get(p.id);
    expect(after.references.find((x) => x.id === r.added[1].id)!.view).toBe('front');
    expect(after.references.find((x) => x.id === r.added[0].id)!.usage).toBe('stored-not-used');
  }, 30000);
});

describe('reference flow', () => {
  const { studio } = makeStudio();
  let pid = '';
  let firstVersion = '';
  test('generate: draft then refined, with provenance labels', async () => {
    const p = await preview(studio, 'flow');
    pid = p.id;
    await studio.upload(pid, [file('hoodie_front.png'), file('hoodie_back.png')]);
    const g = await studio.generate(pid);
    expect((await waitJob(studio, pid, g.job.id)).status).toBe('completed');
    const v = await current(studio, pid);
    firstVersion = v.id;
    expect(v.label).toBe('DEMO BASELINE');
    expect(v.tier).toBe('refined');
    expect(v.artifacts.draft).toBeTruthy();
    expect(v.artifacts.model).toBeTruthy();
    expect(v.notes.bodyWidth.source).toBe('inferred');
    expect(v.notes.hoodDepth.source).toBe('default');
    expect(v.notes.bodyLength.source).toBe('default');
    expect(v.qaSummary!.fail).toBe(0);
    expect(v.metrics.timeToFirstMeshMs).toBeLessThan(v.metrics.timeToRefinedMs);
  }, 120000);
  test('the draft is a valid, independently parsed 3D file', async () => {
    const v = await current(studio, pid);
    const bytes = (await studio.readFile(pid, v.artifacts.draft!))!;
    const r = await validator.validateBytes(bytes, {});
    expect((r.issues as { numErrors: number }).numErrors).toBe(0);
    const doc = await new NodeIO().readBinary(bytes);
    expect(doc.getRoot().listMeshes().length).toBeGreaterThan(10);
  });
  test('sleeve edit: new version, scope checked, edited value labelled', async () => {
    const proposal = await studio.previewEdit(pid, { text: 'make the sleeves 3 cm shorter' });
    expect(proposal.ok).toBe(true);
    const a = await studio.applyEdit(pid, { patch: proposal.patch, source: 'chat', summary: proposal.understood });
    expect((await waitJob(studio, pid, a.job.id)).status).toBe('completed');
    const v = await current(studio, pid);
    expect(v.n).toBe(2);
    expect(v.notes.sleeveLength.source).toBe('edited');
    expect(v.editCheck!.passed).toBe(true);
    expect(Object.keys(v.editCheck!.drapedShiftMm ?? {}).length).toBeGreaterThan(0);
  }, 120000);
  test('colour edit reuses the drape and motion instead of simulating again', async () => {
    const proposal = await studio.previewEdit(pid, { text: 'change the colour to navy' });
    const a = await studio.applyEdit(pid, { patch: proposal.patch, source: 'chat', summary: proposal.understood });
    const job = await waitJob(studio, pid, a.job.id);
    const stage = (n: string) => job.stages.find((s) => s.name === n)!.status;
    expect(stage('drape')).toBe('cached');
    expect(stage('motion')).toBe('cached');
    expect(stage('texture')).toBe('done');
  }, 120000);
  test('restore is non-destructive', async () => {
    const before = await studio.get(pid);
    await studio.restore(pid, firstVersion);
    const after = await studio.get(pid);
    expect(after.currentVersionId).toBe(firstVersion);
    expect(after.versions.length).toBe(before.versions.length);
  });
  test('GLB export with baked motion passes the Khronos validator and an independent parser', async () => {
    const e = await studio.exportAsset(pid, firstVersion, 'glb', 'walk');
    expect((await waitJob(studio, pid, e.job.id)).status).toBe('completed');
    const v = await current(studio, pid);
    const rec = v.exports[0];
    expect(rec.status).toBe('passed');
    const report = JSON.parse(new TextDecoder().decode((await studio.readFile(pid, rec.report))!));
    expect(report.validators[0].name).toContain('glTF Validator');
    expect(report.validators[0].passed).toBe(true);
    expect(report.validators[1].passed).toBe(true);
    expect(report.observed.animations.find((a: { name: string }) => a.name === 'walk').weightChannels).toBeGreaterThan(5);
    expect(report.observed.morphCounts).toEqual([33]);
    expect(v.tier).toBe('validated');
  }, 60000);
  test('every report states Blender did not open the file', async () => {
    const v = await current(studio, pid);
    const report = JSON.parse(new TextDecoder().decode((await studio.readFile(pid, v.exports[0].report))!));
    const b = report.validators.find((x: { name: string }) => x.name === 'Opened in Blender');
    expect(b.notRun).toBe(true);
    expect(b.passed).toBe(false);
  });
  test('OBJ has parts, UVs and material files, and refuses motion', async () => {
    await expect(studio.exportAsset(pid, firstVersion, 'obj', 'walk')).rejects.toThrow('OBJ cannot store animation');
    const e = await studio.exportAsset(pid, firstVersion, 'obj', null);
    expect((await waitJob(studio, pid, e.job.id)).status).toBe('completed');
    const rec = (await current(studio, pid)).exports.find((x) => x.format === 'obj')!;
    expect(rec.files.map((f) => f.name).sort()).toEqual(['hoodie.mtl', 'hoodie.obj', 'hoodie_basecolor.jpg']);
  }, 60000);
  test('Blender package is never labelled verified, and contains no fake .blend', async () => {
    const e = await studio.exportAsset(pid, firstVersion, 'blender', null);
    expect((await waitJob(studio, pid, e.job.id)).status).toBe('completed');
    const v = await current(studio, pid);
    const rec = v.exports.find((x) => x.format === 'blender')!;
    expect(rec.status).toBe('unverified');
    expect(rec.files.map((f) => f.name).sort()).toEqual(['README.txt', 'hoodie.glb', 'make_blend.py']);
    expect(rec.files.some((f) => f.name.endsWith('.blend'))).toBe(false);
    expect(v.validatedFormats).not.toContain('blender');
  }, 60000);
  test('an untouched bad edit is refused and creates no version', async () => {
    const before = (await studio.get(pid)).versions.length;
    await expect(studio.applyEdit(pid, { patch: { sleeveLength: 9 }, source: 'manual', summary: 'bad' })).rejects.toThrow('Sleeve length');
    expect((await studio.get(pid)).versions.length).toBe(before);
  });
});

describe('failure handling', () => {
  test('requested AI provider unavailable: falls back and says so, label stays baseline', async () => {
    const { studio } = makeStudio();
    const p = await preview(studio, 'provider', { provider: 'remote-ai', clip: null });
    await studio.upload(p.id, [file('hoodie_front.png')]);
    const g = await studio.generate(p.id);
    expect((await waitJob(studio, p.id, g.job.id)).status).toBe('completed');
    const v = await current(studio, p.id);
    expect(v.provider.requested).toBe('remote-ai');
    expect(v.provider.id).toBe('silhouette-parametric');
    expect(v.provider.fallbackReason).toContain('No remote AI provider');
    expect(v.label).toBe('DEMO BASELINE');
    expect(PROVIDERS.find((x) => x.kind === 'ai')!.status).toBe('not-configured');
  }, 60000);
  test('no references: plain template, flagged as such', async () => {
    const { studio } = makeStudio();
    const p = await preview(studio, 'template', { clip: null });
    const g = await studio.generate(p.id);
    expect((await waitJob(studio, p.id, g.job.id)).status).toBe('completed');
    expect((await current(studio, p.id)).warnings.join(' ')).toContain('not a reconstruction');
  }, 60000);
  test('contradictory front and back are flagged', async () => {
    const { studio } = makeStudio();
    const p = await preview(studio);
    await studio.upload(p.id, [file('hoodie_front.png'), file('hoodie_contradict_back.png')]);
    const r = await studio.infer(p.id);
    expect(r.warnings.join(' ')).toContain('disagree');
    expect(r.warnings.join(' ')).toContain('different colours');
  }, 30000);
  test('measurements override the estimate and are labelled measured', async () => {
    const { studio } = makeStudio();
    const p = await preview(studio);
    await studio.upload(p.id, [file('hoodie_front.png')]);
    await studio.patch(p.id, { measurements: { bodyLength: 0.68, bodyWidth: 0.6 } });
    const r = await studio.infer(p.id);
    expect(r.params.bodyLength).toBe(0.68);
    expect(r.params.bodyWidth).toBe(0.6);
    expect(r.notes.bodyWidth.source).toBe('measured');
  }, 30000);
  test('out-of-range measurement is refused', async () => {
    const { studio } = makeStudio();
    const p = await preview(studio);
    await expect(studio.patch(p.id, { measurements: { bodyLength: 3 } })).rejects.toThrow('Body length');
  });
  test('cancel stops a running stage, retry finishes it and reuses earlier stages', async () => {
    const { studio, runner } = makeStudio();
    const p = await preview(studio, 'cancel');
    await studio.upload(p.id, [file('hoodie_front.png')]);
    runner.holdStage = 'drape';
    const g = await studio.generate(p.id);
    for (let i = 0; i < 500 && !runner.reached.includes('drape'); i++) await Bun.sleep(10);
    expect(await studio.cancelJob(p.id, g.job.id)).toBe(true);
    expect((await waitJob(studio, p.id, g.job.id)).status).toBe('cancelled');
    runner.holdStage = null;
    await studio.retryJob(p.id, g.job.id);
    const done = await waitJob(studio, p.id, g.job.id);
    expect(done.status).toBe('completed');
    expect(done.stages.find((s) => s.name === 'coarse')!.status).toBe('cached');
    expect(done.stages.find((s) => s.name === 'drape')!.status).toBe('done');
  }, 120000);
  test('page closed mid-job: reopening marks it interrupted, and resume reuses finished stages', async () => {
    const storage = new MapStorage();
    const first = makeStudio(storage);
    const p = await preview(first.studio, 'interrupt');
    await first.studio.upload(p.id, [file('hoodie_front.png')]);
    first.runner.holdStage = 'drape';
    const g = await first.studio.generate(p.id);
    for (let i = 0; i < 500 && !first.runner.reached.includes('drape'); i++) await Bun.sleep(10);
    // A new Studio on the same storage is what a reloaded page sees. The first one is abandoned, as a closed tab would be.
    const second = makeStudio(storage);
    await second.studio.start();
    const j = (await second.studio.store.readJob(p.id, g.job.id))!;
    expect(j.status).toBe('interrupted');
    await second.studio.retryJob(p.id, g.job.id);
    const done = await waitJob(second.studio, p.id, g.job.id, ['completed', 'failed', 'cancelled']);
    expect(done.status).toBe('completed');
    expect(done.stages.find((s) => s.name === 'texture')!.status).toBe('cached');
    const v = await current(second.studio, p.id);
    expect(v.status).toBe('ready');
    expect(await storage.exists(`projects/${p.id}/${v.artifacts.model}`)).toBe(true);
  }, 180000);
  test('a stage that fails marks the job failed with its message, and leaves no partial output', async () => {
    const storage = new MapStorage();
    const { studio } = makeStudio(storage);
    const p = await preview(studio, 'fails');
    await studio.upload(p.id, [file('hoodie_front.png')]);
    const original = storage.writeMany.bind(storage);
    storage.writeMany = async (entries) => {
      if (entries.some(([k]) => k.includes('/cache/drape-'))) throw new Error('Storage is full');
      return original(entries);
    };
    const g = await studio.generate(p.id);
    const j = await waitJob(studio, p.id, g.job.id);
    expect(j.status).toBe('failed');
    expect(j.error).toContain('Storage is full');
    expect((await storage.list(`projects/${p.id}/cache/drape-`)).length).toBe(0);
  }, 60000);
  test('library: rename, duplicate, delete', async () => {
    const { studio } = makeStudio();
    const p = await preview(studio, 'library');
    await studio.upload(p.id, [file('hoodie_front.png')]);
    await studio.patch(p.id, { name: 'Renamed' });
    const d = (await studio.duplicate(p.id))!;
    expect(d.name).toBe('Renamed copy');
    expect(d.references.length).toBe(1);
    expect(await studio.readFile(d.id, d.references[0].file)).toBeTruthy();
    await studio.remove(d.id);
    await expect(studio.get(d.id)).rejects.toThrow('not found');
    expect((await studio.get(p.id)).id).toBe(p.id);
    await expect(studio.get('..%2F..%2Fetc')).rejects.toThrow('Invalid project id');
  }, 30000);
});
