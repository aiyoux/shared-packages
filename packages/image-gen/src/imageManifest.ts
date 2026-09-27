/**
 * Pure image-model store naming / manifest helpers — no browser or VFS
 * imports, so node vitest can test them. Mirrors the speech package's
 * modelStore.manifest pattern with an image root and task.
 */

export const IMAGE_STORE_ROOT_FOLDER = 'Image Models';

export const MANIFEST_NAME = 'manifest.json';
export const MANIFEST_CATALOG_VERSION = 1;

export type ImageModelManifestFile = {
	/** Repo path, e.g. `text_encoder/model.onnx`. */
	path: string;
	/** Name the file is stored under in the model folder (the basename). */
	name: string;
	bytes: number;
	sha256?: string;
	sourceUrl: string;
};

export type ImageModelManifest = {
	catalogVersion: typeof MANIFEST_CATALOG_VERSION;
	modelId: string;
	engine: string;
	task: 't2i';
	repo: string;
	revision: string;
	dtype: string;
	files: ImageModelManifestFile[];
	downloadedAt: number;
	/** How the files arrived: fetched via the bridge, or imported by the user. */
	origin?: 'imported' | 'downloaded';
};

/** Minimal catalog shape the manifest helpers need. */
export type ImageModelRef = {
	id: string;
	engine: string;
	task: 't2i';
	repo: string;
	revision: string;
	dtype: string;
	files: readonly { path: string }[];
};

/** `<engine>/<modelId>` pair for one catalog entry. */
export function modelDirPath(def: ImageModelRef): { engineFolder: string; modelFolder: string } {
	return { engineFolder: def.engine, modelFolder: def.id };
}

/** Full path segments from the VFS root for one model's folder. */
export function modelFolderSegments(def: ImageModelRef): string[] {
	return [IMAGE_STORE_ROOT_FOLDER, def.engine, def.id];
}

/** The key `ensureFolders()` uses for this model's folder in its returned map. */
export function modelFolderKey(def: ImageModelRef): string {
	return modelFolderSegments(def).join('/');
}

/**
 * Repo paths are flat-unsafe (`text_encoder/model.onnx` vs
 * `unet/model.onnx` share nothing, but basenames are what VFS stores) —
 * model folders store files flat. The mapping is total for our catalogs
 * (no two files share a basename within one model).
 */
export function storedName(repoPath: string): string {
	const idx = repoPath.lastIndexOf('/');
	return idx >= 0 ? repoPath.slice(idx + 1) : repoPath;
}

export function manifestFor(
	def: ImageModelRef,
	files: ImageModelManifestFile[],
	opts?: { origin?: ImageModelManifest['origin'] }
): ImageModelManifest {
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
export function parseManifest(bytes: Uint8Array, modelId: string): ImageModelManifest | null {
	try {
		const text = new TextDecoder().decode(bytes);
		const parsed: unknown = JSON.parse(text);
		if (typeof parsed !== 'object' || parsed === null) return null;
		const m = parsed as Partial<ImageModelManifest>;
		if (m.catalogVersion !== MANIFEST_CATALOG_VERSION) return null;
		if (m.modelId !== modelId || typeof m.repo !== 'string' || !Array.isArray(m.files)) {
			return null;
		}
		return m as ImageModelManifest;
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

/**
 * Do the file basenames present in a folder cover everything `def` needs?
 * Only basenames are compared; sizes are checked separately by the caller.
 */
export function manifestCovers(
	def: Pick<ImageModelRef, 'files'>,
	presentNames: readonly string[]
): boolean {
	const have = new Set(presentNames);
	return def.files.every((file) => have.has(storedName(file.path)));
}
