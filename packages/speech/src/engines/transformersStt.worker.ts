import { transformersStt } from './transformersStt.js';
import { serveWorkerRpc } from './workerRpc.js';
import type { TtsLoadOpts } from '../types.js';

serveWorkerRpc({
 async load(payload, progress) {
  const selection = payload.selection as TtsLoadOpts;
  await transformersStt.load(selection.modelId, { ...selection, onProgress: progress });
  return { result: undefined };
 },
 async transcribe(payload, progress) {
  const result = await transformersStt.transcribe(payload.audio as Float32Array, payload.sampleRate as number, { language: payload.language as string | undefined, onProgress: progress });
  return { result };
 }
});
