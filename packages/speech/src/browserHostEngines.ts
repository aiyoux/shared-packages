import { registerBrowserAiHandler, runBrowserAi, type BrowserAiRunOptions } from '@shared-packages/file-system/ai';
import { STT_ENGINE_CATALOG, TTS_ENGINE_CATALOG, type SttEngine, type TtsEngine, type TtsLoadOpts, type TtsRender, type SttResult } from './types.js';
import { SegmentPlayer } from './engines/playback.js';
import { concatWav } from './wav.js';
import { KOKORO_82M } from './models.js';
import { DEFAULT_PIPER_VOICE } from './piperVoices.js';
import { createWorkerRpc, resetInferenceWorkers } from './engines/workerRpc.js';

type Selection = Pick<TtsLoadOpts, 'modelId' | 'dirId' | 'device'>;
type Payload = { selection: Selection; text?: string; audio?: Float32Array; sampleRate?: number; voice?: string; speed?: number; language?: string };
let installed = false;
const local = new Map<string, Promise<TtsEngine>>();
function engine(id: 'kokoro' | 'piper'): Promise<TtsEngine> {
 let pending = local.get(id);
 if (!pending) {
  pending = id === 'kokoro' ? import('./engines/kokoroTts.js').then((m) => m.kokoroTts)
   : import('./engines/piperTts.js').then((m) => m.piperTts);
  local.set(id, pending);
 }
 return pending;
}
/** Register lightweight loaders in every contender. No weights or inference
 * workers are created until the elected host receives a request. */
export function initializeSpeechBrowserHost(): void {
 if (installed) return; installed = true;
 let sttKey: string | null = null;
 const sttWorker = createWorkerRpc(() => new Worker(new URL('./engines/transformersStt.worker.ts', import.meta.url), { type: 'module', name: 'shared-transcription' }), 'Transformers STT', () => { sttKey = null; });
 for (const id of ['transformers', 'kokoro', 'piper'] as const) registerBrowserAiHandler(`speech:${id}`, {
  kind: id === 'transformers' ? 'transcribe' : 'speak',
  async run(action, value, context) {
   const payload = value as Payload;
   if (id === 'transformers') {
    const requested = JSON.stringify(payload.selection);
    if (sttKey !== requested) {
     context.state('loading');
     await sttWorker.call('load', { selection: payload.selection }, [], context.progress);
     context.signal.throwIfAborted(); sttKey = requested;
    }
    context.state('loaded');
    if (action === 'load') return undefined;
    return sttWorker.call('transcribe', { audio: payload.audio, sampleRate: payload.sampleRate, language: payload.language }, payload.audio?.buffer instanceof ArrayBuffer ? [payload.audio.buffer] : [], context.progress);
   }
   const source = await engine(id);
   context.state('loading');
   await (source as TtsEngine).load({ ...payload.selection, signal: context.signal, onProgress: context.progress });
   context.signal.throwIfAborted();
   if (action === 'load') { context.state(id === 'piper' ? 'not-loaded' : 'loaded'); return undefined; }
   if (id !== 'piper') context.state('loaded');
   const result = await source.synthesize(payload.text!, { voice: payload.voice, speed: payload.speed, signal: context.signal, onSegment: action === 'speak' ? undefined : context.progress, onAudioSegment: action === 'speak' ? (segment, index, total) => context.progress({ segment, index, total }) : undefined });
   context.state('loaded'); return result;
  },
  capture(result) {
   if (id === 'transformers') return new Blob([(result as SttResult).text], { type: 'text/plain' });
   const render = result as TtsRender;
   return new Blob([concatWav(render.segments, render.segments[0]?.sampleRate ?? 24000) as Uint8Array<ArrayBuffer>], { type: 'audio/wav' });
  },
  reply(result, action) { return action === 'speak' ? undefined : result; },
  dispose() {
   resetInferenceWorkers(id === 'transformers' ? 'Transformers STT' : id === 'kokoro' ? 'Kokoro' : 'Piper');
  }
 });
}

export function createHostedStt(): SttEngine {
 initializeSpeechBrowserHost();
 let selection: Selection = {};
 let recorder: import('./mic.js').MicRecorder | null = null;
 const info = STT_ENGINE_CATALOG.find((row) => row.id === 'transformers')!;
 const invoke = <T>(action: string, payload: Omit<Payload, 'selection'>, opts?: BrowserAiRunOptions) => runBrowserAi<T>('speech:transformers', action, { ...payload, selection: 'selection' in payload ? payload.selection : selection }, selection.modelId ?? 'Whisper/Moonshine', opts);
 const hosted: SttEngine = {
  info,
  async probe() { return { supported: typeof WebAssembly !== 'undefined' }; },
  async load(modelId, opts) {
   selection = { modelId: modelId ?? undefined, dirId: opts?.dirId };
   await invoke('load', {}, { signal: opts?.signal, onProgress: (p) => opts?.onProgress?.(p as Parameters<NonNullable<TtsLoadOpts['onProgress']>>[0]) });
  },
  async startListening() { const { createMicRecorder } = await import('./mic.js'); recorder = await createMicRecorder(); await recorder.start(); },
  async stopListening() {
   const current = recorder; recorder = null; if (!current) return '';
   const { decodeToMono16k } = await import('./audio.js');
   const audio = await decodeToMono16k(await current.stop());
   return (await hosted.transcribe(audio.samples, audio.sampleRate)).text;
  },
  transcribe(audio, sampleRate, opts) {
   return invoke<SttResult>('transcribe', { audio, sampleRate, language: opts?.language }, { ...opts?.browserHost, signal: opts?.signal, onProgress: (p) => opts?.onProgress?.(p as { doneChunks: number; chunks: number }) });
  }
 };
 return hosted;
}

export function createHostedTts(id: 'kokoro' | 'piper'): TtsEngine {
 initializeSpeechBrowserHost();
 let selection: Selection = {};
 const player = new SegmentPlayer();
 let speaking: AbortController | null = null;
 const info = TTS_ENGINE_CATALOG.find((row) => row.id === id)!;
 const invoke = <T>(action: string, payload: Omit<Payload, 'selection'>, opts?: BrowserAiRunOptions) => runBrowserAi<T>(`speech:${id}`, action, { ...payload, selection: 'selection' in payload ? payload.selection : selection }, selection.modelId ?? (id === 'piper' ? `piper-${payload.voice ?? DEFAULT_PIPER_VOICE}` : KOKORO_82M.id), opts, { webgpu: selection.device === 'webgpu' });
 const hosted: TtsEngine = {
  info,
  async load(opts) {
   selection = { modelId: opts?.modelId, dirId: opts?.dirId, device: opts?.device };
   await invoke('load', {}, { signal: opts?.signal, onProgress: (p) => opts?.onProgress?.(p as Parameters<NonNullable<TtsLoadOpts['onProgress']>>[0]) });
  },
  async listVoices() { return (await engine(id) as TtsEngine).listVoices(); },
  synthesize(text, opts) {
   return invoke<TtsRender>('synthesize', { text, voice: opts?.voice, speed: opts?.speed, ...(opts?.dirId ? { selection: { ...selection, dirId: opts.dirId } } : {}) }, { ...opts?.browserHost, title: opts?.browserHost?.title ?? text.slice(0, 80), signal: opts?.signal, onProgress: (p) => opts?.onSegment?.(p as { done: number; total: number }) });
  },
  async speak(text, opts) {
   hosted.stop(); const controller = new AbortController(); speaking = controller;
   const abort = () => controller.abort(opts?.signal?.reason);
   opts?.signal?.addEventListener('abort', abort, { once: true });
   if (opts?.signal?.aborted) abort();
   let playback: Promise<void> = Promise.resolve();
   try {
    await invoke<void>('speak', { text, voice: opts?.voice, speed: opts?.speed }, { ...opts?.browserHost, title: opts?.browserHost?.title ?? text.slice(0, 80), signal: controller.signal, onProgress(value) {
     const frame = value as { segment?: TtsRender['segments'][number]; index?: number; total?: number };
     if (!frame.segment) return;
     const segment = frame.segment;
     playback = playback.then(async () => {
      if (controller.signal.aborted) return;
      opts?.onProgress?.({ phase: 'playing', text: segment.text ?? text, segmentIndex: frame.index ?? 0, segmentCount: frame.total ?? 1 });
      await player.play({ segments: [segment], channels: 1 }, { signal: controller.signal });
     });
     playback.catch(() => {});
    } });
    await playback;
   } finally { controller.abort(); opts?.signal?.removeEventListener('abort', abort); if (speaking === controller) speaking = null; }
  },
  stop() { speaking?.abort(); speaking = null; player.stop(); }
 };
 return hosted;
}

export const hostedPiperTts = createHostedTts('piper');
