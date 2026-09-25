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
	/**
	 * False only until the lock has answered. The answer is exact and prompt
	 * (see `createElection`), so there is nothing to guess in the meantime.
	 */
	readonly decided: boolean;
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
 * Report leadership once the lock has answered, and every change after.
 *
 * Never guesses. A lone tab is momentarily undecided while its lock request is
 * in flight, and guessing "not leader" there turned its own autosave off — the
 * page rename Documents once lost. That used to be papered over with a grace
 * timer, which a page busy for longer than the grace still lost to. The
 * election now answers "not leader" exactly, from the lock, so this just waits
 * for that answer.
 */
export function watchLeadership(
	election: Election,
	onLead: (isLeader: boolean) => void
): () => void {
	let last: boolean | null = null;
	let stopped = false;

	function report(): void {
		if (stopped || !election.decided) return;
		const isLeader = election.isLeader;
		if (isLeader === last) return;
		last = isLeader;
		onLead(isLeader);
	}

	const off = election.onChange(report);
	report();

	return () => {
		stopped = true;
		off();
	};
}
