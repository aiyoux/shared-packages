/**
 * VFS-backed model weight store. Weights download from a CDN on first use and
 * live as ordinary files under `Speech Models/<engine>/<model>/` in the shared
 * VFS, so they show up in the File Explorer and persist across reloads.
 *
 * Provenance lives in a per-model `manifest.json` sidecar (VfsService has no
 * meta-only patch). Corruption handling is size-based; content hashing is an
 * explicit user action (`verifyModel`), never automatic.
 */

import {
	getSharedVfs,
	blobFromResponse,
	type VfsNode,
	type VfsService
} from '@shared-packages/file-system';
import { createSHA256 } from 'hash-wasm';
import { SpeechEngineError, type ModelDownloadProgress } from './types.js';
import type { SpeechModelDef } from './models.js';
import { hfResolveUrl } from './models.js';
import {
	MANIFEST_NAME,
	MODEL_STORE_ROOT_FOLDER,
	type SpeechModelManifest,
	manifestFor,
	modelFolderKey,
	modelFolderSegments,
	parseManifest,
	storedName
} from './modelStore.manifest.js';

export type ModelStoreFileState = VfsNode | 'missing' | 'corrupt';

export type EnsureModelResult = { dirId: string; fresh: boolean; manifest: SpeechModelManifest };

export class ModelStore {
	private constructor(private readonly vfs: VfsService) {}

	private static instance: Promise<ModelStore> | null = null;

	/** Singleton over `getSharedVfs()`. Requests persistent storage once. */
	static get(): Promise<ModelStore> {
		this.instance ??= (async () => {
			const store = new ModelStore(getSharedVfs());
			await store.ready();
			return store;
		})();
		return this.instance;
	}

	private readyPromise: Promise<void> | null = null;

	async ready(): Promise<void> {
		this.readyPromise ??= (async () => {
			await this.vfs.ready();
			void this.vfs.requestPersistentStorage?.().catch(() => {});
		})();
		await this.readyPromise;
	}

	/** Root folder id for the store, creating it if needed. */
	async rootDirId(): Promise<string> {
		const folders = await this.vfs.ensureFolders(null, [[MODEL_STORE_ROOT_FOLDER]]);
		const id = folders.get(MODEL_STORE_ROOT_FOLDER);
		if (id == null) throw new SpeechEngineError('DOWNLOAD_FAILED', 'Could not create the model store folder');
		return id;
	}

	/** Folder id for one model, creating the tree if needed. */
	async modelDirId(def: SpeechModelDef): Promise<string> {
		const segments = modelFolderSegments(def);
		const folders = await this.vfs.ensureFolders(null, [segments]);
		const id = folders.get(modelFolderKey(def));
		if (id == null) throw new SpeechEngineError('DOWNLOAD_FAILED', `Could not create the folder for ${def.id}`);
		return id;
	}

	async hasFile(dirId: string, name: string, expectedBytes?: number): Promise<ModelStoreFileState> {
		const node = await this.vfs.childByName(dirId, storedName(name));
		if (!node || node.kind !== 'file') return 'missing';
		if (expectedBytes != null && node.size !== expectedBytes) return 'corrupt';
		return node;
	}

	/**
	 * Make sure every catalog file for `def` is in the VFS, downloading what
	 * is missing and (re)writing the manifest sidecar. `fresh` is true when
	 * anything had to be downloaded.
	 */
	async ensureModel(
		def: SpeechModelDef,
		opts?: { onProgress?: (p: ModelDownloadProgress) => void; signal?: AbortSignal }
	): Promise<EnsureModelResult> {
		await this.ready();
		const dirId = await this.modelDirId(def);
		const manifestFiles: SpeechModelManifest['files'] = [];
		let fresh = false;

		// If a valid manifest exists, reuse its sha256 hashes for unchanged files.
		const existingManifest = await this.readManifest(dirId, def.id);

		for (const file of def.files) {
			const prior = existingManifest?.files.find((x) => x.path === file.path);
			const expected = prior?.bytes ?? file.bytes;
			const state = await this.hasFile(dirId, file.path, expected);
			if (state !== 'missing' && state !== 'corrupt') {
				manifestFiles.push({
					path: file.path,
					name: storedName(file.path),
					bytes: state.size ?? 0,
					sha256: prior?.sha256,
					sourceUrl: hfResolveUrl(def, file.path)
				});
				continue;
			}
			if (state === 'corrupt') await this.discardNode(dirId, file.path);
			const downloaded = await this.downloadFile(def, file.path, {
				onProgress: opts?.onProgress,
				signal: opts?.signal
			});
			fresh = true;
			manifestFiles.push({
				path: file.path,
				name: storedName(file.path),
				bytes: downloaded.node.size ?? 0,
				sha256: downloaded.sha256,
				sourceUrl: hfResolveUrl(def, file.path)
			});
		}

		const manifest = manifestFor(def, manifestFiles);
		await this.writeManifest(dirId, def.id, manifest);
		return { dirId, fresh, manifest };
	}

	/**
	 * Pre-fetch one extra file that the runtime will want (e.g. a Kokoro voice
	 * bin) so it lands in Files alongside the model.
	 */
	async ensureExtraFile(
		def: SpeechModelDef,
		path: string,
		opts?: { onProgress?: (p: ModelDownloadProgress) => void; signal?: AbortSignal }
	): Promise<void> {
		await this.ready();
		const dirId = await this.modelDirId(def);
		const state = await this.hasFile(dirId, path);
		if (state !== 'missing' && state !== 'corrupt') return;
		if (state === 'corrupt') await this.discardNode(dirId, path);
		await this.downloadFile(def, path, { onProgress: opts?.onProgress, signal: opts?.signal });
	}

	/**
	 * Ingest a response the runtime already fetched (transformers.js custom
	 * cache `put()`) into the store, hashing as it streams.
	 */
	async ingestResponse(
		def: SpeechModelDef,
		path: string,
		res: Response,
		opts?: { onProgress?: (p: ModelDownloadProgress) => void; signal?: AbortSignal }
	): Promise<void> {
		if (!res.ok || !res.body) {
			throw new SpeechEngineError('DOWNLOAD_FAILED', `Cannot ingest ${path}: ${res.status}`);
		}
		const dirId = await this.modelDirId(def);
		const name = storedName(path);
		const state = await this.hasFile(dirId, path);
		if (state !== 'missing' && state !== 'corrupt') return;
		if (state === 'corrupt') await this.discardNode(dirId, path);
		const { node, sha256 } = await this.pumpInto(res, dirId, name, opts);
		// The manifest only tracks catalog files; extra files (voices, tokenizers
		// the library pulls in) are recorded here so sizes stay checkable.
		await this.appendManifestFile(def, dirId, {
			path,
			name,
			bytes: node.size ?? 0,
			sha256,
			sourceUrl: res.url || hfResolveUrl(def, path)
		});
	}

	private async pumpInto(
		res: Response,
		dirId: string,
		name: string,
		opts?: { onProgress?: (p: ModelDownloadProgress) => void; signal?: AbortSignal }
	): Promise<{ node: VfsNode; sha256: string }> {
		const hasher = await createSHA256();
		hasher.init();
		let transferred = 0;
		const total = contentLength(res);
		const reader = res.body!.getReader();
		const node = await this.vfs.writeFileStream(
			{ parentId: dirId, name, contentType: 'application/octet-stream' },
			new ReadableStream<Uint8Array>({
				async pull(controller) {
					const { done, value } = await reader.read();
					if (done) {
						controller.close();
						return;
					}
					transferred += value.byteLength;
					hasher.update(value);
					opts?.onProgress?.({ file: name, transferred, total, done: false });
					controller.enqueue(value);
				}
			}),
			{ signal: opts?.signal }
		);
		opts?.onProgress?.({ file: name, transferred, total, done: true });
		return { node, sha256: hasher.digest('hex') };
	}

	/** Record an extra (non-catalog) file in the manifest, tolerating races. */
	private async appendManifestFile(
		def: SpeechModelDef,
		dirId: string,
		entry: { path: string; name: string; bytes: number; sha256?: string; sourceUrl: string }
	): Promise<void> {
		try {
			const manifest = (await this.readManifest(dirId, def.id)) ?? manifestFor(def, []);
			if (manifest.files.some((x) => x.path === entry.path)) return;
			manifest.files.push({ ...entry });
			await this.writeManifest(dirId, def.id, manifest);
		} catch {
			// Manifest bookkeeping is best-effort; the weights themselves are intact.
		}
	}

	async readManifest(dirId: string, modelId: string): Promise<SpeechModelManifest | null> {
		const node = await this.vfs.childByName(dirId, MANIFEST_NAME);
		if (!node || node.kind !== 'file') return null;
		const bytes = await this.vfs.readBytes(node.id);
		return parseManifest(bytes, modelId);
	}

	private async writeManifest(dirId: string, _modelId: string, manifest: SpeechModelManifest): Promise<void> {
		const body = new Blob([JSON.stringify(manifest, null, '\t')], { type: 'application/json' });
		await this.vfs.writeFile({
			parentId: dirId,
			name: MANIFEST_NAME,
			body,
			contentType: 'application/json',
			onConflict: 'overwrite'
		});
	}

	private async downloadFile(
		def: SpeechModelDef,
		path: string,
		opts?: { onProgress?: (p: ModelDownloadProgress) => void; signal?: AbortSignal }
	): Promise<{ node: VfsNode; sha256?: string }> {
		const url = hfResolveUrl(def, path);
		const name = storedName(path);
		const dirId = await this.modelDirId(def);
		try {
			const res = await fetch(url, { signal: opts?.signal });
			if (!res.ok || !res.body) {
				throw new SpeechEngineError('DOWNLOAD_FAILED', `${res.status} ${res.statusText} fetching ${path}`);
			}
			return await this.pumpInto(res, dirId, name, opts);
		} catch (error) {
			if (error instanceof DOMException && error.name === 'AbortError') throw error;
			// If OPFS streaming is unavailable on this browser, fall back to an
			// assembled blob write so the model is still obtainable.
			const blob = await blobFromResponse(await fetch(url, { signal: opts?.signal }), {
				onProgress: (done_, total_) =>
					opts?.onProgress?.({ file: name, transferred: done_, total: total_, done: false }),
				contentType: 'application/octet-stream'
			});
			const node = await this.vfs.writeFile({
				parentId: dirId,
				name,
				body: blob,
				contentType: 'application/octet-stream',
				onConflict: 'rename'
			});
			opts?.onProgress?.({ file: name, transferred: blob.size, total: blob.size, done: true });
			return { node };
		}
	}

	/**
	 * Remove a bad node so a fresh download can take its name. Model files
	 * are re-fetchable, so they are permanently deleted rather than trashed —
	 * trash-then-rewrite would leak a dead copy on every retry.
	 */
	private async discardNode(dirId: string, name: string): Promise<void> {
		const node = await this.vfs.childByName(dirId, storedName(name));
		if (!node || node.kind !== 'file') return;
		await this.vfs.permanentDelete(node.id, { recursive: false });
	}

	/** Explicit user action: re-hash stored files against the manifest. */
	async verifyModel(
		def: SpeechModelDef,
		opts?: { onProgress?: (p: ModelDownloadProgress) => void; signal?: AbortSignal }
	): Promise<{ ok: boolean; problems: string[] }> {
		await this.ready();
		const dirId = await this.modelDirId(def);
		const manifest = await this.readManifest(dirId, def.id);
		const problems: string[] = [];
		for (const file of def.files) {
			const node = await this.vfs.childByName(dirId, file.path);
			if (!node || node.kind !== 'file') {
				problems.push(`${file.path}: missing`);
				continue;
			}
			const expectedBytes = manifest?.files.find((x) => x.path === file.path)?.bytes ?? file.bytes;
			if (expectedBytes != null && node.size !== expectedBytes) {
				problems.push(`${file.path}: ${node.size} bytes, expected ${expectedBytes}`);
				continue;
			}
			const sha256 = manifest?.files.find((x) => x.path === file.path)?.sha256;
			if (!sha256) continue;
			const blob = await this.vfs.readBlob(node.id);
			const hasher = await createSHA256();
			hasher.init();
			hasher.update(new Uint8Array(await blob.arrayBuffer()));
			if (hasher.digest('hex') !== sha256) problems.push(`${file.path}: checksum mismatch`);
			opts?.onProgress?.({ file: file.path, transferred: blob.size, total: blob.size, done: true });
		}
		return { ok: problems.length === 0, problems };
	}

	async readBlob(dirId: string, name: string): Promise<Blob> {
		const node = await this.vfs.childByName(dirId, name);
		if (!node || node.kind !== 'file') throw new SpeechEngineError('NO_MODEL', `Model file ${name} is not downloaded yet`);
		return this.vfs.readBlob(node.id);
	}

	async readBytes(dirId: string, name: string): Promise<Uint8Array> {
		const node = await this.vfs.childByName(dirId, name);
		if (!node || node.kind !== 'file') throw new SpeechEngineError('NO_MODEL', `Model file ${name} is not downloaded yet`);
		return this.vfs.readBytes(node.id);
	}

	async hasModel(def: SpeechModelDef): Promise<boolean> {
		await this.ready();
		const dirId = await this.modelDirId(def);
		for (const file of def.files) {
			const state = await this.hasFile(dirId, file.path, file.bytes);
			if (state === 'missing' || state === 'corrupt') return false;
		}
		return true;
	}

	/** Delete one model folder (weights + manifest). */
	async removeModel(engine: string, modelId: string): Promise<void> {
		await this.ready();
		const segments = [MODEL_STORE_ROOT_FOLDER, engine, modelId];
		const folders = await this.vfs.ensureFolders(null, [segments]);
		const dirId = folders.get(segments.join('/'));
		if (dirId == null) return;
		await this.vfs.permanentDelete(dirId, { recursive: true });
	}

	/** Everything currently stored, for a manage/delete UI. */
	async listStoredModels(): Promise<Array<{ engine: string; modelId: string; bytes: number }>> {
		await this.ready();
		const folders = await this.vfs.ensureFolders(null, [[MODEL_STORE_ROOT_FOLDER]]);
		const rootId = folders.get(MODEL_STORE_ROOT_FOLDER);
		if (rootId == null) return [];
		const result: Array<{ engine: string; modelId: string; bytes: number }> = [];
		const engines = await this.vfs.list({ parentId: rootId });
		for (const engine of engines) {
			if (engine.kind !== 'folder') continue;
			const models = await this.vfs.list({ parentId: engine.id });
			for (const model of models) {
				if (model.kind !== 'folder') continue;
				const files = await this.vfs.list({ parentId: model.id });
				const bytes = files.reduce((n, x) => n + (x.kind === 'file' ? (x.size ?? 0) : 0), 0);
				result.push({ engine: engine.name, modelId: model.name, bytes });
			}
		}
		return result;
	}
}

function contentLength(res: Response): number | undefined {
	const raw = res.headers.get('content-length');
	if (!raw) return undefined;
	const n = Number(raw);
	return Number.isFinite(n) ? n : undefined;
}

/** Shared singleton — all speech engines download through one store. */
export function getSpeechModelStore(): Promise<ModelStore> {
	return ModelStore.get();
}