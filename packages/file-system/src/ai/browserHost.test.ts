import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ steps: [] as string[], start: vi.fn(), stage: vi.fn(), change: vi.fn() }));
vi.mock('../live/election.js', () => ({ getTabId: () => 'host', createElection: () => ({ tabId: 'host', isLeader: true, leader: { id: 'elected-host', tabId: 'host', term: 1 }, onChange: () => () => {}, destroy: vi.fn() }) }));
vi.mock('../live/bus.js', () => ({ createLiveBus: () => ({ broadcast: vi.fn(), onMessage: () => () => {}, destroy: vi.fn() }) }));
vi.mock('../services/ops.js', () => ({ startOp: mocks.start, opsService: async () => ({ change: mocks.change }) }));
vi.mock('../services/landing.js', () => ({ stageOpResult: mocks.stage }));
import { browserAiHost, configureBrowserAiHost, registerBrowserAiHandler, runBrowserAi } from './browserHost.js';
const landing = { kind: 'vfs-folder' as const, folderId: 'chosen-folder', name: 'out.txt' };
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
beforeEach(() => {
 vi.stubGlobal('window', {}); vi.stubGlobal('navigator', { locks: {} }); vi.stubGlobal('BroadcastChannel', class {});
 mocks.steps.length = 0; mocks.start.mockReset(); mocks.stage.mockReset(); mocks.change.mockReset();
 mocks.stage.mockImplementation(async () => { mocks.steps.push('capture'); return { kind: 'opfs-file', path: 'run', contentType: 'text/plain' }; });
 mocks.start.mockImplementation(async (input) => {
  mocks.steps.push('start'); const controller = new AbortController();
  input.signal?.addEventListener('abort', () => controller.abort(input.signal.reason), { once: true });
  return { id: 'run', signal: controller.signal, progress: vi.fn(), done: async () => { mocks.steps.push('done'); }, fail: async () => { mocks.steps.push('failed'); }, cancelled: async () => { mocks.steps.push('cancelled'); } };
 });
 configureBrowserAiHost({ chooseOutput: async () => landing, land: async () => { mocks.steps.push('land'); } });
 registerBrowserAiHandler('test', { kind: 'transcribe', run: async (_action, _payload, ctx) => { ctx.state('loaded'); mocks.steps.push('inference'); return 'words'; }, capture: (result) => new Blob([String(result)], { type: 'text/plain' }), dispose: vi.fn() });
});
describe('browser host durable execution', () => {
 it('passes the actual audio-tool container to output selection and keeps its op kind', async () => {
  const videoLanding = { kind: 'vfs-folder' as const, folderId: 'chosen-folder', name: 'upsampled.mp4' };
  const chooseOutput = vi.fn(async () => videoLanding);
  configureBrowserAiHost({ chooseOutput, land: async () => {} });
  registerBrowserAiHandler('audio-container', { kind: 'audio-tool', run: async () => new Blob(['video'], { type: 'video/mp4' }), capture: (result) => result as Blob, dispose: vi.fn() });
  const result = await runBrowserAi<Blob>('audio-container', 'upsample', {}, 'NovaSR', { title: 'Upsample', outputExtension: '.mp4' });
  expect(chooseOutput).toHaveBeenCalledWith('audio-tool', 'Upsample', '.mp4');
  expect(mocks.start).toHaveBeenCalledWith(expect.objectContaining({ kind: 'audio-tool', landing: videoLanding }));
  expect(result.type).toBe('video/mp4');
 });
 it('chooses output, owns the op, captures and lands before returning output', async () => {
  expect(await runBrowserAi('test', 'transcribe', {}, 'test-model')).toBe('words');
  expect(mocks.steps).toEqual(['start', 'inference', 'capture', 'done', 'land']);
  expect(mocks.start.mock.calls[0][0]).toMatchObject({ kind: 'transcribe', landing, where: { executor: 'this-browser', note: 'Shared browser AI host' } });
 });
 it('refuses inference without a selected output before creating an op', async () => {
  configureBrowserAiHost({ chooseOutput: async () => null });
  await expect(runBrowserAi('test', 'transcribe', {}, 'test-model')).rejects.toMatchObject({ name: 'AbortError' });
  expect(mocks.start).not.toHaveBeenCalled();
 });
 it('loads weights without creating an inference output or op', async () => {
  await runBrowserAi('test', 'load', {}, 'test-model'); expect(mocks.start).not.toHaveBeenCalled(); expect(mocks.stage).not.toHaveBeenCalled();
 });
 it('leaves durable output available when its destination cannot be reached', async () => {
  configureBrowserAiHost({ land: async () => { throw new Error('destination removed'); } });
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try { expect(await runBrowserAi('test', 'transcribe', {}, 'test-model', { landing })).toBe('words'); expect(mocks.steps).toContain('capture'); expect(mocks.steps).toContain('done'); expect(mocks.steps).not.toContain('failed'); }
  finally { warning.mockRestore(); }
 });
 it('reports a missing saved chat after capture while retaining its done result and loaded model', async () => {
  configureBrowserAiHost({ land: async () => undefined });
  registerBrowserAiHandler('chat-test', { kind: 'chat', run: async (_action, _payload, ctx) => { ctx.state('loaded'); return 'saved reply'; }, capture: (reply) => new Blob([String(reply)], { type: 'text/plain' }), dispose: vi.fn() });
  await expect(runBrowserAi('chat-test', 'generate', {}, 'chat-model', {
   landing: { kind: 'session', app: 'ai-chats', sessionId: 'deleted-chat' },
   chat: { userText: 'Question', connection: { name: 'Browser', model: 'chat-model' } }
  })).rejects.toThrow('Reply finished; its saved chat destination is unavailable. Open Ops to review it.');
  expect(mocks.steps).toEqual(['start', 'capture', 'done']);
  expect(browserAiHost().models['chat-model']).toBe('loaded');
 });
 it('returns a saved chat reply only after its explicit session landing succeeds', async () => {
  configureBrowserAiHost({ land: async () => ({ kind: 'session', sessionId: 'saved-chat' }) });
  registerBrowserAiHandler('chat-landed', { kind: 'chat', run: async (_action, _payload, ctx) => { ctx.state('loaded'); return 'saved reply'; }, capture: (reply) => new Blob([String(reply)]), dispose: vi.fn() });
  expect(await runBrowserAi('chat-landed', 'generate', {}, 'chat-model', {
   landing: { kind: 'session', app: 'ai-chats', sessionId: 'saved-chat' },
   chat: { userText: 'Question', connection: { name: 'Browser', model: 'chat-model' } }
  })).toBe('saved reply');
 });
 it('user cancellation records cancelled and never captures an abandoned result', async () => {
  let started!: () => void; const ready = new Promise<void>((resolve) => { started = resolve; });
  registerBrowserAiHandler('cancel-test', { kind: 'transcribe', run: async (_action, _payload, ctx) => { started(); return new Promise((_, reject) => ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason), { once: true })); }, capture: () => assertNever(), dispose: vi.fn() });
  const controller = new AbortController();
  const promise = runBrowserAi('cancel-test', 'transcribe', {}, 'test-model', { landing, signal: controller.signal });
  const rejected = expect(promise).rejects.toMatchObject({ name: 'AbortError' });
  await ready; controller.abort(); await rejected; await tick();
  expect(mocks.steps).toContain('cancelled'); expect(mocks.stage).not.toHaveBeenCalled();
 });
});
function assertNever(): Blob { throw new Error('cancelled output must not be captured'); }
