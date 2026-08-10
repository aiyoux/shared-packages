/**
 * Hub-only monitor (localhost fs service) connection profile.
 * Default: http://127.0.0.1:8300 (watch + fs features).
 */

export const HUB_MONITOR_DB_NAME = 'HubMonitor';
export const HUB_MONITOR_STORE = 'profiles';
export const HUB_MONITOR_META = 'meta';

/** Default local monitor URL (browser talks to this URL directly). */
export const DEFAULT_MONITOR_BASE_URL = 'http://127.0.0.1:8300';

export type MonitorConnectionProfileV1 = {
	v: 1;
	id: string;
	name: string;
	/**
	 * Monitor base URL the **browser** opens directly (loopback, SSH tunnel,
	 * public hostname, etc.). Default http://127.0.0.1:8300.
	 * Never put secrets in the URL.
	 */
	baseUrl: string;
	/**
	 * Absolute local directory to browse (clamped root for the driver).
	 * e.g. `/home/user/src` or `/tmp`
	 */
	rootPath: string;
	createdAt: number;
	updatedAt: number;
};

export type HubMonitorMeta = {
	activeProfileId: string | null;
};

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/** Normalize absolute root path: trim, strip trailing slash (except `/`). */
export function normalizeMonitorRootPath(raw: string): string {
	let t = (raw ?? '').trim();
	if (!t) throw new Error('INVALID_ROOT_PATH');
	if (t.includes('\0') || t.includes('..')) throw new Error('INVALID_ROOT_PATH');
	// Reject schemes
	if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(t)) throw new Error('INVALID_ROOT_PATH');
	if (!t.startsWith('/')) throw new Error('INVALID_ROOT_PATH');
	// Collapse trailing slashes except root
	if (t !== '/') t = t.replace(/\/+$/, '');
	return t;
}

export function validateMonitorProfileInput(input: {
	name: string;
	baseUrl?: string;
	rootPath: string;
}): string | null {
	if (!input.name.trim()) return 'Name is required';
	if (!input.rootPath.trim()) return 'Root path is required (absolute local directory)';

	const baseUrl =
		(input.baseUrl ?? DEFAULT_MONITOR_BASE_URL).trim() || DEFAULT_MONITOR_BASE_URL;
	let url: URL;
	try {
		url = new URL(baseUrl);
	} catch {
		return 'Base URL is invalid';
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		return 'Base URL must be http or https';
	}
	if (url.username || url.password) {
		return 'Base URL must not include credentials';
	}
	// Any host is allowed — browser connects directly (tunnel, LAN, loopback).

	try {
		normalizeMonitorRootPath(input.rootPath);
	} catch {
		return 'Root path must be an absolute path without .. segments';
	}

	return null;
}

