/** NovaSR weights are explicitly imported in Settings; engines never download. */
import { browserModelStore, type ModelDef } from '@shared-packages/model-store';

export const NOVASR_MODEL: ModelDef = {
  "id": "speech:novasr",
  "task": "audio-upsampling",
  "label": "NovaSR",
  "license": "Apache-2.0",
  "files": [
    {
      "path": "novasr.onnx",
      "bytes": 228736,
      "blake3": "f65dfab59e7fd9182c96d5dbb56ee98cb0e75294d93026f5cdba9ab3cd36116d",
      "url": "https://huggingface.co/TigreGotico/audiosronnx-novasr/resolve/5d92bf1488aae6d92356ef5951c7ef9bf9f9801b/novasr.onnx"
    }
  ],
  "origin": {
    "kind": "hf",
    "repo": "TigreGotico/audiosronnx-novasr",
    "revision": "5d92bf1488aae6d92356ef5951c7ef9bf9f9801b"
  }
};
export const NOVASR_MODEL_URL = NOVASR_MODEL.files[0]!.url!;

export async function inspectNovasrModel(): Promise<'installed' | 'partial' | 'not-installed'> {
  const status = await browserModelStore.status(NOVASR_MODEL, true);
  return status.ready ? 'installed' : status.files.some(file => file.actual) ? 'partial' : 'not-installed';
}
export async function removeNovasrModel(): Promise<void> {
  await browserModelStore.clearModel(NOVASR_MODEL.id);
}
/** Cached sessions must notice clears and replacements before the next run. */
export async function novasrModelRevision(signal?: AbortSignal): Promise<string> {
  return browserModelStore.readReady(NOVASR_MODEL, async files => files.manifest.revision, { signal });
}
export async function loadNovasrModel(signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  return browserModelStore.readReady(NOVASR_MODEL, async files => {
    signal.throwIfAborted();
    const bytes = new Uint8Array(await (await files.file('novasr.onnx')).arrayBuffer());
    signal.throwIfAborted();
    return bytes;
  }, { signal, verify: true });
}
