import { describe, expect, it } from 'vitest';
import { evaluateOutput } from './eval.js';
import { parseNodeDocument, serializeNodeDocument } from './document.js';
import type { NodeDocument, QueryNode } from './types.js';

const query: QueryNode = {
	id: 'q',
	kind: 'query',
	x: 0,
	y: 0,
	viewId: 'names',
	valueType: { kind: 'array', of: 'string' },
	bind: 'clone',
	snapshot: { bytesRef: 'data:application/json,{}' }
};

const doc: NodeDocument = {
	schemaVersion: 1,
	nodes: [
		query,
		{ id: 'out', kind: 'output', x: 200, y: 0, valueType: { kind: 'array', of: 'string' } }
	],
	wires: [{ id: 'w', fromNodeId: 'q', fromSocket: 'out', toNodeId: 'out', toSocket: 'in' }]
};

describe('query node', () => {
	it('round-trips and evaluates through the host', async () => {
		expect(parseNodeDocument(serializeNodeDocument(doc))).toEqual(doc);
		const result = await evaluateOutput(doc, {
			loadImage: async () => null,
			applyFilter: async () => null,
			loadQuery: async () => ({
				kind: 'array',
				of: 'string',
				items: [{ kind: 'string', value: 'Ada' }]
			})
		});
		expect(result).toEqual({
			ok: true,
			type: { kind: 'array', of: 'string' },
			items: [{ kind: 'string', value: 'Ada' }]
		});
	});
});
