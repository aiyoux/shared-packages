# `@shared-packages/speech`

Browser speech engines behind one STT / TTS API, following the compress/crypto
pattern:

**Speech-to-text**

- **webspeech** — the browser's Web Speech API (standardized in Chrome 139+;
  on-device mode via `available()`/`install()`/`processLocally` where offered).
- **transformers** — Whisper and Moonshine fully in-tab via transformers.js +
  ONNX Runtime WebAssembly, with weights stored in the shared VFS.
- **ai** — audio-capable upstream models through the monitor's AI connection
  (`/v1/ai/chat/completions` with `input_audio` parts).

**Text-to-speech**

- **webspeech** — `speechSynthesis` OS voices, live read-aloud only.
- **kokoro** — Kokoro-82M via kokoro-js, WASM, exports WAV.

**Model store** — weights are fetched from the HF CDN on first use (streamed,
SHA-256 hashed, progress reported) into `Speech Models/<engine>/<model>/` in
the shared VFS, so they appear in the File Explorer and persist across
reloads. A `manifest.json` sidecar per model records source URL, size, and
hashes; corruption is detected by size, and hashing is an explicit verify
action.

This is the library. Product UI (engine pickers, mic controls, transcripts)
stays in the consumer.

## Usage

```ts
import {
  listSttEngines, loadSttEngine,
  decodeToMono16k, getSpeechModelStore, sttModelsFor
} from '@shared-packages/speech';

const engine = await loadSttEngine('transformers');
await engine.load('whisper-tiny', { onProgress: console.log });
const decoded = await decodeToMono16k(audioBlob);
const result = await engine.transcribe(decoded.samples, decoded.sampleRate);
```

Heavy dependencies (`@huggingface/transformers`, `kokoro-js`) are reachable
only through `loadSttEngine` / `loadTtsEngine` dynamic imports — importing the
barrel for types and catalogs never pulls ORT into the bundle.

## Licenses

All bundled engines and their models are Apache-2.0 (transformers.js,
kokoro-js, Kokoro-82M, Whisper, Moonshine) or browser built-ins.

## Local development

Consumers depend on this package via `file:`. Edit here and they HMR. Run
`npm install` in a consumer only when `exports` change.