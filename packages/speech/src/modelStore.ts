/**
 * VFS-backed model weight store. The app never downloads weights itself —
 * users follow per-file download links (plain browser downloads, which bypass
 * the page's COEP isolation) and import the files into a VFS folder of their
 * choosing. Engines load from wherever the user pointed them; the legacy
 * fixed tree `Speech Models/<engine>/<model>/` remains the default location.
 *
 * Provenance lives in a per-model `manifest.json` sidecar (VfsService has no
 * meta-only patch). Corruption handling is size-based; content hashing is an
 * explicit user action (`verifyModel`) or part of an import, never automatic.
 */

import {
	getSharedVfs,
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
	type SpeechModelManifestFile,
	manifestCovers,
	manifestFor,
	modelFolderKey,
	modelFolderSegments,
	parseManifest,
	pathSegments,
	storedName
} from './modelStore.manifest.js';

export type ModelStoreFileState = VfsNode | 'missing' | 'corrupt';

export type ImportedModelFile = { path: string; blob: Blob };

export type ImportedModelResult = { dirId: string; manifest: SpeechModelManifest };

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
		if (id == null) throw new SpeechEngineError('NO_MODEL', 'Could not create the model store folder');
		return id;
	}

	/** Default folder id for one model, creating the tree if needed. */
	async defaultModelDirId(def: SpeechModelDef): Promise<string> {
		const segments = modelFolderSegments(def);
		const folders = await this.vfs.ensureFolders(null, [segments]);
		const id = folders.get(modelFolderKey(def));
		if (id == null) throw new SpeechEngineError('NO_MODEL', `Could not create the folder for ${def.id}`);
		return id;
	}

	/**
	 * Resolve the folder holding `def`'s files, without creating anything.
	 * `startDirId === null` scans the legacy fixed tree. First a manifest
	 * matching `def.id` wins (BFS, depth ≤ maxDepth); otherwise the first
	 * folder whose file basenames cover `def.files` does — imports without a
	 * manifest are still usable.
	 */
	async findModelDir(
		def: SpeechModelDef,
		startDirId: string | null,
		opts?: { maxDepth?: number }
	): Promise<string | null> {
		await this.ready();
		const maxDepth = opts?.maxDepth ?? 3;
		const queue: Array<{ id: string; depth: number }> = [];
		const visited: string[] = [];
		const seen = new Set<string>();

		if (startDirId == null) {
			// Legacy fixed tree, resolved without creating engine/model folders.
			const rootId = await this.rootDirId();
			const engine = await this.vfs.childByName(rootId, def.engine);
			if (engine?.kind === 'folder') {
				const model = await this.vfs.childByName(engine.id, def.id);
				if (model?.kind === 'folder') queue.push({ id: model.id, depth: 0 });
			}
		} else {
			queue.push({ id: startDirId, depth: 0 });
		}

		while (queue.length) {
			const { id, depth } = queue.shift()!;
			if (seen.has(id)) continue;
			seen.add(id);
			visited.push(id);
			const manifest = await this.readManifest(id, def.id);
			if (manifest) return id;
			if (depth < maxDepth) {
				const children = await this.vfs.list({ parentId: id });
				for (const child of children) {
					if (child.kind === 'folder') queue.push({ id: child.id, depth: depth + 1 });
				}
			}
		}

		for (const id of visited) {
			const children = await this.vfs.list({ parentId: id });
			const names = children.filter((c) => c.kind === 'file').map((c) => c.name);
			if (manifestCovers(def, names)) return id;
		}
		return null;
	}

	/**
	 * Locate a file by repo path under `dirId`: walk the path's folder
	 * segments, then fall back to a flat basename lookup (imports land flat,
	 * and the legacy store stored everything by basename).
	 */
	async resolveFileNode(dirId: string, path: string): Promise<VfsNode | null> {
		const segments = pathSegments(path);
		const name = segments[segments.length - 1]!;
		let parent: string | null = dirId;
		let nested = true;
		for (const segment of segments.slice(0, -1)) {
			const next = await this.vfs.childByName(parent, segment);
			if (!next || next.kind !== 'folder') {
				nested = false;
				break;
			}
			parent = next.id;
		}
		if (nested) {
			const node = await this.vfs.childByName(parent, name);
			if (node?.kind === 'file') return node;
		}
		// Flat fallback in the starting dir itself.
		const flat = await this.vfs.childByName(dirId, name);
		return flat?.kind === 'file' ? flat : null;
	}

	async hasFile(dirId: string, name: string, expectedBytes?: number): Promise<ModelStoreFileState> {
		const node = await this.vfs.childByName(dirId, storedName(name));
		if (!node || node.kind !== 'file') return 'missing';
		if (expectedBytes != null && node.size !== expectedBytes) return 'corrupt';
		return node;
	}

	/**
	 * Store user-imported files for `def` under `targetDirId` (any folder the
	 * user chose) and write the manifest sidecar. Files land flat by basename.
	 * A selected file always replaces an existing copy. Catalog size alone
	 * cannot prove that OPFS still holds the bytes.
	 */
	async importModel(
		def: SpeechModelDef,
		files: readonly ImportedModelFile[],
		targetDirId: string,
		opts?: { onProgress?: (p: ModelDownloadProgress) => void; signal?: AbortSignal }
	): Promise<ImportedModelResult> {
		await this.ready();
		const manifestFiles: SpeechModelManifestFile[] = [];
		for (const file of files) {
			const name = storedName(file.path);
			if (file.blob.size === 0) throw new SpeechEngineError('NO_MODEL', `${name} is empty`);
			const previous = await this.resolveFileNode(targetDirId, file.path);
			const writeDirId = previous?.parentId ?? targetDirId;
			if (!previous && (await this.vfs.childByName(writeDirId, name))?.kind === 'folder') {
				throw new SpeechEngineError('NO_MODEL', `${name} is a folder in Files`);
			}
			// Keep the old copy until the new OPFS file has closed and reads back.
			const importName = previous ? `${name}.import-${crypto.randomUUID()}` : name;
			const { node: staged, sha256 } = await this.pumpBlob(file.blob, writeDirId, importName, opts);
			let written = staged;
			let previousDeleted = false;
			try {
				const savedSize = (await this.vfs.readBlob(staged.id)).size;
				if (savedSize !== file.blob.size) {
					throw new SpeechEngineError('NO_MODEL', `${name} saved as ${savedSize} bytes in Files; expected ${file.blob.size}`);
				}
				if (previous) {
					await this.vfs.permanentDelete(previous.id, { recursive: false });
					previousDeleted = true;
					written = await this.vfs.rename(staged.id, name);
				}
			} catch (error) {
				if (!previousDeleted) {
					await this.vfs.permanentDelete(staged.id, { recursive: false }).catch(() => {});
				}
				throw error;
			}
			manifestFiles.push({
				path: file.path,
				name,
				bytes: written.size ?? 0,
				sha256,
				sourceUrl: hfResolveUrl(def, file.path)
			});
		}

		const manifest = manifestFor(def, manifestFiles, { origin: 'imported' });
		await this.writeManifest(targetDirId, manifest);
		return { dirId: targetDirId, manifest };
	}

	/**
	 * Ingest a response the runtime already fetched (transformers.js custom
	 * cache `put()`) into the store, hashing as it streams.
	 */
	async ingestResponse(
		def: SpeechModelDef,
		path: string,
		res: Response,
		opts: { dirId: string; onProgress?: (p: ModelDownloadProgress) => void; signal?: AbortSignal }
	): Promise<void> {
		if (!res.ok || !res.body) {
			throw new SpeechEngineError('NO_MODEL', `Cannot ingest ${path}: ${res.status}`);
		}
		const { dirId } = opts;
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
		return this.pumpStream(res.body!.getReader(), contentLength(res), dirId, name, opts);
	}

	private async pumpBlob(
		blob: Blob,
		dirId: string,
		name: string,
		opts?: { onProgress?: (p: ModelDownloadProgress) => void; signal?: AbortSignal }
	): Promise<{ node: VfsNode; sha256: string }> {
		return this.pumpStream(blob.stream().getReader(), blob.size, dirId, name, opts);
	}

	private async pumpStream(
		reader: ReadableStreamDefaultReader<Uint8Array>,
		total: number | undefined,
		dirId: string,
		name: string,
		opts?: { onProgress?: (p: ModelDownloadProgress) => void; signal?: AbortSignal }
	): Promise<{ node: VfsNode; sha256: string }> {
		const hasher = await createSHA256();
		hasher.init();
		let transferred = 0;
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
			await this.writeManifest(dirId, manifest);
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

	private async writeManifest(dirId: string, manifest: SpeechModelManifest): Promise<void> {
		const body = new Blob([JSON.stringify(manifest, null, '\t')], { type: 'application/json' });
		await this.vfs.writeFile({
			parentId: dirId,
			name: MANIFEST_NAME,
			body,
			contentType: 'application/json',
			onConflict: 'overwrite'
		});
	}

	/** Remove a bad node so a fresh import can take its name. */
	private async discardNode(dirId: string, name: string): Promise<void> {
		const node = await this.vfs.childByName(dirId, storedName(name));
		if (!node || node.kind !== 'file') return;
		await this.vfs.permanentDelete(node.id, { recursive: false });
	}

	/** Explicit user action: re-hash stored files against the manifest. */
	async verifyModel(
		def: SpeechModelDef,
		opts?: { dirId?: string; onProgress?: (p: ModelDownloadProgress) => void; signal?: AbortSignal }
	): Promise<{ ok: boolean; problems: string[]; dirId: string | null }> {
		await this.ready();
		const dirId = opts?.dirId ?? (await this.findModelDir(def, null)) ?? (await this.defaultModelDirId(def));
		const manifest = await this.readManifest(dirId, def.id);
		const problems: string[] = [];
		for (const file of def.files) {
			const node = await this.resolveFileNode(dirId, file.path);
			if (!node) {
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
		return { ok: problems.length === 0, problems, dirId };
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

	/** Read a file by repo path under `dirId` (walk + flat fallback). */
	async readBlobPath(dirId: string, path: string): Promise<Blob> {
		const node = await this.resolveFileNode(dirId, path);
		if (!node) throw new SpeechEngineError('NO_MODEL', `Model file ${storedName(path)} is not downloaded yet`);
		return this.vfs.readBlob(node.id);
	}

	async readBytesPath(dirId: string, path: string): Promise<Uint8Array> {
		const node = await this.resolveFileNode(dirId, path);
		if (!node) throw new SpeechEngineError('NO_MODEL', `Model file ${storedName(path)} is not downloaded yet`);
		return this.vfs.readBytes(node.id);
	}

	/** All catalog files present with sane sizes? When `dirId` is omitted the
	 * legacy fixed tree is checked. */
	async hasModel(def: SpeechModelDef, dirId?: string): Promise<boolean> {
		await this.ready();
		const dir = dirId ?? (await this.defaultModelDirId(def));
		const manifest = await this.readManifest(dir, def.id);
		for (const file of def.files) {
			const node = await this.resolveFileNode(dir, file.path);
			if (!node) return false;
			const expected = manifest?.files.find((x) => x.path === file.path)?.bytes ?? file.bytes;
			if (expected != null && node.size !== expected) return false;
		}
		return true;
	}

	/**
	 * Resolve `def`'s folder (the chosen one, or a scan from the legacy tree)
	 * and require every catalog file to be present with a sane size — engines
	 * call this instead of downloading. Throws `NO_MODEL` naming the missing
	 * basenames and a download link when anything is absent.
	 */
	async requireModelDir(def: SpeechModelDef, dirId?: string): Promise<string> {
		await this.ready();
		const dir = dirId ?? (await this.findModelDir(def, null));
		if (!dir) throw this.missingModelError(def, def.files.map((f) => f.path));
		const manifest = await this.readManifest(dir, def.id);
		const missing: string[] = [];
		for (const file of def.files) {
			const node = await this.resolveFileNode(dir, file.path);
			if (!node) {
				missing.push(file.path);
				continue;
			}
			const expected = manifest?.files.find((x) => x.path === file.path)?.bytes ?? file.bytes;
			if (expected != null && node.size !== expected) missing.push(file.path);
		}
		if (missing.length) throw this.missingModelError(def, missing);
		return dir;
	}

	private missingModelError(def: SpeechModelDef, paths: readonly string[]): SpeechEngineError {
		const names = paths.map((p) => storedName(p)).join(', ');
		const link = hfResolveUrl(def, paths[0]!);
		return new SpeechEngineError(
			'NO_MODEL',
			`Missing model files: ${names}. Download them from ${link} and import them below.`
		);
	}

	/** Delete one model's files. With `dirId` only the tracked files and the
	 * manifest are removed (the folder itself belongs to the user); otherwise
	 * the whole default model folder goes. */
	async removeModel(def: SpeechModelDef, opts?: { dirId?: string }): Promise<void> {
		await this.ready();
		if (opts?.dirId) {
			const manifest = await this.readManifest(opts.dirId, def.id);
			const paths = new Set([
				...def.files.map((f) => f.path),
				...(manifest?.files.map((f) => f.path) ?? [])
			]);
			for (const path of paths) {
				const node = await this.resolveFileNode(opts.dirId, path);
				if (node) await this.vfs.permanentDelete(node.id, { recursive: false });
			}
			const manifestNode = await this.vfs.childByName(opts.dirId, MANIFEST_NAME);
			if (manifestNode?.kind === 'file') {
				await this.vfs.permanentDelete(manifestNode.id, { recursive: false });
			}
			return;
		}
		const segments = modelFolderSegments(def);
		const folders = await this.vfs.ensureFolders(null, [segments]);
		const dirId = folders.get(modelFolderKey(def));
		if (dirId == null) return;
		await this.vfs.permanentDelete(dirId, { recursive: true });
	}

	/** Everything currently stored, for a manage/delete UI. With `dirId`,
	 * immediate subfolders of the chosen folder are listed instead. */
	async listStoredModels(opts?: { dirId?: string }): Promise<Array<{ engine: string; modelId: string; bytes: number }>> {
		await this.ready();
		const rootId = opts?.dirId ?? (await this.rootDirId());
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

/** Shared singleton — all speech engines load weights through one store. */
export function getSpeechModelStore(): Promise<ModelStore> {
	return ModelStore.get();
}
