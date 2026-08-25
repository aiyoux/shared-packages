/** Payload FileDropZone emits for File Explorer / Connections row drags. */
export type ExplorerDropPayload = {
	driverId?: string;
	connectionId?: string;
	ids: string[];
	clientX: number;
	clientY: number;
};

export const EXPLORER_ID_TYPES = [
	'application/x-fe-explorer-ids',
	'application/x-cm-explorer-ids'
] as const;

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
} {
	const trimmed = raw.trim();
	if (!trimmed) return { ids: [] };
	if (trimmed.startsWith('{')) {
		try {
			const parsed = JSON.parse(trimmed) as {
				driverId?: unknown;
				ids?: unknown;
				connectionId?: unknown;
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
			return { ids, ...(driverId ? { driverId } : {}), ...(connectionId ? { connectionId } : {}) };
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
