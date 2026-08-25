/**
 * Hub-only rclone RC connection profile.
 * `rcPass` is plaintext in IDB unless the connection vault is enabled or
 * `persistSecret` is false (tab-only).
 * @see docs/design/rclone-api-connection.md
 */

import type { SealedSecret } from '../vault/types.js';

export const HUB_RCLONE_DB_NAME = 'HubRclone';
export const HUB_RCLONE_STORE = 'profiles';
export const HUB_RCLONE_META = 'meta';

/** Default local rcd URL (browser talks to this URL directly). */
export const DEFAULT_RCLONE_BASE_URL = 'http://127.0.0.1:7750';

/** @deprecated Direct mode accepts any http(s) URL; kept for proxy/legacy callers. */
export const RCLONE_ALLOWED_PORTS = new Set([7750]);

export type RcloneConnectionProfileV1 = {
	/** Schema version */
	v: 1;
	/** Profile id (uuid) */
	id: string;
	/** Display name */
	name: string;
	/**
	 * RC base URL the **browser** opens directly (loopback, SSH tunnel, etc.).
	 * Default http://127.0.0.1:7750. Never put secrets in the URL userinfo.
	 */
	baseUrl: string;
	/**
	 * rclone remote / fs string, e.g. `remote:` or `remote:bucket` or alias `home:`.
	 */
	fs: string;
	/**
	 * Optional path clamp under `fs` (no leading slash; no `..`).
	 * Normalized without trailing slash (dirs still use trailing / in entry ids).
	 */
	rootPath?: string;
	/** RC Basic user */
	rcUser: string;
	/** RC Basic password — never log. Empty when sealed, locked, or session-only. */
	rcPass: string;
	/** False = keep the password in this tab only. Default true. */
	persistSecret?: boolean;
	/** Present when the connection vault has wrapped `rcPass`. */
	sealedRcPass?: SealedSecret;
	createdAt: number;
	updatedAt: number;
};

export type HubRcloneMeta = {
	activeProfileId: string | null;
};

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/**
 * Normalize optional root path under fs.
 * - trim, strip leading `/`
 * - reject `..` segments
 * - strip trailing `/` (empty → '')
 */
export function normalizeRootPath(raw?: string | null): string {
	let t = (raw ?? '').trim();
	if (!t) return '';
	// strip leading slashes
	t = t.replace(/^\/+/, '');
	// strip trailing slashes
	t = t.replace(/\/+$/, '');
	if (!t) return '';
	const parts = t.split('/').filter((p) => p.length > 0);
	for (const p of parts) {
		if (p === '.' || p === '..') {
			throw new Error('INVALID_ROOT_PATH');
		}
	}
	return parts.join('/');
}

export function isLoopbackHostname(host: string): boolean {
	const h = host.trim().toLowerCase();
	if (LOOPBACK_HOSTS.has(h)) return true;
	// strip brackets for ipv6
	if (h.startsWith('[') && h.endsWith(']')) {
		return LOOPBACK_HOSTS.has(h.slice(1, -1)) || h === '[::1]';
	}
	return false;
}

/**
 * Validate profile form fields. Returns error message or null if ok.
 * `rcPass` may be blank when editing (caller keeps prior secret).
 */
export function validateProfileInput(input: {
	name: string;
	baseUrl?: string;
	fs: string;
	rootPath?: string;
	rcUser?: string;
	/** When false, empty rcPass is allowed (keep existing). Default true for create. */
	requireRcPass?: boolean;
	rcPass?: string;
}): string | null {
	if (!input.name.trim()) return 'Name is required';
	if (!input.fs.trim()) return 'Remote (fs) is required';

	const baseUrl = (input.baseUrl ?? DEFAULT_RCLONE_BASE_URL).trim() || DEFAULT_RCLONE_BASE_URL;
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
		normalizeRootPath(input.rootPath);
	} catch {
		return 'Root path must not contain .. segments';
	}

	if (input.requireRcPass !== false && !(input.rcPass ?? '').trim()) {
		return 'RC password is required';
	}

	return null;
}
