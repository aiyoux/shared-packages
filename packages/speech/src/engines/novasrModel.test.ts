import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NOVASR_MODEL, inspectNovasrModel, loadNovasrModel, removeNovasrModel } from './novasrModel.js';
const store = vi.hoisted(() => ({ status: vi.fn(), readReady: vi.fn(), clearModel: vi.fn() }));
vi.mock('@shared-packages/model-store', () => ({ browserModelStore: store }));
const network = vi.fn();
beforeEach(() => { vi.clearAllMocks(); vi.stubGlobal('fetch', network); });
afterEach(() => vi.unstubAllGlobals());
describe('NovaSR explicit model storage', () => {
  it('reports missing and partial weights without a network request', async () => {
    store.status.mockResolvedValue({ ready: false, files: [{ state: 'missing' }] });
    await expect(inspectNovasrModel()).resolves.toBe('not-installed');
    store.status.mockResolvedValue({ ready: false, files: [{ state: 'hash-mismatch', actual: {} }] });
    await expect(inspectNovasrModel()).resolves.toBe('partial');
    expect(store.status).toHaveBeenCalledWith(NOVASR_MODEL, true);
    expect(network).not.toHaveBeenCalled();
  });
  it('does not fetch or replace weights when the store rejects a missing file', async () => {
    store.readReady.mockRejectedValue(new Error('novasr.onnx is missing. Load it in Settings → AI models.'));
    await expect(loadNovasrModel(new AbortController().signal)).rejects.toThrow('Settings → AI models');
    expect(network).not.toHaveBeenCalled();
  });
  it('uses the verified locked snapshot until bytes are materialized', async () => {
    let reading = false;
    store.readReady.mockImplementation(async (def, run, options) => {
      expect(def.files[0].blake3).toMatch(/^[a-f0-9]{64}$/);
      expect(options.verify).toBe(true);
      reading = true;
      const result = await run({ file: async () => {
        expect(reading).toBe(true); return new File(['model'], 'novasr.onnx');
      } });
      reading = false; return result;
    });
    expect(new TextDecoder().decode(await loadNovasrModel(new AbortController().signal))).toBe('model');
    expect(network).not.toHaveBeenCalled();
  });
  it('clears only the dedicated model id', async () => {
    await removeNovasrModel();
    expect(store.clearModel).toHaveBeenCalledExactlyOnceWith(NOVASR_MODEL.id);
  });
});
