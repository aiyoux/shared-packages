import { describe, expect, it } from 'vitest';
import {
	parseExplorerDropPayload,
	routeFileDrop,
	type DropTransferLike,
	type ExplorerDropPayload
} from './explorer-drop.ts';

function fakeTransfer(opts: {
	types: string[];
	files?: File[];
	data?: Record<string, string>;
}): DropTransferLike {
	const data = opts.data ?? {};
	return {
		types: opts.types,
		files: opts.files ?? [],
		getData(type) {
			return data[type] ?? '';
		}
	};
}

describe('parseExplorerDropPayload', () => {
	it('prefers JSON driverId + ids', () => {
		expect(
			parseExplorerDropPayload('{"driverId":"memory","ids":[" a ","b"]}')
		).toEqual({ driverId: 'memory', ids: ['a', 'b'] });
	});

	it('omits a missing or blank driverId', () => {
		expect(parseExplorerDropPayload('{"ids":["x"]}')).toEqual({ ids: ['x'] });
		expect(parseExplorerDropPayload('{"driverId":"  ","ids":["x"]}')).toEqual({
			ids: ['x']
		});
	});

	it('falls back to comma-separated ids', () => {
		expect(parseExplorerDropPayload(' a, b , ,c ')).toEqual({ ids: ['a', 'b', 'c'] });
		expect(parseExplorerDropPayload('')).toEqual({ ids: [] });
	});

	it('falls back to csv when JSON is invalid', () => {
		expect(parseExplorerDropPayload('{not-json')).toEqual({ ids: ['{not-json'] });
	});

	it('does not treat a JSON object without an ids array as csv', () => {
		expect(parseExplorerDropPayload('{"driverId":"memory"}')).toEqual({
			driverId: 'memory',
			ids: []
		});
	});
});

describe('routeFileDrop', () => {
	it('calls only onExplorerIds when explorer MIME and File clones are both present', () => {
		const filesCalls: File[][] = [];
		const explorerCalls: ExplorerDropPayload[] = [];
		const clone = new File(['x'], 'clone.bin');
		routeFileDrop(
			{
				dataTransfer: fakeTransfer({
					types: ['application/x-fe-explorer-ids', 'Files'],
					files: [clone],
					data: {
						'application/x-fe-explorer-ids': '{"driverId":"memory","ids":["a"]}'
					}
				}),
				clientX: 12,
				clientY: 34
			},
			{
				onfiles: (files) => filesCalls.push(files),
				onExplorerIds: (payload) => explorerCalls.push(payload)
			}
		);
		expect(filesCalls).toEqual([]);
		expect(explorerCalls).toEqual([
			{ driverId: 'memory', ids: ['a'], clientX: 12, clientY: 34 }
		]);
	});

	it('calls only onfiles for a true OS drop', () => {
		const filesCalls: File[][] = [];
		const explorerCalls: ExplorerDropPayload[] = [];
		const osFile = new File(['y'], 'os.bin');
		routeFileDrop(
			{
				dataTransfer: fakeTransfer({
					types: ['Files'],
					files: [osFile]
				}),
				clientX: 1,
				clientY: 2
			},
			{
				onfiles: (files) => filesCalls.push(files),
				onExplorerIds: (payload) => explorerCalls.push(payload)
			}
		);
		expect(explorerCalls).toEqual([]);
		expect(filesCalls).toEqual([[osFile]]);
	});

	it('emits clientX/Y and parses CSV explorer ids', () => {
		const explorerCalls: ExplorerDropPayload[] = [];
		routeFileDrop(
			{
				dataTransfer: fakeTransfer({
					types: ['application/x-cm-explorer-ids'],
					data: { 'application/x-cm-explorer-ids': 'id1, id2' }
				}),
				clientX: 8,
				clientY: 9
			},
			{
				onfiles: () => {
					throw new Error('onfiles must not run');
				},
				onExplorerIds: (payload) => explorerCalls.push(payload)
			}
		);
		expect(explorerCalls).toEqual([{ ids: ['id1', 'id2'], clientX: 8, clientY: 9 }]);
	});
});
