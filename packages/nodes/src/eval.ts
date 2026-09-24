import { socketOf, socketsOf, type SocketDef } from './sockets.js';
import type {
	FilterKind,
	FilterNode,
	FilterParams,
	FlowNode,
	ImageNode,
	NodeDocument,
	OutlinesNode,
	OutputNode,
	PackNode,
	PathValue,
	QueryNode,
	ScalarKind,
	SceneNode,
	ValueType
} from './types.js';

export type QueryValue =
	| { kind: 'string'; value: string }
	| { kind: 'int'; value: number }
	| { kind: 'float'; value: number }
	| { kind: 'array'; of: Exclude<ScalarKind, 'image'>; items: Array<{ kind: 'string'; value: string } | { kind: 'int'; value: number } | { kind: 'float'; value: number }> };

export type EvalHost<I, S = unknown> = {
	loadImage(node: ImageNode): Promise<I | null>;
	applyFilter(image: I, filter: FilterKind, params: FilterParams): Promise<I | null>;
	loadQuery?(node: QueryNode): Promise<QueryValue | null>;
	/** Resolve a scene node. A `host` clone is the surrounding page object's scene. */
	loadScene?(node: SceneNode): Promise<S | null>;
	/** Turn a loaded scene into SVG outline paths. The nodes package does not import Three.js. */
	encodeOutlines?(scene: S): Promise<PathValue[] | null>;
};

type PathItem = { kind: 'path'; d: string; stroke?: string; strokeWidth?: number };

type Item<I> =
	| { kind: 'image'; image: I }
	| { kind: 'int'; value: number }
	| { kind: 'float'; value: number }
	| { kind: 'string'; value: string }
	| PathItem;

export type EvalResult<I, S = unknown> =
	| { ok: false; message: string }
	| { ok: true; type: { kind: 'image' }; image: I }
	| { ok: true; type: { kind: 'int' }; value: number }
	| { ok: true; type: { kind: 'float' }; value: number }
	| { ok: true; type: { kind: 'string' }; value: string }
	| { ok: true; type: { kind: 'path' }; d: string; stroke?: string; strokeWidth?: number }
	| { ok: true; type: { kind: 'scene' }; scene: S }
	| { ok: true; type: { kind: 'array'; of: ScalarKind }; items: Array<Item<I>> };

type Fail = { ok: false; message: string };

type Ok<I, S = unknown> =
	| { ok: true; kind: 'image'; image: I }
	| { ok: true; kind: 'int'; value: number }
	| { ok: true; kind: 'float'; value: number }
	| { ok: true; kind: 'string'; value: string }
	| { ok: true; kind: 'path'; d: string; stroke?: string; strokeWidth?: number }
	| { ok: true; kind: 'scene'; scene: S }
	| { ok: true; kind: 'array'; of: ScalarKind; items: Array<Item<I>> };

type Runtime<I, S = unknown> = Fail | Ok<I, S>;

function coerce<I, S>(value: Ok<I, S>, target: ValueType): Ok<I, S> | null {
	if (target.kind === 'scene') return value.kind === 'scene' ? value : null;
	if (target.kind === 'array') {
		if (value.kind !== 'array') return null;
		if (value.of === target.of) return value;
		if (value.of === 'int' && target.of === 'float') {
			return {
				ok: true,
				kind: 'array',
				of: 'float',
				items: value.items.map((item) =>
					item.kind === 'int' ? { kind: 'float' as const, value: item.value } : item
				)
			};
		}
		return null;
	}
	if (value.kind === 'array') return null;
	if (value.kind === target.kind) return value;
	if (value.kind === 'int' && target.kind === 'float') {
		return { ok: true, kind: 'float', value: value.value };
	}
	return null;
}

function pathFields(value: { d: string; stroke?: string; strokeWidth?: number }) {
	return {
		d: value.d,
		...(value.stroke !== undefined ? { stroke: value.stroke } : {}),
		...(value.strokeWidth !== undefined ? { strokeWidth: value.strokeWidth } : {})
	};
}

function project<I, S>(value: Ok<I, S>): EvalResult<I, S> {
	switch (value.kind) {
		case 'image':
			return { ok: true, type: { kind: 'image' }, image: value.image };
		case 'int':
			return { ok: true, type: { kind: 'int' }, value: value.value };
		case 'float':
			return { ok: true, type: { kind: 'float' }, value: value.value };
		case 'string':
			return { ok: true, type: { kind: 'string' }, value: value.value };
		case 'path':
			return { ok: true, type: { kind: 'path' }, ...pathFields(value) };
		case 'scene':
			return { ok: true, type: { kind: 'scene' }, scene: value.scene };
		case 'array':
			return { ok: true, type: { kind: 'array', of: value.of }, items: value.items };
		default: {
			const never: never = value;
			return never;
		}
	}
}

function toItem<I, S>(value: Ok<I, S>, element: ScalarKind): Item<I> | null {
	if (value.kind !== element) return null;
	switch (value.kind) {
		case 'image':
			return { kind: 'image', image: value.image };
		case 'int':
			return { kind: 'int', value: value.value };
		case 'float':
			return { kind: 'float', value: value.value };
		case 'string':
			return { kind: 'string', value: value.value };
		case 'path':
			return { kind: 'path', ...pathFields(value) };
		default:
			return null;
	}
}

/** A cycle in the dependency cone of `outputId` (walk wires upstream). */
function upstreamCycle(doc: NodeDocument, outputId: string): boolean {
	const deps = new Map<string, string[]>();
	for (const wire of doc.wires) {
		const list = deps.get(wire.toNodeId);
		if (list) list.push(wire.fromNodeId);
		else deps.set(wire.toNodeId, [wire.fromNodeId]);
	}
	const color = new Map<string, 0 | 1 | 2>();
	const visit = (id: string): boolean => {
		const state = color.get(id) ?? 0;
		if (state === 1) return true;
		if (state === 2) return false;
		color.set(id, 1);
		for (const dep of deps.get(id) ?? []) {
			if (visit(dep)) return true;
		}
		color.set(id, 2);
		return false;
	};
	return visit(outputId);
}

function displayName(node: FlowNode): string {
	return node.name && node.name.length > 0 ? node.name : node.kind;
}

/**
 * Evaluate the first output node. Host failures (`null`) become result
 * messages; host throws are not caught. Each node runs at most once.
 */
export async function evaluateOutput<I, S = unknown>(
	doc: NodeDocument,
	host: EvalHost<I, S>
): Promise<EvalResult<I, S>> {
	const output = doc.nodes.find((node): node is OutputNode => node.kind === 'output');
	if (!output) return { ok: false, message: 'Output is not wired.' };
	const wired = doc.wires.some((wire) => wire.toNodeId === output.id && wire.toSocket === 'in');
	if (!wired) return { ok: false, message: 'Output is not wired.' };
	if (upstreamCycle(doc, output.id)) return { ok: false, message: 'The graph contains a loop.' };

	const byId = new Map<string, FlowNode>();
	for (const node of doc.nodes) {
		if (!byId.has(node.id)) byId.set(node.id, node);
	}
	const memo = new Map<string, Promise<Runtime<I, S>>>();
	const active = new Set<string>();

	function evalNode(node: FlowNode): Promise<Runtime<I, S>> {
		const cached = memo.get(node.id);
		if (cached) return cached;
		if (active.has(node.id)) {
			return Promise.resolve({ ok: false, message: 'The graph contains a loop.' });
		}
		active.add(node.id);
		const pending = dispatch(node).finally(() => {
			active.delete(node.id);
		});
		memo.set(node.id, pending);
		return pending;
	}

	async function readRequired(node: FlowNode, socket: SocketDef): Promise<Runtime<I, S>> {
		const wire = doc.wires.find((candidate) => candidate.toNodeId === node.id && candidate.toSocket === socket.key);
		if (!wire) {
			if (node.kind === 'output') return { ok: false, message: 'Output is not wired.' };
			return { ok: false, message: `${displayName(node)} ${socket.label} is not wired.` };
		}
		const from = byId.get(wire.fromNodeId);
		const fromSocket = from ? socketOf(from, wire.fromSocket) : undefined;
		if (!from || !fromSocket || fromSocket.dir !== 'out') {
			return { ok: false, message: 'Type mismatch.' };
		}
		const produced = await evalNode(from);
		if (!produced.ok) return produced;
		const coerced = coerce(produced, socket.type);
		if (!coerced) return { ok: false, message: 'Type mismatch.' };
		return coerced;
	}

	async function readParam(
		node: FilterNode,
		key: 'amount' | 'radius' | 'brightness' | 'contrast'
	): Promise<number | Fail> {
		const socket = socketOf(node, key);
		if (!socket) return node[key];
		const wire = doc.wires.find((candidate) => candidate.toNodeId === node.id && candidate.toSocket === key);
		if (!wire) return node[key];
		const read = await readRequired(node, socket);
		if (!read.ok) return read;
		if (read.kind !== 'float') return { ok: false, message: 'Type mismatch.' };
		return read.value;
	}

	async function dispatch(node: FlowNode): Promise<Runtime<I, S>> {
		switch (node.kind) {
			case 'int':
			case 'float':
			case 'string': {
				if (node.kind === 'string') {
					if (typeof node.value !== 'string') return { ok: false, message: 'Type mismatch.' };
					return { ok: true, kind: 'string', value: node.value };
				}
				if (typeof node.value !== 'number' || !Number.isFinite(node.value)) {
					return { ok: false, message: 'Type mismatch.' };
				}
				if (node.kind === 'int') return { ok: true, kind: 'int', value: Math.trunc(node.value) };
				return { ok: true, kind: 'float', value: node.value };
			}
			case 'image': {
				const image = await host.loadImage(node);
				if (image == null) return { ok: false, message: 'Image source is missing.' };
				return { ok: true, kind: 'image', image };
			}
			case 'query': {
				const loaded = host.loadQuery ? await host.loadQuery(node) : null;
				if (loaded == null) return { ok: false, message: 'Data view is missing.' };
				if (loaded.kind === 'array') {
					return { ok: true, kind: 'array', of: loaded.of, items: loaded.items };
				}
				return { ok: true, ...loaded };
			}
			case 'pack':
				return evalPack(node);
			case 'filter':
				return evalFilter(node);
			case 'scene': {
				const scene = host.loadScene ? await host.loadScene(node) : null;
				if (scene == null) return { ok: false, message: 'Scene is missing.' };
				return { ok: true, kind: 'scene', scene };
			}
			case 'outlines':
				return evalOutlines(node);
			case 'output': {
				const socket = socketOf(node, 'in');
				if (!socket) return { ok: false, message: 'Output is not wired.' };
				return readRequired(node, socket);
			}
			default: {
				const never: never = node;
				return never;
			}
		}
	}

	async function evalOutlines(node: OutlinesNode): Promise<Runtime<I, S>> {
		const socket = socketOf(node, 'scene');
		if (!socket) return { ok: false, message: `${displayName(node)} Scene is not wired.` };
		const scene = await readRequired(node, socket);
		if (!scene.ok) return scene;
		if (scene.kind !== 'scene') return { ok: false, message: 'Type mismatch.' };
		const paths = host.encodeOutlines ? await host.encodeOutlines(scene.scene) : null;
		if (!paths) return { ok: false, message: 'Outlines could not be encoded.' };
		return {
			ok: true,
			kind: 'array',
			of: 'path',
			items: paths.map((path) => ({ kind: 'path' as const, ...pathFields(path) }))
		};
	}

	async function evalPack(node: PackNode): Promise<Runtime<I, S>> {
		const items: Array<Item<I>> = [];
		for (const socket of socketsOf(node)) {
			if (socket.dir !== 'in') continue;
			const read = await readRequired(node, socket);
			if (!read.ok) return read;
			const item = toItem(read, node.element);
			if (!item) return { ok: false, message: 'Type mismatch.' };
			items.push(item);
		}
		return { ok: true, kind: 'array', of: node.element, items };
	}

	async function evalFilter(node: FilterNode): Promise<Runtime<I, S>> {
		const imageSocket = socketOf(node, 'image');
		if (!imageSocket) return { ok: false, message: `${displayName(node)} Image is not wired.` };
		const image = await readRequired(node, imageSocket);
		if (!image.ok) return image;
		if (image.kind !== 'image') return { ok: false, message: 'Type mismatch.' };
		const amount = await readParam(node, 'amount');
		if (typeof amount !== 'number') return amount;
		const radius = await readParam(node, 'radius');
		if (typeof radius !== 'number') return radius;
		const brightness = await readParam(node, 'brightness');
		if (typeof brightness !== 'number') return brightness;
		const contrast = await readParam(node, 'contrast');
		if (typeof contrast !== 'number') return contrast;
		const filtered = await host.applyFilter(image.image, node.filter, {
			amount,
			radius,
			brightness,
			contrast
		});
		if (filtered == null) return { ok: false, message: 'Filter failed.' };
		return { ok: true, kind: 'image', image: filtered };
	}

	const value = await evalNode(output);
	if (!value.ok) return { ok: false, message: value.message };
	return project(value);
}
