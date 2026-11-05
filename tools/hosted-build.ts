/**
 * Prepares dist/ for hosting as a Claude Artifact: a page fragment plus its files, with the one character the host refuses
 * escaped. Usage: bun run tools/hosted-build.ts <output folder>. Prints the files map for the publish call.
 */
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const out = process.argv[2];
if (!out) throw new Error('Pass an output folder.');
const dist = join(import.meta.dir, '..', 'dist');
rmSync(join(out, 'assets'), { recursive: true, force: true });
rmSync(join(out, 'samples'), { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(join(dist, 'assets'), join(out, 'assets'), { recursive: true });
cpSync(join(dist, 'samples'), join(out, 'samples'), { recursive: true });
const html = readFileSync(join(dist, 'index.html'), 'utf8');
const js = html.match(/src="\.\/(assets\/index-[^"]+\.js)"/)![1];
const css = html.match(/href="\.\/(assets\/index-[^"]+\.css)"/)![1];
writeFileSync(join(out, 'index.html'), `<title>AI 3D Studio</title>\n<link rel="stylesheet" href="${css}">\n<div id="root"></div>\n<script type="module" src="${js}"></script>\n`);
const list: string[] = [];
const walk = (d: string) => {
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    if (statSync(p).isDirectory()) walk(p);
    else if (n !== 'index.html') list.push(relative(out, p));
  }
};
walk(out);
for (const f of list.filter((x) => x.endsWith('.js'))) {
  const p = join(out, f);
  writeFileSync(p, readFileSync(p, 'utf8').replaceAll('�', '\\ufffd'));
}
console.log(JSON.stringify(Object.fromEntries(list.sort().map((f) => [f, f]))));
