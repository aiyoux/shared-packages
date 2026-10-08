/**
 * App-side AI selection (HubAi DB, v3): one durable model choice per
 * task/app cell. Replaces the retired v2 row (which monitor, which daemon
 * profile, which model) — same single-row shape, now a map covering every
 * task the hub configures, not just chat.
 *
 * This store holds only *choices* (AiModelRef), never secrets and never
 * provider URLs: resolution back to a concrete offer is app-side, and the
 * read chain repairs silently only when the ref no longer matches anything
 * (per docs/design/unified-ai-pipeline.md — never reroute to another
 * computer or provider on a mismatch).
 *
 * No timers: a write pings the BroadcastChannel, subscribers re-read. There is
 * no election, lease, or liveness decision here (tab-coordination rules), so
 * last write wins across tabs — acceptable for a settings selection, and the
 * single-cell read-modify-write keeps concurrent writers from clobbering each
 * other's tasks.
 */
import type { AiLocation, AiOffer, AiTask } from './catalog.js';
import {
	HUB_AI_PROFILES_CHANNEL,
	notifyTabChannel,
	subscribeTabChannel
} from '../crossTab.js';
import { closeIdbForTests, openIdb } from '@shared-packages/ui/idb';
import { HUB_AI_DB_NAME, HUB_AI_META, HUB_AI_STORE } from './types.js';

/**
 * Tasks with a durable selection. The four monitor-routed tasks keep
 * `catalog.ts`'s union; the browser-only kinds join the same union so apps,
 * the settings tab, and the model library speak one vocabulary.
 */
export type AiTaskKey = AiTask | 'handwriting' | 'scan-detect' | 'ocr' | 'translate';

/**
 * One durable model choice — the identity fields of `AiOffer` minus task.
 * For kinds outside the monitor catalog (e.g. sketcher HWR engine or a scan
 * detector) this is the same shape with `location: 'browser'` and the
 * engine/detector id in `modelId`; they simply never have monitor locations.
 */
export type AiModelRef = {
	location: AiLocation;
	/** 'whisper/small' | 'smollm2-135m' | an image model id | an engine id. */
	modelId: string;
	/** Engine id, provider profile id, or native row id; null where it does not apply. */
	sourceId: string | null;
	/** Device variant, or the voice for TTS refs; null where it does not apply. */
	variantId: string | null;
	/** The saved monitor the choice runs on. Required for monitor locations:
	 * a monitor ref without one names no monitor and resolves to nothing.
	 * Null for browser refs. */
	monitorProfileId?: string | null;
};

/** task -> appId -> ref; `'default'` is the task-wide choice (chat stays global). */
export type AiSelectionMap = {
	v: 3;
	tasks: Partial<Record<AiTaskKey, Partial<Record<string, AiModelRef>>>>;
};

function openDb(): Promise<IDBDatabase> {
	// v3 replaces the v2 single chat selection with a per-task map.
	// Pre-release, no install base: another version reads as empty.
	return openIdb({
		name: HUB_AI_DB_NAME,
		version: 3,
		onUpgrade(db) {
			if (db.objectStoreNames.contains('profiles')) {
				db.deleteObjectStore('profiles');
			}
			if (!db.objectStoreNames.contains(HUB_AI_STORE)) {
				db.createObjectStore(HUB_AI_STORE, { keyPath: 'id' });
			}
			if (!db.objectStoreNames.contains(HUB_AI_META)) {
				db.createObjectStore(HUB_AI_META, { keyPath: 'key' });
			}
		}
	});
}

/** Test helper: close the connection so deleteDatabase can complete. */
export async function closeSelectionDbForTests(): Promise<void> {
	return closeIdbForTests(HUB_AI_DB_NAME);
}

export const EMPTY_SELECTION_MAP: AiSelectionMap = { v: 3, tasks: {} };

function asSelectionMap(row: unknown): AiSelectionMap {
	if (!row || typeof row !== 'object') return { ...EMPTY_SELECTION_MAP };
	if ((row as { v?: unknown }).v !== 3) return { ...EMPTY_SELECTION_MAP };
	const tasks = (row as AiSelectionMap).tasks;
	if (!tasks || typeof tasks !== 'object') return { ...EMPTY_SELECTION_MAP };
	return { v: 3, tasks };
}

/** The current selection map, or the empty default when none has been saved. */
export async function getAiSelectionMap(): Promise<AiSelectionMap> {
	const db = await openDb();
	return new Promise((resolve, reject) => {
		const tx = db.transaction(HUB_AI_STORE, 'readonly');
		const req = tx.objectStore(HUB_AI_STORE).get('active');
		req.onsuccess = () => {
			resolve(asSelectionMap(req.result));
		};
		req.onerror = () => reject(req.error);
	});
}

/** Persist the whole map (the settings tab writes derived views) and wake tabs.
 * Returns the stored map without the single-row id. */
export async function setAiSelectionMap(next: AiSelectionMap): Promise<AiSelectionMap> {
	// Plain data only: callers often hand over refs from Svelte `$state`, and
	// IndexedDB cannot clone a proxy (DataCloneError), so the pick silently
	// never persisted (OCR engine picker, 2026-10-08). JSON is the map's shape.
	const plain = JSON.parse(JSON.stringify(asSelectionMap(next))) as AiSelectionMap;
	const row = { ...plain, id: 'active' as const };
	const db = await openDb();
	await new Promise<void>((resolve, reject) => {
		const tx = db.transaction(HUB_AI_STORE, 'readwrite');
		tx.objectStore(HUB_AI_STORE).put(row);
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
		tx.onabort = () => reject(tx.error ?? new Error('setAiSelectionMap aborted'));
	});
	notifyTabChannel(HUB_AI_PROFILES_CHANNEL);
	return { v: 3, tasks: row.tasks };
}

/** Write one task/app cell without touching the other cells. Passing null
 * clears the cell, re-exposing whatever fallback it masks. */
export async function setAiModelRef(
	task: AiTaskKey,
	appId: string,
	ref: AiModelRef | null
): Promise<AiSelectionMap> {
	const current = await getAiSelectionMap();
	const taskRows = { ...(current.tasks[task] ?? {}) };
	if (ref === null) {
		delete taskRows[appId];
	} else {
		taskRows[appId] = ref;
	}
	return setAiSelectionMap({ v: 3, tasks: { ...current.tasks, [task]: taskRows } });
}

/**
 * Read one task's ref: the app's own cell first, then the task-wide
 * `'default'` cell. Null means nothing has been chosen.
 */
export function resolveAiModelRef(
	map: AiSelectionMap,
	task: AiTaskKey,
	appId?: string
): AiModelRef | null {
	if (appId && appId !== 'default') {
		return map.tasks[task]?.[appId] ?? map.tasks[task]?.['default'] ?? null;
	}
	return map.tasks[task]?.['default'] ?? null;
}

/**
 * The durable ref for an offer pick: everything that resolves it, including
 * the monitor it runs on. A browser offer's sourceId is only a display label
 * ('this-browser') — the runtime is this browser itself, so it is dropped;
 * native and provider rows keep theirs. Prefer `AiChoice.ref` (choices.ts),
 * which already pairs the offer with its monitor.
 */
export function offerAiRef(offer: AiOffer, monitorProfileId: string | null): AiModelRef {
	if (offer.location !== 'browser' && !monitorProfileId) {
		throw new Error('A monitor model ref must name its monitor.');
	}
	return {
		location: offer.location,
		modelId: offer.modelId,
		sourceId: offer.location === 'browser' ? null : offer.sourceId,
		variantId: offer.variantId,
		monitorProfileId: offer.location === 'browser' ? null : monitorProfileId
	};
}

/**
 * The offer a ref names when restoring into a live catalog: exact identity
 * first (model, location, source, variant), then model + location with the
 * ref's source when it names one. Identity only: the caller passes offers
 * from the ref's own monitor (`matchAiChoice` in choices.ts does).
 */
export function matchAiModelRef(
	ref: AiModelRef,
	offers: readonly AiOffer[]
): AiOffer | null {
	const exact = offers.find(
		(o) =>
			o.location === ref.location &&
			o.modelId === ref.modelId &&
			o.sourceId === ref.sourceId &&
			o.variantId === ref.variantId
	);
	if (exact) return exact;
	return (
		offers.find(
			(o) =>
				o.location === ref.location &&
				o.modelId === ref.modelId &&
				(!ref.sourceId || o.sourceId === ref.sourceId)
		) ?? null
	);
}

// Only other tabs need the ping in theory; `subscribeTabChannel` includes
// this tab so the many small pickers never have to write their own
// in-memory state after a save.

/**
 * Re-run `cb` whenever the selection changes: once immediately, then on every
 * write, including writes made in this tab (the settings panel is a listener,
 * not the only writer's reader).
 */
export function subscribeAiSelection(cb: (map: AiSelectionMap) => void): () => void {
	let last = '';
	const run = async () => {
		try {
			const map = await getAiSelectionMap();
			const stamp = JSON.stringify(map);
			if (stamp === last) return;
			last = stamp;
			cb(map);
		} catch {
			/* a failed read must not kill the subscriber */
		}
	};
	void run();
	const stop = subscribeTabChannel(HUB_AI_PROFILES_CHANNEL, () => {
		void run();
	});
	return stop;
}