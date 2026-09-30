import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadNovasrModel } from './novasrModel.js';

const vfs = vi.hoisted(() => ({ ready: vi.fn(), ensureFolders: vi.fn(), childByName: vi.fn(), readBlob: vi.fn(), permanentDelete: vi.fn(), writeFileStream: vi.fn() }));
vi.mock('@shared-packages/file-system', () => ({ getSharedVfs: () => vfs }));
const fetchModel = vi.fn();
const digest = Uint8Array.from('0ece352753caec56d1815fb2410c6a4bd90e06119b2de85f921c20bfa6fc0274'.match(/../g)!, (b) => parseInt(b, 16)).buffer;
// Stand in for crypto's digest, without storing the 229 KB third-party model
// in the test tree. The production value is verified against the pinned HF file.
const bytes = new Uint8Array(228736);

beforeEach(() => {
	vi.clearAllMocks();
	vi.stubGlobal('fetch', fetchModel);
	vi.spyOn(crypto.subtle, 'digest').mockResolvedValue(digest);
	vfs.ready.mockResolvedValue(undefined);
	vfs.ensureFolders.mockImplementation(async (_parent, paths) => new Map([[paths[0].join('/'), 'model-folder']]));
	vfs.childByName.mockResolvedValue(null);
	vfs.readBlob.mockResolvedValue(new Blob([bytes]));
	vfs.permanentDelete.mockResolvedValue(undefined);
	vfs.writeFileStream.mockResolvedValue({ id: 'cached-model' });
	fetchModel.mockReset().mockImplementation(async () => new Response(bytes));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('NovaSR persistent model cache', () => {
	it('reuses and validates a cached pinned model without downloading again', async () => {
		vfs.childByName.mockResolvedValue({ id: 'model', kind: 'file' });
		const result = await loadNovasrModel(new AbortController().signal);
		expect(result).toEqual(bytes);
		expect(crypto.subtle.digest).toHaveBeenCalledWith('SHA-256', result);
		expect(fetchModel).not.toHaveBeenCalled();
		expect(vfs.writeFileStream).not.toHaveBeenCalled();
	});

	it('replaces corrupt cached bytes with a validated download', async () => {
		vfs.childByName.mockResolvedValue({ id: 'corrupt', kind: 'file' });
		vfs.readBlob.mockResolvedValue(new Blob(['truncated']));
		const signal = new AbortController().signal;
		await expect(loadNovasrModel(signal)).resolves.toEqual(bytes);
		expect(vfs.permanentDelete).toHaveBeenCalledWith('corrupt', { recursive: false });
		expect(fetchModel).toHaveBeenCalledOnce();
		expect(vfs.writeFileStream).toHaveBeenCalledWith(
			{ parentId: 'model-folder', name: 'novasr.onnx', contentType: 'application/octet-stream' },
			expect.any(ReadableStream), { signal }
		);
	});

	it('refuses a same-size model whose hash does not match the pin', async () => {
		vi.mocked(crypto.subtle.digest).mockResolvedValue(new ArrayBuffer(32));
		await expect(loadNovasrModel(new AbortController().signal)).rejects.toThrow('does not match the pinned model');
		expect(vfs.writeFileStream).not.toHaveBeenCalled();
	});

	it('passes cancellation to fetch and refuses to persist a late response', async () => {
		let respond!: (value: Response) => void;
		fetchModel.mockImplementationOnce(() => new Promise<Response>((resolve) => { respond = resolve; }));
		const controller = new AbortController();
		const pending = loadNovasrModel(controller.signal);
		const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
		await vi.waitFor(() => expect(fetchModel).toHaveBeenCalledOnce());
		expect(fetchModel.mock.calls[0]![1]).toEqual({ signal: controller.signal });
		controller.abort(new DOMException('Cancelled', 'AbortError'));
		respond(new Response(bytes));
		await rejected;
		expect(vfs.writeFileStream).not.toHaveBeenCalled();
	});
});
