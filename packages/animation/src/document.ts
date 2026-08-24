import {
	BIND_MODES,
	type AnimClip,
	type AnimClipSnapshot,
	type AnimDocument,
	type AnimFrame,
	type BindMode,
	type ClipSource,
	type FsBackend
} from './types.js';

export class AnimParseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'AnimParseError';
	}
}

const BINDS_REQUIRING_SOURCE: ReadonlySet<BindMode> = new Set(['live', 'snapshot', 'gitPin']);

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
	return {
		x: finiteNumber(raw.x, 'frame.x'),
		y: finiteNumber(raw.y, 'frame.y'),
		w: finiteNumber(raw.w, 'frame.w'),
		h: finiteNumber(raw.h, 'frame.h')
	};
}

function parseSource(raw: unknown): ClipSource {
	if (!isRecord(raw)) throw new AnimParseError('clip.source must be an object');
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

function parseClip(raw: unknown, index: number): AnimClip {
	if (!isRecord(raw)) throw new AnimParseError(`clips[${index}] must be an object`);
	const bind = parseBind(raw.bind);
	const clip: AnimClip = {
		id: nonEmptyString(raw.id, `clips[${index}].id`),
		startMs: finiteNumber(raw.startMs, `clips[${index}].startMs`),
		durationMs: finiteNumber(raw.durationMs, `clips[${index}].durationMs`),
		frame: parseFrame(raw.frame),
		bind
	};
	if (raw.source !== undefined) {
		if (bind === 'clone') {
			throw new AnimParseError(`clips[${index}] clone bind must omit source`);
		}
		clip.source = parseSource(raw.source);
	} else if (BINDS_REQUIRING_SOURCE.has(bind)) {
		throw new AnimParseError(`clips[${index}] ${bind} bind requires source`);
	}
	if (raw.snapshot !== undefined) clip.snapshot = parseSnapshot(raw.snapshot);
	return clip;
}

export function parseAnimDocument(input: Uint8Array | unknown): AnimDocument {
	const raw = decodeInput(input);
	if (!isRecord(raw)) throw new AnimParseError('document must be an object');
	if (raw.schemaVersion !== 1) {
		throw new AnimParseError(`unsupported schemaVersion: ${String(raw.schemaVersion)}`);
	}
	if (!Array.isArray(raw.clips)) throw new AnimParseError('clips must be an array');
	return {
		schemaVersion: 1,
		durationMs: finiteNumber(raw.durationMs, 'durationMs'),
		clips: raw.clips.map((clip, i) => parseClip(clip, i))
	};
}

function persistSource(source: ClipSource): ClipSource {
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

function persistClip(clip: AnimClip): AnimClip {
	const out: AnimClip = {
		id: clip.id,
		startMs: clip.startMs,
		durationMs: clip.durationMs,
		frame: { x: clip.frame.x, y: clip.frame.y, w: clip.frame.w, h: clip.frame.h },
		bind: clip.bind
	};
	if (clip.source) out.source = persistSource(clip.source);
	if (clip.snapshot) {
		const snapshot: AnimClipSnapshot = { bytesRef: clip.snapshot.bytesRef };
		if (clip.snapshot.atGeneration !== undefined) snapshot.atGeneration = clip.snapshot.atGeneration;
		if (clip.snapshot.atCommit !== undefined) snapshot.atCommit = clip.snapshot.atCommit;
		out.snapshot = snapshot;
	}
	return out;
}

export function serializeAnimDocument(doc: AnimDocument): string {
	const clean = parseAnimDocument(doc);
	return JSON.stringify({
		schemaVersion: 1,
		durationMs: clean.durationMs,
		clips: clean.clips.map(persistClip)
	});
}

export function sameFsBackend(docBackend: FsBackend, source: ClipSource): boolean {
	return source.backend === docBackend;
}

export function assertClipMatchesDoc(docBackend: FsBackend, clip: AnimClip): void {
	if (clip.source == null) return;
	if (!sameFsBackend(docBackend, clip.source)) {
		throw new Error(
			`Clip ${clip.id} source backend '${clip.source.backend}' does not match document backend '${docBackend}'`
		);
	}
}
