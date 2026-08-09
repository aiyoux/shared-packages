/**
 * B2 control-plane vs data-plane host classification.
 *
 * Backblaze does **not** support CORS for most native API calls (authorize,
 * list, get_upload_url, delete, copy, …). Those hit `api*.backblazeb2.com` and
 * must be relayed same-origin via the hub Worker.
 *
 * Upload pods (`*.backblaze.com`) and download hosts (`f*.backblazeb2.com`)
 * support browser CORS when the bucket rule allows it — those stay direct.
 */

/** Hostnames that only host B2 control-plane APIs (no object bytes). */
export function isB2ControlPlaneHostname(hostname: string): boolean {
	const h = hostname.toLowerCase();
	// Realm entry: https://api.backblazeb2.com/b2api/v4/b2_authorize_account
	if (h === 'api.backblazeb2.com') return true;
	// Post-authorize storage API: https://api001.backblazeb2.com/…
	if (/^api\d+\.backblazeb2\.com$/.test(h)) return true;
	return false;
}

/**
 * True when the URL must go through the hub proxy (no browser CORS on B2).
 */
export function isB2ControlPlaneUrl(rawUrl: string): boolean {
	let u: URL;
	try {
		u = new URL(rawUrl);
	} catch {
		return false;
	}
	if (u.protocol !== 'https:') return false;
	if (u.username || u.password) return false;
	return isB2ControlPlaneHostname(u.hostname);
}

/**
 * Parse + validate a control-plane target for the Worker proxy (SSRF guard).
 * @throws Error when the URL is not an allowed B2 control-plane HTTPS URL.
 */
export function assertB2ControlPlaneUrl(rawUrl: string): URL {
	let u: URL;
	try {
		u = new URL(rawUrl);
	} catch {
		throw new Error('Invalid B2 target URL');
	}
	if (u.protocol !== 'https:') {
		throw new Error('B2 proxy only allows https URLs');
	}
	if (u.username || u.password) {
		throw new Error('B2 proxy rejects URLs with userinfo');
	}
	// Block literal IPs
	if (/^\d{1,3}(\.\d{1,3}){3}$/.test(u.hostname) || u.hostname.includes(':')) {
		throw new Error('B2 proxy rejects IP hosts');
	}
	if (!isB2ControlPlaneHostname(u.hostname)) {
		throw new Error(
			`B2 proxy only allows control-plane hosts (api*.backblazeb2.com), not ${u.hostname}`
		);
	}
	return u;
}

/** Hosts allowed for direct browser data-plane calls (upload/download). */
export function isB2DataPlaneHostname(hostname: string): boolean {
	const h = hostname.toLowerCase();
	// Download: f000.backblazeb2.com, s3 endpoints if ever used
	if (h === 'backblazeb2.com' || h.endsWith('.backblazeb2.com')) {
		// Exclude control plane
		return !isB2ControlPlaneHostname(h);
	}
	// Upload pods: pod-000-1000-00.backblaze.com
	if (h === 'backblaze.com' || h.endsWith('.backblaze.com')) return true;
	return false;
}

export function isB2DataPlaneUrl(rawUrl: string): boolean {
	let u: URL;
	try {
		u = new URL(rawUrl);
	} catch {
		return false;
	}
	if (u.protocol !== 'https:') return false;
	if (u.username || u.password) return false;
	return isB2DataPlaneHostname(u.hostname);
}
