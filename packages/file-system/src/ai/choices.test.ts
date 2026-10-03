/**
 * browserChatOffers: the readiness filter that drops variants whose model
 * files are not loaded (speech supplies the predicate; the offers and their
 * identity stay here so a saved model ref keeps matching).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { browserChatOffers } from './choices.js';

const ready = { requestAdapter: async () => ({}) };

afterEach(() => {
	delete (navigator as { gpu?: unknown }).gpu;
});

describe('browserChatOffers', () => {
	it('returns the offers unchanged without a readiness filter', async () => {
		await expect(browserChatOffers()).resolves.toMatchObject([
			{ id: 'browser:smollm2-135m:cpu', modelId: 'onnx-community/SmolLM2-135M-Instruct-ONNX', ready: true }
		]);
	});

	it('keeps the offers identity when a readiness filter passes them', async () => {
		const offers = await browserChatOffers(async () => true);
		expect(offers.map((o) => o.id)).toEqual(['browser:smollm2-135m:cpu']);
	});

	it('drops every offer when readiness fails it', async () => {
		await expect(browserChatOffers(async () => false)).resolves.toEqual([]);
	});

	it('keeps only the variants that are actually loaded, per device', async () => {
		(navigator as { gpu?: unknown }).gpu = ready;
		const offers = await browserChatOffers(async (offer) => offer.variantId === 'webgpu');
		expect(offers.map((o) => o.id)).toEqual(['browser:smollm2-135m:gpu']);
	});
});