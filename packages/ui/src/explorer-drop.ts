/** Payload FileDropZone emits for File Explorer / Connections row drags. */
export type ExplorerDropPayload = {
	driverId?: string;
	connectionId?: string;
	ids: string[];
	/** File-type ids advertised at drag start (`image`, `pdf`, …). */
	fileTypes?: string[];
	clientX: number;
	clientY: number;
};

export const EXPLORER_ID_TYPES = [
	'application/x-fe-explorer-ids',
	'application/x-cm-explorer-ids'
] as const;

/**
 * One MIME type per dragged file type, so drop targets can classify during
 * `dragover` (browsers expose `types` but not `getData` until drop).
 * Example: `application/x-fe-ft-image`.
 */
export const FE_FILE_TYPE_PREFIX = 'application/x-fe-ft-';

export function fileTypeMime(fileType: string): string {
	return `${FE_FILE_TYPE_PREFIX}${fileType}`;
}

export function fileTypesFromDragTypes(types: Iterable<string> | ArrayLike<string>): string[] {
	const out: string[] = [];
	for (const t of Array.from(types as Iterable<string>)) {
		if (t.startsWith(FE_FILE_TYPE_PREFIX)) out.push(t.slice(FE_FILE_TYPE_PREFIX.length));
	}
	return out;
}

export type DropAcceptVerdict = 'ok' | 'unsupported' | 'unknown';

/** Whether an in-flight explorer drag contains at least one accepted file type. */
export function dropAccepts(
	types: Iterable<string> | ArrayLike<string> | null | undefined,
	accept: readonly string[]
): DropAcceptVerdict {
	if (!types) return 'unknown';
	const listed = Array.from(types as Iterable<string>);
	const fts = fileTypesFromDragTypes(listed);
	if (!fts.length) {
		return EXPLORER_ID_TYPES.some((t) => listed.includes(t)) ? 'unknown' : 'unknown';
	}
	const files = fts.filter((t) => t !== 'folder');
	if (!files.length) return 'unsupported';
	return files.some((t) => accept.includes(t)) ? 'ok' : 'unsupported';
}

export type DropTransferLike = {
	types?: Iterable<string> | ArrayLike<string> | null;
	files?: ArrayLike<File> | null;
	getData?: (type: string) => string;
};

export function hasExplorerMime(dt: DropTransferLike | null | undefined): boolean {
	if (!dt) return false;
	const types = Array.from(dt.types ?? []);
	return EXPLORER_ID_TYPES.some((t) => types.includes(t));
}

export function readExplorerPayload(dt: DropTransferLike | null | undefined): {
	driverId?: string;
	connectionId?: string;
	ids: string[];
} {
	if (!dt) return { ids: [] };
	let raw = '';
	try {
		raw =
			dt.getData?.('application/x-fe-explorer-ids') ||
			dt.getData?.('application/x-cm-explorer-ids') ||
			dt.getData?.('text/plain') ||
			'';
	} catch {
		raw = '';
	}
	return parseExplorerDropPayload(raw);
}

function emitExplorerIds(
	e: { dataTransfer?: DropTransferLike | null; clientX: number; clientY: number },
	onExplorerIds: (payload: ExplorerDropPayload) => void
): boolean {
	const parsed = readExplorerPayload(e.dataTransfer);
	if (!parsed.ids.length) return false;
	const payload: ExplorerDropPayload = {
		ids: parsed.ids,
		clientX: e.clientX,
		clientY: e.clientY
	};
	if (parsed.driverId) payload.driverId = parsed.driverId;
	if (parsed.connectionId) payload.connectionId = parsed.connectionId;
	if (parsed.fileTypes?.length) payload.fileTypes = parsed.fileTypes;
	onExplorerIds(payload);
	return true;
}

/** Explorer MIME wins over File clones; true OS drops go to onfiles. */
export function routeFileDrop(
	e: { dataTransfer?: DropTransferLike | null; clientX: number; clientY: number },
	handlers: {
		onfiles: (files: File[]) => void;
		onExplorerIds?: (payload: ExplorerDropPayload) => void;
	}
): void {
	if (hasExplorerMime(e.dataTransfer) && handlers.onExplorerIds) {
		emitExplorerIds(e, handlers.onExplorerIds);
		return;
	}
	const os = e.dataTransfer?.files?.length ? Array.from(e.dataTransfer.files) : [];
	if (os.length) {
		handlers.onfiles(os);
		return;
	}
	if (handlers.onExplorerIds) emitExplorerIds(e, handlers.onExplorerIds);
}

/** Prefer JSON `{"driverId","ids"}`; fall back to comma-separated ids. */
export function parseExplorerDropPayload(raw: string): {
	driverId?: string;
	connectionId?: string;
	ids: string[];
	fileTypes?: string[];
} {
	const trimmed = raw.trim();
	if (!trimmed) return { ids: [] };
	if (trimmed.startsWith('{')) {
		try {
			const parsed = JSON.parse(trimmed) as {
				driverId?: unknown;
				ids?: unknown;
				connectionId?: unknown;
				fileTypes?: unknown;
			};
			const driverId =
				typeof parsed.driverId === 'string' && parsed.driverId.trim()
					? parsed.driverId.trim()
					: undefined;
			const connectionId =
				typeof parsed.connectionId === 'string' && parsed.connectionId.trim()
					? parsed.connectionId.trim()
					: undefined;
			const ids = Array.isArray(parsed.ids)
				? parsed.ids.map((id) => String(id).trim()).filter(Boolean)
				: [];
			const fileTypes = Array.isArray(parsed.fileTypes)
				? parsed.fileTypes.map((t) => String(t).trim()).filter(Boolean)
				: undefined;
			return {
				ids,
				...(driverId ? { driverId } : {}),
				...(connectionId ? { connectionId } : {}),
				...(fileTypes?.length ? { fileTypes } : {})
			};
		} catch {
			/* fall through to comma-separated ids */
		}
	}
	return {
		ids: trimmed
			.split(',')
			.map((id) => id.trim())
			.filter(Boolean)
	};
}
