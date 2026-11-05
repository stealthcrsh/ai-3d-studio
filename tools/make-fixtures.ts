/**
 * Synthetic, self-authored reference images with known ground-truth proportions. No third-party or personal imagery.
 * They test the measuring code and the failure paths. They are not evidence of performance on real photographs.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { encodePng, encodeJpeg, type RGBAImage } from '../src/server/vision.ts';

const OUT = join(import.meta.dir, '..', 'fixtures');
mkdirSync(OUT, { recursive: true });

type Pt = [number, number];
const inside = (p: Pt, poly: Pt[]) => {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    if (poly[i][1] > p[1] !== poly[j][1] > p[1] && p[0] < ((poly[j][0] - poly[i][0]) * (p[1] - poly[i][1])) / (poly[j][1] - poly[i][1]) + poly[i][0]) c = !c;
  }
  return c;
};

interface Spec { w: number; h: number; bg: [number, number, number]; base: [number, number, number]; rib?: [number, number, number]; widthToLength: number; sleeveToLength: number; pattern?: 'stripes' | 'chest-print'; back?: boolean; noisy?: boolean; noHood?: boolean }

function render(s: Spec): RGBAImage {
  const { w, h } = s;
  const data = new Uint8Array(w * h * 4);
  const length = h * 0.56;
  const bodyW = length * s.widthToLength;
  const cx = w / 2;
  const top = h * 0.26;
  const hem = top + length;
  const sl = length * s.sleeveToLength;
  const ang = (62 * Math.PI) / 180;
  const sdx = Math.cos(ang) * sl;
  const sdy = Math.sin(ang) * sl;
  const sw = bodyW * 0.17;
  const body: Pt[] = [[cx - bodyW / 2, top + length * 0.06], [cx + bodyW / 2, top + length * 0.06], [cx + bodyW / 2, hem], [cx - bodyW / 2, hem]];
  const sleeve = (side: number): Pt[] => {
    const sx = cx + (side * bodyW) / 2;
    const sy = top + length * 0.06;
    return [[sx - side * 2, sy], [sx + side * sdx, sy + sdy - sw * 0.5], [sx + side * sdx - side * sw * 0.8, sy + sdy + sw * 0.4], [sx - side * 2, sy + length * 0.3]];
  };
  const shoulderLine: Pt[] = [[cx - bodyW / 2, top + length * 0.07], [cx - bodyW * 0.14, top], [cx + bodyW * 0.14, top], [cx + bodyW / 2, top + length * 0.07]];
  const hoodH = length * 0.34;
  const hood: Pt[] = [];
  for (let i = 0; i <= 24; i++) {
    const a = Math.PI + (i / 24) * Math.PI;
    hood.push([cx + Math.cos(a) * bodyW * 0.23, top + 4 + Math.sin(a) * hoodH]);
  }
  const polys = [body, sleeve(1), sleeve(-1), shoulderLine, ...(s.noHood ? [] : [hood])];
  const faceHole: Pt[] = [];
  for (let i = 0; i <= 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    faceHole.push([cx + Math.cos(a) * bodyW * 0.12, top - hoodH * 0.42 + Math.sin(a) * hoodH * 0.36]);
  }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const p: Pt = [x + 0.5, y + 0.5];
      let col = s.bg;
      if (s.noisy) {
        const n = Math.sin(x * 0.09) * Math.cos(y * 0.13) * 60 + Math.sin((x + y) * 0.31) * 40;
        col = [s.bg[0] + n, s.bg[1] - n * 0.6, s.bg[2] + n * 0.4] as [number, number, number];
      }
      if (polys.some((q) => inside(p, q))) {
        const shade = 1 - 0.13 * Math.abs((x - cx) / (bodyW * 0.9)) ** 2;
        let c = s.base;
        if (s.rib && y > hem - length * 0.09 && Math.abs(x - cx) <= bodyW / 2) c = s.rib;
        if (s.pattern === 'stripes' && Math.floor((y - top) / 24) % 2 === 0) c = [Math.min(255, c[0] + 120), Math.min(255, c[1] + 120), Math.min(255, c[2] + 120)];
        if (s.pattern === 'chest-print' && Math.abs(x - cx) < bodyW * 0.2 && y > top + length * 0.18 && y < top + length * 0.36) c = [235, 96, 52];
        const inHoodFace = !s.back && !s.noHood && inside(p, faceHole);
        col = inHoodFace ? [c[0] * 0.45, c[1] * 0.45, c[2] * 0.45] : [c[0] * shade, c[1] * shade, c[2] * shade];
      }
      data.set([col[0], col[1], col[2], 255], i);
    }
  return { width: w, height: h, data };
}

const save = (name: string, img: RGBAImage) => {
  writeFileSync(join(OUT, name), name.endsWith('.jpg') ? encodeJpeg(img, 90) : encodePng(img));
  console.log(name);
};

const STD: Spec = { w: 800, h: 900, bg: [238, 236, 230], base: [86, 104, 122], rib: [72, 88, 104], widthToLength: 0.92, sleeveToLength: 0.85 };
save('hoodie_front.png', render(STD));
save('hoodie_back.png', render({ ...STD, back: true }));
save('hoodie_front.jpg', render(STD));
save('hoodie_patterned_front.png', render({ ...STD, base: [36, 44, 74], rib: [28, 34, 58], pattern: 'stripes', widthToLength: 0.84, sleeveToLength: 0.9 }));
save('hoodie_print_front.png', render({ ...STD, base: [46, 72, 58], rib: [38, 60, 48], pattern: 'chest-print', widthToLength: 1.02, sleeveToLength: 0.78 }));
save('hoodie_contradict_back.png', render({ ...STD, base: [176, 48, 44], rib: [150, 40, 38], widthToLength: 0.62, back: true }));
save('hoodie_busy_background.png', render({ ...STD, bg: [120, 130, 96], noisy: true }));
save('tshirt_no_hood.png', render({ ...STD, noHood: true, sleeveToLength: 0.35 }));
const blank = new Uint8Array(400 * 400 * 4).fill(240);
save('blank.png', { width: 400, height: 400, data: blank });
// Damaged files, for rejection tests. The first bytes look valid but the body is garbage.
const png = encodePng(render({ ...STD, w: 200, h: 220 }));
writeFileSync(join(OUT, 'corrupt_truncated.png'), png.slice(0, Math.floor(png.length * 0.3)));
writeFileSync(join(OUT, 'fake_image.png'), new TextEncoder().encode('this is not an image, only text renamed to .png'));
// A tiny file whose header claims an enormous image, the shape of a decompression bomb.
const bomb = png.slice(0, 33);
new DataView(bomb.buffer, bomb.byteOffset).setUint32(16, 60000);
new DataView(bomb.buffer, bomb.byteOffset).setUint32(20, 60000);
writeFileSync(join(OUT, 'bomb_header.png'), bomb);
writeFileSync(join(OUT, 'measurements.txt'), 'Chest flat width 66 cm. Body length 72 cm. Synthetic fixture text.\n');
writeFileSync(join(OUT, 'README.md'), [
  '# Fixtures', '', 'All fixtures are synthetic and generated by `bun run fixtures`. No third-party or personal imagery is used.', '',
  'Ground truth for silhouette tests:', '', '| File | width / length | sleeve / length |', '|---|---|---|',
  '| hoodie_front.png | 0.92 | 0.85 |', '| hoodie_patterned_front.png | 0.84 | 0.90 |', '| hoodie_print_front.png | 1.02 | 0.78 |', '',
  'These prove the measurement code and failure paths work. They are not evidence of accuracy on real photographs.', '',
].join('\n'));
