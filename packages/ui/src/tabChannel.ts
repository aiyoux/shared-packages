/**
 * Cross-tab ping over BroadcastChannel.
 *
 * The one implementation: `@shared-packages/file-system`'s `crossTab.ts` is
 * only channel names on top of this. Two things are easy to get wrong here,
 * and both were live in the copies this replaces:
 *
 * 1. BroadcastChannel suppresses delivery only to the *object that posted*,
 *    not to the posting document. A helper that constructs a fresh channel per
 *    call therefore does deliver to that same document's subscribers. Every
 *    message carries an ORIGIN tag so subscribers can drop their own.
 *
 * 2. A channel constructed per call is never closed. On a hot path — one ping
 *    per completed transfer piece — that leaks thousands of channels. Poster
 *    channels are created once per name and reused.
 *
 * Plain TS on purpose: imported from stores and IDB modules that are not
 * compiled with the Svelte plugin, so reach it at `@shared-packages/ui/tabChannel`
 * rather than through the package barrel.
 */

/** Identifies this browsing context for the lifetime of the document. */
const ORIGIN = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

type Ping = { t: number; origin: string };

const posters = new Map<string, BroadcastChannel>();

/** Node keeps its event loop alive for an open channel; tests would never exit. */
function unref(ch: BroadcastChannel): BroadcastChannel {
	(ch as BroadcastChannel & { unref?: () => void }).unref?.();
	return ch;
}

function poster(name: string): BroadcastChannel | null {
	const existing = posters.get(name);
	if (existing) return existing;
	try {
		const ch = unref(new BroadcastChannel(name));
		posters.set(name, ch);
		return ch;
	} catch {
		return null;
	}
}

/** Tell other tabs that `name` changed. Never fires this tab's subscribers. */
export function notifyTabChannel(name: string): void {
	try {
		poster(name)?.postMessage({ t: Date.now(), origin: ORIGIN } satisfies Ping);
	} catch {
		/* a closed or unavailable channel must not break the caller */
	}
}

/**
 * Run `fn` when a tab pings `name`. Returns an unsubscribe function.
 *
 * By default only OTHER tabs count: a tab that already reloaded after its own
 * save must not reload again, and that same-tab echo once raced a persist and
 * wiped in-memory writes. `includeThisTab` is for a listener that is not the
 * writer — a panel in the same tab as a form that saved — and needs to hear it.
 */
export function subscribeTabChannel(
	name: string,
	fn: () => void,
	opts?: { includeThisTab?: boolean }
): () => void {
	let ch: BroadcastChannel;
	try {
		ch = unref(new BroadcastChannel(name));
	} catch {
		return () => {};
	}
	const includeThisTab = opts?.includeThisTab === true;
	const on = (e: MessageEvent) => {
		const data = e.data as Partial<Ping> | null;
		if (!includeThisTab && data && typeof data === 'object' && data.origin === ORIGIN) return;
		fn();
	};
	ch.addEventListener('message', on);
	return () => {
		ch.removeEventListener('message', on);
		ch.close();
	};
}

/** Test seam: drop cached poster channels. */
export function __resetTabChannels(): void {
	for (const ch of posters.values()) {
		try {
			ch.close();
		} catch {
			/* already closed */
		}
	}
	posters.clear();
}
