/**
 * Best-effort BroadcastChannel for raw IndexedDB stores (rclone / B2 / monitor
 * profiles) that Dexie liveQuery cannot observe.
 *
 * Same-tab writers already reload after their own save; BroadcastChannel does
 * not echo to the posting instance, which is the intended split.
 */

export const HUB_RCLONE_PROFILES_CHANNEL = 'hub-rclone-profiles';
export const HUB_B2_PROFILES_CHANNEL = 'hub-b2-profiles';
export const HUB_MONITOR_PROFILES_CHANNEL = 'hub-monitor-profiles';
export const HUB_VAULT_CHANNEL = 'hub-vault';

const notifyChannels = new Map<string, BroadcastChannel>();

function maybeUnref(ch: BroadcastChannel): void {
	const unref = (ch as BroadcastChannel & { unref?: () => void }).unref;
	if (typeof unref === 'function') unref.call(ch);
}

function openNotifyChannel(name: string): BroadcastChannel | null {
	try {
		if (typeof BroadcastChannel === 'undefined') return null;
		let ch = notifyChannels.get(name);
		if (!ch) {
			ch = new BroadcastChannel(name);
			maybeUnref(ch);
			notifyChannels.set(name, ch);
		}
		return ch;
	} catch {
		return null;
	}
}

export function notifyTabChannel(name: string): void {
	try {
		openNotifyChannel(name)?.postMessage({ t: Date.now() });
	} catch {
		/* missing API or closed channel */
	}
}

/**
 * Listen on the same BroadcastChannel instance used to post, so this tab
 * does not re-query from its own notify (a same-tab echo used to race persist
 * and wipe in-memory writes).
 */
export function subscribeOwnTabChannel(name: string, listener: () => void): () => void {
	try {
		const ch = openNotifyChannel(name);
		if (!ch) return () => {};
		const onMsg = () => {
			try {
				listener();
			} catch {
				/* a stale subscriber must not break others */
			}
		};
		ch.addEventListener('message', onMsg);
		return () => {
			try {
				ch.removeEventListener('message', onMsg);
			} catch {
				/* ignore */
			}
		};
	} catch {
		return () => {};
	}
}

export function subscribeTabChannel(name: string, listener: () => void): () => void {
	try {
		if (typeof BroadcastChannel === 'undefined') return () => {};
		const ch = new BroadcastChannel(name);
		maybeUnref(ch);
		const onMsg = () => {
			try {
				listener();
			} catch {
				/* a stale subscriber must not break others */
			}
		};
		ch.addEventListener('message', onMsg);
		return () => {
			try {
				ch.removeEventListener('message', onMsg);
				ch.close();
			} catch {
				/* ignore */
			}
		};
	} catch {
		return () => {};
	}
}
