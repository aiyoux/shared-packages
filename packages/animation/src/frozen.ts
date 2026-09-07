/**
 * What "frozen" means, and how to get there.
 *
 * A `clone` or `snapshot` bind is supposed to be a cycle-breaker: it holds
 * bytes, not a pointer. That is true only while the thing being frozen is a
 * *leaf* — a PNG, a sound. Freeze a document that itself binds, and the bytes
 * you stored are full of `source` pointers: the cycle survives, laundered
 * through a data URL where no graph walk will look (see
 * `docs/design/live-reference-cycles.md`, F3/F5).
 *
 * So the property has to be transitive, and it has to be checkable:
 *
 *   **A frozen subtree contains no `source` anywhere.**
 *
 * `assertFrozen` is that check and is the merge condition for binding any
 * document as a clip. `freezeDocument` is how a document gets there.
 *
 * Pure: no VFS, no DOM. The caller supplies the resolver.
 */

import type { AnimClip, AnimClipSnapshot, AnimDocument } from './types.js';
import { isBoundClip } from './types.js';
import { refKey } from './refs.js';
import { DEFAULT_MAX_DEPTH, enter, rootContext, type ResolveContext } from './resolveContext.js';

const GITPIN_PREFIX = 'gitpin:';

/**
 * Whether a snapshot's bytes are actually pinned to something immutable.
 *
 * A `gitpin:` ref without `atCommit` can only be read at HEAD, which follows a
 * moving branch — `live` behaviour wearing a `gitPin` label. The bind side
 * refuses to write that form and the read side refuses to follow it (W10), so
 * this is the predicate that states the rule rather than leaving it implied at
 * two call sites.
 */
export function isFrozenSnapshot(snapshot: AnimClipSnapshot | undefined): boolean {
	if (!snapshot) return false;
	if (!snapshot.bytesRef.startsWith(GITPIN_PREFIX)) return true;
	return typeof snapshot.atCommit === 'string' && snapshot.atCommit.length > 0;
}

export type FrozenViolation = {
	clipId: string;
	reason: 'has-source' | 'unpinned-snapshot' | 'no-bytes';
};

/**
 * Every reason a document is not fully frozen. Empty means it is.
 *
 * Returns a list rather than throwing: a caller reporting to a user wants all
 * of them, and a caller gating a merge only needs `.length`.
 */
export function frozenViolations(doc: AnimDocument): FrozenViolation[] {
	const out: FrozenViolation[] = [];
	for (const clip of doc.clips) {
		if (isBoundClip(clip)) {
			out.push({ clipId: clip.id, reason: 'has-source' });
			continue;
		}
		if (!clip.snapshot) {
			out.push({ clipId: clip.id, reason: 'no-bytes' });
			continue;
		}
		if (!isFrozenSnapshot(clip.snapshot)) {
			out.push({ clipId: clip.id, reason: 'unpinned-snapshot' });
		}
	}
	return out;
}

/** True when nothing in `doc` points at another document. */
export function isFrozen(doc: AnimDocument): boolean {
	return frozenViolations(doc).length === 0;
}

export class NotFrozenError extends Error {
	readonly violations: FrozenViolation[];
	constructor(violations: FrozenViolation[]) {
		super(
			`Document is not frozen: ${violations
				.map((v) => `${v.clipId} (${v.reason})`)
				.join(', ')}`
		);
		this.name = 'NotFrozenError';
		this.violations = violations;
	}
}

/**
 * Throw unless `doc` is transitively frozen.
 *
 * This is a gate, not a render-path check — it runs when a document is about to
 * be embedded, where throwing is the correct response. Never call it from a
 * play loop; use the resolve context there (I6).
 */
export function assertFrozen(doc: AnimDocument): void {
	const violations = frozenViolations(doc);
	if (violations.length) throw new NotFrozenError(violations);
}

/** Resolve one clip's current bytes as a `data:` URL, or null if unavailable. */
export type BytesResolver = (clip: AnimClip) => Promise<string | null> | string | null;

/** Load a referenced document so its own clips can be frozen in turn. */
export type DocResolver = (key: string) => Promise<AnimDocument | null> | AnimDocument | null;

export type FreezeBudget = {
	maxDepth?: number;
	/** Total `bytesRef` characters allowed. Refuses past it rather than emitting. */
	maxBytesRefChars?: number;
};

/**
 * Deep-freezing a tree of page rasters as base64 `data:` URLs is how a document
 * reaches tens of megabytes — `live-documents.md` already treats base64
 * `bytesRef` as a broadcast hazard. The cap exists so that is a refusal with a
 * reason, not a silent monster.
 */
export const DEFAULT_MAX_BYTES_REF_CHARS = 32 * 1024 * 1024;

export type FreezeResult =
	| { kind: 'frozen'; doc: AnimDocument; bytesRefChars: number }
	| { kind: 'cyclic'; path: readonly string[] }
	| { kind: 'too-deep'; depth: number }
	| { kind: 'too-large'; bytesRefChars: number; limit: number }
	| { kind: 'unresolved'; clipId: string };

/**
 * Produce a transitively frozen copy of `doc`.
 *
 * Eager by necessity: the VFS has no historical read (`readBytes` takes an id
 * only) and a live link's `generation` records drift without being able to
 * retrieve it, so "freeze now, resolve later" is not available (F6). Every
 * descendant is resolved to real bytes here or the freeze fails.
 *
 * Returns a result on every path. A freeze is a user-initiated action, so the
 * caller wants to explain the refusal, not catch an exception.
 */
export async function freezeDocument(
	doc: AnimDocument,
	selfKey: string,
	resolvers: { bytes: BytesResolver; doc?: DocResolver },
	budget: FreezeBudget = {}
): Promise<FreezeResult> {
	const maxDepth = budget.maxDepth ?? DEFAULT_MAX_DEPTH;
	const limit = budget.maxBytesRefChars ?? DEFAULT_MAX_BYTES_REF_CHARS;
	let chars = 0;

	async function freeze(
		current: AnimDocument,
		ctx: ResolveContext
	): Promise<FreezeResult> {
		const clips: AnimClip[] = [];
		for (const clip of current.clips) {
			if (!isBoundClip(clip)) {
				// Already frozen, or frozen-but-unpinned; either way it carries no
				// pointer to follow. An unpinned gitPin still needs its bytes.
				if (isFrozenSnapshot(clip.snapshot)) {
					chars += clip.snapshot?.bytesRef.length ?? 0;
					if (chars > limit) return { kind: 'too-large', bytesRefChars: chars, limit };
					clips.push(clip);
					continue;
				}
			}

			// Descending is what could recurse, so it is gated even when the
			// referenced document turns out to be a leaf.
			if (isBoundClip(clip)) {
				const step = enter(ctx, refKey(clip.source));
				if (step.kind === 'cyclic') return { kind: 'cyclic', path: step.path };
				if (step.kind === 'too-deep') return { kind: 'too-deep', depth: step.depth };
				const nested = await resolvers.doc?.(refKey(clip.source));
				if (nested) {
					const inner = await freeze(nested, step.ctx);
					if (inner.kind !== 'frozen') return inner;
				}
			}

			const bytesRef = await resolvers.bytes(clip);
			if (!bytesRef) return { kind: 'unresolved', clipId: clip.id };
			chars += bytesRef.length;
			if (chars > limit) return { kind: 'too-large', bytesRefChars: chars, limit };

			const { ...rest } = clip;
			delete (rest as { source?: unknown }).source;
			clips.push({ ...rest, bind: 'clone', snapshot: { bytesRef } } as AnimClip);
		}
		return { kind: 'frozen', doc: { ...current, clips }, bytesRefChars: chars };
	}

	const result = await freeze(doc, rootContext(selfKey, maxDepth));
	// The contract is the contract: never hand back something that fails the
	// gate it exists to satisfy.
	if (result.kind === 'frozen') assertFrozen(result.doc);
	return result;
}
