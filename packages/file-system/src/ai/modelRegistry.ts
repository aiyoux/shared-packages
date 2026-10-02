/**
 * Composition slot for the model library behind the settings popup's
 * "AI models" tab.
 *
 * The dialog lives here, but the browser model catalogs live in the sibling
 * packages (speech, image-gen, scan) that `file-system` must not depend on,
 * and monitor offers come from `library.ts` per monitor profile. So the tab
 * renders whatever a consumer registered through this slot, plus the
 * monitor panels it owns. The hub's `modelLibrary.ts` is the one aggregator
 * that derives sections from those catalogs — no second hand-copied table of
 * model names exists.
 *
 * Registration is a plain module call the hub makes at load. A consumer that
 * never registers (an immersive app mounting the dialog itself) degrades to
 * the "library unavailable" note rather than crashing.
 */
import type { ModelDef } from '@shared-packages/model-store';
import type { AiModelRef, AiTaskKey } from './selection.js';

export type AiLibraryModelStatus =
	/** Weights present in the owner's store (browser model store, monitor library). */
	| 'installed'
	/** Catalogued but no weights present yet. */
	| 'not-installed'
	/** Imported but with missing or unverified files. */
	| 'partial'
	/** Configured, but the runtime/device/service is not ready. */
	| 'unavailable'
	/** Runs as a service (webspeech packs, monitor providers) — nothing to install. */
	| 'remote'
	/** Ships with the app or is cached out of our control. */
	| 'built-in';

export type AiLibraryModelRow = {
	ref: AiModelRef;
	label: string;
	/** Engine, license, repo — one short line. */
	detail?: string;
	/** Weights on disk when known; null otherwise. */
	sizeBytes: number | null;
	status: AiLibraryModelStatus;
	/** Files managed by the dedicated browser model store. */
	browserModel?: ModelDef;
	/** One row over many store models (Piper's voices): the card shows the picked one, starting at `browserModel`. */
	browserModelOptions?: readonly ModelDef[];
	/** Optional in-app import flow (package import card, monitor library install). */
	install?: () => Promise<void>;
	/** Use "Import files" when the action opens a file chooser. */
	installLabel?: string;
	remove?: () => Promise<void>;
	/** Where the weights actually live, when the status alone does not say it. */
	note?: string;
};

export type AiModelSection = {
	id: string;
	task: AiTaskKey;
	/** A specialized app picker can keep its durable choice within classify. */
	selectionTask?: AiTaskKey;
	title: string;
	/** Lazy: status checks read the browser model store or the monitor, per section. */
	models: () => Promise<AiLibraryModelRow[]>;
};

/** One app surface that a user can assign a default model to. */
export type AiTaskSurface = {
	appId: string;
	task: AiTaskKey;
	label: string;
};

type RegisteredSources = {
	sections: AiModelSection[];
	surfaces: AiTaskSurface[];
};

let registered: RegisteredSources = { sections: [], surfaces: [] };

/** Register the library sections and default-picker surfaces (idempotent:
 * a later registration replaces the previous set). */
export function registerAiLibrarySources(parts: RegisteredSources): void {
	registered = {
		sections: [...parts.sections],
		surfaces: [...parts.surfaces]
	};
}

/** What has been registered; empty until the host app's aggregator runs. */
export function listAiLibrarySources(): RegisteredSources {
	return { sections: registered.sections, surfaces: registered.surfaces };
}

export type { AiModelRef, AiTaskKey };
