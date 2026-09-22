/**
 * The node document's op vocabulary and reducer.
 *
 * Idempotent: applying the same op twice equals applying it once, and an op
 * that changes nothing returns the same document reference. Poses and values
 * are absolute. `invertNodeOp` returns null when apply would no-op; otherwise
 * the inverse ops restore the previous document.
 */

import { clampPackCount, socketOf, socketsOf, typesCompatible, wireWouldCycle } from './sockets.js';
import type {
	ConstNode,
	DocSource,
	FilterKind,
	FilterNode,
	FlowNode,
	NodeDocument,
	NodeSnapshot,
	OutputNode,
	PackNode,
	ScalarKind,
	ValueType,
	Wire
} from './types.js';

export type NodeOp =
	| { t: 'put-node'; node: FlowNode }
	| { t: 'remove-node'; nodeId: string }
	| { t: 'move-node'; nodeId: string; x: number; y: number }
	| { t: 'rename-node'; nodeId: string; name: string }
	| { t: 'set-const'; nodeId: string; value: number | string }
	| {
			t: 'set-filter';
			nodeId: string;
			filter: FilterKind;
			amount: number;
			radius: number;
			brightness: number;
			contrast: number;
	  }
	| { t: 'set-pack'; nodeId: string; element: ScalarKind; inputCount: number }
	| { t: 'set-output-type'; nodeId: string; valueType: ValueType }
	| { t: 'connect'; wire: Wire }
	| { t: 'disconnect'; wireId: string };

const SCALAR_KINDS: readonly ScalarKind[] = ['image', 'int', 'float', 'string'];
const FILTER_KINDS: readonly FilterKind[] = ['grayscale', 'blur', 'brightness-contrast', 'invert'];

function isScalarKind(value: unknown): value is ScalarKind {
	return typeof value === 'string' && (SCALAR_KINDS as readonly string[]).includes(value);
}

function isFilterKind(value: unknown): value is FilterKind {
	return typeof value === 'string' && (FILTER_KINDS as readonly string[]).includes(value);
}

function isValueType(value: unknown): value is ValueType {
	if (value == null || typeof value !== 'object') return false;
	const v = value as ValueType;
	if (v.kind === 'array') return isScalarKind(v.of);
	return isScalarKind(v.kind);
}

function copyType(type: ValueType): ValueType {
	if (type.kind === 'array') return { kind: 'array', of: type.of };
	return { kind: type.kind };
}

function copySnapshot(snapshot: NodeSnapshot): NodeSnapshot {
	return {
		bytesRef: snapshot.bytesRef,
		...(snapshot.atGeneration !== undefined ? { atGeneration: snapshot.atGeneration } : {}),
		...(snapshot.atCommit !== undefined ? { atCommit: snapshot.atCommit } : {})
	};
}

function copySource(source: DocSource): DocSource {
	if (source.backend === 'shared-vfs') {
		return {
			backend: 'shared-vfs',
			nodeId: source.nodeId,
			...(source.generation !== undefined ? { generation: source.generation } : {}),
			...(source.blobId !== undefined ? { blobId: source.blobId } : {})
		};
	}
	return {
		backend: 'monitor',
		profileId: source.profileId,
		relPath: source.relPath,
		...(source.ino !== undefined ? { ino: source.ino } : {}),
		...(source.dev !== undefined ? { dev: source.dev } : {})
	};
}

function copyNode(node: FlowNode): FlowNode {
	const name = node.name && node.name.length > 0 ? { name: node.name } : {};
	const head = { id: node.id, x: node.x, y: node.y, ...name };
	switch (node.kind) {
		case 'output':
			return { ...head, kind: 'output', valueType: copyType(node.valueType) };
		case 'image': {
			const snap = node.snapshot ? { snapshot: copySnapshot(node.snapshot) } : {};
			if (node.bind === 'clone') return { ...head, kind: 'image', bind: 'clone', ...snap };
			return { ...head, kind: 'image', bind: node.bind, source: copySource(node.source), ...snap };
		}
		case 'int':
		case 'float':
		case 'string':
			return { ...head, kind: node.kind, value: node.value };
		case 'pack':
			return { ...head, kind: 'pack', element: node.element, inputCount: node.inputCount };
		case 'filter':
			return {
				...head,
				kind: 'filter',
				filter: node.filter,
				amount: node.amount,
				radius: node.radius,
				brightness: node.brightness,
				contrast: node.contrast
			};
		case 'query': {
			const snap = node.snapshot ? { snapshot: copySnapshot(node.snapshot) } : {};
			if (node.bind === 'clone') {
				return {
					...head,
					kind: 'query',
					viewId: node.viewId,
					valueType: copyType(node.valueType),
					bind: 'clone',
					...snap
				};
			}
			return {
				...head,
				kind: 'query',
				viewId: node.viewId,
				valueType: copyType(node.valueType),
				bind: node.bind,
				source: { ...copySource(node.source), viewId: node.source.viewId },
				...snap
			};
		}
		default: {
			const never: never = node;
			return never;
		}
	}
}

function sameNode(a: FlowNode, b: FlowNode): boolean {
	return JSON.stringify(copyNode(a)) === JSON.stringify(copyNode(b));
}

function cloneWire(wire: Wire): Wire {
	return {
		id: wire.id,
		fromNodeId: wire.fromNodeId,
		fromSocket: wire.fromSocket,
		toNodeId: wire.toNodeId,
		toSocket: wire.toSocket
	};
}

function sameWire(a: Wire, b: Wire): boolean {
	return (
		a.id === b.id &&
		a.fromNodeId === b.fromNodeId &&
		a.fromSocket === b.fromSocket &&
		a.toNodeId === b.toNodeId &&
		a.toSocket === b.toSocket
	);
}

function findNode(doc: NodeDocument, nodeId: string): FlowNode | undefined {
	return doc.nodes.find((node) => node.id === nodeId);
}

function replaceNode(doc: NodeDocument, nodeId: string, next: FlowNode): NodeDocument {
	return { ...doc, nodes: doc.nodes.map((node) => (node.id === nodeId ? next : node)) };
}

function wiresForNode(wires: Wire[], node: FlowNode): Wire[] {
	let dropped = false;
	const next = wires.filter((wire) => {
		if (wire.fromNodeId === node.id && !socketOf(node, wire.fromSocket)) {
			dropped = true;
			return false;
		}
		if (wire.toNodeId === node.id && !socketOf(node, wire.toSocket)) {
			dropped = true;
			return false;
		}
		return true;
	});
	return dropped ? next : wires;
}

function removedWires(before: NodeDocument, after: NodeDocument): Wire[] {
	const kept = new Set(after.wires.map((wire) => wire.id));
	return before.wires.filter((wire) => !kept.has(wire.id));
}

function reconnect(wires: Wire[]): NodeOp[] {
	return wires.map((wire) => ({ t: 'connect' as const, wire: cloneWire(wire) }));
}

function applyPut(doc: NodeDocument, node: FlowNode): NodeDocument {
	const stored = copyNode(node);
	const index = doc.nodes.findIndex((existing) => existing.id === stored.id);
	const prev = index === -1 ? undefined : doc.nodes[index];
	const nodes =
		index === -1
			? [...doc.nodes, stored]
			: sameNode(prev as FlowNode, stored)
				? doc.nodes
				: doc.nodes.map((existing, i) => (i === index ? stored : existing));
	const wires = wiresForNode(doc.wires, stored);
	if (nodes === doc.nodes && wires === doc.wires) return doc;
	return { ...doc, nodes, wires };
}

function applyRemove(doc: NodeDocument, nodeId: string): NodeDocument {
	const node = findNode(doc, nodeId);
	if (!node) return doc;
	if (node.kind === 'output' && doc.nodes.filter((n) => n.kind === 'output').length <= 1) return doc;
	return {
		...doc,
		nodes: doc.nodes.filter((n) => n.id !== nodeId),
		wires: doc.wires.filter((wire) => wire.fromNodeId !== nodeId && wire.toNodeId !== nodeId)
	};
}

function applyMove(doc: NodeDocument, op: Extract<NodeOp, { t: 'move-node' }>): NodeDocument {
	const node = findNode(doc, op.nodeId);
	if (!node) return doc;
	if (!Number.isFinite(op.x) || !Number.isFinite(op.y)) return doc;
	if (node.x === op.x && node.y === op.y) return doc;
	return replaceNode(doc, op.nodeId, { ...node, x: op.x, y: op.y });
}

function applyRename(doc: NodeDocument, op: Extract<NodeOp, { t: 'rename-node' }>): NodeDocument {
	const node = findNode(doc, op.nodeId);
	if (!node || typeof op.name !== 'string') return doc;
	if (op.name === '') {
		if (node.name === undefined || node.name === '') return doc;
		const { name: _omit, ...rest } = node;
		return replaceNode(doc, op.nodeId, rest);
	}
	if (node.name === op.name) return doc;
	return replaceNode(doc, op.nodeId, { ...node, name: op.name });
}

function applySetConst(doc: NodeDocument, op: Extract<NodeOp, { t: 'set-const' }>): NodeDocument {
	const node = findNode(doc, op.nodeId);
	if (!node || (node.kind !== 'int' && node.kind !== 'float' && node.kind !== 'string')) return doc;
	if (node.kind === 'string') {
		if (typeof op.value !== 'string' || node.value === op.value) return doc;
		return replaceNode(doc, op.nodeId, { ...node, value: op.value });
	}
	if (typeof op.value !== 'number' || !Number.isFinite(op.value)) return doc;
	const value = node.kind === 'int' ? Math.trunc(op.value) : op.value;
	if (node.value === value) return doc;
	return replaceNode(doc, op.nodeId, { ...node, value });
}

function paramKeys(node: FilterNode): Set<string> {
	const keys = new Set<string>();
	for (const socket of socketsOf(node)) {
		if (socket.dir === 'in' && socket.key !== 'image') keys.add(socket.key);
	}
	return keys;
}

function applySetFilter(doc: NodeDocument, op: Extract<NodeOp, { t: 'set-filter' }>): NodeDocument {
	const node = findNode(doc, op.nodeId);
	if (!node || node.kind !== 'filter') return doc;
	if (!isFilterKind(op.filter)) return doc;
	if (
		!Number.isFinite(op.amount) ||
		!Number.isFinite(op.radius) ||
		!Number.isFinite(op.brightness) ||
		!Number.isFinite(op.contrast)
	) {
		return doc;
	}
	if (
		node.filter === op.filter &&
		node.amount === op.amount &&
		node.radius === op.radius &&
		node.brightness === op.brightness &&
		node.contrast === op.contrast
	) {
		return doc;
	}
	const nextNode: FilterNode = {
		...node,
		filter: op.filter,
		amount: op.amount,
		radius: op.radius,
		brightness: op.brightness,
		contrast: op.contrast
	};
	const before = paramKeys(node);
	const after = paramKeys(nextNode);
	let dropped = false;
	const wires = doc.wires.filter((wire) => {
		if (wire.toNodeId === node.id && before.has(wire.toSocket) && !after.has(wire.toSocket)) {
			dropped = true;
			return false;
		}
		return true;
	});
	return {
		...doc,
		nodes: doc.nodes.map((n) => (n.id === node.id ? nextNode : n)),
		wires: dropped ? wires : doc.wires
	};
}

function wireFitsPack(doc: NodeDocument, pack: PackNode, wire: Wire): boolean {
	if (wire.toNodeId !== pack.id && wire.fromNodeId !== pack.id) return true;
	if (wire.toNodeId === pack.id) {
		const socket = socketOf(pack, wire.toSocket);
		if (!socket) return false;
		const from = findNode(doc, wire.fromNodeId);
		const fromSocket = from ? socketOf(from, wire.fromSocket) : undefined;
		if (!from || !fromSocket) return true;
		return typesCompatible(fromSocket.type, socket.type);
	}
	const socket = socketOf(pack, wire.fromSocket);
	if (!socket) return false;
	const to = findNode(doc, wire.toNodeId);
	const toSocket = to ? socketOf(to, wire.toSocket) : undefined;
	if (!to || !toSocket) return true;
	return typesCompatible(socket.type, toSocket.type);
}

function applySetPack(doc: NodeDocument, op: Extract<NodeOp, { t: 'set-pack' }>): NodeDocument {
	const node = findNode(doc, op.nodeId);
	if (!node || node.kind !== 'pack') return doc;
	if (!isScalarKind(op.element) || !Number.isFinite(op.inputCount)) return doc;
	const inputCount = clampPackCount(op.inputCount);
	if (node.element === op.element && node.inputCount === inputCount) return doc;
	const nextNode: PackNode = { ...node, element: op.element, inputCount };
	let dropped = false;
	const wires = doc.wires.filter((wire) => {
		if (wireFitsPack(doc, nextNode, wire)) return true;
		dropped = true;
		return false;
	});
	return {
		...doc,
		nodes: doc.nodes.map((n) => (n.id === node.id ? nextNode : n)),
		wires: dropped ? wires : doc.wires
	};
}

function applySetOutput(doc: NodeDocument, op: Extract<NodeOp, { t: 'set-output-type' }>): NodeDocument {
	const node = findNode(doc, op.nodeId);
	if (!node || node.kind !== 'output') return doc;
	if (!isValueType(op.valueType)) return doc;
	const valueType = copyType(op.valueType);
	if (JSON.stringify(copyType(node.valueType)) === JSON.stringify(valueType)) return doc;
	const nextNode: OutputNode = { ...node, valueType };
	let dropped = false;
	const wires = doc.wires.filter((wire) => {
		if (wire.toNodeId !== node.id || wire.toSocket !== 'in') return true;
		const from = findNode(doc, wire.fromNodeId);
		const fromSocket = from ? socketOf(from, wire.fromSocket) : undefined;
		if (!fromSocket || !typesCompatible(fromSocket.type, valueType)) {
			dropped = true;
			return false;
		}
		return true;
	});
	return {
		...doc,
		nodes: doc.nodes.map((n) => (n.id === node.id ? nextNode : n)),
		wires: dropped ? wires : doc.wires
	};
}

function applyConnect(doc: NodeDocument, wire: Wire): NodeDocument {
	if (
		!wire ||
		typeof wire.id !== 'string' ||
		wire.id.length === 0 ||
		typeof wire.fromNodeId !== 'string' ||
		typeof wire.toNodeId !== 'string' ||
		typeof wire.fromSocket !== 'string' ||
		typeof wire.toSocket !== 'string'
	) {
		return doc;
	}
	const from = findNode(doc, wire.fromNodeId);
	const to = findNode(doc, wire.toNodeId);
	if (!from || !to) return doc;
	const fromSocket = socketOf(from, wire.fromSocket);
	const toSocket = socketOf(to, wire.toSocket);
	if (!fromSocket || !toSocket) return doc;
	if (fromSocket.dir !== 'out' || toSocket.dir !== 'in') return doc;
	if (!typesCompatible(fromSocket.type, toSocket.type)) return doc;
	if (wireWouldCycle(doc, wire.fromNodeId, wire.toNodeId)) return doc;
	const next = cloneWire(wire);
	const existing = doc.wires.find((candidate) => candidate.id === next.id);
	const replaced = doc.wires.some(
		(candidate) =>
			candidate.id !== next.id && candidate.toNodeId === next.toNodeId && candidate.toSocket === next.toSocket
	);
	if (existing && sameWire(existing, next) && !replaced) return doc;
	const wires = doc.wires.filter(
		(candidate) =>
			candidate.id !== next.id &&
			!(candidate.toNodeId === next.toNodeId && candidate.toSocket === next.toSocket)
	);
	wires.push(next);
	return { ...doc, wires };
}

function applyDisconnect(doc: NodeDocument, wireId: string): NodeDocument {
	if (!doc.wires.some((wire) => wire.id === wireId)) return doc;
	return { ...doc, wires: doc.wires.filter((wire) => wire.id !== wireId) };
}

export function applyNodeOp(doc: NodeDocument, op: NodeOp): NodeDocument {
	switch (op.t) {
		case 'put-node':
			return applyPut(doc, op.node);
		case 'remove-node':
			return applyRemove(doc, op.nodeId);
		case 'move-node':
			return applyMove(doc, op);
		case 'rename-node':
			return applyRename(doc, op);
		case 'set-const':
			return applySetConst(doc, op);
		case 'set-filter':
			return applySetFilter(doc, op);
		case 'set-pack':
			return applySetPack(doc, op);
		case 'set-output-type':
			return applySetOutput(doc, op);
		case 'connect':
			return applyConnect(doc, op.wire);
		case 'disconnect':
			return applyDisconnect(doc, op.wireId);
		default: {
			const never: never = op;
			void never;
			return doc;
		}
	}
}

export function invertNodeOp(doc: NodeDocument, op: NodeOp): NodeOp[] | null {
	const next = applyNodeOp(doc, op);
	if (next === doc) return null;
	switch (op.t) {
		case 'move-node': {
			const node = findNode(doc, op.nodeId) as FlowNode;
			return [{ t: 'move-node', nodeId: op.nodeId, x: node.x, y: node.y }];
		}
		case 'rename-node': {
			const node = findNode(doc, op.nodeId) as FlowNode;
			return [{ t: 'rename-node', nodeId: op.nodeId, name: node.name ?? '' }];
		}
		case 'set-const': {
			const node = findNode(doc, op.nodeId) as ConstNode;
			return [{ t: 'set-const', nodeId: op.nodeId, value: node.value }];
		}
		case 'set-filter': {
			const node = findNode(doc, op.nodeId) as FilterNode;
			return [
				{
					t: 'set-filter',
					nodeId: node.id,
					filter: node.filter,
					amount: node.amount,
					radius: node.radius,
					brightness: node.brightness,
					contrast: node.contrast
				},
				...reconnect(removedWires(doc, next))
			];
		}
		case 'set-pack': {
			const node = findNode(doc, op.nodeId) as PackNode;
			return [
				{ t: 'set-pack', nodeId: node.id, element: node.element, inputCount: node.inputCount },
				...reconnect(removedWires(doc, next))
			];
		}
		case 'set-output-type': {
			const node = findNode(doc, op.nodeId) as OutputNode;
			return [
				{ t: 'set-output-type', nodeId: node.id, valueType: copyType(node.valueType) },
				...reconnect(removedWires(doc, next))
			];
		}
		case 'put-node': {
			const existing = findNode(doc, op.node.id);
			if (!existing) return [{ t: 'remove-node', nodeId: op.node.id }];
			// Restoring the previous node also puts back wires the replacement
			// dropped, otherwise undo would not restore the document.
			return [{ t: 'put-node', node: copyNode(existing) }, ...reconnect(removedWires(doc, next))];
		}
		case 'remove-node': {
			const node = findNode(doc, op.nodeId) as FlowNode;
			const dropped = doc.wires.filter(
				(wire) => wire.fromNodeId === op.nodeId || wire.toNodeId === op.nodeId
			);
			return [{ t: 'put-node', node: copyNode(node) }, ...reconnect(dropped)];
		}
		case 'connect': {
			const prev = doc.wires.find((wire) => wire.id === op.wire.id);
			const replaced = doc.wires.filter(
				(wire) =>
					wire.id !== op.wire.id &&
					wire.toNodeId === op.wire.toNodeId &&
					wire.toSocket === op.wire.toSocket
			);
			const inv: NodeOp[] = [{ t: 'disconnect', wireId: op.wire.id }];
			// A same-id edit has to put the previous endpoints back; a bare
			// disconnect would delete a wire that was already in the document.
			if (prev && !sameWire(prev, op.wire)) inv.push({ t: 'connect', wire: cloneWire(prev) });
			inv.push(...reconnect(replaced));
			return inv;
		}
		case 'disconnect': {
			const wire = doc.wires.find((candidate) => candidate.id === op.wireId) as Wire;
			return [{ t: 'connect', wire: cloneWire(wire) }];
		}
		default: {
			const never: never = op;
			void never;
			return null;
		}
	}
}
