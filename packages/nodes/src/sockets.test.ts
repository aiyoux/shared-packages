import { describe, expect, it } from 'vitest';
import { socketOf, socketsOf, typeClass, typesCompatible, wireWouldCycle } from './index.js';
import type { FlowNode, NodeDocument } from './index.js';

function filter(id: string, kind: 'grayscale' | 'blur' | 'brightness-contrast' | 'invert'): FlowNode {
	return {
		id,
		x: 0,
		y: 0,
		kind: 'filter',
		filter: kind,
		amount: 1,
		radius: 4,
		brightness: 0,
		contrast: 0
	};
}

describe('socketsOf', () => {
	it('describes each kind', () => {
		expect(socketsOf({ id: 'o', x: 0, y: 0, kind: 'output', valueType: { kind: 'float' } })).toEqual([
			{ key: 'in', dir: 'in', type: { kind: 'float' }, label: 'In' }
		]);
		expect(socketsOf({ id: 'i', x: 0, y: 0, kind: 'image', bind: 'clone' })).toEqual([
			{ key: 'out', dir: 'out', type: { kind: 'image' }, label: 'Image' }
		]);
		expect(socketsOf({ id: 'n', x: 0, y: 0, kind: 'int', value: 1 })[0]).toMatchObject({
			key: 'out',
			dir: 'out',
			type: { kind: 'int' },
			label: 'Value'
		});
		expect(socketsOf({ id: 's', x: 0, y: 0, kind: 'string', value: 'a' })[0].type).toEqual({ kind: 'string' });
		const pack = socketsOf({ id: 'p', x: 0, y: 0, kind: 'pack', element: 'int', inputCount: 2 });
		expect(pack.map((socket) => [socket.key, socket.label, socket.dir])).toEqual([
			['in-0', 'In 1', 'in'],
			['in-1', 'In 2', 'in'],
			['out', 'Array', 'out']
		]);
		expect(pack[2].type).toEqual({ kind: 'array', of: 'int' });
		expect(socketsOf({ id: 'p', x: 0, y: 0, kind: 'pack', element: 'float', inputCount: 100 })).toHaveLength(9);
		expect(socketsOf({ id: 'p', x: 0, y: 0, kind: 'pack', element: 'float', inputCount: 0 })).toHaveLength(2);
		expect(socketsOf(filter('g', 'grayscale')).map((socket) => socket.key)).toEqual(['image', 'amount', 'out']);
		expect(socketsOf(filter('b', 'blur')).map((socket) => socket.key)).toEqual(['image', 'radius', 'out']);
		expect(socketsOf(filter('bc', 'brightness-contrast')).map((socket) => [socket.key, socket.label])).toEqual([
			['image', 'Image'],
			['brightness', 'Brightness'],
			['contrast', 'Contrast'],
			['out', 'Image']
		]);
		expect(socketOf(filter('v', 'invert'), 'amount')?.label).toBe('Amount');
		expect(socketOf(filter('v', 'invert'), 'radius')).toBeUndefined();
	});
});

describe('typesCompatible / typeClass', () => {
	it('allows identical types and int widening to float, including arrays', () => {
		expect(typesCompatible({ kind: 'int' }, { kind: 'float' })).toBe(true);
		expect(typesCompatible({ kind: 'float' }, { kind: 'int' })).toBe(false);
		expect(typesCompatible({ kind: 'float' }, { kind: 'image' })).toBe(false);
		expect(typesCompatible({ kind: 'int' }, { kind: 'int' })).toBe(true);
		expect(typesCompatible({ kind: 'string' }, { kind: 'string' })).toBe(true);
		expect(typesCompatible({ kind: 'image' }, { kind: 'image' })).toBe(true);
		expect(typesCompatible({ kind: 'array', of: 'int' }, { kind: 'array', of: 'int' })).toBe(true);
		expect(typesCompatible({ kind: 'array', of: 'int' }, { kind: 'array', of: 'float' })).toBe(true);
		expect(typesCompatible({ kind: 'array', of: 'float' }, { kind: 'array', of: 'int' })).toBe(false);
		expect(typesCompatible({ kind: 'int' }, { kind: 'array', of: 'int' })).toBe(false);
		expect(typesCompatible({ kind: 'array', of: 'image' }, { kind: 'image' })).toBe(false);
		expect(typeClass({ kind: 'float' })).toBe('type-float');
		expect(typeClass({ kind: 'array', of: 'int' })).toBe('type-array type-array-of-int');
	});
});

describe('wireWouldCycle', () => {
	const base: NodeDocument = {
		schemaVersion: 1,
		nodes: [],
		wires: [
			{ id: 'ab', fromNodeId: 'a', fromSocket: 'out', toNodeId: 'b', toSocket: 'in' },
			{ id: 'bc', fromNodeId: 'b', fromSocket: 'out', toNodeId: 'c', toSocket: 'in' }
		]
	};

	it('rejects a self-wire and a back edge, and allows a forward edge', () => {
		expect(wireWouldCycle(base, 'a', 'a')).toBe(true);
		expect(wireWouldCycle(base, 'c', 'a')).toBe(true);
		expect(wireWouldCycle(base, 'a', 'c')).toBe(false);
	});

	it('terminates when the graph already contains a cycle', () => {
		const cyclic: NodeDocument = {
			...base,
			wires: [
				{ id: 'ab', fromNodeId: 'a', fromSocket: 'out', toNodeId: 'b', toSocket: 'in' },
				{ id: 'ba', fromNodeId: 'b', fromSocket: 'out', toNodeId: 'a', toSocket: 'in' }
			]
		};
		expect(wireWouldCycle(cyclic, 'c', 'd')).toBe(false);
		expect(wireWouldCycle(cyclic, 'b', 'a')).toBe(true);
	});
});
