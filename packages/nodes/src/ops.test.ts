import { describe, expect, it } from 'vitest';
import { applyNodeOp, invertNodeOp, type NodeOp } from './index.js';
import type { FlowNode, NodeDocument, ValueType, Wire } from './index.js';

function output(id: string, valueType: ValueType): FlowNode {
	return { id, x: 0, y: 0, kind: 'output', valueType };
}

function docOf(nodes: FlowNode[], wires: Wire[] = []): NodeDocument {
	return { schemaVersion: 1, nodes, wires };
}

const image = { id: 'img', x: 0, y: 0, kind: 'image', bind: 'clone' } as const;
const floatConst = { id: 'fl', x: 0, y: 0, kind: 'float', value: 1.25 } as const;
const intConst = { id: 'n', x: 10, y: 20, kind: 'int', value: 2 } as const;

function blur(id: string): FlowNode {
	return {
		id,
		x: 0,
		y: 0,
		kind: 'filter',
		filter: 'blur',
		amount: 1,
		radius: 4,
		brightness: 0,
		contrast: 0
	};
}

function wire(id: string, from: string, fromSocket: string, to: string, toSocket: string): Wire {
	return { id, fromNodeId: from, fromSocket, toNodeId: to, toSocket };
}

function wireIds(doc: NodeDocument): string[] {
	return [...doc.wires.map((w) => w.id)].sort();
}

describe('applyNodeOp connect', () => {
	it('refuses float into an image input and accepts int into float', () => {
		const imageOut = docOf([output('out', { kind: 'image' }), floatConst, image]);
		const refused: NodeOp = {
			t: 'connect',
			wire: wire('w', 'fl', 'out', 'out', 'in')
		};
		expect(applyNodeOp(imageOut, refused)).toBe(imageOut);
		expect(invertNodeOp(imageOut, refused)).toBeNull();

		const floatOut = docOf([output('out', { kind: 'float' }), intConst]);
		const accepted: NodeOp = { t: 'connect', wire: wire('w', 'n', 'out', 'out', 'in') };
		const next = applyNodeOp(floatOut, accepted);
		expect(next).not.toBe(floatOut);
		expect(next.wires).toEqual([accepted.wire]);
		expect(next.wires[0]).not.toBe(accepted.wire);
		expect(floatOut.wires).toEqual([]);
		expect(applyNodeOp(next, accepted)).toBe(next);
	});

	it('refuses a cycle, including a self-wire', () => {
		const doc = docOf(
			[output('out', { kind: 'image' }), blur('a'), blur('b')],
			[wire('ab', 'a', 'out', 'b', 'image'), wire('bo', 'b', 'out', 'out', 'in')]
		);
		const back: NodeOp = { t: 'connect', wire: wire('ba', 'b', 'out', 'a', 'image') };
		expect(applyNodeOp(doc, back)).toBe(doc);
		const self: NodeOp = { t: 'connect', wire: wire('aa', 'a', 'out', 'a', 'image') };
		expect(applyNodeOp(doc, self)).toBe(doc);
	});

	it('replaces the wire already on an input', () => {
		const doc = docOf(
			[output('out', { kind: 'float' }), intConst, { ...floatConst }],
			[wire('old', 'fl', 'out', 'out', 'in')]
		);
		const next = applyNodeOp(doc, { t: 'connect', wire: wire('new', 'n', 'out', 'out', 'in') });
		expect(next.wires).toEqual([wire('new', 'n', 'out', 'out', 'in')]);
		const inv = invertNodeOp(doc, { t: 'connect', wire: wire('new', 'n', 'out', 'out', 'in') });
		expect(inv).toEqual([
			{ t: 'disconnect', wireId: 'new' },
			{ t: 'connect', wire: wire('old', 'fl', 'out', 'out', 'in') }
		]);
		let restored = next;
		for (const op of inv ?? []) restored = applyNodeOp(restored, op);
		expect(restored.wires).toEqual(doc.wires);
	});
});

describe('applyNodeOp structure', () => {
	it('refuses to remove the only output and removes anything else', () => {
		const doc = docOf([output('out', { kind: 'int' }), intConst], [wire('w', 'n', 'out', 'out', 'in')]);
		expect(applyNodeOp(doc, { t: 'remove-node', nodeId: 'out' })).toBe(doc);
		expect(invertNodeOp(doc, { t: 'remove-node', nodeId: 'out' })).toBeNull();
		expect(applyNodeOp(doc, { t: 'remove-node', nodeId: 'missing' })).toBe(doc);

		const removed = applyNodeOp(doc, { t: 'remove-node', nodeId: 'n' });
		expect(removed.nodes.map((node) => node.id)).toEqual(['out']);
		expect(removed.wires).toEqual([]);
		const inv = invertNodeOp(doc, { t: 'remove-node', nodeId: 'n' });
		expect(inv?.[0]).toMatchObject({ t: 'put-node', node: { id: 'n' } });
		expect(inv?.[1]).toMatchObject({ t: 'connect', wire: { id: 'w' } });
		let restored = removed;
		for (const op of inv ?? []) restored = applyNodeOp(restored, op);
		expect(restored.nodes.map((node) => node.id).sort()).toEqual(['n', 'out']);
		expect(wireIds(restored)).toEqual(['w']);
	});

	it('set-output-type drops an incompatible incoming wire and invert puts it back', () => {
		const doc = docOf([output('out', { kind: 'image' }), image], [wire('w', 'img', 'out', 'out', 'in')]);
		const op: NodeOp = { t: 'set-output-type', nodeId: 'out', valueType: { kind: 'float' } };
		const next = applyNodeOp(doc, op);
		expect(next.nodes[0]).toMatchObject({ valueType: { kind: 'float' } });
		expect(next.wires).toEqual([]);
		expect(doc.wires).toHaveLength(1);
		expect(applyNodeOp(next, op)).toBe(next);

		const kept = docOf(
			[output('out', { kind: 'float' }), intConst],
			[wire('w', 'n', 'out', 'out', 'in')]
		);
		const still = applyNodeOp(kept, { t: 'set-output-type', nodeId: 'out', valueType: { kind: 'int' } });
		expect(still.wires).toEqual(kept.wires);

		const inv = invertNodeOp(doc, op);
		let restored = next;
		for (const step of inv ?? []) restored = applyNodeOp(restored, step);
		expect(restored.nodes[0]).toMatchObject({ valueType: { kind: 'image' } });
		expect(wireIds(restored)).toEqual(['w']);
	});

	it('invert move-node restores position', () => {
		const doc = docOf([output('out', { kind: 'image' }), intConst]);
		const op: NodeOp = { t: 'move-node', nodeId: 'n', x: 30, y: 40 };
		const moved = applyNodeOp(doc, op);
		expect(moved.nodes[1]).toMatchObject({ x: 30, y: 40 });
		expect(applyNodeOp(moved, op)).toBe(moved);
		expect(applyNodeOp(doc, { t: 'move-node', nodeId: 'n', x: 10, y: 20 })).toBe(doc);
		expect(invertNodeOp(doc, { t: 'move-node', nodeId: 'missing', x: 1, y: 1 })).toBeNull();

		const inv = invertNodeOp(doc, op);
		expect(inv).toEqual([{ t: 'move-node', nodeId: 'n', x: 10, y: 20 }]);
		const restored = applyNodeOp(moved, inv![0]);
		expect(restored.nodes[1]).toMatchObject({ x: 10, y: 20 });
	});

	it('rename clears on empty string, set-const truncates ints, and wrong types no-op', () => {
		const doc = docOf([output('out', { kind: 'image' }), { ...intConst, name: 'Count' }]);
		const cleared = applyNodeOp(doc, { t: 'rename-node', nodeId: 'n', name: '' });
		expect(cleared.nodes[1]).not.toHaveProperty('name');
		expect(applyNodeOp(cleared, { t: 'rename-node', nodeId: 'n', name: '' })).toBe(cleared);
		const renamed = applyNodeOp(applyNodeOp(cleared, { t: 'rename-node', nodeId: 'n', name: 'Count' }), {
			t: 'rename-node',
			nodeId: 'n',
			name: 'Count'
		});
		expect(renamed).toBeTypeOf('object');

		const truncated = applyNodeOp(doc, { t: 'set-const', nodeId: 'n', value: 3.9 });
		expect(truncated.nodes[1]).toMatchObject({ value: 3 });
		expect(applyNodeOp(doc, { t: 'set-const', nodeId: 'n', value: 'nope' })).toBe(doc);
		expect(applyNodeOp(doc, { t: 'set-const', nodeId: 'out', value: 1 })).toBe(doc);
		const text = docOf([
			output('out', { kind: 'string' }),
			{ id: 's', x: 0, y: 0, kind: 'string', value: 'a' }
		]);
		expect(applyNodeOp(text, { t: 'set-const', nodeId: 's', value: 1 })).toBe(text);
		expect(applyNodeOp(text, { t: 'set-const', nodeId: 's', value: 'b' }).nodes[1]).toMatchObject({ value: 'b' });
	});

	it('set-filter drops param wires the new filter does not have', () => {
		const gray: FlowNode = {
			id: 'flt',
			x: 0,
			y: 0,
			kind: 'filter',
			filter: 'grayscale',
			amount: 1,
			radius: 4,
			brightness: 0,
			contrast: 0
		};
		const doc = docOf(
			[output('out', { kind: 'image' }), image, floatConst, gray],
			[wire('imgw', 'img', 'out', 'flt', 'image'), wire('amt', 'fl', 'out', 'flt', 'amount')]
		);
		const op: NodeOp = {
			t: 'set-filter',
			nodeId: 'flt',
			filter: 'blur',
			amount: 1,
			radius: 8,
			brightness: 0,
			contrast: 0
		};
		const next = applyNodeOp(doc, op);
		expect(wireIds(next)).toEqual(['imgw']);
		expect(next.nodes.find((node) => node.id === 'flt')).toMatchObject({ filter: 'blur', radius: 8 });
		const inv = invertNodeOp(doc, op);
		let restored = next;
		for (const step of inv ?? []) restored = applyNodeOp(restored, step);
		expect(restored.nodes.find((node) => node.id === 'flt')).toMatchObject({ filter: 'grayscale', radius: 4 });
		expect(wireIds(restored)).toEqual(['amt', 'imgw']);
	});

	it('set-pack clamps the count and drops wires whose types no longer match', () => {
		const pack: FlowNode = { id: 'p', x: 0, y: 0, kind: 'pack', element: 'int', inputCount: 2 };
		const doc = docOf(
			[output('out', { kind: 'array', of: 'int' }), intConst, { ...intConst, id: 'n2', value: 3 }, pack],
			[
				wire('a', 'n', 'out', 'p', 'in-0'),
				wire('b', 'n2', 'out', 'p', 'in-1'),
				wire('o', 'p', 'out', 'out', 'in')
			]
		);
		const shrunk = applyNodeOp(doc, { t: 'set-pack', nodeId: 'p', element: 'int', inputCount: 1 });
		expect(shrunk.nodes.find((node) => node.id === 'p')).toMatchObject({ inputCount: 1 });
		expect(wireIds(shrunk)).toEqual(['a', 'o']);

		const retyped = applyNodeOp(doc, { t: 'set-pack', nodeId: 'p', element: 'image', inputCount: 9 });
		expect(retyped.nodes.find((node) => node.id === 'p')).toMatchObject({ element: 'image', inputCount: 8 });
		expect(retyped.wires).toEqual([]);

		const widened = applyNodeOp(doc, { t: 'set-pack', nodeId: 'p', element: 'float', inputCount: 2 });
		expect(wireIds(widened)).toEqual(['a', 'b']);
		expect(applyNodeOp(doc, { t: 'set-pack', nodeId: 'p', element: 'int', inputCount: 2 })).toBe(doc);
	});

	it('put-node upserts by id, copies the node, and drops sockets that disappeared', () => {
		const doc = docOf([output('out', { kind: 'image' })]);
		const added = applyNodeOp(doc, { t: 'put-node', node: intConst });
		expect(added.nodes.map((node) => node.id)).toEqual(['out', 'n']);
		expect(added.nodes[1]).not.toBe(intConst);
		expect(applyNodeOp(added, { t: 'put-node', node: { ...intConst } })).toBe(added);

		const gray: FlowNode = {
			id: 'flt',
			x: 0,
			y: 0,
			kind: 'filter',
			filter: 'grayscale',
			amount: 1,
			radius: 4,
			brightness: 0,
			contrast: 0
		};
		const withFilter = docOf(
			[output('out', { kind: 'image' }), floatConst, gray],
			[wire('amt', 'fl', 'out', 'flt', 'amount')]
		);
		const replaced = applyNodeOp(withFilter, { t: 'put-node', node: blur('flt') });
		expect(replaced.wires).toEqual([]);
		const inv = invertNodeOp(withFilter, { t: 'put-node', node: blur('flt') });
		let restored = replaced;
		for (const step of inv ?? []) restored = applyNodeOp(restored, step);
		expect(restored.nodes.find((node) => node.id === 'flt')).toMatchObject({ filter: 'grayscale' });
		expect(wireIds(restored)).toEqual(['amt']);
	});
});
