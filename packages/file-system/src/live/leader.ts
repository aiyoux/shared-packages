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
import { createWaitTracker, type WaitTracker } from './waits.js';

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
	const election = createElection(lockName ?? liveDocNames(nodeId).lockName, rest);
	return registered(nodeId, election);
}

/** This tab's live elections per document, so a person can take one over. */
const byNode = new Map<string, Set<Election>>();

function registered(nodeId: string, election: Election): Election {
	let set = byNode.get(nodeId);
	if (!set) byNode.set(nodeId, (set = new Set()));
	set.add(election);
	const destroy = election.destroy;
	election.destroy = () => {
		const cur = byNode.get(nodeId);
		cur?.delete(election);
		if (cur && !cur.size) byNode.delete(nodeId);
		destroy();
	};
	return election;
}

/**
 * Take a document over from a tab that is not answering: its sequencing and
 * its saving both, so the tab that takes over is also the one that saves.
 * Only for a person pressing a button (see `Election.takeOver`). The old tab
 * rejoins as a follower when it next runs.
 */
export function takeOverDocument(nodeId: string): void {
	for (const election of byNode.get(nodeId) ?? []) election.takeOver();
}

/**
 * Waits on the tab that sequences `nodeId`, reported under one notice whose
 * button calls `takeOverDocument`. A session begins a wait when it needs the
 * sequencer (the join snapshot, an edit to be ordered) and ends it on any
 * sign the sequencer is running.
 */
export function createDocumentWait(nodeId: string, what: string): WaitTracker {
	return createWaitTracker(
		`live-doc:${nodeId}`,
		() => ({
			what,
			detail:
				'The tab coordinating this document has not answered. It may be busy, or frozen in the background.',
			takeOver: () => takeOverDocument(nodeId)
		}),
		{ enabled: () => typeof window !== 'undefined' }
	);
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
	opts?: Omit<LeaderElectionOpts, 'lockName' | 'yieldWhenHidden'> & {
		/**
		 * Write this tab's unsaved edits before the role moves on (a hidden
		 * tab yielding, an ordinary close). Awaited before the lock is let go,
		 * so the next owner starts from a file that already holds them, and
		 * this tab is clean rather than holding edits another tab now saves.
		 */
		beforeHandover?: () => Promise<void> | void;
	}
): LeaderElection {
	const { beforeHandover, ...rest } = opts ?? {};
	const nodeLock = liveDocNames(nodeId).persistLockName;
	const election = createElection(nodeLock, {
		...rest,
		teardown: beforeHandover,
		yieldWhenHidden: true
	});
	return registered(nodeId, election);
}
