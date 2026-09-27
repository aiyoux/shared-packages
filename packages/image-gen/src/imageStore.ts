import {
	getSharedVfs,
	type VfsNode,
	type VfsService
} from '@shared-packages/file-system';
import { createSHA256 } from 'hash-wasm';
import type { ImageModelDef } from './imageModels.js';
import {
	IMAGE_STORE_ROOT_FOLDER,
	MANIFEST_NAME,
	manifestCovers,
	manifestFor,
	modelFolderKey,
	modelFolderSegments,
	parseManifest,
	storedName,
	type ImageModelManifest,
	type ImageModelManifestFile
} from './imageManifest.js';

export type ImageProgress = {
	file: string;
	transferred: number;
	total?: number;
	done: boolean;
};

export class ImageStoreError extends Error {
	constructor(
		public readonly code: 'NO_MODEL' | 'DOWNLOAD_FAILED',
		message: string,
		public readonly cause?: unknown
	) {
		super(message);
		this.name = 'ImageStoreError';
	}
}

export type ImportedImageFile = { path: string; blob: Blob };
export type ImageFileState = VfsNode | 'missing' | 'corrupt';

/**
 * VFS-backed image-model weight store. Same contract as the speech model
 * store under a different root (`Image Models/<engine>/<model>/`):
 * engines load from wherever the user pointed them, files arrive either by
 * user import or by bridge fetch, provenance lives in a `manifest.json`
 * sidecar, and corruption handling is size-based.
 */
export class ImageStore {
	private constructor(private readonly vfs: VfsService) {}

	private static instance: Promise<ImageStore> | null = null;

	/** Singleton over `getSharedVfs()`. Requests persistent storage once. */
	static get(): Promise<ImageStore> {
		this.instance ??= (async () => {
			const store = new ImageStore(getSharedVfs());
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
		const folders = await this.vfs.ensureFolders(null, [[IMAGE_STORE_ROOT_FOLDER]]);
		const id = folders.get(IMAGE_STORE_ROOT_FOLDER);
		if (id == null) throw new ImageStoreError('NO_MODEL', 'Could not create the model store folder');
		return id;
	}

	/** Default folder id for one model, creating the tree if needed. */
	async defaultModelDirId(def: ImageModelDef): Promise<string> {
		const segments = modelFolderSegments(def);
		const folders = await this.vfs.ensureFolders(null, [segments]);
		const id = folders.get(modelFolderKey(def));
		if (id == null) throw new ImageStoreError('NO_MODEL', `Could not create the folder for ${def.id}`);
		return id;
	}

	/**
	 * Resolve the folder holding `def`'s files, without creating anything.
	 * `startDirId === null` scans the fixed tree. First a manifest matching
	 * `def.id` wins (BFS, depth ≤ maxDepth); otherwise the first folder whose
	 * file basenames cover `def.files` does.
	 */
	async findModelDir(
		def: ImageModelDef,
		startDirId: string | null,
		opts?: { maxDepth?: number }
	): Promise<string | null> {
		await this.ready();
		const maxDepth = opts?.maxDepth ?? 3;
		const queue: Array<{ id: string; depth: number }> = [];
		const visited: string[] = [];
		const seen = new Set<string>();

		if (startDirId == null) {
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
			const relPaths = await this.listRelativePaths(id, '', maxDepth);
			const needed = def.files.map((f) => f.path);
			if (needed.every((p) => relPaths.has(p))) return id;
		}
		return null;
	}

	/** All descendant file paths relative to `rootId` (BFS, depth-limited). */
	private async listRelativePaths(
		rootId: string,
		prefix: string,
		maxDepth: number
	): Promise<Set<string>> {
		const out = new Set<string>();
		const queue: Array<{ id: string; prefix: string; depth: number }> = [
			{ id: rootId, prefix, depth: 0 }
		];
		while (queue.length) {
			const { id, prefix: pre, depth } = queue.shift()!;
			const children = await this.vfs.list({ parentId: id });
			for (const child of children) {
				if (child.kind === 'file') out.add(pre ? `${pre}/${child.name}` : child.name);
				else if (depth < maxDepth) {
					queue.push({
						id: child.id,
						prefix: pre ? `${pre}/${child.name}` : child.name,
						depth: depth + 1
					});
				}
			}
		}
		return out;
	}

	/**
	 * Locate a file by repo path under `dirId`: walk the path's folder
	 * segments, then fall back to a flat basename lookup (imports land flat).
	 */
	async resolveFileNode(dirId: string, path: string): Promise<VfsNode | null> {
		const segments = path.split('/').filter(Boolean);
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
		const flat = await this.vfs.childByName(dirId, name);
		return flat?.kind === 'file' ? flat : null;
	}

	async hasFile(dirId: string, path: string, expectedBytes?: number): Promise<ImageFileState> {
		const node = await this.resolveFileNode(dirId, path);
		if (!node) return 'missing';
		if (expectedBytes != null && node.size !== expectedBytes) return 'corrupt';
		return node;
	}

	/** True when every catalog file is present with manifest/catalog sizes. */
	async hasModel(def: ImageModelDef, dirId?: string): Promise<boolean> {
		const id = dirId ?? (await this.findModelDir(def, null));
		if (!id) return false;
		const manifest = await this.readManifest(id, def.id);
		for (const file of def.files) {
			const expected =
				manifest?.files.find((f) => f.path === file.path)?.bytes ?? file.bytes;
			const state = await this.hasFile(id, file.path, expected ?? undefined);
			if (state === 'missing' || state === 'corrupt') return false;
		}
		return true;
	}

	/** Import user-provided blobs for the catalog files, with manifest. */
	async importModel(
		def: ImageModelDef,
		files: readonly ImportedImageFile[],
		targetDirId: string,
		opts?: { onProgress?: (p: ImageProgress) => void; signal?: AbortSignal }
	): Promise<{ dirId: string; manifest: ImageModelManifest }> {
		await this.ready();
		const manifestFiles: ImageModelManifestFile[] = [];
		const existingManifest = await this.readManifest(targetDirId, def.id);

		for (const file of files) {
			const name = storedName(file.path);
			const parentId = await this.ensureParentDir(targetDirId, file.path);
			const prior = existingManifest?.files.find((x) => x.path === file.path);
			const node = await this.resolveFileNode(targetDirId, file.path);
			if (node?.kind === 'file') {
				const expected = prior?.bytes;
				if (expected == null || node.size === expected) {
					manifestFiles.push({
						path: file.path,
						name,
						bytes: node.size ?? 0,
						sha256: prior?.sha256,
						sourceUrl: hfImageUrl(def, file.path)
					});
					continue;
				}
				await this.vfs.permanentDelete(node.id, { recursive: false });
			}
			const { node: written, sha256 } = await this.pumpBlob(file.blob, parentId, name, opts);
			manifestFiles.push({
				path: file.path,
				name,
				bytes: written.size ?? 0,
				sha256,
				sourceUrl: hfImageUrl(def, file.path)
			});
		}

		const manifest = manifestFor(def, manifestFiles, { origin: 'imported' });
		await this.writeManifest(targetDirId, manifest);
		return { dirId: targetDirId, manifest };
	}

	/**
	 * Ingest a response the runtime already fetched (bridge fetch) into the
	 * store, hashing as it streams. Files already present are skipped.
	 */
	async ingestResponse(
		def: ImageModelDef,
		path: string,
		res: Response,
		opts: { dirId: string; onProgress?: (p: ImageProgress) => void; signal?: AbortSignal }
	): Promise<void> {
		if (!res.ok || !res.body) {
			throw new ImageStoreError('NO_MODEL', `Cannot ingest ${path}: ${res.status}`);
		}
		const { dirId } = opts;
		const name = storedName(path);
		const state = await this.hasFile(dirId, path);
		if (state !== 'missing' && state !== 'corrupt') return;
		if (state === 'corrupt') {
			const node = await this.resolveFileNode(dirId, path);
			if (node) await this.vfs.permanentDelete(node.id, { recursive: false });
		}
		const total = contentLength(res);
		const parentId = await this.ensureParentDir(dirId, path);
		const { node, sha256 } = await this.pumpStream(
			res.body.getReader(),
			total,
			parentId,
			name,
			opts
		);
		await this.appendManifestFile(def, dirId, {
			path,
			name,
			bytes: node.size ?? 0,
			sha256,
			sourceUrl: res.url || hfImageUrl(def, path)
		});
	}

	async readManifest(dirId: string, modelId: string): Promise<ImageModelManifest | null> {
		const node = await this.vfs.childByName(dirId, MANIFEST_NAME);
		if (!node || node.kind !== 'file') return null;
		const bytes = await this.vfs.readBytes(node.id);
		return parseManifest(bytes, modelId);
	}

	async readBlobPath(dirId: string, path: string): Promise<Blob> {
		const node = await this.resolveFileNode(dirId, path);
		if (!node) throw new ImageStoreError('NO_MODEL', `Missing model file ${path}`);
		return this.vfs.readBlob(node.id);
	}

	async readBytesPath(dirId: string, path: string): Promise<Uint8Array> {
		const node = await this.resolveFileNode(dirId, path);
		if (!node) throw new ImageStoreError('NO_MODEL', `Missing model file ${path}`);
		return this.vfs.readBytes(node.id);
	}

	async removeModel(def: ImageModelDef, opts?: { dirId?: string }): Promise<void> {
		const id = opts?.dirId ?? (await this.findModelDir(def, null));
		if (id) await this.vfs.permanentDelete(id, { recursive: true });
	}

	/**
	 * Folder id for a repo path's parent, creating the chain as needed.
	 * Files keep their repo layout (`unet/model.onnx` stays nested) so
	 * same-basename weights never collide.
	 */
	private async ensureParentDir(dirId: string, repoPath: string): Promise<string> {
		const segments = repoPath.split('/').filter(Boolean).slice(0, -1);
		if (segments.length === 0) return dirId;
		const folders = await this.vfs.ensureFolders(dirId, [segments]);
		const id = folders.get(segments.join('/'));
		if (id == null) throw new ImageStoreError('NO_MODEL', `Could not create folders for ${repoPath}`);
		return id;
	}

	private async writeManifest(dirId: string, manifest: ImageModelManifest): Promise<void> {
		await this.vfs.writeFile({
			parentId: dirId,
			name: MANIFEST_NAME,
			body: new TextEncoder().encode(JSON.stringify(manifest, null, 2)),
			contentType: 'application/json'
		});
	}

	private async appendManifestFile(
		def: ImageModelDef,
		dirId: string,
		file: ImageModelManifestFile
	): Promise<void> {
		const manifest =
			(await this.readManifest(dirId, def.id)) ?? manifestFor(def, [], { origin: 'downloaded' });
		const next = manifest.files.filter((f) => f.path !== file.path);
		next.push(file);
		await this.writeManifest(dirId, { ...manifest, files: next });
	}

	private async pumpBlob(
		blob: Blob,
		dirId: string,
		name: string,
		opts?: { onProgress?: (p: ImageProgress) => void; signal?: AbortSignal }
	): Promise<{ node: VfsNode; sha256: string }> {
		return this.pumpStream(blob.stream().getReader(), blob.size, dirId, name, opts);
	}

	private async pumpStream(
		reader: ReadableStreamDefaultReader<Uint8Array>,
		total: number | undefined,
		dirId: string,
		name: string,
		opts?: { onProgress?: (p: ImageProgress) => void; signal?: AbortSignal }
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
}

/** Resolve URL for one file inside an image model repo. */
export function hfImageUrl(
	def: Pick<ImageModelDef, 'repo' | 'revision'>,
	path: string
): string {
	return `https://huggingface.co/${def.repo}/resolve/${def.revision}/${path}`;
}

function contentLength(res: Response): number | undefined {
	const raw = res.headers.get('content-length');
	if (!raw) return undefined;
	const n = Number(raw);
	return Number.isFinite(n) && n >= 0 ? n : undefined;
}
