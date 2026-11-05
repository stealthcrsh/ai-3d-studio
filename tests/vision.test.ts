import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { analyzeGarmentImage, checkImageHeader, colorDistance, readDimensions, sniff, MAX_PIXELS } from '../src/core/vision.ts';
import { nodeCodec } from './support.ts';

const FIX = join(import.meta.dir, '..', 'fixtures');
const load = (n: string) => new Uint8Array(readFileSync(join(FIX, n)));
const analyze = async (n: string) => {
  const b = load(n);
  return analyzeGarmentImage(await nodeCodec.decode(b, sniff(b) as 'png' | 'jpeg'));
};

describe('file checks', () => {
  test('type comes from bytes, not the file name', () => {
    expect(sniff(load('hoodie_front.png'), 'hoodie_front.png')).toBe('png');
    expect(sniff(load('hoodie_front.jpg'), 'x.png')).toBe('jpeg');
    expect(sniff(load('fake_image.png'), 'fake_image.png')).toBe('unknown');
  });
  test('truncated PNG fails to decode with an error', async () => {
    await expect(nodeCodec.decode(load('corrupt_truncated.png'), 'png')).rejects.toThrow();
  });
  test('header claiming an enormous image is refused before decoding', () => {
    const d = readDimensions(load('bomb_header.png'), 'png')!;
    expect(d.width * d.height).toBeGreaterThan(MAX_PIXELS);
    expect(() => checkImageHeader(load('bomb_header.png'), 'png')).toThrow('40 megapixels');
  });
});

describe('silhouette measurement against known ground truth', () => {
  // Tolerances are PROPOSED. Fixtures are synthetic, so this tests the code, not real photo accuracy.
  for (const [file, wl, sl] of [['hoodie_front.png', 0.92, 0.85], ['hoodie_patterned_front.png', 0.84, 0.9], ['hoodie_print_front.png', 1.02, 0.78]] as const) {
    test(file, async () => {
      const a = await analyze(file);
      expect(a.ok).toBe(true);
      expect(Math.abs(a.ratios.widthToLength - wl) / wl).toBeLessThan(0.1);
      expect(Math.abs(a.ratios.sleeveToLength - sl) / sl).toBeLessThan(0.15);
      expect(a.hoodDetected).toBe(true);
    });
  }
  test('JPEG and PNG of the same image agree closely', async () => {
    expect(Math.abs((await analyze('hoodie_front.jpg')).ratios.widthToLength - (await analyze('hoodie_front.png')).ratios.widthToLength)).toBeLessThan(0.02);
  });
  test('colour is measured', async () => {
    expect(colorDistance((await analyze('hoodie_front.png')).medianColor, '#56687a')).toBeLessThan(25);
  });
});

describe('hard inputs fail honestly', () => {
  test('blank image finds no garment', async () => {
    const a = await analyze('blank.png');
    expect(a.ok).toBe(false);
    expect(a.confidence).toBe(0);
  });
  test('no hood is reported rather than invented', async () => {
    const a = await analyze('tshirt_no_hood.png');
    expect(a.hoodDetected).toBe(false);
    expect(a.warnings.join(' ')).toContain('hood');
  });
  test('busy background lowers confidence and warns', async () => {
    const clean = await analyze('hoodie_front.png');
    const busy = await analyze('hoodie_busy_background.png');
    expect(busy.confidence).toBeLessThan(clean.confidence);
    expect(busy.warnings.join(' ')).toContain('background');
  });
});
