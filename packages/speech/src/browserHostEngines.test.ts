import { beforeEach, describe, expect, it, vi } from 'vitest';
const { run } = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('@shared-packages/file-system/ai', () => ({ registerBrowserAiHandler: vi.fn(), runBrowserAi: run }));
import { createHostedStt, createHostedTts } from './browserHostEngines.js';

beforeEach(() => { run.mockReset(); run.mockResolvedValue(undefined); });
describe('browser speech host clients', () => {
 it('sends selected model and audio once with its selected landing', async () => {
  const engine = createHostedStt();
  await engine.load('whisper-tiny', { dirId: 'weights' }); run.mockClear();
  const audio = new Float32Array([0.1, 0.2]);
  const landing = { kind: 'vfs-folder' as const, folderId: 'out', name: 'words.txt' };
  const result = { text: 'words', segments: [], durationMs: 1, engineId: 'transformers' };
  run.mockResolvedValueOnce(result);
  expect(await engine.transcribe(audio, 16000, { language: 'en', browserHost: { landing, title: 'Words' } })).toEqual(result);
  expect(run).toHaveBeenCalledTimes(1);
  expect(run.mock.calls[0].slice(0, 4)).toEqual(['speech:transformers', 'transcribe', { audio, sampleRate: 16000, language: 'en', selection: { modelId: 'whisper-tiny', dirId: 'weights' } }, 'whisper-tiny']);
  expect(run.mock.calls[0][4]).toMatchObject({ landing, title: 'Words' });
 });
 it('TTS sends full inference with host device and retains another client selection', async () => {
  const first = createHostedTts('kokoro'); const second = createHostedTts('kokoro');
  await first.load({ modelId: 'kokoro', dirId: 'a', device: 'wasm' });
  await second.load({ modelId: 'kokoro-f16', dirId: 'b', device: 'webgpu' }); run.mockClear();
  const landing = { kind: 'vfs-folder' as const, folderId: 'output', name: 'speech.wav' };
  await first.synthesize('one', { browserHost: { landing } });
  await second.synthesize('two', { browserHost: { landing } });
  expect(run.mock.calls[0][2].selection).toMatchObject({ dirId: 'a', device: 'wasm' });
  expect(run.mock.calls[1][2].selection).toMatchObject({ dirId: 'b', device: 'webgpu' });
  expect(run.mock.calls[1][5]).toEqual({ webgpu: true });
 });
 it('load forwards cancellation and progress without requesting inference output', async () => {
  const engine = createHostedTts('piper'); const controller = new AbortController(); const progress = vi.fn();
  await engine.load({ dirId: 'voice', signal: controller.signal, onProgress: progress });
  expect(run.mock.calls[0][1]).toBe('load'); expect(run.mock.calls[0][4].signal).toBe(controller.signal);
  run.mock.calls[0][4].onProgress({ file: 'voice.onnx', transferred: 10, done: false });
  expect(progress).toHaveBeenCalledWith({ file: 'voice.onnx', transferred: 10, done: false });
 });
});
