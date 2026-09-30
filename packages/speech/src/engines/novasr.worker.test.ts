import { afterEach, describe, expect, it, vi } from 'vitest';

const runtime = vi.hoisted(() => ({
	env: { wasm: { wasmPaths: '', numThreads: 0, proxy: true } },
	InferenceSession: { create: vi.fn() }
}));
vi.mock('onnxruntime-web', () => runtime);

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); runtime.InferenceSession.create.mockReset(); });

describe('NovaSR worker loading', () => {
	it.each([false, true])('uses the vendored WASM pair with crossOriginIsolated=%s', async (isolated) => {
		const scope = { onmessage: null as ((event: MessageEvent) => void) | null, postMessage: vi.fn() };
		vi.stubGlobal('self', scope);
		vi.stubGlobal('crossOriginIsolated', isolated);
		const session = { inputNames: ['x'], outputNames: ['y'], run: vi.fn() };
		runtime.InferenceSession.create.mockResolvedValue(session);
		await import('./novasr.worker.js');
		const model = new Uint8Array([1, 2, 3]);
		scope.onmessage!({ data: { id: 1, op: 'load', model } } as MessageEvent);
		await vi.waitFor(() => expect(scope.postMessage).toHaveBeenCalledWith({ id: 1, ok: true, result: true }, []));
		expect(runtime.env.wasm).toEqual({ wasmPaths: '/vendor/ort/', numThreads: isolated ? 2 : 1, proxy: false });
		expect(runtime.InferenceSession.create).toHaveBeenCalledWith(model, { executionProviders: ['wasm'] });
	});
});
