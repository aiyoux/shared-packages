import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runAiMedia, type AiOffer } from './catalog.js';
const native: AiOffer = { id: 'sdxs', name: 'SDXS', modelId: 'sdxs', sourceId: 'sdxs', variantId: 'gpu', deviceClass: 'gpu', task: 'image-generation', location: 'monitor-native', supported: true, ready: true, available: true, reason: null };
const baseUrl = 'https://monitor.test';
let requests: string[];
beforeEach(() => {
 requests = [];
 vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
  const path = new URL(String(input)).pathname;
  requests.push(path);
  const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
  if (path === '/v1/meta') return json({ name: 'Test', features: ['ai'], capabilities: { jobs: true } });
  if (path === '/v1/ai/jobs') return json({ jobId: 'preview' });
  if (path === '/v1/ai/jobs/preview') return json({ state: 'done', seed: 42 });
  if (path === '/v1/ai/jobs/preview/result') return new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'image/png' } });
  if (path === '/v1/jobs/ai%3Apreview/landed') return json({});
  throw new Error(`Unexpected request: ${path}`);
 }));
});
afterEach(() => vi.unstubAllGlobals());
describe('monitor image previews', () => {
 it('collects native image bytes before releasing the temporary monitor result', async () => {
  const output = await runAiMedia(baseUrl, native, { prompt: 'A fox' }, { preview: true });
  expect(output.seed).toBe(42);
  expect(output.blob.type).toBe('image/png');
  expect([...new Uint8Array(await output.blob.arrayBuffer())]).toEqual([1, 2, 3]);
  expect(requests.slice(-2)).toEqual(['/v1/ai/jobs/preview/result', '/v1/jobs/ai%3Apreview/landed']);
 });
 it('uses the cancellable job path for providers on monitors supporting jobs', async () => {
  await runAiMedia(baseUrl, { ...native, location: 'monitor-provider' }, { prompt: 'A fox' }, { preview: true });
  expect(requests).toContain('/v1/ai/jobs');
  expect(requests).toContain('/v1/jobs/ai%3Apreview/landed');
 });
 it('keeps the image preview available if releasing the monitor result fails', async () => {
  const realFetch = globalThis.fetch;
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => String(input).endsWith('/landed') ? new Response('', { status: 503 }) : realFetch(input, init)));
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
   const output = await runAiMedia(baseUrl, native, { prompt: 'A fox' }, { preview: true });
   expect(output.blob.size).toBe(3);
   expect(warning).toHaveBeenCalled();
  } finally { warning.mockRestore(); }
 });
 it('keeps speech on the durable output path', async () => {
  await expect(runAiMedia(baseUrl, { ...native, task: 'text-to-speech' }, { text: 'Hello' }, { preview: true })).rejects.toThrow('Memory previews are only supported for image generation');
  expect(requests).toEqual([]);
 });
});
