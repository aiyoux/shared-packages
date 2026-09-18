import { describe, expect, it } from 'vitest';
import { applyDiagramOp, type DigrOp } from './ops.js';
import { DEFAULT_DIGR_CANVAS, type DigrDocument, type DigrNode } from './types.js';

function emptyDoc(): DigrDocument {
	return { schemaVersion: 1, nodes: [], canvas: { ...DEFAULT_DIGR_CANVAS } };
}

function docWith(...nodes: DigrNode[]): DigrDocument {
	return { schemaVersion: 1, nodes, canvas: { ...DEFAULT_DIGR_CANVAS } };
}

const box: DigrNode = { id: 'a', x: 10, y: 10, w: 100, h: 50, text: 'Box' };

describe('applyDiagramOp', () => {
	it('put-node appends, and upserts in place when the id exists', () => {
		let doc = applyDiagramOp(emptyDoc(), { t: 'put-node', node: box });
		expect(doc.nodes).toEqual([box]);
		const moved: DigrNode = { ...box, x: 500 };
		const doc2 = applyDiagramOp(doc, { t: 'put-node', node: moved });
		expect(doc2.nodes).toEqual([moved]);
		expect(doc2.nodes[0]).not.toBe(moved); // a copy, not the caller's object
	});

	it('put-node appends at the end — array order is z-order', () => {
		const doc = docWith(box);
		const next = applyDiagramOp(doc, {
			t: 'put-node',
			node: { id: 'b', x: 0, y: 0, w: 10, h: 10, text: 'On top' }
		});
		expect(next.nodes.map((n) => n.id)).toEqual(['a', 'b']);
	});

	it('set-node-frame fully replaces the frame — absent rotation clears it', () => {
		const doc = docWith({ ...box, rotation: 0.25 });
		const next = applyDiagramOp(doc, {
			t: 'set-node-frame',
			nodeId: 'a',
			frame: { x: 1, y: 2, w: 3, h: 4 }
		});
		expect(next.nodes[0]).toMatchObject({ x: 1, y: 2, w: 3, h: 4, text: 'Box' });
		expect('rotation' in next.nodes[0]).toBe(false);
	});

	it('set-node-frame can set and clear rotation', () => {
		const doc = docWith(box);
		const rotated = applyDiagramOp(doc, {
			t: 'set-node-frame',
			nodeId: 'a',
			frame: { x: 1, y: 2, w: 3, h: 4, rotation: 1 }
		});
		expect(rotated.nodes[0].rotation).toBe(1);
		const cleared = applyDiagramOp(rotated, {
			t: 'set-node-frame',
			nodeId: 'a',
			frame: { x: 1, y: 2, w: 3, h: 4, rotation: 0 }
		});
		expect('rotation' in cleared.nodes[0]).toBe(false);
	});

	it('set-node-text replaces text; identical text returns the same document', () => {
		const doc = docWith(box);
		const changed = applyDiagramOp(doc, { t: 'set-node-text', nodeId: 'a', text: 'New' });
		expect(changed.nodes[0].text).toBe('New');
		expect(applyDiagramOp(doc, { t: 'set-node-text', nodeId: 'a', text: 'Box' })).toBe(doc);
	});

	it('remove-node drops the node; removing an absent id is a no-op', () => {
		const doc = docWith(box);
		expect(applyDiagramOp(doc, { t: 'remove-node', nodeId: 'a' }).nodes).toEqual([]);
		expect(applyDiagramOp(doc, { t: 'remove-node', nodeId: 'zz' })).toBe(doc);
	});

	it('set-node-style writes a copy and empty styles clear the field', () => {
		const doc = docWith(box);
		const styled = applyDiagramOp(doc, {
			t: 'set-node-style',
			nodeId: 'a',
			style: { fill: '#123456' }
		});
		expect(styled.nodes[0].style).toEqual({ fill: '#123456' });
		const cleared = applyDiagramOp(styled, { t: 'set-node-style', nodeId: 'a', style: null });
		expect('style' in cleared.nodes[0]).toBe(false);
		const emptyCleared = applyDiagramOp(doc, {
			t: 'set-node-style',
			nodeId: 'a',
			style: {}
		});
		expect('style' in emptyCleared.nodes[0]).toBe(false);
	});

	it('set-canvas writes a copy and is a no-op for identical dimensions', () => {
		const doc = emptyDoc();
		const resized = applyDiagramOp(doc, { t: 'set-canvas', canvas: { w: 800, h: 600 } });
		expect(resized.canvas).toEqual({ w: 800, h: 600 });
		expect(resized.canvas).not.toBe(doc.canvas);
		expect(applyDiagramOp(doc, { t: 'set-canvas', canvas: { ...DEFAULT_DIGR_CANVAS } })).toBe(doc);
	});

	it('unknown node ids leave the document unchanged', () => {
		const doc = docWith(box);
		expect(applyDiagramOp(doc, { t: 'set-node-frame', nodeId: 'zz', frame: { x: 0, y: 0, w: 1, h: 1 } })).toBe(doc);
		expect(applyDiagramOp(doc, { t: 'set-node-text', nodeId: 'zz', text: 'x' })).toBe(doc);
		expect(applyDiagramOp(doc, { t: 'set-node-style', nodeId: 'zz', style: { fill: '#000000' } })).toBe(doc);
	});

	it('ops are idempotent', () => {
		let doc = docWith(box);
		const ops: DigrOp[] = [
			{ t: 'put-node', node: { id: 'b', x: 0, y: 0, w: 5, h: 5, text: 'B' } },
			{ t: 'set-node-frame', nodeId: 'a', frame: { x: 9, y: 9, w: 9, h: 9 } },
			{ t: 'set-node-text', nodeId: 'a', text: 'Again' },
			{ t: 'set-node-style', nodeId: 'a', style: { stroke: '#abcdef' } },
			{ t: 'set-canvas', canvas: { w: 2000, h: 1200 } }
		];
		for (const op of ops) doc = applyDiagramOp(doc, op);
		let twice = doc;
		for (const op of ops) twice = applyDiagramOp(twice, op);
		expect(twice).toEqual(doc);
	});
});