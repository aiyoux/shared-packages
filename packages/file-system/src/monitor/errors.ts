export class ExplorerMonitorError extends Error {
	readonly code: string;
	constructor(code: string, message?: string) {
		super(message ?? code);
		this.code = code;
		this.name = 'ExplorerMonitorError';
	}
}

export function mapMonitorError(e: unknown): ExplorerMonitorError {
	if (e instanceof ExplorerMonitorError) return e;
	const msg = e instanceof Error ? e.message : String(e);
	if (/not found|404/i.test(msg)) return new ExplorerMonitorError('MONITOR_NOT_FOUND', msg);
	if (/denied|403|not_allowed/i.test(msg))
		return new ExplorerMonitorError('MONITOR_FORBIDDEN', msg);
	if (/too.?large|413/i.test(msg)) return new ExplorerMonitorError('MONITOR_TOO_LARGE', msg);
	if (/503|unavailable|fetch|network|ECONNREFUSED/i.test(msg))
		return new ExplorerMonitorError('MONITOR_UNAVAILABLE', msg);
	return new ExplorerMonitorError('MONITOR_ERROR', msg);
}

export function formatMonitorErrorMessage(e: unknown): string {
	const m = mapMonitorError(e);
	switch (m.code) {
		case 'MONITOR_UNAVAILABLE':
			return 'Monitor service unavailable — is it running on loopback (e.g. :8300)?';
		case 'MONITOR_FORBIDDEN':
			return 'Path not allowed by monitor config (check allowed_path_prefixes).';
		case 'MONITOR_NOT_FOUND':
			return 'Path not found on host.';
		case 'MONITOR_TOO_LARGE':
			return 'File too large to download (100 MiB cap).';
		default:
			return m.message || 'Monitor error';
	}
}
