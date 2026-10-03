import type { ExplorerDriver, ExplorerEntry } from './explorerDriver.js';

export const FILE_CLIPBOARD_TYPE = 'application/x-scratchpad-files';
export const FILE_CLIPBOARD_WEB_TYPE = `web ${FILE_CLIPBOARD_TYPE}`;
const FILE_CLIPBOARD_HTML_ATTR = 'data-scratchpad-files';

export type FileClipboardPayload = {
	mode: 'copy' | 'cut';
	clipboardId: string;
	sourceDriverId: string;
	sourceConnectionId?: string;
	sourceParentId: string | null;
	ids: string[];
	entries: ExplorerEntry[];
};

// Native paste can still expose a stale cut envelope if OS clipboard writes
// are denied. Do not move a completed item again in another pane.
const movedFiles = new Map<string, Set<string>>();

export function markClipboardFileMoved(payload: FileClipboardPayload, id: string): void {
	let moved = movedFiles.get(payload.clipboardId);
	if (!moved) {
		moved = new Set();
		movedFiles.set(payload.clipboardId, moved);
		if (movedFiles.size > 100) movedFiles.delete(movedFiles.keys().next().value!);
	}
	moved.add(id);
}

/** Clipboard data is external input; never run file operations on an unchecked envelope. */
export function fileClipboardPayload(value: unknown): FileClipboardPayload | null {
	if (!value || typeof value !== 'object') return null;
	const p = value as Partial<FileClipboardPayload>;
	if (p.mode !== 'copy' && p.mode !== 'cut') return null;
	if (typeof p.sourceDriverId !== 'string' || !p.sourceDriverId) return null;
	if (p.sourceConnectionId !== undefined && typeof p.sourceConnectionId !== 'string') return null;
	if (p.clipboardId !== undefined && typeof p.clipboardId !== 'string') return null;
	if (p.sourceParentId != null && typeof p.sourceParentId !== 'string') return null;
	if (!Array.isArray(p.ids) || p.ids.some((id) => typeof id !== 'string' || !id)) return null;
	if (!Array.isArray(p.entries)) return null;
	const entries: ExplorerEntry[] = [];
	for (const entry of p.entries) {
		if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string' ||
			typeof entry.name !== 'string' || (entry.kind !== 'file' && entry.kind !== 'folder') ||
			(entry.parentId != null && typeof entry.parentId !== 'string')) return null;
		entries.push({ ...entry, parentId: entry.parentId ?? p.sourceParentId ?? null });
	}
	const clipboardId = p.clipboardId || `legacy:${JSON.stringify([p.mode, p.sourceDriverId, p.sourceConnectionId, p.ids])}`;
	const ids = [...new Set(p.ids)].filter((id) => p.mode !== 'cut' || !movedFiles.get(clipboardId)?.has(id));
	if (ids.some((id) => !entries.some((entry) => entry.id === id))) return null;
	return { ...p, clipboardId, mode: p.mode, sourceDriverId: p.sourceDriverId,
		sourceParentId: p.sourceParentId ?? null, ids, entries };
}

export function fileClipboardFromText(text: string): FileClipboardPayload | null {
	try {
		const envelope = JSON.parse(text);
		return envelope?.type === FILE_CLIPBOARD_TYPE ? fileClipboardPayload(envelope.data) : null;
	} catch {
		return null;
	}
}

/** Text targets get readable names; references belong in a separate clipboard format. */
export function fileClipboardText(payload: FileClipboardPayload): string {
	return payload.ids.map((id) => payload.entries.find((entry) => entry.id === id)!.name).join('\n');
}

/** Folder selections stay on the app clipboard; browsers cannot export native folders. */
export function fileClipboardHasFolders(payload: FileClipboardPayload | null): boolean {
	return Boolean(payload?.entries.some((entry) => entry.kind === 'folder' && payload.ids.includes(entry.id)));
}

export function fileClipboardFromHtml(html: string): FileClipboardPayload | null {
	if (!html || typeof DOMParser === 'undefined') return null;
	try {
		const doc = new DOMParser().parseFromString(html, 'text/html');
		const encoded = doc.querySelector(`[${FILE_CLIPBOARD_HTML_ATTR}]`)?.getAttribute(FILE_CLIPBOARD_HTML_ATTR);
		return encoded ? fileClipboardPayload(JSON.parse(decodeURIComponent(encoded))) : null;
	} catch { return null; }
}

// Older browsers expose only writeText/readText. Retain only the latest text we
// successfully wrote, so changing the OS clipboard still replaces the operation.
let ownedText: { text: string; payload: FileClipboardPayload } | null = null;

export function fileClipboardFromOwnedText(text: string): FileClipboardPayload | null {
	return text && ownedText?.text === text ? fileClipboardPayload(ownedText.payload) : null;
}

export async function copyFilesToSystem(payload: FileClipboardPayload): Promise<void> {
	const files = fileClipboardPayload(payload);
	if (!files) throw new Error('Invalid file clipboard');
	if (fileClipboardHasFolders(payload)) return;
	const text = fileClipboardText(files);
	if (navigator.clipboard?.write && typeof ClipboardItem !== 'undefined') {
		const escaped = text.replace(/[&<>"']/g, (char) => ({
			'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
		})[char]!);
		const html = `<span ${FILE_CLIPBOARD_HTML_ATTR}="${encodeURIComponent(JSON.stringify(files))}">${escaped.replace(/\n/g, '<br>')}</span>`;
		const data: Record<string, Blob> = {
			'text/plain': new Blob([text], { type: 'text/plain' }),
			'text/html': new Blob([html], { type: 'text/html' })
		};
		if (ClipboardItem.supports?.(FILE_CLIPBOARD_WEB_TYPE)) {
			data[FILE_CLIPBOARD_WEB_TYPE] = new Blob([JSON.stringify(files)], { type: FILE_CLIPBOARD_TYPE });
		}
		await navigator.clipboard.write([new ClipboardItem(data)]);
		ownedText = null;
	} else if (navigator.clipboard?.writeText) {
		await navigator.clipboard.writeText(text);
		ownedText = { text, payload: files };
	} else throw new Error('This browser cannot write to the system clipboard');
}

export async function fileClipboardFromItems(items: ClipboardItems): Promise<FileClipboardPayload | null> {
	for (const item of items) {
		if (!item.types.includes(FILE_CLIPBOARD_WEB_TYPE)) continue;
		try {
			return fileClipboardPayload(JSON.parse(await (await item.getType(FILE_CLIPBOARD_WEB_TYPE)).text()));
		} catch { /* Malformed custom data is not a file operation. */ }
	}
	for (const item of items) {
		if (!item.types.includes('text/html')) continue;
		try {
			const files = fileClipboardFromHtml(await (await item.getType('text/html')).text());
			if (files) return files;
		} catch { /* Keep native text/image paste usable when HTML cannot be read. */ }
	}
	return null;
}

/** Native paste hides web custom formats. Only recover refs for the same image snapshot. */
export async function fileClipboardForPastedImage(image: File): Promise<FileClipboardPayload | null> {
	if (!navigator.clipboard?.read) return null;
	try {
		const items = await navigator.clipboard.read();
		const files = await fileClipboardFromItems(items);
		if (!files) return null;
		for (const item of items) {
			if (!item.types.includes(image.type)) continue;
			const blob = await item.getType(image.type);
			if (blob.size !== image.size) continue;
			const [a, b] = await Promise.all([blob.arrayBuffer(), image.arrayBuffer()]);
			const bytes = new Uint8Array(b);
			if (new Uint8Array(a).every((byte, index) => byte === bytes[index])) return files;
		}
	} catch { /* Native image paste works even without async clipboard permission. */ }
	return null;
}

export function sameClipboardSource(payload: FileClipboardPayload, driver: ExplorerDriver): boolean {
	return payload.sourceDriverId === driver.id &&
		(payload.sourceConnectionId ?? '') === (driver.connectionId ?? '');
}

const sources = new Map<string, ExplorerDriver>();

/** Retain the source even if its pane changes connection before Paste. */
export function rememberClipboardSource(driver: ExplorerDriver): void {
	sources.set(JSON.stringify([driver.id, driver.connectionId ?? '']), driver);
}

export function clipboardSource(payload: FileClipboardPayload): ExplorerDriver | null {
	return sources.get(JSON.stringify([payload.sourceDriverId, payload.sourceConnectionId ?? ''])) ?? null;
}

export function fileClipboardLabel(payload: FileClipboardPayload): string {
	return `Files: ${payload.ids.length} item${payload.ids.length === 1 ? '' : 's'}${payload.mode === 'cut' ? ' (cut)' : ''}`;
}

/** Share only serializable file references, retaining names and source folders across panes/tabs. */
export function clipboardEntries(entries: ExplorerEntry[]): ExplorerEntry[] {
	return entries.map(({ id, name, kind, parentId, size, fileType, contentType }) =>
		({ id, name, kind, parentId, size, fileType, contentType }));
}
