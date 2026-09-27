import type { SpeechModelDef } from './models.js';

/**
 * Pure model-store naming / manifest helpers — no browser or VFS imports, so
 * node vitest can test them (see `modelStore.ts` for the browser side).
 */

export const MODEL_STORE_ROOT_FOLDER = 'Speech Models';

export const MANIFEST_NAME = 'manifest.json';
export const MANIFEST_CATALOG_VERSION = 1;

export type SpeechModelManifestFile = {
	/** Repo path, e.g. `onnx/encoder_model_quantized.onnx`. */
	path: string;
	/** Name the file is stored under in the model folder (the basename). */
	name: string;
	bytes: number;
	sha256?: string;
	sourceUrl: string;
};

export type SpeechModelManifest = {
	catalogVersion: typeof MANIFEST_CATALOG_VERSION;
	modelId: string;
	engine: string;
	task: 'stt' | 'tts';
	repo: string;
	revision: string;
	dtype: string;
	files: SpeechModelManifestFile[];
	downloadedAt: number;
	/** How the files arrived: fetched by the app, or imported by the user. */
	origin?: 'imported' | 'downloaded';
};

/** `<engine>/<modelId>` pair for one catalog entry. */
export function modelDirPath(def: SpeechModelDef): { engineFolder: string; modelFolder: string } {
	return { engineFolder: def.engine, modelFolder: def.id };
}

/** Full path segments from the VFS root for one model's folder. */
export function modelFolderSegments(def: SpeechModelDef): string[] {
	return [MODEL_STORE_ROOT_FOLDER, def.engine, def.id];
}

/** The key `ensureFolders()` uses for this model's folder in its returned map. */
export function modelFolderKey(def: SpeechModelDef): string {
	return modelFolderSegments(def).join('/');
}

/**
 * Repo paths are not flat (`onnx/encoder_model_quantized.onnx`) but model
 * folders store files flat — `writeFileStream` takes a single name. The
 * stored name is the repo path's basename; the mapping is total for our
 * catalogs (no two files share a basename within one model).
 */
export function storedName(repoPath: string): string {
	const idx = repoPath.lastIndexOf('/');
	return idx >= 0 ? repoPath.slice(idx + 1) : repoPath;
}

export function manifestFor(
	def: SpeechModelDef,
	files: SpeechModelManifestFile[],
	opts?: { origin?: SpeechModelManifest['origin'] }
): SpeechModelManifest {
	return {
		catalogVersion: MANIFEST_CATALOG_VERSION,
		modelId: def.id,
		engine: def.engine,
		task: def.task,
		repo: def.repo,
		revision: def.revision,
		dtype: def.dtype,
		files,
		downloadedAt: Date.now(),
		...opts
	};
}

/**
 * Parse a stored manifest, tolerating older/foreign shapes. Returns null when
 * the bytes are not a manifest for this model id.
 */
export function parseManifest(bytes: Uint8Array, modelId: string): SpeechModelManifest | null {
	try {
		const text = new TextDecoder().decode(bytes);
		const parsed: unknown = JSON.parse(text);
		if (typeof parsed !== 'object' || parsed === null) return null;
		const m = parsed as Partial<SpeechModelManifest>;
		if (m.catalogVersion !== MANIFEST_CATALOG_VERSION) return null;
		if (m.modelId !== modelId || typeof m.repo !== 'string' || !Array.isArray(m.files)) {
			return null;
		}
		return m as SpeechModelManifest;
	} catch {
		return null;
	}
}

/**
 * A stored file is usable when it exists and its size matches the manifest
 * (or the catalog when the manifest is missing). Content hashing is an
 * explicit user action, never part of this check.
 */
export function sizeMatches(actual: number | undefined, expected: number | undefined): boolean {
	if (expected == null) return actual != null && actual >= 0;
	return actual === expected;
}

/** Format a model's byte size for display (KB/MB/GB, one decimal). */
export function formatModelBytes(bytes: number): string {
	if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
	if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
	if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
	return `${bytes} B`;
}

/** Repo path → nested folder segments below a model dir, e.g. `onnx/model.onnx` → `['onnx', 'model.onnx']`. */
export function pathSegments(repoPath: string): string[] {
	return repoPath.split('/').filter(Boolean);
}

/**
 * Do the file basenames present in a folder cover everything `def` needs?
 * Used when a folder has no manifest — e.g. files the user imported flat from
 * their Downloads folder. Only basenames are compared; sizes are checked
 * separately by the caller.
 */
export function manifestCovers(
	def: Pick<SpeechModelDef, 'files'>,
	presentNames: readonly string[]
): boolean {
	const have = new Set(presentNames);
	return def.files.every((file) => have.has(storedName(file.path)));
}

/**
 * Why a stored model file can't be the real one, or null. An empty file still
 * parses as an (empty) ONNX model — ORT then fails with "No graph was found
 * in the protobuf" — so this runs before any bytes reach a runtime. The
 * catalog size, when known, is the repo file's size; an incomplete browser
 * download or import lands short of it.
 */
export function modelFileSizeProblem(path: string, actual: number, expected?: number): string | null {
	const name = storedName(path);
	if (actual === 0) {
		return `${name} in Files is empty — download it again and re-import it.`;
	}
	if (expected != null && actual !== expected) {
		return `${name} in Files is ${formatModelBytes(actual)} but should be ${formatModelBytes(expected)} — the download or import was incomplete. Download it again and re-import it.`;
	}
	return null;
}
