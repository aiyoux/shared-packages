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

function parseView(raw: unknown): DigrDocView | undefined {
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

export function parseDigrDocument(input: Uint8Array | unknown): DigrDocument {
	const raw = decodeInput(input);
	if (!isRecord(raw)) throw new DigrParseError('document must be an object');
	if (raw.schemaVersion !== 1) {
		throw new DigrParseError(`unsupported schemaVersion: ${String(raw.schemaVersion)}`);
	}
	if (!Array.isArray(raw.nodes)) throw new DigrParseError('nodes must be an array');
	const view = parseView(raw.view);
	const canvas = parseCanvas(raw.canvas);
	return {
		schemaVersion: 1,
		nodes: raw.nodes.map((node, i) => parseNode(node, i)),
		canvas,
		...(view ? { view } : {})
	};
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
		nodes: clean.nodes.map(persistNode),
		canvas: clean.canvas,
		...(clean.view ? { view: clean.view } : {})
	});
}