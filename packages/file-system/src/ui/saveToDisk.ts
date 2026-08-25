/**
 * Save a remote/local file onto the user's PC.
 *
 * Chrome's download shelf only shows byte progress for a real HTTP GET (with
 * Content-Length). A `blob:` URL is already in RAM, so Chrome draws a spinner.
 *
 * Prefer `downloadUrl` → native GET when the URL is safe for the page (HTTPS,
 * same-origin, or loopback HTTP). Otherwise stream through File System Access
 * (`showSaveFilePicker`) or fall back to a blob click after in-app progress.
 */

export type HttpDownloadLocation = {
	url: string;
	filename: string;
};

/** True when Chrome can GET `url` as a top-level download from this page. */
export function httpDownloadIsSafe(url: string, pageHref?: string): boolean {
	let target: URL;
	try {
		target = new URL(url, pageHref ?? (typeof location !== 'undefined' ? location.href : undefined));
	} catch {
		return false;
	}
	if (target.protocol !== 'http:' && target.protocol !== 'https:') return false;
	const host = target.hostname.replace(/^\[|\]$/g, '').toLowerCase();
	const loopback =
		host === 'localhost' ||
		host.endsWith('.localhost') ||
		host === '::1' ||
		/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
	const page =
		pageHref ?? (typeof location !== 'undefined' ? location.href : undefined);
	if (!page) return target.protocol === 'https:' || loopback;
	let origin: URL;
	try {
		origin = new URL(page);
	} catch {
		return false;
	}
	if (target.origin === origin.origin) return true;
	if (target.protocol === 'https:') return true;
	// HTTPS page → HTTP loopback is a mixed-content exemption in Chromium.
	if (loopback) return true;
	// HTTPS page → HTTP LAN is mixed content; the existing fetch() path still works.
	if (origin.protocol === 'https:' && target.protocol === 'http:') return false;
	return true;
}

export function triggerHttpDownload(url: string, filename: string): void {
	if (typeof document === 'undefined') return;
	const a = document.createElement('a');
	a.href = url;
	a.download = filename;
	a.rel = 'noopener';
	document.body.appendChild(a);
	a.click();
	a.remove();
}

export function triggerBlobDownload(blob: Blob, filename: string): void {
	const url = URL.createObjectURL(blob);
	triggerHttpDownload(url, filename);
	// Chrome starts the download asynchronously; revoking immediately can abort it.
	window.setTimeout(() => {
		try {
			URL.revokeObjectURL(url);
		} catch {
			/* ignore */
		}
	}, 60_000);
}

type SavePicker = (opts?: {
	suggestedName?: string;
}) => Promise<{
	createWritable: () => Promise<{
		write: (data: BufferSource | Blob) => Promise<void>;
		close: () => Promise<void>;
		abort: () => Promise<void>;
	}>;
}>;

function savePicker(): SavePicker | null {
	if (typeof window === 'undefined') return null;
	const fn = (window as unknown as { showSaveFilePicker?: SavePicker }).showSaveFilePicker;
	return typeof fn === 'function' ? fn.bind(window) : null;
}

export type StreamDownload = (opts: {
	onProgress?: (transferred: number, total?: number) => void;
	onChunk?: (chunk: Uint8Array) => void | Promise<void>;
	assemble?: boolean;
}) => Promise<Blob>;

/**
 * Stream `download` to a user-picked file (Chromium) or, if the picker is
 * missing/cancelled, assemble a Blob and click it.
 * Returns `'picker' | 'blob'`. `AbortError` from the picker is rethrown so the
 * caller can treat cancel as a no-op.
 */
export async function saveFileToDisk(args: {
	filename: string;
	download: StreamDownload;
	onProgress?: (transferred: number, total?: number) => void;
}): Promise<'picker' | 'blob'> {
	const picker = savePicker();
	if (picker) {
		const handle = await picker({ suggestedName: args.filename });
		const writable = await handle.createWritable();
		try {
			await args.download({
				assemble: false,
				onProgress: args.onProgress,
				// Download chunks are never SharedArrayBuffer-backed; the cast narrows
				// TS 5.7's generic Uint8Array for the FileSystemWritable boundary.
				// (Not @shared-packages/ui/bytes: file-system must not take a
				// dependency on the UI component package for one helper.)
				onChunk: (chunk) => writable.write(chunk as Uint8Array<ArrayBuffer>)
			});
			await writable.close();
			return 'picker';
		} catch (e) {
			try {
				await writable.abort();
			} catch {
				/* already closed */
			}
			throw e;
		}
	}

	const blob = await args.download({
		assemble: true,
		onProgress: args.onProgress
	});
	triggerBlobDownload(blob, args.filename);
	return 'blob';
}
