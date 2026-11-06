import type { ImageCodec, RGBAImage } from '../core/vision.ts';
import type { StageHandle, StageRunner, Storage } from '../engine/platform.ts';
import type { StageTask } from '../engine/stages.ts';

/** Project files live in the browser's IndexedDB, on the user's own device. */
export class IndexedDbStorage implements Storage {
  kind = 'indexeddb';
  durable = true;
  private constructor(private db: IDBDatabase) {}

  static open(): Promise<IndexedDbStorage> {
    return new Promise((res, rej) => {
      const r = indexedDB.open('ai-3d-studio', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('files');
      r.onsuccess = () => res(new IndexedDbStorage(r.result));
      r.onerror = () => rej(r.error);
      r.onblocked = () => rej(new Error('Storage is blocked by another tab.'));
    });
  }

  private tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T> {
    return new Promise((res, rej) => {
      const t = this.db.transaction('files', mode);
      const req = fn(t.objectStore('files'));
      t.oncomplete = () => res((req ? req.result : undefined) as T);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error ?? new Error('Storage is full or unavailable.'));
    });
  }

  async read(path: string) {
    const v = await this.tx<Uint8Array | undefined>('readonly', (s) => s.get(path));
    return v ? new Uint8Array(v) : null;
  }

  writeMany(entries: [string, Uint8Array][]) {
    return this.tx<void>('readwrite', (s) => {
      for (const [k, v] of entries) s.put(v, k);
    });
  }

  async exists(path: string) {
    return (await this.tx<number>('readonly', (s) => s.count(path))) > 0;
  }

  private range = (prefix: string) => IDBKeyRange.bound(prefix, `${prefix}￿`);

  async list(prefix: string) {
    return (await this.tx<IDBValidKey[]>('readonly', (s) => s.getAllKeys(this.range(prefix)))) as string[];
  }

  removePrefix(prefix: string) {
    return this.tx<void>('readwrite', (s) => {
      s.delete(this.range(prefix));
    });
  }
}

/** Fallback when the browser blocks storage, such as some private windows. Work is lost when the tab closes. */
export class MemoryStorage implements Storage {
  kind = 'memory';
  durable = false;
  private files = new Map<string, Uint8Array>();
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

/** Pixel decoding and encoding through the browser's own image code. Works inside Workers. */
export const canvasCodec: ImageCodec = {
  async decode(bytes, kind) {
    const bitmap = await createImageBitmap(new Blob([bytes.slice()], { type: `image/${kind}` }));
    const c = new OffscreenCanvas(bitmap.width, bitmap.height);
    const g = c.getContext('2d', { willReadFrequently: true })!;
    g.drawImage(bitmap, 0, 0);
    bitmap.close();
    const d = g.getImageData(0, 0, c.width, c.height);
    return { width: d.width, height: d.height, data: new Uint8Array(d.data.buffer) };
  },
  encodeJpeg: (img, quality) => encode(img, 'image/jpeg', quality),
  encodePng: (img) => encode(img, 'image/png'),
};

async function encode(img: RGBAImage, type: string, quality?: number) {
  const c = new OffscreenCanvas(img.width, img.height);
  c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(img.data.buffer, img.data.byteOffset, img.data.byteLength) as Uint8ClampedArray<ArrayBuffer>, img.width, img.height), 0, 0);
  return new Uint8Array(await (await c.convertToBlob({ type, quality })).arrayBuffer());
}

/**
 * Each stage gets its own Worker. terminate() stops it immediately, even mid-solver, which is what makes cancel real.
 * When storage fell back to memory, Workers cannot see it, so stages run on the page instead and cancel takes effect
 * between stages only.
 */
export class WorkerStageRunner implements StageRunner {
  constructor(private memory: Storage | null) {}

  start(task: StageTask, onProgress: (p: { phase: string; frame: number; total: number }) => void): StageHandle {
    if (this.memory) {
      const storage = this.memory;
      let killed = false;
      const done = import('../engine/stages.ts').then(({ executeStage }) =>
        executeStage(task, storage, canvasCodec, (p) => {
          if (killed) throw new Error('cancelled');
          onProgress(p);
        }),
      );
      return { done, kill: () => (killed = true) };
    }
    const worker = new Worker(new URL('./stage.worker.ts', import.meta.url), { type: 'module' });
    let settle: { res: () => void; rej: (e: Error) => void };
    const done = new Promise<void>((res, rej) => (settle = { res, rej }));
    worker.onmessage = (m) => {
      if (m.data.type === 'progress') onProgress(m.data.progress);
      else if (m.data.type === 'done') {
        worker.terminate();
        settle.res();
      } else if (m.data.type === 'error') {
        worker.terminate();
        settle.rej(new Error(m.data.message));
      }
    };
    worker.onerror = (e) => {
      worker.terminate();
      settle.rej(new Error(e.message || 'The worker failed to start.'));
    };
    worker.postMessage(task);
    return {
      done,
      kill: () => {
        worker.terminate();
        settle.rej(new Error('cancelled'));
      },
    };
  }
}
