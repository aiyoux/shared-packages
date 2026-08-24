/**
 * Human-readable explorer errors for toasts and banners.
 * Drivers often throw `{ code: 'B2_ERROR' }` with a better `message` — never
 * show the raw code when a real sentence exists.
 */
import { VfsError } from '../types.js';
import { formatB2ErrorMessage } from '../b2/errors.js';
import { formatRcloneErrorMessage } from '../rclone/errors.js';
import { formatMonitorErrorMessage } from '../monitor/errors.js';

const CODE_ONLY = /^[A-Z][A-Z0-9_]{2,}$/;

const CODE_LABELS: Record<string, string> = {
	B2_ERROR: 'Backblaze B2 could not complete that request.',
	B2_AUTH: 'Invalid Backblaze application key. Check the key id and that it can access this bucket.',
	B2_CORS: 'Backblaze B2 blocked this browser request (CORS or proxy).',
	B2_FORBIDDEN: 'This Backblaze key cannot write here.',
	B2_NOT_FOUND: 'That file or folder was not found on Backblaze B2.',
	B2_NETWORK: 'Network error talking to Backblaze B2.',
	OPFS_IO: 'Could not write the file to browser storage.',
	OPFS_UNAVAILABLE: 'Browser file storage is not available in this context.',
	NOT_FOUND: 'That file or folder was not found.',
	NAME_CONFLICT: 'A file or folder with that name already exists.',
	INVALID_NAME: 'That name is not allowed.',
	QUOTA_EXCEEDED: 'Browser storage is full.',
	HAS_CHILDREN: 'That folder is not empty.',
	MONITOR_ERROR: 'The monitor connection could not complete that request.',
	MONITOR_UNAVAILABLE: 'Monitor is unavailable. Check the base URL and that the service is running.',
	MONITOR_FORBIDDEN: 'That path is not allowed by the monitor.',
	MONITOR_NOT_FOUND: 'That path was not found on the host.',
	RCLONE_ERROR: 'rclone could not complete that request.'
};

function codeOf(e: unknown): string {
	if (e && typeof e === 'object' && 'code' in e && typeof (e as { code: unknown }).code === 'string') {
		return (e as { code: string }).code;
	}
	return '';
}

function looksLikeRevokedDrop(e: unknown): boolean {
	const name = e instanceof Error ? e.name : '';
	const msg = e instanceof Error ? e.message : String(e ?? '');
	return (
		name === 'NotFoundError' ||
		/could not be found at the time an operation was processed/i.test(msg)
	);
}

export function formatExplorerError(e: unknown): string {
	if (looksLikeRevokedDrop(e)) {
		return 'Could not read the dropped folder. Drop it again (the browser revokes folder access if the upload starts too late).';
	}

	const code = codeOf(e);
	const name = e instanceof Error ? e.name : '';

	if (name === 'ExplorerB2Error' || code.startsWith('B2_')) {
		const formatted = formatB2ErrorMessage(e);
		if (formatted && !CODE_ONLY.test(formatted)) return formatted;
		if (CODE_LABELS[code]) return CODE_LABELS[code];
		return formatted || CODE_LABELS.B2_ERROR;
	}
	if (name === 'ExplorerRcloneError' || code.startsWith('RCLONE_')) {
		const formatted = formatRcloneErrorMessage(e);
		if (formatted && !CODE_ONLY.test(formatted)) return formatted;
		return CODE_LABELS[code] || formatted || CODE_LABELS.RCLONE_ERROR;
	}
	if (name === 'ExplorerMonitorError' || code.startsWith('MONITOR_')) {
		return formatMonitorErrorMessage(e);
	}
	if (e instanceof VfsError) {
		if (e.message && e.message !== e.code && !CODE_ONLY.test(e.message)) return e.message;
		return CODE_LABELS[e.code] || e.message || e.code;
	}

	if (e instanceof Error) {
		const msg = e.message.trim();
		if (msg && msg !== code && !CODE_ONLY.test(msg)) return msg;
		if (CODE_LABELS[code]) return CODE_LABELS[code];
		if (msg) return msg;
	}

	if (CODE_LABELS[code]) return CODE_LABELS[code];
	if (code) return code.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
	const s = String(e ?? '').trim();
	return s || 'Something went wrong';
}
