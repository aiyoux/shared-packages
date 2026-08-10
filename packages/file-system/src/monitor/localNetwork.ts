/**
 * Local Network Access helpers for monitor requests.
 *
 * An HTTPS page reaching `127.0.0.1` (e.g. through an SSH tunnel) is a
 * public -> local request. Chrome 142+ gates these behind the Local Network
 * Access permission, and without an explicit annotation each one logs:
 *
 *   "site requested a resource from a network that it could only access
 *    because of its users' privileged network position"
 *
 * `targetAddressSpace: 'local'` declares the intent up front, so the browser
 * resolves address space before DNS and asks the user once instead of warning
 * per request.
 *
 * It is a `fetch` option, with no `EventSource` or `WebSocket` equivalent —
 * which is why the watch stream is SSE consumed via `fetch` rather than either
 * of those. Every local-network call the app makes is then a `fetch` covered by
 * a single permission grant.
 */

/** `RequestInit` plus the LNA option, which is not yet in the DOM lib types. */
type LocalRequestInit = RequestInit & { targetAddressSpace?: 'local' | 'private' | 'public' };

/**
 * True when `url` points at loopback (or a `.local` name).
 *
 * Deliberately narrow: declaring `targetAddressSpace: 'local'` for a host that
 * resolves to a public address makes the request *fail*, so a profile pointed
 * at a real hostname must not be annotated. RFC1918 ranges are left out too —
 * they are a different address space, and annotating them wrongly would break
 * the same way.
 */
export function isLoopbackUrl(url: string): boolean {
	let hostname: string;
	try {
		hostname = new URL(url).hostname;
	} catch {
		return false;
	}
	// URL keeps IPv6 literals bracketed.
	const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
	if (host === 'localhost' || host.endsWith('.localhost')) return true;
	if (host === '::1') return true;
	if (host.endsWith('.local')) return true;
	return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/**
 * Annotate `init` for the Local Network Access permission when `url` is
 * loopback. Browsers that don't implement the option ignore the extra key, so
 * this is safe to apply unconditionally for loopback targets.
 */
export function withLocalAddressSpace(url: string, init: RequestInit = {}): RequestInit {
	if (!isLoopbackUrl(url)) return init;
	// Assigned through the widened type: a literal would trip the excess-property
	// check against `RequestInit`, which does not yet declare this option.
	const annotated: LocalRequestInit = { ...init, targetAddressSpace: 'local' };
	return annotated;
}
