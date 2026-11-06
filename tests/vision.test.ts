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

describe('WebP headers', () => {
  // Header-only byte layouts from the WebP container spec. Decoding is left to the browser and checked there.
  const webp = (chunk: string, body: number[]) => {
    const b = new Uint8Array(40);
    b.set([...'RIFF'].map((c) => c.charCodeAt(0)), 0);
    b.set([...`WEBP${chunk}`].map((c) => c.charCodeAt(0)), 8);
    b.set(body, 20);
    return b;
  };
  const lossy = webp('VP8 ', [0, 0, 0, 0x9d, 0x01, 0x2a, 0xe8, 0x03, 0xe2, 0x04]);
  const lossless = (() => {
    const v = (999 & 0x3fff) | ((1249 & 0x3fff) << 14);
    return webp('VP8L', [0x2f, v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]);
  })();
  const extended = (flags: number) => webp('VP8X', [flags, 0, 0, 0, 0xe7, 0x03, 0x00, 0xe1, 0x04, 0x00]);
  test('lossy, lossless and extended sizes are read', () => {
    for (const b of [lossy, lossless, extended(0x28)]) {
      expect(sniff(b, 'x.png')).toBe('webp');
      expect(readDimensions(b, 'webp')).toEqual({ width: 1000, height: 1250 });
      expect(checkImageHeader(b, 'webp')).toEqual({ width: 1000, height: 1250 });
    }
  });
  test('animated WebP is refused', () => {
    expect(() => checkImageHeader(extended(0x02), 'webp')).toThrow('Animated WebP');
  });
  test('an oversized WebP header is refused before decoding', () => {
    const b = extended(0);
    b.set([0xff, 0xff, 0x00, 0xff, 0xff, 0x00], 24);
    expect(() => checkImageHeader(b, 'webp')).toThrow('40 megapixels');
  });
  test('a WebP with an unknown first chunk is refused', () => {
    expect(() => checkImageHeader(webp('JUNK', []), 'webp')).toThrow('header is invalid');
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
  test('sleeves resting against the body do not widen the chest', async () => {
    const a = await analyze('hoodie_arms_down_front.png');
    expect(a.ok).toBe(true);
    expect(Math.abs(a.ratios.widthToLength - 0.95) / 0.95).toBeLessThan(0.1);
    expect(a.warnings.join(' ')).toContain('estimated from the hem');
  });
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
