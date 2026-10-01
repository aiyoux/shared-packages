/** Pinned NovaSR weights cached in the same VFS tree as speech models. */
const REVISION = '5d92bf1488aae6d92356ef5951c7ef9bf9f9801b';
export const NOVASR_MODEL_URL =
	`https://huggingface.co/TigreGotico/audiosronnx-novasr/resolve/${REVISION}/novasr.onnx`;
const MODEL_BYTES = 228736;
const MODEL_SHA256 = '0ece352753caec56d1815fb2410c6a4bd90e06119b2de85f921c20bfa6fc0274';
const MODEL_PATH = ['Speech Models', 'novasr', REVISION, 'novasr.onnx'];

/** Inspect without creating folders or fetching any weights. */
async function storedModel() {
	const { getSharedVfs } = await import('@shared-packages/file-system');
	const vfs = getSharedVfs();
	await vfs.ready();
	let parentId: string | null = null;
	for (const [index, name] of MODEL_PATH.entries()) {
		const node = await vfs.childByName(parentId, name);
		if (!node || node.kind !== (index === MODEL_PATH.length - 1 ? 'file' : 'folder')) return { vfs, node: null };
		if (index === MODEL_PATH.length - 1) return { vfs, node };
		parentId = node.id;
	}
	return { vfs, node: null };
}

export async function inspectNovasrModel(): Promise<'installed' | 'partial' | 'not-installed'> {
	const { vfs, node } = await storedModel();
	if (!node) return 'not-installed';
	const bytes = new Uint8Array(await (await vfs.readBlob(node.id)).arrayBuffer());
	return await valid(bytes, new AbortController().signal) ? 'installed' : 'partial';
}

export async function removeNovasrModel(): Promise<void> {
	const { vfs, node } = await storedModel();
	if (node) await vfs.permanentDelete(node.id, { recursive: false });
}

async function valid(bytes: Uint8Array<ArrayBuffer>, signal: AbortSignal): Promise<boolean> {
	if (bytes.length !== MODEL_BYTES) return false;
	const hash = await crypto.subtle.digest('SHA-256', bytes);
	signal.throwIfAborted();
	return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('') === MODEL_SHA256;
}

export async function loadNovasrModel(signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
	const { getSharedVfs } = await import('@shared-packages/file-system');
	signal.throwIfAborted();
	const vfs = getSharedVfs();
	await vfs.ready();
	signal.throwIfAborted();
	const path = ['Speech Models', 'novasr', REVISION];
	const folders = await vfs.ensureFolders(null, [path], { signal });
	const dirId = folders.get(path.join('/'));
	if (!dirId) throw new Error('Could not create the NovaSR model folder in Files');
	const node = await vfs.childByName(dirId, 'novasr.onnx');
	signal.throwIfAborted();
	if (node?.kind === 'file') {
		const bytes = new Uint8Array(await (await vfs.readBlob(node.id)).arrayBuffer());
		signal.throwIfAborted();
		if (await valid(bytes, signal)) return bytes;
		await vfs.permanentDelete(node.id, { recursive: false });
		signal.throwIfAborted();
	}
	const res = await fetch(NOVASR_MODEL_URL, { signal });
	if (!res.ok) throw new Error(`Could not download NovaSR (${res.status})`);
	const bytes = new Uint8Array(await res.arrayBuffer());
	signal.throwIfAborted();
	if (!(await valid(bytes, signal))) throw new Error('NovaSR download does not match the pinned model');
	await vfs.writeFileStream(
		{ parentId: dirId, name: 'novasr.onnx', contentType: 'application/octet-stream' },
		new Blob([bytes]).stream(),
		{ signal }
	);
	signal.throwIfAborted();
	return bytes;
}
