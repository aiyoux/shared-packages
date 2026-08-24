import {
	BIND_MODES,
	CLIP_MEDIA_KINDS,
	SKETCH_OBJECT_KINDS,
	type AnimClip,
	type AnimClipSnapshot,
	type AnimDocument,
	type AnimFrame,
	type AnimKeyframe,
	type BindMode,
	type ClipMediaKind,
	type ClipSource,
	type FsBackend,
	type SketchFragment,
	type SketchObjectKind
} from './types.js';

export class AnimParseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'AnimParseError';
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value != null && typeof value === 'object' && !Array.isArray(value);
}

function finiteNumber(value: unknown, field: string): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		throw new AnimParseError(`${field} must be a finite number`);
	}
	return value;
}

function nonEmptyString(value: unknown, field: string): string {
	if (typeof value !== 'string' || value.length === 0) {
		throw new AnimParseError(`${field} must be a non-empty string`);
	}
	return value;
}

function decimalString(value: unknown, field: string): string {
	if (typeof value !== 'string' || !/^\d+$/.test(value)) {
		throw new AnimParseError(`${field} must be a decimal string`);
	}
	return value;
}

function decodeInput(input: unknown): unknown {
	if (typeof input === 'string') {
		try {
			return JSON.parse(input);
		} catch {
			throw new AnimParseError('invalid JSON');
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

function parseFrame(raw: unknown): AnimFrame {
	if (!isRecord(raw)) throw new AnimParseError('clip.frame must be an object');
	const frame: AnimFrame = {
		x: finiteNumber(raw.x, 'frame.x'),
		y: finiteNumber(raw.y, 'frame.y'),
		w: finiteNumber(raw.w, 'frame.w'),
		h: finiteNumber(raw.h, 'frame.h')
	};
	if (raw.rotation !== undefined) {
		frame.rotation = finiteNumber(raw.rotation, 'frame.rotation');
	}
	return frame;
}

function parseKeyframe(raw: unknown, index: number): AnimKeyframe {
	if (!isRecord(raw)) throw new AnimParseError(`clip.keyframes[${index}] must be an object`);
	const key: AnimKeyframe = { tMs: finiteNumber(raw.tMs, `keyframes[${index}].tMs`) };
	if (raw.x !== undefined) key.x = finiteNumber(raw.x, `keyframes[${index}].x`);
	if (raw.y !== undefined) key.y = finiteNumber(raw.y, `keyframes[${index}].y`);
	if (raw.w !== undefined) key.w = finiteNumber(raw.w, `keyframes[${index}].w`);
	if (raw.h !== undefined) key.h = finiteNumber(raw.h, `keyframes[${index}].h`);
	if (raw.rotation !== undefined) {
		key.rotation = finiteNumber(raw.rotation, `keyframes[${index}].rotation`);
	}
	return key;
}

function isSketchObjectKind(value: unknown): value is SketchObjectKind {
	return typeof value === 'string' && (SKETCH_OBJECT_KINDS as readonly string[]).includes(value);
}

function parseFragment(raw: unknown, field: string): SketchFragment {
	if (!isRecord(raw)) throw new AnimParseError(`${field} must be an object`);
	if (raw.kind === 'file') return { kind: 'file' };
	if (raw.kind === 'page') {
		return { kind: 'page', pageId: nonEmptyString(raw.pageId, `${field}.pageId`) };
	}
	if (raw.kind === 'layer') {
		return {
			kind: 'layer',
			pageId: nonEmptyString(raw.pageId, `${field}.pageId`),
			layerId: nonEmptyString(raw.layerId, `${field}.layerId`)
		};
	}
	if (raw.kind === 'object') {
		if (!isSketchObjectKind(raw.objectKind)) {
			throw new AnimParseError(`${field}.objectKind is unknown: ${String(raw.objectKind)}`);
		}
		return {
			kind: 'object',
			pageId: nonEmptyString(raw.pageId, `${field}.pageId`),
			layerId: nonEmptyString(raw.layerId, `${field}.layerId`),
			objectKind: raw.objectKind,
			objectId: nonEmptyString(raw.objectId, `${field}.objectId`)
		};
	}
	throw new AnimParseError(`unknown fragment.kind: ${String(raw.kind)}`);
}

function fragmentNeedsV2(fragment: SketchFragment | undefined): boolean {
	return fragment != null && fragment.kind !== 'file';
}

function parseMediaKind(raw: unknown, field: string): ClipMediaKind | undefined {
	if (raw === undefined) return undefined;
	if (typeof raw !== 'string' || !(CLIP_MEDIA_KINDS as readonly string[]).includes(raw)) {
		throw new AnimParseError(`${field} is unknown: ${String(raw)}`);
	}
	return raw as ClipMediaKind;
}

function parseSource(raw: unknown, schemaVersion: 1 | 2): ClipSource {
	if (!isRecord(raw)) throw new AnimParseError('clip.source must be an object');
	const fragment =
		raw.fragment === undefined ? undefined : parseFragment(raw.fragment, 'source.fragment');
	if (schemaVersion === 1 && fragmentNeedsV2(fragment)) {
		throw new AnimParseError('schemaVersion 1 cannot carry a sketch fragment');
	}
	if (raw.backend === 'shared-vfs') {
		const source: ClipSource = {
			backend: 'shared-vfs',
			nodeId: nonEmptyString(raw.nodeId, 'source.nodeId')
		};
		if (raw.generation !== undefined) {
			source.generation = finiteNumber(raw.generation, 'source.generation');
		}
		if (raw.blobId !== undefined) {
			source.blobId = nonEmptyString(raw.blobId, 'source.blobId');
		}
		if (fragment) source.fragment = fragment;
		return source;
	}
	if (raw.backend === 'monitor') {
		const source: ClipSource = {
			backend: 'monitor',
			profileId: nonEmptyString(raw.profileId, 'source.profileId'),
			relPath: nonEmptyString(raw.relPath, 'source.relPath')
		};
		if (raw.ino !== undefined) source.ino = decimalString(raw.ino, 'source.ino');
		if (raw.dev !== undefined) source.dev = decimalString(raw.dev, 'source.dev');
		if (fragment) source.fragment = fragment;
		return source;
	}
	throw new AnimParseError(`unknown source backend: ${String(raw.backend)}`);
}

function parseSnapshot(raw: unknown): AnimClipSnapshot {
	if (!isRecord(raw)) throw new AnimParseError('clip.snapshot must be an object');
	const snapshot: AnimClipSnapshot = {
		bytesRef: nonEmptyString(raw.bytesRef, 'snapshot.bytesRef')
	};
	if (raw.atGeneration !== undefined) {
		snapshot.atGeneration = finiteNumber(raw.atGeneration, 'snapshot.atGeneration');
	}
	if (raw.atCommit !== undefined) {
		snapshot.atCommit = nonEmptyString(raw.atCommit, 'snapshot.atCommit');
	}
	return snapshot;
}

function parseBind(raw: unknown): BindMode {
	if (typeof raw !== 'string' || !(BIND_MODES as readonly string[]).includes(raw)) {
		throw new AnimParseError(`unknown bind: ${String(raw)}`);
	}
	return raw as BindMode;
}

function parseClip(raw: unknown, index: number, schemaVersion: 1 | 2): AnimClip {
	if (!isRecord(raw)) throw new AnimParseError(`clips[${index}] must be an object`);
	const bind = parseBind(raw.bind);
	const keyframes = Array.isArray(raw.keyframes)
		? raw.keyframes.map((k, i) => parseKeyframe(k, i))
		: undefined;
	const mediaKind = parseMediaKind(raw.mediaKind, `clips[${index}].mediaKind`);
	if (schemaVersion === 1 && mediaKind === 'sketch-fragment') {
		throw new AnimParseError(
			`clips[${index}] schemaVersion 1 cannot carry mediaKind sketch-fragment`
		);
	}
	const base = {
		id: nonEmptyString(raw.id, `clips[${index}].id`),
		startMs: finiteNumber(raw.startMs, `clips[${index}].startMs`),
		durationMs: finiteNumber(raw.durationMs, `clips[${index}].durationMs`),
		frame: parseFrame(raw.frame),
		...(keyframes && keyframes.length > 0 ? { keyframes } : {}),
		...(raw.snapshot !== undefined ? { snapshot: parseSnapshot(raw.snapshot) } : {}),
		...(mediaKind && mediaKind !== 'image' ? { mediaKind } : {})
	};
	if (bind === 'clone') {
		if (raw.source !== undefined) {
			throw new AnimParseError(`clips[${index}] clone bind must omit source`);
		}
		return { ...base, bind: 'clone' };
	}
	if (raw.source === undefined) {
		throw new AnimParseError(`clips[${index}] ${bind} bind requires source`);
	}
	return { ...base, bind, source: parseSource(raw.source, schemaVersion) };
}

function parseSchemaVersion(raw: unknown): 1 | 2 {
	if (raw === 1 || raw === 2) return raw;
	throw new AnimParseError(`unsupported schemaVersion: ${String(raw)}`);
}

export function parseAnimDocument(input: Uint8Array | unknown): AnimDocument {
	const raw = decodeInput(input);
	if (!isRecord(raw)) throw new AnimParseError('document must be an object');
	const schemaVersion = parseSchemaVersion(raw.schemaVersion);
	if (!Array.isArray(raw.clips)) throw new AnimParseError('clips must be an array');
	return {
		schemaVersion,
		durationMs: finiteNumber(raw.durationMs, 'durationMs'),
		clips: raw.clips.map((clip, i) => parseClip(clip, i, schemaVersion))
	};
}

function persistFragment(fragment: SketchFragment): SketchFragment {
	if (fragment.kind === 'file') return { kind: 'file' };
	if (fragment.kind === 'page') return { kind: 'page', pageId: fragment.pageId };
	if (fragment.kind === 'layer') {
		return { kind: 'layer', pageId: fragment.pageId, layerId: fragment.layerId };
	}
	return {
		kind: 'object',
		pageId: fragment.pageId,
		layerId: fragment.layerId,
		objectKind: fragment.objectKind,
		objectId: fragment.objectId
	};
}

function persistSource(source: ClipSource): ClipSource {
	if (source.backend === 'shared-vfs') {
		return {
			backend: 'shared-vfs',
			nodeId: source.nodeId,
			...(source.generation !== undefined ? { generation: source.generation } : {}),
			...(source.blobId !== undefined ? { blobId: source.blobId } : {}),
			...(source.fragment ? { fragment: persistFragment(source.fragment) } : {})
		};
	}
	return {
		backend: 'monitor',
		profileId: source.profileId,
		relPath: source.relPath,
		...(source.ino !== undefined ? { ino: source.ino } : {}),
		...(source.dev !== undefined ? { dev: source.dev } : {}),
		...(source.fragment ? { fragment: persistFragment(source.fragment) } : {})
	};
}

function persistSnapshot(snapshot: AnimClipSnapshot): AnimClipSnapshot {
	return {
		bytesRef: snapshot.bytesRef,
		...(snapshot.atGeneration !== undefined ? { atGeneration: snapshot.atGeneration } : {}),
		...(snapshot.atCommit !== undefined ? { atCommit: snapshot.atCommit } : {})
	};
}

function persistFrame(frame: AnimFrame): AnimFrame {
	return {
		x: frame.x,
		y: frame.y,
		w: frame.w,
		h: frame.h,
		...(frame.rotation ? { rotation: frame.rotation } : {})
	};
}

function persistKeyframe(key: AnimKeyframe): AnimKeyframe {
	return {
		tMs: key.tMs,
		...(key.x !== undefined ? { x: key.x } : {}),
		...(key.y !== undefined ? { y: key.y } : {}),
		...(key.w !== undefined ? { w: key.w } : {}),
		...(key.h !== undefined ? { h: key.h } : {}),
		...(key.rotation !== undefined ? { rotation: key.rotation } : {})
	};
}

function persistClip(clip: AnimClip): AnimClip {
	const base = {
		id: clip.id,
		startMs: clip.startMs,
		durationMs: clip.durationMs,
		frame: persistFrame(clip.frame),
		...(clip.keyframes && clip.keyframes.length > 0
			? { keyframes: clip.keyframes.map(persistKeyframe) }
			: {}),
		...(clip.snapshot ? { snapshot: persistSnapshot(clip.snapshot) } : {}),
		...(clip.mediaKind && clip.mediaKind !== 'image' ? { mediaKind: clip.mediaKind } : {})
	};
	if (clip.bind === 'clone') return { ...base, bind: 'clone' };
	return { ...base, bind: clip.bind, source: persistSource(clip.source) };
}

export function clipNeedsV2(clip: AnimClip): boolean {
	if (clip.mediaKind === 'sketch-fragment') return true;
	if (clip.bind === 'clone') return false;
	return fragmentNeedsV2(clip.source.fragment);
}

export function serializeAnimDocument(doc: AnimDocument): string {
	const schemaVersion: 1 | 2 = doc.clips.some(clipNeedsV2) ? 2 : 1;
	const clean = parseAnimDocument({ ...doc, schemaVersion });
	return JSON.stringify({
		schemaVersion,
		durationMs: clean.durationMs,
		clips: clean.clips.map(persistClip)
	});
}

export function sameFsBackend(docBackend: FsBackend, source: ClipSource): boolean {
	return source.backend === docBackend;
}

export function assertClipMatchesDoc(docBackend: FsBackend, clip: AnimClip): void {
	if (clip.bind === 'clone') return;
	if (clip.source == null) {
		throw new AnimParseError(`Clip ${clip.id} ${clip.bind} bind requires source`);
	}
	if (!sameFsBackend(docBackend, clip.source)) {
		throw new AnimParseError(
			`Clip ${clip.id} source backend '${clip.source.backend}' does not match document backend '${docBackend}'`
		);
	}
}
