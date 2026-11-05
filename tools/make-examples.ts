/** Writes example exports and their validation reports to examples/, using the same engine code as the browser app. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Studio } from '../src/engine/studio.ts';
import { InlineRunner, MapStorage } from '../tests/support.ts';

const ROOT = join(import.meta.dir, '..');
const OUT = join(ROOT, 'examples');
mkdirSync(OUT, { recursive: true });
const storage = new MapStorage();
const studio = new Studio(storage, new InlineRunner(storage));
const wait = async (pid: string, jid: string) => {
  for (;;) {
    const j = await studio.store.readJob(pid, jid);
    if (j && !['queued', 'running'].includes(j.status)) {
      if (j.status !== 'completed') throw new Error(j.error ?? j.status);
      return j;
    }
    await Bun.sleep(30);
  }
};
const p = await studio.create('Example hoodie');
await studio.patch(p.id, { setup: { quality: 'standard', clip: 'walk' } });
const file = (name: string) => ({ name, bytes: new Uint8Array(readFileSync(join(ROOT, 'fixtures', name))) });
await studio.upload(p.id, [file('hoodie_front.png'), file('hoodie_back.png')]);
const g = await studio.generate(p.id);
await wait(p.id, g.job.id);
const v = (await studio.get(p.id)).versions.at(-1)!;
for (const [format, clip] of [['glb', 'walk'], ['glb', null], ['obj', null], ['blender', 'walk']] as const) {
  const e = await studio.exportAsset(p.id, v.id, format, clip);
  await wait(p.id, e.job.id);
  const rec = (await studio.get(p.id)).versions.at(-1)!.exports.find((x) => x.format === format && x.clip === clip)!;
  const dir = join(OUT, `${format}${clip ? `-${clip}` : '-static'}`);
  mkdirSync(dir, { recursive: true });
  for (const f of rec.files) writeFileSync(join(dir, f.name), (await studio.readFile(p.id, `${rec.dir}/${f.name}`))!);
  writeFileSync(join(dir, 'report.json'), (await studio.readFile(p.id, rec.report))!);
  console.log(format, clip, rec.status, rec.files.map((f) => `${f.name} ${(f.bytes / 1e6).toFixed(2)} MB`).join(', '));
}
const qa = (await studio.get(p.id)).versions.at(-1)!;
writeFileSync(join(OUT, 'qa.json'), (await studio.readFile(p.id, qa.artifacts.qa!))!);
console.log('qa', qa.qaSummary, 'metrics', qa.metrics);
