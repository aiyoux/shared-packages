import type { FlowNode, NodeDocument, ScalarKind, ValueType } from './types.js';

export type SocketDir = 'in' | 'out';

export type SocketDef = { key: string; dir: SocketDir; type: ValueType; label: string };

/** Pack fan-in is 1..8. Non-integers truncate; anything outside the range clamps. */
export function clampPackCount(count: number): number {
	if (!Number.isFinite(count)) return 1;
	const n = Math.trunc(count);
	if (n < 1) return 1;
	if (n > 8) return 8;
	return n;
}

function valueType(type: ValueType): ValueType {
	if (type.kind === 'array') return { kind: 'array', of: type.of };
	return { kind: type.kind };
}

function scalar(kind: ScalarKind): ValueType {
	return { kind };
}

function filterParams(filter: FlowNode & { kind: 'filter' }): SocketDef[] {
	const floatIn = (key: string, label: string): SocketDef => ({
		key,
		dir: 'in',
		type: { kind: 'float' },
		label
	});
	switch (filter.filter) {
		case 'grayscale':
		case 'invert':
			return [floatIn('amount', 'Amount')];
		case 'blur':
			return [floatIn('radius', 'Radius')];
		case 'brightness-contrast':
			return [floatIn('brightness', 'Brightness'), floatIn('contrast', 'Contrast')];
		default: {
			const never: never = filter.filter;
			return never;
		}
	}
}

export function socketsOf(node: FlowNode): SocketDef[] {
	switch (node.kind) {
		case 'output':
			return [{ key: 'in', dir: 'in', type: valueType(node.valueType), label: 'In' }];
		case 'image':
			return [{ key: 'out', dir: 'out', type: { kind: 'image' }, label: 'Image' }];
		case 'int':
		case 'float':
		case 'string':
			return [{ key: 'out', dir: 'out', type: scalar(node.kind), label: 'Value' }];
		case 'pack': {
			const count = clampPackCount(node.inputCount);
			const sockets: SocketDef[] = [];
			for (let i = 0; i < count; i++) {
				sockets.push({
					key: `in-${i}`,
					dir: 'in',
					type: scalar(node.element),
					label: `In ${i + 1}`
				});
			}
			sockets.push({
				key: 'out',
				dir: 'out',
				type: { kind: 'array', of: node.element },
				label: 'Array'
			});
			return sockets;
		}
		case 'query':
			return [{ key: 'out', dir: 'out', type: valueType(node.valueType), label: 'Value' }];
		case 'filter':
			return [
				{ key: 'image', dir: 'in', type: { kind: 'image' }, label: 'Image' },
				...filterParams(node),
				{ key: 'out', dir: 'out', type: { kind: 'image' }, label: 'Image' }
			];
		default: {
			const never: never = node;
			return never;
		}
	}
}

export function socketOf(node: FlowNode, key: string): SocketDef | undefined {
	return socketsOf(node).find((socket) => socket.key === key);
}

/**
 * Identical types connect. `int` may widen to `float`, including as the element
 * of an array. Nothing else does — an image is not a float, and a scalar is
 * not an array.
 */
export function typesCompatible(from: ValueType, to: ValueType): boolean {
	if (from.kind === 'array' || to.kind === 'array') {
		if (from.kind !== 'array' || to.kind !== 'array') return false;
		return from.of === to.of || (from.of === 'int' && to.of === 'float');
	}
	if (from.kind === to.kind) return true;
	return from.kind === 'int' && to.kind === 'float';
}

/** CSS class names for a socket chip. Arrays carry both the family and the element. */
export function typeClass(type: ValueType): string {
	if (type.kind === 'array') return `type-array type-array-of-${type.of}`;
	return `type-${type.kind}`;
}

/**
 * True when a wire `fromNodeId -> toNodeId` would loop. Data flows along
 * existing wires in that direction; the new edge loops when `to` can already
 * reach `from`. A self-wire always loops.
 */
export function wireWouldCycle(doc: NodeDocument, fromNodeId: string, toNodeId: string): boolean {
	if (fromNodeId === toNodeId) return true;
	const next = new Map<string, string[]>();
	for (const wire of doc.wires) {
		const list = next.get(wire.fromNodeId);
		if (list) list.push(wire.toNodeId);
		else next.set(wire.fromNodeId, [wire.toNodeId]);
	}
	const seen = new Set<string>();
	const stack = [toNodeId];
	while (stack.length > 0) {
		const current = stack.pop() as string;
		if (current === fromNodeId) return true;
		if (seen.has(current)) continue;
		seen.add(current);
		const kids = next.get(current);
		if (kids) for (const kid of kids) stack.push(kid);
	}
	return false;
}
