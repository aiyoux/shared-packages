/**
 * The ONE place live-document lock and channel names are derived.
 *
 * All names are returned together, from a single call, on purpose. If two code
 * paths derive them independently they can silently disagree — and a mismatched
 * lock name does not fail loudly, it means *no tab ever claims leadership* and
 * nothing syncs, while every test that asserts on state the acting tab wrote
 * itself keeps passing. That exact bug (a composite key compared against a bare
 * one) cost the modular-app project a silent live-sync outage; see M20 in
 * `docs/design/live-documents.md` in the scratch-pad repo.
 *
 * Web Lock names and BroadcastChannel names are separate namespaces, so the
 * suffixes are for debuggability rather than collision-avoidance. persistLockName
 * must still differ from lockName: both are Web Locks, and a collision would
 * make persist-owner election steal sequencing leadership (or vice versa).
 */

const LIVE_DOC_PREFIX = 'vfs-live-doc';

export type LiveDocNames = {
	/** Web Locks name — whoever holds it is the leader for this document. */
	readonly lockName: string;
	/** BroadcastChannel name carrying this document's frames. */
	readonly channelName: string;
	/**
	 * Persist lock is who writes VFS; sequencing may live elsewhere (SharedWorker).
	 * Must not equal lockName or channelName.
	 */
	readonly persistLockName: string;
};

/**
 * Derive lock, persist-lock, and channel names for a document. Throws on an
 * empty id rather than returning a name that would quietly pair every id-less
 * caller together — a loud failure here is the whole point of funnelling
 * through one function.
 */
export function liveDocNames(nodeId: string): LiveDocNames {
	const id = nodeId?.trim();
	if (!id) throw new Error('liveDocNames: nodeId is required');
	return {
		lockName: `${LIVE_DOC_PREFIX}:${id}:lock`,
		channelName: `${LIVE_DOC_PREFIX}:${id}:bus`,
		persistLockName: `${LIVE_DOC_PREFIX}:${id}:persist`
	};
}
