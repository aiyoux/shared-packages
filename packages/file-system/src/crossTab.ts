/**
 * Change pings for monitor / AI profile stores, the B2 connection list
 * (held by monitors) and the VFS itself, which Dexie liveQuery cannot observe.
 *
 * The channel names live here; the channel itself is `@shared-packages/ui`'s
 * `tabChannel`, the one implementation. The two ways to listen are named for
 * what they mean rather than for how BroadcastChannel happens to deliver:
 */
import {
	notifyTabChannel,
	subscribeTabChannel as subscribe
} from '@shared-packages/ui/tabChannel';

export { notifyTabChannel };

export const HUB_B2_PROFILES_CHANNEL = 'hub-b2-profiles';
export const HUB_MONITOR_PROFILES_CHANNEL = 'hub-monitor-profiles';
export const HUB_AI_PROFILES_CHANNEL = 'hub-ai-profiles';

/**
 * Hear every ping, this tab's included — for a listener that is not the
 * writer (the explorer, when a form in the same tab saved a profile).
 */
export function subscribeTabChannel(name: string, listener: () => void): () => void {
	return subscribe(name, listener, { includeThisTab: true });
}

/**
 * Hear other tabs only — for the writer itself, which already reloaded after
 * its own save; a same-tab echo used to race persist and wipe in-memory writes.
 */
export function subscribeOwnTabChannel(name: string, listener: () => void): () => void {
	return subscribe(name, listener);
}
