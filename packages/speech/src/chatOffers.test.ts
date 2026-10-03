import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { BROWSER_CHAT_MODELS } from './models.js';

/** The model store is faked: `status` is what readReady consults, so a
 * def counts as loaded exactly when this resolves `{ ready: true }` (a
 * rejection plays a store the browser cannot open). */
const statusMock = vi.fn();
vi.mock('@shared-packages/model-store', () => ({
	browserModelStore: { status: (...args: unknown[]) => statusMock(...args) },
	transformersCache: vi.fn()
}));

// Real file-system/ai and the real readiness wiring: the test proves the
// whole chain, not a copy of it.
import { chatBrowserModelDef, chatBrowserOffers } from './chatOffers.js';

const gpuDef = BROWSER_CHAT_MODELS.webgpu.model;
const cpuDef = BROWSER_CHAT_MODELS.wasm.model;

afterEach(() => {
	delete (navigator as { gpu?: unknown }).gpu;
});

describe("chatBrowserOffers", () => {
	beforeEach(() => {
		statusMock.mockReset();
	});

	it("maps a chat offer onto the def its device variant runs", () => {
		expect(chatBrowserModelDef({ variantId: "wasm" } as never)).toBe(cpuDef);
		expect(chatBrowserModelDef({ variantId: "webgpu" } as never)).toBe(gpuDef);
		// Anything else runs the CPU build, like the worker does.
		expect(chatBrowserModelDef({ variantId: "gpu" } as never)).toBe(cpuDef);
	});

	it("hides the chat model while its files are not loaded", async () => {
		statusMock.mockRejectedValue(new Error("MISSING_FILES"));
		await expect(chatBrowserOffers()).resolves.toEqual([]);
		expect(statusMock).toHaveBeenCalledWith(cpuDef);
	});

	it("hides a stored-but-incomplete variant and keeps the loaded one", async () => {
		(navigator as { gpu?: unknown }).gpu = { requestAdapter: async () => ({}) };
		statusMock.mockImplementation((def: unknown) =>
			def === cpuDef ? Promise.resolve({ ready: true, files: [] }) : Promise.resolve({ ready: false, files: [] })
		);
		const offers = await chatBrowserOffers();
		expect(offers.map((o) => o.id)).toEqual(["browser:smollm2-135m:cpu"]);
		expect(statusMock).toHaveBeenCalledWith(gpuDef);
	});

	it("shows both variants when both are loaded and WebGPU is available", async () => {
		(navigator as { gpu?: unknown }).gpu = { requestAdapter: async () => ({}) };
		statusMock.mockResolvedValue({ ready: true, files: [] });
		const offers = await chatBrowserOffers();
		expect(offers.map((o) => o.id)).toEqual(["browser:smollm2-135m:cpu", "browser:smollm2-135m:gpu"]);
	});
});