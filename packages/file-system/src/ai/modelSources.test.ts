import { describe, expect, it, vi } from 'vitest';
import type { ModelDef } from '@shared-packages/model-store';
import type { ExplorerDriver, ExplorerEntry } from '../ui/explorerDriver.js';

vi.mock('../monitor/credentials.js', () => ({ listProfiles: async () => [] }));
vi.mock('../b2/connections.js', () => ({ listB2Connections: async () => ({ rows: [], unreachable: [] }) }));
import { connectModelDevice, folderModelFiles, linkedDeviceFiles, onlineModelFiles, onlineUrl, registerModelDeviceConnect } from './modelSources.js';

const def: ModelDef = {
	id: 'speech:test', task: 'transcription', label: 'Test',
	files: [
		{ path: 'config.json', bytes: 2 },
		{ path: 'onnx/model.onnx', bytes: 5 },
		{ path: 'cdn.bin', bytes: 3, url: 'https://cdn.jsdelivr.net/gh/x/y@abc/cdn.bin' }
	],
	origin: { kind: 'hf', repo: 'org/repo', revision: 'a'.repeat(40) }
};

/** A folder tree as an explorer driver; `listed` records which folders were read. */
function treeDriver(tree: Record<string, Record<string, number | 'folder'>>) {
	const listed: Array<string | null> = [];
	const driver = {
		async list({ parentId }: { parentId: string | null }) {
			listed.push(parentId);
			const entries: ExplorerEntry[] = Object.entries(tree[parentId ?? ''] ?? {}).map(([name, size]) => ({
				id: `${parentId ?? ''}/${name}`, parentId, name, kind: size === 'folder' ? 'folder' : 'file', size: size === 'folder' ? undefined : size
			}) as ExplorerEntry);
			return { entries, truncated: false };
		},
		async readBlob(id: string) { return new Blob([id]); }
	} as unknown as ExplorerDriver;
	return { driver, listed };
}

describe('model sources', () => {
	it('walks only the folders a model names and matches by relative path', async () => {
		const { driver, listed } = treeDriver({
			'/m': { 'config.json': 2, onnx: 'folder', unrelated: 'folder' },
			'/m/onnx': { 'model.onnx': 4 }
		});
		const rows = await folderModelFiles(def, driver, '/m');
		expect(rows.map((row) => [row.file.path, row.state])).toEqual([
			['config.json', 'found'], ['onnx/model.onnx', 'size-mismatch'], ['cdn.bin', 'missing']
		]);
		expect(listed).toEqual(['/m', '/m/onnx']);
		const stream = await rows[0]!.source!.open(new AbortController().signal);
		expect(await new Response(stream).text()).toBe('/m/config.json');
	});

	it('derives pinned resolve URLs for HF files and keeps explicit ones', () => {
		expect(onlineUrl(def, 'onnx/model.onnx')).toBe(`https://huggingface.co/org/repo/resolve/${'a'.repeat(40)}/onnx/model.onnx`);
		expect(onlineUrl(def, 'cdn.bin')).toBe('https://cdn.jsdelivr.net/gh/x/y@abc/cdn.bin');
		expect(onlineUrl({ ...def, origin: { kind: 'user' }, files: [{ path: 'own.onnx' }] }, 'own.onnx')).toBeNull();
	});

	it('marks files on hosts the monitor will not retrieve as not fetchable, up front', async () => {
		const rows = onlineModelFiles(def, { id: 'online:pc', label: 'PC', baseUrl: 'http://pc:8300/', hosts: ['huggingface.co'] });
		expect(rows.map((row) => row.state)).toEqual(['found', 'found', 'not-fetchable']);
		const fetch = vi.fn(async () => new Response('ok'));
		vi.stubGlobal('fetch', fetch);
		try {
			await rows[1]!.source!.open(new AbortController().signal);
			const [url] = fetch.mock.calls[0] as unknown as [string];
			expect(url).toBe(`http://pc:8300/v1/tools/fetch?url=${encodeURIComponent(onlineUrl(def, 'onnx/model.onnx')!)}`);
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it('has nothing to fetch online for a user-supplied model', () => {
		const user: ModelDef = { id: 'scan:x', task: 'scan-detect', label: 'X', files: [{ path: 'x.onnx' }], origin: { kind: 'user' } };
		expect(onlineModelFiles(user, { id: 'o', label: 'PC', baseUrl: 'http://pc', hosts: ['huggingface.co'] })[0]!.state).toBe('not-fetchable');
	});

	it('starts the registered device connect flow and reports when none is registered', () => {
		expect(connectModelDevice()).toBe(false);
		const connect = vi.fn();
		registerModelDeviceConnect(connect);
		expect(connectModelDevice()).toBe(true);
		expect(connect).toHaveBeenCalledOnce();
		registerModelDeviceConnect(null);
		expect(connectModelDevice()).toBe(false);
	});

	it("counts a linked device's file only with the def's size and hash", () => {
		const withHash: ModelDef = { ...def, files: [{ path: 'a', bytes: 1, blake3: 'f'.repeat(64) }, { path: 'b', bytes: 2 }, { path: 'c', bytes: 3 }] };
		expect(linkedDeviceFiles(withHash, [
			{ path: 'a', bytes: 1, blake3: '0'.repeat(64) },
			{ path: 'b', bytes: 2, blake3: '1'.repeat(64) },
			{ path: 'c', bytes: 4, blake3: '2'.repeat(64) }
		]).map((row) => row.state)).toEqual(['hash-mismatch', 'found', 'size-mismatch']);
	});
});
