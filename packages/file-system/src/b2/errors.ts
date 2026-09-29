/** Stable UI error codes for B2 File Explorer (never include key material). */

export class ExplorerB2Error extends Error {
	readonly code: string;
	constructor(code: string, message?: string) {
		super((message && message.trim()) || code);
		this.name = 'ExplorerB2Error';
		this.code = code;
	}
}

/** Monitor wire code (`b2.*`) → explorer code (`B2_*`). */
const WIRE_CODES: Record<string, string> = {
	'b2.auth': 'B2_AUTH',
	'b2.master_key': 'B2_MASTER_KEY',
	'b2.key_not_scoped': 'B2_MASTER_KEY',
	'b2.wrong_bucket': 'B2_FORBIDDEN',
	'b2.forbidden': 'B2_FORBIDDEN',
	'b2.outside_prefix': 'B2_FORBIDDEN',
	'b2.not_found': 'B2_NOT_FOUND',
	'b2.connection_not_found': 'B2_NOT_FOUND',
	'b2.network': 'B2_NETWORK',
	'b2.upstream': 'B2_NETWORK',
	'b2.rate_limit': 'B2_RATE_LIMIT',
	'b2.folder_not_empty': 'B2_FOLDER_NOT_EMPTY',
	'b2.folder_op_unsupported': 'B2_FOLDER_OP_UNSUPPORTED',
	'b2.rename_partial': 'B2_RENAME_PARTIAL',
	'b2.invalid_name': 'INVALID_NAME',
	'b2.invalid_connection': 'B2_INVALID'
};

/** Error for a monitor `{error:{code,message}}` body (or an NDJSON failure line). */
export function b2ErrorFromWire(code: string | undefined, message: string | undefined): ExplorerB2Error {
	const mapped = (code && WIRE_CODES[code]) || 'B2_ERROR';
	return new ExplorerB2Error(mapped, message || code || 'B2 request failed');
}

export function formatB2ErrorMessage(e: unknown): string {
	if (e instanceof Error && e.message.trim()) return e.message;
	const s = String(e ?? '').trim();
	return s || 'B2 request failed';
}

export function mapB2Error(e: unknown): ExplorerB2Error {
	if (e instanceof ExplorerB2Error) return e;
	if (e instanceof Error && e.name === 'AbortError') {
		return new ExplorerB2Error('B2_ABORTED', 'Cancelled');
	}
	if (e instanceof TypeError) {
		return new ExplorerB2Error(
			'B2_NETWORK',
			'Cannot reach the monitor that holds this B2 connection. Is it running and allowing this origin?'
		);
	}
	return new ExplorerB2Error('B2_ERROR', formatB2ErrorMessage(e));
}
