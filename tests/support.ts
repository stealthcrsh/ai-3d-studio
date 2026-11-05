import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import type { ImageCodec } from '../src/core/vision.ts';
import { executeStage, type StageTask } from '../src/engine/stages.ts';
import type { StageRunner, Storage } from '../src/engine/platform.ts';

/** Test stand-ins for browser APIs. The engine code under test is the same code the browser runs. */
export const nodeCodec: ImageCodec = {
  async decode(bytes, kind) {
    if (kind === 'png') {
      const p = PNG.sync.read(Buffer.from(bytes));
      return { width: p.width, height: p.height, data: new Uint8Array(p.data) };
    }
    const d = jpeg.decode(bytes, { useTArray: true });
    return { width: d.width, height: d.height, data: new Uint8Array(d.data) };
  },
  async encodeJpeg(img, quality) {
    return new Uint8Array(jpeg.encode({ data: img.data, width: img.width, height: img.height }, quality * 100).data);
  },
  async encodePng(img) {
    const p = new PNG({ width: img.width, height: img.height });
    p.data = Buffer.from(img.data);
    return new Uint8Array(PNG.sync.write(p));
  },
};

export class MapStorage implements Storage {
  kind = 'memory';
  durable = false;
  files = new Map<string, Uint8Array>();
  async read(path: string) {
    return this.files.get(path) ?? null;
  }
  async writeMany(entries: [string, Uint8Array][]) {
    for (const [k, v] of entries) this.files.set(k, v);
  }
  async exists(path: string) {
    return this.files.has(path);
  }
  async list(prefix: string) {
    return [...this.files.keys()].filter((k) => k.startsWith(prefix)).sort();
  }
  async removePrefix(prefix: string) {
    for (const k of [...this.files.keys()]) if (k.startsWith(prefix)) this.files.delete(k);
  }
}

/**
 * Runs stages in the test process. A kill takes effect at the next progress report, which approximates
 * Worker.terminate(). Real Worker termination is exercised in the browser run, see docs/reports/browser-run.md.
 */
export class InlineRunner implements StageRunner {
  /** Set to a stage name to hold that stage open until the test releases it. */
  holdStage: string | null = null;
  private release: (() => void) | null = null;
  reached: string[] = [];
  constructor(private storage: Storage) {}
  releaseHeld() {
    this.release?.();
  }
  start(task: StageTask, onProgress: (p: { phase: string; frame: number; total: number }) => void) {
    let killed = false;
    let rejectHold: ((e: Error) => void) | null = null;
    this.reached.push(task.stage);
    const hold = this.holdStage === task.stage ? new Promise<void>((res, rej) => { this.release = res; rejectHold = rej; }) : Promise.resolve();
    const done = hold.then(() => {
      if (killed) throw new Error('cancelled');
      return executeStage(task, this.storage, nodeCodec, (p) => {
        if (killed) throw new Error('cancelled');
        onProgress(p);
      });
    });
    return {
      done,
      kill: () => {
        killed = true;
        rejectHold?.(new Error('cancelled'));
      },
    };
  }
}
