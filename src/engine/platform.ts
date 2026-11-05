import type { ImageCodec } from '../core/vision.ts';
import type { StageTask } from './stages.ts';

/** Everything the engine needs from its host. The browser supplies IndexedDB and Web Workers. */
export interface Storage {
  kind: string;
  durable: boolean;
  read(path: string): Promise<Uint8Array | null>;
  /** All entries land together or not at all, so an interrupted stage never leaves partial output. */
  writeMany(entries: [string, Uint8Array][]): Promise<void>;
  exists(path: string): Promise<boolean>;
  list(prefix: string): Promise<string[]>;
  removePrefix(prefix: string): Promise<void>;
}

export interface StageHandle {
  done: Promise<void>;
  /** Stops the stage at once, even inside a tight solver loop. */
  kill(): void;
}

export interface StageRunner {
  start(task: StageTask, onProgress: (p: { phase: string; frame: number; total: number }) => void): StageHandle;
}

export const textBytes = (s: string) => new TextEncoder().encode(s);
export const bytesText = (b: Uint8Array) => new TextDecoder().decode(b);

export async function readJson<T>(storage: Storage, path: string): Promise<T | null> {
  const b = await storage.read(path);
  return b ? (JSON.parse(bytesText(b)) as T) : null;
}

export type { ImageCodec };
