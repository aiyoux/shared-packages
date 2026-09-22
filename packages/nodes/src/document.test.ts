import { describe, expect, it } from 'vitest';
import {
	NodeParseError,
	emptyNodeDocument,
	ensureNodeIdentity,
	parseNodeDocument,
	parseNodeView,
	serializeNodeDocument
} from './index.js';
import type { NodeDocument } from './index.js';

const source = { backend: 'shared-vfs' as const, nodeId: 'vfs-1', generation: 4 };

const doc: NodeDocument = {
	schemaVersion: 1,
	id: 'nodes-1',
	createdAt: 42,
	nodes: [
		{ id: 'out', x: 640, y: 180, name: 'Output', kind: 'output', valueType: { kind: 'image' } },
		{ id: 'img', x: 10, y: 20, kind: 'image', bind: 'clone', snapshot: { bytesRef: 'b1', atGeneration: 3 } },
		{ id: 'live', x: 1, y: 2, name: 'Plate', kind: 'image', bind: 'live', source },
		{
			id: 'mon',
			x: 3,
			y: 4,
			kind: 'image',
			bind: 'snapshot',
			source: { backend: 'monitor', profileId: 'p', relPath: 'a/b.png', ino: '9', dev: '1' },
			snapshot: { bytesRef: 'b2', atCommit: 'abc' }
		},
		{ id: 'gi', x: 5, y: 6, kind: 'image', bind: 'gitPin', source: { backend: 'shared-vfs', nodeId: 'pin' } },
		{ id: 'n', x: 8, y: 9, name: 'Count', kind: 'int', value: 4 },
		{ id: 'f', x: 11, y: 12, kind: 'float', value: 1.5 },
		{ id: 's', x: 13, y: 14, kind: 'string', value: 'hi' },
		{ id: 'p', x: 15, y: 16, kind: 'pack', element: 'int', inputCount: 2 },
		{
			id: 'flt',
			x: 17,
			y: 18,
			kind: 'filter',
			filter: 'blur',
			amount: 0.5,
			radius: 6,
			brightness: -1,
			contrast: 2
		}
	],
	wires: [
		{ id: 'w1', fromNodeId: 'img', fromSocket: 'out', toNodeId: 'flt', toSocket: 'image' },
		{ id: 'w2', fromNodeId: 'flt', fromSocket: 'out', toNodeId: 'out', toSocket: 'in' }
	]
};

describe('parseNodeDocument', () => {
	it('round-trips a document through serialize + parse', () => {
		expect(parseNodeDocument(serializeNodeDocument(doc))).toEqual(doc);
	});

	it('is byte-stable and writes fields in a stable order', () => {
		const once = serializeNodeDocument(doc);
		expect(serializeNodeDocument(parseNodeDocument(once))).toBe(once);
		expect(Object.keys(JSON.parse(once))).toEqual(['schemaVersion', 'id', 'createdAt', 'nodes', 'wires']);
		const nodes = JSON.parse(once).nodes as Array<Record<string, unknown>>;
		expect(Object.keys(nodes[0])).toEqual(['id', 'x', 'y', 'name', 'kind', 'valueType']);
		expect(Object.keys(nodes[1])).toEqual(['id', 'x', 'y', 'kind', 'bind', 'snapshot']);
		expect(nodes[1]).not.toHaveProperty('source');
		expect(Object.keys(nodes[2])).toEqual(['id', 'x', 'y', 'name', 'kind', 'bind', 'source']);
	});

	it('parses from bytes and from JSON strings', () => {
		const bytes = new TextEncoder().encode(JSON.stringify(doc));
		expect(parseNodeDocument(bytes)).toEqual(doc);
		expect(parseNodeDocument(JSON.stringify(doc))).toEqual(doc);
	});

	it('omits an empty name and keeps a whitespace name', () => {
		const parsed = parseNodeDocument({
			schemaVersion: 1,
			nodes: [
				{ id: 'o', x: 0, y: 0, kind: 'output', valueType: { kind: 'int' }, name: '' },
				{ id: 'c', x: 1, y: 1, kind: 'int', value: 1, name: '  ' }
			],
			wires: []
		});
		expect(parsed.nodes[0]).not.toHaveProperty('name');
		expect(parsed.nodes[1].name).toBe('  ');
	});

	it('defaults missing filter params and clamps pack inputCount', () => {
		const parsed = parseNodeDocument({
			schemaVersion: 1,
			nodes: [
				{ id: 'o', x: 0, y: 0, kind: 'output', valueType: { kind: 'image' } },
				{ id: 'flt', x: 0, y: 0, kind: 'filter', filter: 'invert' },
				{ id: 'wide', x: 0, y: 0, kind: 'pack', element: 'float', inputCount: 99 },
				{ id: 'narrow', x: 0, y: 0, kind: 'pack', element: 'string', inputCount: 0 },
				{ id: 'frac', x: 0, y: 0, kind: 'pack', element: 'int', inputCount: 2.9 }
			],
			wires: []
		});
		expect(parsed.nodes[1]).toMatchObject({ amount: 1, radius: 4, brightness: 0, contrast: 0 });
		expect(parsed.nodes[2]).toMatchObject({ inputCount: 8 });
		expect(parsed.nodes[3]).toMatchObject({ inputCount: 1 });
		expect(parsed.nodes[4]).toMatchObject({ inputCount: 2 });
	});

	it('drops wires whose endpoints or socket keys do not exist, and keeps a type mismatch', () => {
		const parsed = parseNodeDocument({
			schemaVersion: 1,
			nodes: [
				{ id: 'o', x: 0, y: 0, kind: 'output', valueType: { kind: 'image' } },
				{ id: 'img', x: 0, y: 0, kind: 'image', bind: 'clone' },
				{ id: 'n', x: 0, y: 0, kind: 'int', value: 1 },
				{ id: 'flt', x: 0, y: 0, kind: 'filter', filter: 'blur' }
			],
			wires: [
				{ id: 'ok', fromNodeId: 'img', fromSocket: 'out', toNodeId: 'flt', toSocket: 'image' },
				{ id: 'missing-node', fromNodeId: 'nope', fromSocket: 'out', toNodeId: 'flt', toSocket: 'image' },
				{ id: 'missing-socket', fromNodeId: 'img', fromSocket: 'out', toNodeId: 'flt', toSocket: 'amount' },
				{ id: 'mismatch', fromNodeId: 'n', fromSocket: 'out', toNodeId: 'o', toSocket: 'in' }
			]
		});
		expect(parsed.wires.map((wire) => wire.id)).toEqual(['ok', 'mismatch']);
	});

	it('never writes a view into the document, and ignores one on read', () => {
		const stale = parseNodeDocument({
			schemaVersion: 1,
			nodes: [{ id: 'o', x: 0, y: 0, kind: 'output', valueType: { kind: 'image' } }],
			wires: [],
			view: { layout: { kind: 'leaf' }, windows: { leaf1: { role: 'graph' } } }
		});
		expect('view' in stale).toBe(false);
		expect(JSON.parse(serializeNodeDocument(stale))).not.toHaveProperty('view');
	});

	it('requires an output node', () => {
		expect(() =>
			parseNodeDocument({
				schemaVersion: 1,
				nodes: [{ id: 'c', x: 0, y: 0, kind: 'int', value: 1 }],
				wires: []
			})
		).toThrow(NodeParseError);
	});

	it('rejects a clone that carries a source and a bound image without one', () => {
		expect(() =>
			parseNodeDocument({
				schemaVersion: 1,
				nodes: [
					{ id: 'o', x: 0, y: 0, kind: 'output', valueType: { kind: 'image' } },
					{ id: 'img', x: 0, y: 0, kind: 'image', bind: 'clone', source: source }
				],
				wires: []
			})
		).toThrow(NodeParseError);
		expect(() =>
			parseNodeDocument({
				schemaVersion: 1,
				nodes: [
					{ id: 'o', x: 0, y: 0, kind: 'output', valueType: { kind: 'image' } },
					{ id: 'img', x: 0, y: 0, kind: 'image', bind: 'live' }
				],
				wires: []
			})
		).toThrow(NodeParseError);
	});

	it('rejects a non-finite number and the wrong const value type', () => {
		expect(() =>
			parseNodeDocument({
				schemaVersion: 1,
				nodes: [{ id: 'o', x: NaN, y: 0, kind: 'output', valueType: { kind: 'image' } }],
				wires: []
			})
		).toThrow(NodeParseError);
		expect(() =>
			parseNodeDocument({
				schemaVersion: 1,
				nodes: [
					{ id: 'o', x: 0, y: 0, kind: 'output', valueType: { kind: 'image' } },
					{ id: 's', x: 0, y: 0, kind: 'string', value: 1 }
				],
				wires: []
			})
		).toThrow(NodeParseError);
	});

	it('validates a stored view record without it being part of the document', () => {
		const view = {
			layout: { kind: 'split', id: 'root', direction: 'row', ratio: 0.5 },
			windows: { canvas: { role: 'graph' } }
		};
		expect(parseNodeView(view)).toEqual(view);
		expect(parseNodeView(undefined)).toBeUndefined();
		expect(parseNodeView({ windows: {} })).toBeUndefined();
		expect(parseNodeView({ layout: 'nope' })).toBeUndefined();
		expect(parseNodeView({ layout: ['nope'], windows: { a: { role: 'graph' } } })).toEqual({
			windows: { a: { role: 'graph' } }
		});
		expect(parseNodeView({ layout: { kind: 'leaf' } })).toEqual({ layout: { kind: 'leaf' } });
		expect(() => parseNodeView({ windows: { a: { role: '' } } })).toThrow(NodeParseError);
		expect(() => parseNodeView([])).toThrow(NodeParseError);
	});

	it('rejects the wrong schemaVersion and invalid shapes', () => {
		expect(() => parseNodeDocument({ schemaVersion: 2, nodes: [], wires: [] })).toThrow(NodeParseError);
		expect(() => parseNodeDocument('not json')).toThrow(NodeParseError);
		expect(() => parseNodeDocument([])).toThrow(NodeParseError);
		expect(() => parseNodeDocument({ schemaVersion: 1 })).toThrow(NodeParseError);
	});
});

describe('emptyNodeDocument', () => {
	it('has one image output and travelling identity', () => {
		const empty = emptyNodeDocument();
		expect(empty.schemaVersion).toBe(1);
		expect(empty.wires).toEqual([]);
		expect(empty.nodes).toHaveLength(1);
		expect(empty.nodes[0]).toMatchObject({
			kind: 'output',
			name: 'Output',
			x: 640,
			y: 180,
			valueType: { kind: 'image' }
		});
		expect(empty.id).toEqual(expect.any(String));
		expect(empty.id).not.toBe('');
		expect(empty.createdAt).toEqual(expect.any(Number));
		expect(empty.nodes[0].id).toEqual(expect.any(String));
		expect(empty.nodes[0].id).not.toBe(empty.id);
		expect(ensureNodeIdentity(empty)).toBe(empty);

		const minted = ensureNodeIdentity({
			schemaVersion: 1,
			nodes: [{ id: 'o', x: 0, y: 0, kind: 'output', valueType: { kind: 'image' } }],
			wires: []
		});
		expect(minted).not.toBe(
			ensureNodeIdentity({
				schemaVersion: 1,
				nodes: [{ id: 'o', x: 0, y: 0, kind: 'output', valueType: { kind: 'image' } }],
				wires: []
			})
		);
		expect(ensureNodeIdentity(minted)).toBe(minted);
	});
});
