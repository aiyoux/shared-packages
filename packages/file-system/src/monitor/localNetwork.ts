/**
 * Local Network Access helpers for monitor requests.
 *
 * An HTTPS page reaching `127.0.0.1` (e.g. through an SSH tunnel) is a
 * public -> loopback request. Chrome 142+ gates these behind the Local Network
 * Access permission, and without an explicit annotation each one logs:
 *
 *   "site requested a resource from a network that it could only access
 *    because of its users' privileged network position"
 *
 * `targetAddressSpace` declares the intent up front, so the browser resolves
 * address space before DNS and asks the user once instead of warning per
 * request.
 *
 * It is a `fetch` option, with no `EventSource` or `WebSocket` equivalent —
 * which is why the watch stream is SSE consumed via `fetch` rather than either
 * of those. Every local-network call the app makes is then a `fetch` covered by
 * a single permission grant.
 *
 * **`loopback` and `local` are different address spaces.** `loopback` is
 * 127.0.0.0/8, ::1 and `localhost`; `local` is the local network (RFC1918,
 * `.local`). Declaring the wrong one is worse than declaring nothing — the
 * request fails outright with "Request had a target IP address space of `local`
 * yet the resource is in address space `loopback`". The WICG explainer's
 * example uses `local` because its target is `http://router.local`, not
 * loopback; monitor over an SSH tunnel needs `loopback`.
 */

/** Address spaces recognised by the Local Network Access check. */
export type TargetAddressSpace = 'loopback' | 'local' | 'public';

/** `RequestInit` plus the LNA option, which is not yet in the DOM lib types. */
type AddressSpaceRequestInit = RequestInit & { targetAddressSpace?: TargetAddressSpace };

/**
 * The address space `url` resolves into, or `null` when it is public (or
 * unparseable) and must not be annotated.
 *
 * Deliberately narrow: annotating a host that resolves elsewhere makes the
 * request *fail*, so anything not provably loopback-or-local is left alone.
 */
export function addressSpaceFor(url: string): Exclude<TargetAddressSpace, 'public'> | null {
	let hostname: string;
	try {
		hostname = new URL(url).hostname;
	} catch {
		return null;
	}
	// URL keeps IPv6 literals bracketed.
	const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();

	if (host === 'localhost' || host.endsWith('.localhost')) return 'loopback';
	if (host === '::1') return 'loopback';
	if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return 'loopback';

	// mDNS names resolve onto the local network, not loopback.
	if (host.endsWith('.local')) return 'local';

	// RFC1918 literals are the local network too.
	if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return 'local';
	if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(host)) return 'local';
	if (/^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(host)) return 'local';

	return null;
}

/** True when `url` targets loopback specifically (127.0.0.0/8, ::1, localhost). */
export function isLoopbackUrl(url: string): boolean {
	return addressSpaceFor(url) === 'loopback';
}

/**
 * Annotate `init` with the address space `url` resolves into, so the browser
 * can apply the Local Network Access permission instead of warning per request.
 * Public targets are returned untouched. Browsers that don't implement the
 * option ignore the extra key.
 */
export function withLocalAddressSpace(url: string, init: RequestInit = {}): RequestInit {
	const space = addressSpaceFor(url);
	if (!space) return init;
	// Assigned through the widened type: a literal would trip the excess-property
	// check against `RequestInit`, which does not yet declare this option.
	const annotated: AddressSpaceRequestInit = { ...init, targetAddressSpace: space };
	return annotated;
}
