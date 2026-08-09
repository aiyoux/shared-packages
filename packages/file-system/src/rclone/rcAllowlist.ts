/**
 * SSRF + RC method allow/deny for rclone same-origin proxy (v1).
 * @see docs/design/rclone-api-connection.md
 */

import { RCLONE_ALLOWED_PORTS, isLoopbackHostname } from './types.js';

/** Default same-origin paths used by host apps. */
export const DEFAULT_RCLONE_RC_PROXY_PATH = '/api/rclone/rc';
export const DEFAULT_RCLONE_UPLOAD_PROXY_PATH = '/api/rclone/upload';
export const DEFAULT_RCLONE_DOWNLOAD_PROXY_PATH = '/api/rclone/download';

/** RC methods allowed through the proxy (v1). */
export const RCLONE_ALLOWED_RC_METHODS = new Set([
	'operations/list',
	'operations/mkdir',
	'operations/deletefile',
	'operations/rmdir',
	'operations/purge',
	'operations/movefile',
	'operations/copyfile',
	'operations/stat',
	'operations/about',
	'operations/uploadfile',
	'config/listremotes',
	'rc/noopauth',
	'rc/noop'
]);

/** Explicit hard denies (defense in depth). */
export const RCLONE_DENIED_RC_METHODS = new Set([
	'core/command',
	'config/dump',
	'config/create',
	'config/update',
	'config/password',
	'backend/command',
	'job/list',
	'core/quit',
	'sync/copy',
	'sync/move',
	'sync/sync',
	'operations/delete'
]);

export function isAllowedRcMethod(method: string): boolean {
	const m = method.trim().replace(/^\//, '');
	if (RCLONE_DENIED_RC_METHODS.has(m)) return false;
	return RCLONE_ALLOWED_RC_METHODS.has(m);
}

export type AssertTargetResult =
	| { ok: true; url: URL }
	| { ok: false; reason: string };

/**
 * Assert upstream RC base URL is loopback + allowed port.
 * `target` may be full base (http://127.0.0.1:7750) or with path.
 */
export function assertRcloneProxyTargetUrl(target: string): AssertTargetResult {
	let url: URL;
	try {
		url = new URL(target);
	} catch {
		return { ok: false, reason: 'Invalid URL' };
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		return { ok: false, reason: 'Scheme must be http or https' };
	}
	if (url.username || url.password) {
		return { ok: false, reason: 'URL must not include credentials' };
	}
	if (!isLoopbackHostname(url.hostname)) {
		return { ok: false, reason: 'Host must be loopback' };
	}
	const port = url.port
		? Number(url.port)
		: url.protocol === 'https:'
			? 443
			: 80;
	if (!RCLONE_ALLOWED_PORTS.has(port)) {
		return { ok: false, reason: `Port ${port} not allowlisted` };
	}
	return { ok: true, url };
}

export function isLoopbackTarget(target: string): boolean {
	return assertRcloneProxyTargetUrl(target).ok;
}
