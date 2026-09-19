/**
 * Local cycle prevention for live binds: a total order on documents.
 *
 * A directed graph whose every live edge strictly descends a total order
 * cannot contain a cycle. Rank is `(createdAt, docId)` — both must be the
 * same on every peer with no coordination, so the check is purely local.
 *
 * Prerequisite: pass fields that travel in the file. VFS node `createdAt`
 * and node ids are per-device and must not be used as rank across collab
 * peers. This module does not read the VFS.
 *
 * Only `live` is constrained. `snapshot`, `clone`, and `gitPin` are not
 * this helper's problem — they are not resolution edges.
 */

export type DocRank = { createdAt: number; docId: string };

/** Negative if a < b, 0 if equal, positive if a > b. createdAt first, then docId. */
export function compareDocRank(a: DocRank, b: DocRank): number {
	if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
	if (a.docId !== b.docId) return a.docId < b.docId ? -1 : 1;
	return 0;
}

/**
 * A live bind from `from` to `to` is allowed only when rank(from) > rank(to).
 * Equal ranks refuse (would be a self-loop class).
 */
export function liveBindAllowed(from: DocRank, to: DocRank): boolean {
	return compareDocRank(from, to) > 0;
}
