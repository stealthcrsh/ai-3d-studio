import { executeStage, type StageTask } from '../engine/stages.ts';
import { canvasCodec, IndexedDbStorage } from './platform.ts';

self.onmessage = async (m: MessageEvent<StageTask>) => {
  try {
    const storage = await IndexedDbStorage.open();
    await executeStage(m.data, storage, canvasCodec, (progress) => self.postMessage({ type: 'progress', progress }));
    self.postMessage({ type: 'done' });
  } catch (e) {
    self.postMessage({ type: 'error', message: e instanceof Error ? e.message : String(e) });
  }
};
