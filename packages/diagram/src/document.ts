import {
	DEFAULT_DIGR_CANVAS,
	type DigrCanvas,
	type DigrDocView,
	type DigrDocument,
	type DigrNode,
	type DigrNodeStyle,
	type DigrWindowData
} from './types.js';

export class DigrParseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'DigrParseError';
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value != null && typeof value === 'object' && !Array.isArray(value);
}

function finiteNumber(value: unknown, field: string): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		throw new DigrParseError(`${field} must be a finite number`);
	}
	return value;
}

/** Text is the one forgiving field: a malformed value becomes an empty box
 *  rather than rejecting the whole document — same rule as a clip's `name`. */
function textString(value: unknown, field: string): string {
	if (value === undefined || value === null) return '';
	if (typeof value !== 'string') throw new DigrParseError(`${field} must be a string`);
	return value;
}

function colorString(value: unknown, field: string): string {
	if (typeof value !== 'string' || !/^#[0-9a-f]{3,8}$/i.test(value)) {
		throw new DigrParseError(`${field} must be a #rgb/#rrggbb/#rrggbbaa color`);
	}
	return value;
}

function decodeInput(input: unknown): unknown {
	if (typeof input === 'string') {
		try {
			return JSON.parse(input);
		} catch {
			throw new DigrParseError('invalid JSON');
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

function parseStyle(raw: unknown, field: string): DigrNodeStyle | undefined {
	if (raw === undefined) return undefined;
	if (!isRecord(raw)) throw new DigrParseError(`${field} must be an object`);
	const style: DigrNodeStyle = {};
	if (raw.fill !== undefined) style.fill = colorString(raw.fill, `${field}.fill`);
	if (raw.stroke !== undefined) style.stroke = colorString(raw.stroke, `${field}.stroke`);
	if (raw.textColor !== undefined) {
		style.textColor = colorString(raw.textColor, `${field}.textColor`);
	}
	return Object.keys(style).length > 0 ? style : undefined;
}

function parseNode(raw: unknown, index: number): DigrNode {
	if (!isRecord(raw)) throw new DigrParseError(`nodes[${index}] must be an object`);
	const node: DigrNode = {
		id: nonEmptyString(raw.id, `nodes[${index}].id`),
		x: finiteNumber(raw.x, `nodes[${index}].x`),
		y: finiteNumber(raw.y, `nodes[${index}].y`),
		w: finiteNumber(raw.w, `nodes[${index}].w`),
		h: finiteNumber(raw.h, `nodes[${index}].h`),
		text: textString(raw.text, `nodes[${index}].text`)
	};
	if (raw.rotation !== undefined) {
		node.rotation = finiteNumber(raw.rotation, `nodes[${index}].rotation`);
	}
	const style = parseStyle(raw.style, `nodes[${index}].style`);
	if (style) node.style = style;
	return node;
}

function nonEmptyString(value: unknown, field: string): string {
	if (typeof value !== 'string' || value.length === 0) {
		throw new DigrParseError(`${field} must be a non-empty string`);
	}
	return value;
}

function parseWindowData(raw: unknown, leafId: string): DigrWindowData {
	if (!isRecord(raw)) throw new DigrParseError(`view.windows["${leafId}"] must be an object`);
	return { role: nonEmptyString(raw.role, `view.windows["${leafId}"].role`) };
}

/**
 * Validate a stored per-user view record.
 *
 * Deliberately not called by `parseDigrDocument`: the view is not part of the
 * document (see `DigrDocView`). The host reads the record from its own
 * per-viewer store and validates it here, so the shape stays with the format
 * while the data stays off the file.
 */
export function parseDigrView(raw: unknown): DigrDocView | undefined {
	if (raw === undefined) return undefined;
	if (!isRecord(raw)) throw new DigrParseError('view must be an object');
	let windows: Record<string, DigrWindowData> | undefined;
	if (raw.windows !== undefined) {
		if (!isRecord(raw.windows)) throw new DigrParseError('view.windows must be an object');
		windows = {};
		for (const [leafId, w] of Object.entries(raw.windows)) {
			windows[leafId] = parseWindowData(w, leafId);
		}
	}
	const view: DigrDocView = {};
	if (isRecord(raw.layout)) view.layout = raw.layout;
	if (windows && Object.keys(windows).length > 0) view.windows = windows;
	return Object.keys(view).length > 0 ? view : undefined;
}

function parseCanvas(raw: unknown): DigrCanvas {
	if (raw === undefined) return { ...DEFAULT_DIGR_CANVAS };
	if (!isRecord(raw)) throw new DigrParseError('canvas must be an object');
	const w = finiteNumber(raw.w, 'canvas.w');
	const h = finiteNumber(raw.h, 'canvas.h');
	if (w <= 0 || h <= 0) throw new DigrParseError('canvas dimensions must be positive');
	return { w, h };
}

function optionalId(raw: unknown): string | undefined {
	return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

function optionalCreatedAt(raw: unknown): number | undefined {
	return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined;
}

export function parseDigrDocument(input: Uint8Array | unknown): DigrDocument {
	const raw = decodeInput(input);
	if (!isRecord(raw)) throw new DigrParseError('document must be an object');
	if (raw.schemaVersion !== 1) {
		throw new DigrParseError(`unsupported schemaVersion: ${String(raw.schemaVersion)}`);
	}
	if (!Array.isArray(raw.nodes)) throw new DigrParseError('nodes must be an array');
	// `raw.view` is ignored, not parsed: older files carry a view block and it is
	// per-user state that does not belong in the document. Dropping it on read is
	// what makes the serialized bytes device-independent.
	const canvas = parseCanvas(raw.canvas);
	const id = optionalId(raw.id);
	const createdAt = optionalCreatedAt(raw.createdAt);
	return {
		schemaVersion: 1,
		...(id !== undefined ? { id } : {}),
		...(createdAt !== undefined ? { createdAt } : {}),
		nodes: raw.nodes.map((node, i) => parseNode(node, i)),
		canvas
	};
}

function mintDocId(): string {
	if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
		return crypto.randomUUID();
	}
	return `digr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Adopt travelling identity, or mint uuid + `Date.now()` when either field is
 * missing. Returns a new object when it mints; does not mutate `doc`.
 *
 * A diagram needs one for the same two reasons an animation does: it is the key
 * its per-viewer layout is stored under, and it is what lets another document
 * name this one across a room switch, where node ids mean nothing.
 */
export function ensureDigrIdentity(doc: DigrDocument): DigrDocument {
	const id = optionalId(doc.id) ?? mintDocId();
	const createdAt = optionalCreatedAt(doc.createdAt) ?? Date.now();
	if (doc.id === id && doc.createdAt === createdAt) return doc;
	return { ...doc, id, createdAt };
}

function persistStyle(style: DigrNodeStyle): DigrNodeStyle {
	return {
		...(style.fill ? { fill: style.fill } : {}),
		...(style.stroke ? { stroke: style.stroke } : {}),
		...(style.textColor ? { textColor: style.textColor } : {})
	};
}

function persistNode(node: DigrNode): DigrNode {
	return {
		id: node.id,
		x: node.x,
		y: node.y,
		w: node.w,
		h: node.h,
		...(node.rotation ? { rotation: node.rotation } : {}),
		text: node.text,
		...(node.style ? { style: persistStyle(node.style) } : {})
	};
}

/**
 * Serialization runs the doc back through the parser first and only writes
 * known fields (drops unknown fields — deliberate, same rule as the anim
 * package). Key order is insertion-stable so byte-identical re-saves stay
 * byte-identical.
 */
export function serializeDigrDocument(doc: DigrDocument): string {
	const clean = parseDigrDocument(doc);
	return JSON.stringify({
		schemaVersion: 1 as const,
		...(clean.id !== undefined ? { id: clean.id } : {}),
		...(clean.createdAt !== undefined ? { createdAt: clean.createdAt } : {}),
		nodes: clean.nodes.map(persistNode),
		canvas: clean.canvas
	});
}