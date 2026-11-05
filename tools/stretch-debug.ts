import { buildSkeleton } from '../src/core/avatar.ts';
import { buildGarment } from '../src/core/garment.ts';
import { DEFAULT_PARAMS } from '../src/core/params.ts';
import { drape } from '../src/core/cloth.ts';
const sk = buildSkeleton('regular');
const g = buildGarment(DEFAULT_PARAMS, 'standard', sk);
const d = drape(g, sk, {});
const x = d.positions;
// Which part owns each sim vertex.
const owner = new Map<number, Set<string>>();
for (const p of g.parts) if (p.map.length) for (const s of p.map) (owner.get(s) ?? owner.set(s, new Set()).get(s)!).add(p.id);
const stat = new Map<string, number[]>();
const worst: { r: number; a: number; b: number; rest: number }[] = [];
for (let e = 0; e < g.edgeRest.length; e++) {
  const a = g.edges[e * 2], b = g.edges[e * 2 + 1];
  const l = Math.hypot(x[a*3]-x[b*3], x[a*3+1]-x[b*3+1], x[a*3+2]-x[b*3+2]);
  const r = l / g.edgeRest[e];
  worst.push({ r, a, b, rest: g.edgeRest[e] });
  const pa = [...owner.get(a)!].filter((p) => owner.get(b)!.has(p));
  for (const p of pa.length ? pa : ['(cross)']) (stat.get(p) ?? stat.set(p, []).get(p)!).push(r);
}
for (const [p, v] of stat) { v.sort((a, b) => a - b); console.log(p.padEnd(12), 'n', String(v.length).padStart(5), 'p50', v[v.length>>1].toFixed(3), 'p99', v[Math.floor(v.length*.99)].toFixed(3), 'max', v[v.length-1].toFixed(2), 'min', v[0].toFixed(3)); }
worst.sort((p, q) => q.r - p.r);
for (const w of worst.slice(0, 8)) console.log(w.r.toFixed(2), 'rest', w.rest.toFixed(4), [...owner.get(w.a)!].join('+'), '|', [...owner.get(w.b)!].join('+'), 'at', x[w.a*3].toFixed(3), x[w.a*3+1].toFixed(3), x[w.a*3+2].toFixed(3));
