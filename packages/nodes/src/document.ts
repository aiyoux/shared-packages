import { BIND_MODES, type BindMode, type DocSource } from '@shared-packages/doc-refs';
import { clampPackCount, socketOf } from './sockets.js';
import type {
	FilterKind,
	FlowNode,
	ImageNode,
	NodeDocView,
	NodeDocument,
	NodeSnapshot,
	NodeWindowData,
	ScalarKind,
	ValueType,
	Wire
} from './types.js';

export class NodeParseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'NodeParseError';
	}
}

const SCALAR_KINDS: readonly ScalarKind[] = ['image', 'int', 'float', 'string'];
const FILTER_KINDS: readonly FilterKind[] = ['grayscale', 'blur', 'brightness-contrast', 'invert'];

function isRecord(value: unknown): value is Record<string, unknown> {
	return value != null && typeof value === 'object' && !Array.isArray(value);
}

function finiteNumber(value: unknown, field: string): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		throw new NodeParseError(`${field} must be a finite number`);
	}
	return value;
}

function nonEmptyString(value: unknown, field: string): string {
	if (typeof value !== 'string' || value.length === 0) {
		throw new NodeParseError(`${field} must be a non-empty string`);
	}
	return value;
}

function isScalarKind(value: unknown): value is ScalarKind {
	return typeof value === 'string' && (SCALAR_KINDS as readonly string[]).includes(value);
}

function isFilterKind(value: unknown): value is FilterKind {
	return typeof value === 'string' && (FILTER_KINDS as readonly string[]).includes(value);
}

function decodeInput(input: unknown): unknown {
	if (typeof input === 'string') {
		try {
			return JSON.parse(input);
		} catch {
			throw new NodeParseError('invalid JSON');
		}
	}
	if (input instanceof ArrayBuffer) {
		return decodeInput(new Uint8Array(input));
	}
	if (ArrayBuffer.isView(input)) {
		const view = input as ArrayBufferView;
		const bytes =
			input instanceof Uint8Array
				? input
				: new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
		return decodeInput(new TextDecoder().decode(bytes));
	}
	return input;
}

function optionalId(raw: unknown): string | undefined {
	return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

function optionalCreatedAt(raw: unknown): number | undefined {
	return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined;
}

function optionalName(raw: unknown, field: string): string | undefined {
	if (raw === undefined) return undefined;
	if (typeof raw !== 'string') throw new NodeParseError(`${field} must be a string`);
	return raw.length > 0 ? raw : undefined;
}

function parseValueType(raw: unknown, field: string): ValueType {
	if (!isRecord(raw)) throw new NodeParseError(`${field} must be an object`);
	if (raw.kind === 'array') {
		if (!isScalarKind(raw.of)) {
			throw new NodeParseError(`${field}.of is unknown: ${String(raw.of)}`);
		}
		return { kind: 'array', of: raw.of };
	}
	if (!isScalarKind(raw.kind)) {
		throw new NodeParseError(`${field}.kind is unknown: ${String(raw.kind)}`);
	}
	return { kind: raw.kind };
}

function parseSnapshot(raw: unknown, field: string): NodeSnapshot {
	if (!isRecord(raw)) throw new NodeParseError(`${field} must be an object`);
	const snapshot: NodeSnapshot = { bytesRef: nonEmptyString(raw.bytesRef, `${field}.bytesRef`) };
	if (raw.atGeneration !== undefined) {
		snapshot.atGeneration = finiteNumber(raw.atGeneration, `${field}.atGeneration`);
	}
	if (raw.atCommit !== undefined) {
		snapshot.atCommit = nonEmptyString(raw.atCommit, `${field}.atCommit`);
	}
	return snapshot;
}

function parseBind(raw: unknown, field: string): BindMode {
	if (typeof raw !== 'string' || !(BIND_MODES as readonly string[]).includes(raw)) {
		throw new NodeParseError(`${field} is unknown: ${String(raw)}`);
	}
	return raw as BindMode;
}

function parseSource(raw: unknown, field: string): DocSource {
	if (!isRecord(raw)) throw new NodeParseError(`${field} must be an object`);
	if (raw.backend === 'shared-vfs') {
		const source: DocSource = {
			backend: 'shared-vfs',
			nodeId: nonEmptyString(raw.nodeId, `${field}.nodeId`)
		};
		if (raw.generation !== undefined) {
			source.generation = finiteNumber(raw.generation, `${field}.generation`);
		}
		if (raw.blobId !== undefined) {
			source.blobId = nonEmptyString(raw.blobId, `${field}.blobId`);
		}
		return source;
	}
	if (raw.backend === 'monitor') {
		const source: DocSource = {
			backend: 'monitor',
			profileId: nonEmptyString(raw.profileId, `${field}.profileId`),
			relPath: nonEmptyString(raw.relPath, `${field}.relPath`)
		};
		if (raw.ino !== undefined) source.ino = nonEmptyString(raw.ino, `${field}.ino`);
		if (raw.dev !== undefined) source.dev = nonEmptyString(raw.dev, `${field}.dev`);
		return source;
	}
	throw new NodeParseError(`${field}.backend is unknown: ${String(raw.backend)}`);
}

function parseNode(raw: unknown, index: number): FlowNode {
	if (!isRecord(raw)) throw new NodeParseError(`nodes[${index}] must be an object`);
	const field = `nodes[${index}]`;
	const id = nonEmptyString(raw.id, `${field}.id`);
	const x = finiteNumber(raw.x, `${field}.x`);
	const y = finiteNumber(raw.y, `${field}.y`);
	const name = optionalName(raw.name, `${field}.name`);
	const head = { id, x, y, ...(name ? { name } : {}) };

	switch (raw.kind) {
		case 'output':
			return { ...head, kind: 'output', valueType: parseValueType(raw.valueType, `${field}.valueType`) };
		case 'image':
			return parseImage(raw, field, head);
		case 'int':
		case 'float':
			return { ...head, kind: raw.kind, value: finiteNumber(raw.value, `${field}.value`) };
		case 'string':
			if (typeof raw.value !== 'string') throw new NodeParseError(`${field}.value must be a string`);
			return { ...head, kind: 'string', value: raw.value };
		case 'pack': {
			if (!isScalarKind(raw.element)) {
				throw new NodeParseError(`${field}.element is unknown: ${String(raw.element)}`);
			}
			return {
				...head,
				kind: 'pack',
				element: raw.element,
				inputCount: clampPackCount(finiteNumber(raw.inputCount, `${field}.inputCount`))
			};
		}
		case 'filter': {
			if (!isFilterKind(raw.filter)) {
				throw new NodeParseError(`${field}.filter is unknown: ${String(raw.filter)}`);
			}
			return {
				...head,
				kind: 'filter',
				filter: raw.filter,
				amount: raw.amount === undefined ? 1 : finiteNumber(raw.amount, `${field}.amount`),
				radius: raw.radius === undefined ? 4 : finiteNumber(raw.radius, `${field}.radius`),
				brightness:
					raw.brightness === undefined ? 0 : finiteNumber(raw.brightness, `${field}.brightness`),
				contrast: raw.contrast === undefined ? 0 : finiteNumber(raw.contrast, `${field}.contrast`)
			};
		}
		default:
			throw new NodeParseError(`${field}.kind is unknown: ${String(raw.kind)}`);
	}
}

function parseImage(
	raw: Record<string, unknown>,
	field: string,
	head: { id: string; x: number; y: number; name?: string }
): ImageNode {
	const bind = parseBind(raw.bind, `${field}.bind`);
	const snapshot = raw.snapshot === undefined ? undefined : parseSnapshot(raw.snapshot, `${field}.snapshot`);
	const snap = snapshot ? { snapshot } : {};
	if (bind === 'clone') {
		if (raw.source !== undefined) {
			throw new NodeParseError(`${field} clone bind must omit source`);
		}
		return { ...head, kind: 'image', bind: 'clone', ...snap };
	}
	if (raw.source === undefined) {
		throw new NodeParseError(`${field} ${bind} bind requires source`);
	}
	return { ...head, kind: 'image', bind, source: parseSource(raw.source, `${field}.source`), ...snap };
}

function parseWire(raw: unknown, index: number): Wire {
	if (!isRecord(raw)) throw new NodeParseError(`wires[${index}] must be an object`);
	return {
		id: nonEmptyString(raw.id, `wires[${index}].id`),
		fromNodeId: nonEmptyString(raw.fromNodeId, `wires[${index}].fromNodeId`),
		fromSocket: nonEmptyString(raw.fromSocket, `wires[${index}].fromSocket`),
		toNodeId: nonEmptyString(raw.toNodeId, `wires[${index}].toNodeId`),
		toSocket: nonEmptyString(raw.toSocket, `wires[${index}].toSocket`)
	};
}

function wireResolves(nodes: FlowNode[], wire: Wire): boolean {
	const from = nodes.find((node) => node.id === wire.fromNodeId);
	const to = nodes.find((node) => node.id === wire.toNodeId);
	if (!from || !to) return false;
	return socketOf(from, wire.fromSocket) !== undefined && socketOf(to, wire.toSocket) !== undefined;
}

function parseWindowData(raw: unknown, leafId: string): NodeWindowData {
	if (!isRecord(raw)) throw new NodeParseError(`view.windows["${leafId}"] must be an object`);
	return { role: nonEmptyString(raw.role, `view.windows["${leafId}"].role`) };
}

/**
 * Validate a stored per-user view record.
 *
 * Not called by `parseNodeDocument`: the view is not part of the document.
 * Unknown `layout` values are kept only when they are records. An empty record
 * (no layout object, no windows) is the absence of a view.
 */
export function parseNodeView(raw: unknown): NodeDocView | undefined {
	if (raw === undefined) return undefined;
	if (!isRecord(raw)) throw new NodeParseError('view must be an object');
	let windows: Record<string, NodeWindowData> | undefined;
	if (raw.windows !== undefined) {
		if (!isRecord(raw.windows)) throw new NodeParseError('view.windows must be an object');
		windows = {};
		for (const [leafId, entry] of Object.entries(raw.windows)) {
			windows[leafId] = parseWindowData(entry, leafId);
		}
	}
	const view: NodeDocView = {};
	if (isRecord(raw.layout)) view.layout = raw.layout;
	if (windows && Object.keys(windows).length > 0) view.windows = windows;
	return Object.keys(view).length > 0 ? view : undefined;
}

export function parseNodeDocument(input: Uint8Array | string | unknown): NodeDocument {
	const raw = decodeInput(input);
	if (!isRecord(raw)) throw new NodeParseError('document must be an object');
	if (raw.schemaVersion !== 1) {
		throw new NodeParseError(`unsupported schemaVersion: ${String(raw.schemaVersion)}`);
	}
	if (!Array.isArray(raw.nodes)) throw new NodeParseError('nodes must be an array');
	if (!Array.isArray(raw.wires)) throw new NodeParseError('wires must be an array');
	// `raw.view` is ignored. It is per-user state and does not belong in the file.
	const nodes = raw.nodes.map((node, i) => parseNode(node, i));
	if (!nodes.some((node) => node.kind === 'output')) {
		throw new NodeParseError('document must contain an output node');
	}
	const id = optionalId(raw.id);
	const createdAt = optionalCreatedAt(raw.createdAt);
	return {
		schemaVersion: 1,
		...(id !== undefined ? { id } : {}),
		...(createdAt !== undefined ? { createdAt } : {}),
		nodes,
		wires: raw.wires.map((wire, i) => parseWire(wire, i)).filter((wire) => wireResolves(nodes, wire))
	};
}

function mintDocId(): string {
	if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
		return crypto.randomUUID();
	}
	return `node-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Adopt travelling identity, or mint uuid + `Date.now()` when either field is
 * missing. Returns the same reference when both are already set.
 */
export function ensureNodeIdentity(doc: NodeDocument): NodeDocument {
	const id = optionalId(doc.id) ?? mintDocId();
	const createdAt = optionalCreatedAt(doc.createdAt) ?? Date.now();
	if (doc.id === id && doc.createdAt === createdAt) return doc;
	return { ...doc, id, createdAt };
}

/** One image output, centred toward the right of a default canvas, plus identity. */
export function emptyNodeDocument(): NodeDocument {
	return ensureNodeIdentity({
		schemaVersion: 1,
		nodes: [
			{
				id: mintDocId(),
				x: 640,
				y: 180,
				name: 'Output',
				kind: 'output',
				valueType: { kind: 'image' }
			}
		],
		wires: []
	});
}

function persistValueType(type: ValueType): ValueType {
	if (type.kind === 'array') return { kind: 'array', of: type.of };
	return { kind: type.kind };
}

function persistSnapshot(snapshot: NodeSnapshot): NodeSnapshot {
	return {
		bytesRef: snapshot.bytesRef,
		...(snapshot.atGeneration !== undefined ? { atGeneration: snapshot.atGeneration } : {}),
		...(snapshot.atCommit !== undefined ? { atCommit: snapshot.atCommit } : {})
	};
}

function persistSource(source: DocSource): DocSource {
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

function persistNode(node: FlowNode): FlowNode {
	const name = node.name && node.name.length > 0 ? { name: node.name } : {};
	const head = { id: node.id, x: node.x, y: node.y, ...name };
	switch (node.kind) {
		case 'output':
			return { ...head, kind: 'output', valueType: persistValueType(node.valueType) };
		case 'image': {
			const snap = node.snapshot ? { snapshot: persistSnapshot(node.snapshot) } : {};
			if (node.bind === 'clone') return { ...head, kind: 'image', bind: 'clone', ...snap };
			return {
				...head,
				kind: 'image',
				bind: node.bind,
				source: persistSource(node.source),
				...snap
			};
		}
		case 'int':
		case 'float':
		case 'string':
			return { ...head, kind: node.kind, value: node.value };
		case 'pack':
			return {
				...head,
				kind: 'pack',
				element: node.element,
				inputCount: clampPackCount(node.inputCount)
			};
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
		default: {
			const never: never = node;
			return never;
		}
	}
}

function persistWire(wire: Wire): Wire {
	return {
		id: wire.id,
		fromNodeId: wire.fromNodeId,
		fromSocket: wire.fromSocket,
		toNodeId: wire.toNodeId,
		toSocket: wire.toSocket
	};
}

/**
 * Known fields only, in a stable order: schemaVersion, id, createdAt, nodes,
 * wires. Runs through the parser first so a re-save is byte-identical and a
 * `view` block cannot leak back into the file.
 */
export function serializeNodeDocument(doc: NodeDocument): string {
	const clean = parseNodeDocument(doc);
	return JSON.stringify({
		schemaVersion: 1 as const,
		...(clean.id !== undefined ? { id: clean.id } : {}),
		...(clean.createdAt !== undefined ? { createdAt: clean.createdAt } : {}),
		nodes: clean.nodes.map(persistNode),
		wires: clean.wires.map(persistWire)
	});
}
