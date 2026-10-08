/**
 * AI selection store tests (fake-indexeddb): the per-task map, the
 * app->default fallback, and same-tab subscription delivery.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import {
	closeSelectionDbForTests,
	EMPTY_SELECTION_MAP,
	getAiSelectionMap,
	matchAiModelRef,
	offerAiRef,
	resolveAiModelRef,
	setAiModelRef,
	setAiSelectionMap,
	subscribeAiSelection,
	type AiModelRef
} from './selection.js';
import { HUB_AI_DB_NAME } from './types.js';
import type { AiOffer } from './catalog.js';

async function wipeDb() {
	await closeSelectionDbForTests();
	await new Promise<void>((resolve) => {
		const req = indexedDB.deleteDatabase(HUB_AI_DB_NAME);
		req.onsuccess = req.onerror = req.onblocked = () => resolve();
	});
}

afterEach(async () => {
	await closeSelectionDbForTests();
});

describe('AI selection store', () => {
	beforeEach(async () => {
		await wipeDb();
	});

	it('persists a ref handed over as a proxy (Svelte $state), not just plain objects', async () => {
		const ref: AiModelRef = { location: 'browser', modelId: 'paddle', sourceId: null, variantId: null };
		await setAiModelRef('ocr', 'ocr-tool', new Proxy(ref, {}));
		expect(resolveAiModelRef(await getAiSelectionMap(), 'ocr', 'ocr-tool')).toEqual(ref);
	});

	it('reads the empty default when nothing has been saved', async () => {
		expect(await getAiSelectionMap()).toEqual(EMPTY_SELECTION_MAP);
		expect(resolveAiModelRef(await getAiSelectionMap(), 'chat', 'kb-chat')).toBeNull();
	});

	it('round-trips one ref through set/get', async () => {
		const ref: AiModelRef = {
			location: 'browser',
			modelId: 'whisper/small',
			sourceId: 'transformers',
			variantId: 'webgpu'
		};
		const map = await setAiModelRef('transcription', 'transcribe', ref);
		expect(map.tasks.transcription?.transcribe).toEqual(ref);
		expect(await getAiSelectionMap()).toEqual(map);
		expect(resolveAiModelRef(await getAiSelectionMap(), 'transcription', 'transcribe')).toEqual(ref);
	});

	it('clears one cell without touching the others', async () => {
		await setAiModelRef('transcription', 'transcribe', { location: 'monitor-native', modelId: 'w', sourceId: null, variantId: 'cpu' });
		await setAiModelRef('text-to-speech', 'speak', { location: 'browser', modelId: 'kokoro', sourceId: 'kokoro', variantId: null });
		await setAiModelRef('transcription', 'transcribe', null);
		const map = await getAiSelectionMap();
		expect(map.tasks.transcription?.transcribe).toBeUndefined();
		let count = 0;
		for (const t of Object.values(map.tasks)) count += Object.keys(t ?? {}).length;
		expect(count).toBe(1);
	});

	it('falls back to the task default row', async () => {
		await setAiModelRef('chat', 'default', { location: 'monitor-provider', modelId: 'm2', sourceId: 'profile-1', variantId: null, monitorProfileId: null });
		const map = await getAiSelectionMap();
		expect(resolveAiModelRef(map, 'chat', 'kb-chat')).toEqual(map.tasks.chat?.default);
		expect(resolveAiModelRef(map, 'chat', 'kb-chat')).toEqual(map.tasks.chat?.['default']);
		// The own cell wins over the task default.
		await setAiModelRef('chat', 'sketcher-assistant', { location: 'browser', modelId: 'smollm2-135m', sourceId: null, variantId: null });
		const next = await getAiSelectionMap();
		expect(resolveAiModelRef(next, 'chat', 'sketcher-assistant')?.modelId).toBe('smollm2-135m');
		expect(resolveAiModelRef(next, 'chat', 'kb-chat')?.modelId).toBe('m2');
	});

	it('reads a map saved under an older version as empty', async () => {
		await setAiSelectionMap({ v: 3, tasks: { chat: { default: { location: 'browser', modelId: 'm', sourceId: null, variantId: null } } } });
		// Simulate the v2 row directly under the same key.
		await closeSelectionDbForTests();
		await new Promise<void>((resolve, reject) => {
			const req = indexedDB.open(HUB_AI_DB_NAME, 3);
			req.onsuccess = () => {
				const db = req.result;
				const tx = db.transaction('selection', 'readwrite');
				tx.objectStore('selection').put({
					id: 'active', v: 2, monitorProfileId: null, aiProfileId: null, model: 'old-model', updatedAt: 0
				});
				tx.oncomplete = () => {
					db.close();
					resolve();
				};
				tx.onerror = () => reject(tx.error);
			};
			req.onerror = () => reject(req.error);
		});
		expect(await getAiSelectionMap()).toEqual(EMPTY_SELECTION_MAP);
	});

	it('delivers writes to subscribers, including this tab', async () => {
		const seen: Awaited<ReturnType<typeof getAiSelectionMap>>[] = [];
		const stop = subscribeAiSelection((map) => {
			seen.push(structuredClone(map) as typeof seen[number]);
		});
		// First delivery is the immediate read.
		await new Promise<void>((resolve) => {
			const t = setTimeout(resolve, 50);
			const check = () => {
				if (seen.length >= 1) {
					clearTimeout(t);
					resolve();
				} else {
					setTimeout(check, 5);
				}
			};
			check();
		});
		await setAiModelRef('chat', 'default', { location: 'browser', modelId: 'smollm2-135m', sourceId: null, variantId: null });
		// Second delivery: the write, surfaced through the same-tab subscriber.
		await new Promise<void>((resolve) => {
			const t = setTimeout(resolve, 200);
			const check = () => {
				if (seen.some((m) => m.tasks.chat?.default?.modelId === 'smollm2-135m')) {
					clearTimeout(t);
					resolve();
				} else {
					setTimeout(check, 10);
				}
			};
			check();
		});
		stop();
	});

	it('skips re-delivering when a write leaves the map identical', async () => {
		const seen: string[] = [];
		const stop = subscribeAiSelection((map) => seen.push(JSON.stringify(map)));
		// First delivery is the immediate read of an empty map.
		await new Promise<void>((resolve) => {
			const t = setTimeout(resolve, 250);
			const check = () => (seen.length > 0 ? (clearTimeout(t), resolve()) : setTimeout(check, 10));
			check();
		});
		expect(seen).toHaveLength(1);
		const ref: AiModelRef = { location: 'browser', modelId: 'smollm2-135m', sourceId: null, variantId: null };

		// Two writes that leave the map identical surface exactly one change.
		await setAiModelRef('chat', 'default', ref);
		await setAiModelRef('chat', 'default', ref);
		// Long enough that a non-deduped subscriber would have re-read.
		await new Promise((resolve) => setTimeout(resolve, 250));
		stop();
		expect(seen).toHaveLength(2);
	});
});

/** A minimal offer row with just the fields matching reads. */
function offer(id: string, over: Partial<AiOffer> = {}): AiOffer {
	return {
		id, name: id, task: 'chat', location: 'browser',
		modelId: 'm1', sourceId: 'p1', variantId: 'cpu',
		deviceClass: 'cpu', supported: true, ready: true, available: true, reason: null,
		...over
	};
}

describe('matchAiModelRef', () => {
	it('matches exact identity first, then model+location with a named source', () => {
		const offers = [
			offer('native', { location: 'monitor-native', modelId: 'llama', sourceId: 'n1', variantId: 'cuda' }),
			offer('provider', { location: 'monitor-provider', modelId: 'llama', sourceId: 'p1', variantId: 'service' })
		];
		const ref: AiModelRef = { location: 'monitor-native', modelId: 'llama', sourceId: 'n1', variantId: 'cuda' };
		expect(matchAiModelRef(ref, offers)?.id).toBe('native');

		// A ref written by an app without the exact variant still resolves:
		// loose pass over the same model + location with a named source.
		const loose: AiModelRef = { location: 'monitor-native', modelId: 'llama', sourceId: '', variantId: '' };
		const matched = matchAiModelRef(loose, offers);
		expect(matched?.id).toBe('native');
		// A ref with a source the catalog doesn't know stays null — a source
		// never reroutes to another connection's model.
		expect(matchAiModelRef({ ...ref, sourceId: 'other' }, offers)).toBeNull();
	});

	it('stays null when nothing matches', () => {
		const offers = [offer('a', { location: 'browser', modelId: 'k', sourceId: 'this-browser', variantId: 'cpu' })];
		expect(
			matchAiModelRef({ location: 'monitor-provider', modelId: 'k', sourceId: null, variantId: null }, offers)
		).toBeNull();
		expect(
			matchAiModelRef({ location: 'browser', modelId: 'other', sourceId: null, variantId: null }, offers)
		).toBeNull();
	});

	it('offerAiRef drops the browser display source and pins monitor refs to their monitor', () => {
		expect(
			offerAiRef(offer('b', { location: 'browser', modelId: 'k', sourceId: 'this-browser', variantId: 'cpu' }), null)
		).toEqual({ location: 'browser', modelId: 'k', sourceId: null, variantId: 'cpu', monitorProfileId: null });
		const provider = offer('p', { location: 'monitor-provider', modelId: 'k', sourceId: 'p1', variantId: 'service' });
		expect(offerAiRef(provider, 'home')).toEqual({ location: 'monitor-provider', modelId: 'k', sourceId: 'p1', variantId: 'service', monitorProfileId: 'home' });
		// A monitor ref that names no monitor would resolve to "whichever one".
		expect(() => offerAiRef(provider, null)).toThrow(/must name its monitor/);
	});
});