/** Payload FileDropZone emits for File Explorer / Connections row drags. */
export type ExplorerDropPayload = {
	driverId?: string;
	ids: string[];
	clientX: number;
	clientY: number;
};

/** Prefer JSON `{"driverId","ids"}`; fall back to comma-separated ids. */
export function parseExplorerDropPayload(raw: string): {
	driverId?: string;
	ids: string[];
} {
	const trimmed = raw.trim();
	if (!trimmed) return { ids: [] };
	if (trimmed.startsWith('{')) {
		try {
			const parsed = JSON.parse(trimmed) as { driverId?: unknown; ids?: unknown };
			const driverId =
				typeof parsed.driverId === 'string' && parsed.driverId.trim()
					? parsed.driverId.trim()
					: undefined;
			const ids = Array.isArray(parsed.ids)
				? parsed.ids.map((id) => String(id).trim()).filter(Boolean)
				: [];
			return { driverId, ids };
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
