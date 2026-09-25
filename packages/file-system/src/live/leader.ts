/**
 * Per-document leader election over the Web Locks API.
 *
 * One tab holds the lock for a given document and owns its state; every other
 * tab sits in the lock QUEUE. That queue is the entire failover mechanism: when
 * the holder's tab dies the browser hands the lock to the next waiter on its
 * own, so there is no heartbeat, no liveness timeout, and no re-election code
 * to get wrong. (M1 in `docs/design/live-documents.md`.)
 *
 * The mechanics live in `election.ts`, shared with the catalog worker and every
 * other cross-tab role; see `docs/design/tab-coordination.md` in scratch-pad.
 */

import { liveDocNames } from './names.js';
import { createElection, type Election, type ElectionOpts } from './election.js';

export { getTabId } from './election.js';

/**
 * A per-document election. Same object as `createElection` — the document id
 * only chooses the lock — so a document's sequencer, its saver and the catalog
 * all fail over, fence and take over the same way.
 */
export type LeaderElection = Election;

export type LeaderElectionOpts = Omit<ElectionOpts, 'prepare' | 'teardown' | 'abandon'> & {
	/** Defaults to liveDocNames(nodeId).lockName. Pass persistLockName for persist-only election. */
	lockName?: string;
};

export function createLeaderElection(nodeId: string, opts?: LeaderElectionOpts): LeaderElection {
	const { lockName, ...rest } = opts ?? {};
	return createElection(lockName ?? liveDocNames(nodeId).lockName, rest);
}

/**
 * Who saves a live document. A separate lock from sequencing (the two must not
 * steal each other), and it yields while hidden so the tab the person is
 * looking at is the one whose timers drive the save. Frozen tabs stand down in
 * `createElection` itself. Documents and Creative both use this — they each
 * had their own copy of it.
 */
export function createPersistElection(
	nodeId: string,
	opts?: Omit<LeaderElectionOpts, 'lockName' | 'yieldWhenHidden'>
): LeaderElection {
	return createLeaderElection(nodeId, {
		...opts,
		lockName: liveDocNames(nodeId).persistLockName,
		yieldWhenHidden: true
	});
}
