/**
 * Which context speaks for a document, and which one writes it.
 *
 * Two SEPARATE locks, always. Collapsing them makes persist election steal
 * sequencing leadership, and a mismatched name does not fail loudly — it means
 * nobody ever claims anything and nothing syncs.
 *
 * The election itself is injected rather than imported: this package does not
 * depend on `@shared-packages/file-system`, and the structural type below is
 * what `createLeaderElection` already returns.
 */

export type Election = {
	readonly isLeader: boolean;
	onChange(fn: () => void): () => void;
	yieldLeadership(): void;
	destroy(): void;
};

export type Role = 'sequencer' | 'replica';

/**
 * Exported so the mapping is pinned by a test rather than buried in
 * construction: a role that resolves wrong means two sequencers or none, and
 * neither fails loudly.
 */
export function roleForLeadership(isLeader: boolean): Role {
	return isLeader ? 'sequencer' : 'replica';
}

/**
 * How long to wait for a lock before concluding somebody else holds it.
 *
 * An uncontended lock is granted within a task, so this only ever elapses when
 * another context really is leading.
 */
export const LEADERSHIP_GRACE_MS = 250;

/**
 * Report leadership, never guessing "not leader" before the lock resolves.
 *
 * The grant is asynchronous, so a lone tab is momentarily not-yet-leader.
 * Guessing there is not a harmless early guess: the answer decides who owns
 * persistence, so a single tab would briefly turn its own autosave off and
 * silently drop any write landing in that window. Documents lost a page rename
 * that way, which is how the grace period came to exist.
 *
 * Fires immediately with the current answer, and again whenever the lock moves.
 */
export function watchLeadership(
	election: Election,
	onLead: (isLeader: boolean) => void,
	graceMs: number = LEADERSHIP_GRACE_MS
): () => void {
	let last: boolean | null = null;
	let stopped = false;

	function report(isLeader: boolean): void {
		if (stopped || isLeader === last) return;
		last = isLeader;
		onLead(isLeader);
	}

	const off = election.onChange(() => {
		if (election.isLeader) report(true);
		else if (last !== null) report(false); // a real demotion, e.g. a yield
	});

	if (election.isLeader) report(true);
	const timer = setTimeout(() => {
		if (last === null) report(election.isLeader);
	}, graceMs);

	return () => {
		stopped = true;
		clearTimeout(timer);
		off();
	};
}
