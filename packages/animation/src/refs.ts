/**
 * The document reference graph — who points at whom.
 *
 * An `.anim` document is a document made of pointers: its clips carry a
 * `DocSource` naming another file. When something the graph reaches points
 * back, resolving it can recurse forever. See scratch-pad
 * `docs/design/live-reference-cycles.md` for the failure modes; this module is
 * W1 and W3 of that plan and is the single place the graph is derived, so the
 * guards built on it cannot drift apart.
 *
 * Pure: no VFS, no DOM. Callers supply the loader.
 */

import type { AnimDocument, BindMode, DocSource, FsBackend } from './types.js';
import { isBoundClip } from './types.js';

/** One outbound edge: a clip in some document referencing another file. */
export type DocRef = {
	/** Stable identity for the referenced file, comparable across documents. */
	key: string;
	backend: FsBackend;
	/** The mode carrying the edge. Only `live` re-reads its source over time. */
	bind: Exclude<BindMode, 'clone'>;
	clipId: string;
};

/**
 * Collapse the spellings of one path so two of them cannot become two keys.
 *
 * A monitor source is identified by its path, so `a/b.png`, `./a/b.png` and
 * `a//x/../b.png` used to produce three different keys for one file — and a
 * cycle through any of those aliases was invisible to `findCycle`, because
 * nothing matched. Purely syntactic: resolving symlinks or case-insensitive
 * filesystems needs the daemon, and this runs nowhere near it.
 */
export function normalizeRelPath(relPath: string): string {
	const segments = relPath.split('/');
	const out: string[] = [];
	for (const segment of segments) {
		if (segment === '' || segment === '.') continue;
		if (segment === '..') {
			// A leading `..` has nothing to pop and must be kept, or the path
			// would silently come to mean somewhere else.
			if (out.length && out[out.length - 1] !== '..') out.pop();
			else out.push(segment);
			continue;
		}
		out.push(segment);
	}
	const joined = out.join('/');
	return relPath.startsWith('/') ? `/${joined}` : joined;
}

/**
 * Identity for a clip source, stable across documents and backends.
 *
 * Monitor sources have no node id, so the profile and path together stand in.
 * Treat the result as opaque: `vfsNodeIdFromKey` below is the only sanctioned
 * inverse, and it exists because a loader has to turn a key back into
 * something it can read. Do not add more.
 */
export function refKey(source: DocSource): string {
	switch (source.backend) {
		case 'shared-vfs':
			return `vfs:${source.nodeId}`;
		case 'monitor':
			return `mon:${source.profileId}:${normalizeRelPath(source.relPath)}`;
		default: {
			// Exhaustiveness, on purpose: a new backend must be given an identity
			// here or the build breaks. Falling through to one of the arms above
			// would silently hand two different files the same key, which does not
			// fail — it makes cycle detection quietly wrong.
			const never: never = source;
			throw new Error(`refKey: unhandled backend ${JSON.stringify(never)}`);
		}
	}
}

/** Prefix for `shared-vfs` keys. */
const VFS_PREFIX = 'vfs:';

/** Build a walk key for a VFS node without constructing a `DocSource`. */
export function vfsRefKey(nodeId: string): string {
	return `${VFS_PREFIX}${nodeId}`;
}

/**
 * The node id inside a `shared-vfs` key, or null for any other backend.
 *
 * Null means "this loader cannot read that", which a caller should turn into
 * `load.unknown()` — not `load.leaf()`. A monitor file may well be a document.
 */
export function vfsNodeIdFromKey(key: string): string | null {
	return key.startsWith(VFS_PREFIX) ? key.slice(VFS_PREFIX.length) : null;
}

/**
 * Every outbound reference in a document.
 *
 * `clone` clips are absent because the union gives them no `source` at all —
 * which is exactly why a *cloned document* is invisible here (F5). A clone is
 * safe only when it is transitively frozen; that is `assertFrozen`'s job, not
 * this function's, and the two are meant to be used together.
 *
 * `gitPin` edges are reported but do not traverse (see `traverses`): a pinned
 * clip reads the git blob at `atCommit`, never the live source node.
 */
export function documentRefs(doc: AnimDocument): DocRef[] {
	const out: DocRef[] = [];
	for (const clip of doc.clips) {
		if (!isBoundClip(clip)) continue;
		out.push({
			key: refKey(clip.source),
			backend: clip.source.backend,
			bind: clip.bind,
			clipId: clip.id
		});
	}
	return out;
}

/**
 * Whether an edge re-reads its target, and so can carry a cycle.
 *
 * `live` follows its source forever. `snapshot` holds bytes. `gitPin` holds an
 * immutable commit — but only once `atCommit` is actually set; an unpinned
 * `gitpin:` ref resolves at HEAD, which is a live edge wearing a `gitPin`
 * label. The bind side refuses to write that form (W10.1) and the read side
 * refuses to follow it (W10.2), so by the time a document is on disk `gitPin`
 * is inert here.
 */
export function traverses(ref: DocRef): boolean {
	return ref.bind === 'live';
}

/** Refs that can actually carry a cycle. The DAG rule (I1) applies to these. */
export function liveRefs(doc: AnimDocument): DocRef[] {
	return documentRefs(doc).filter(traverses);
}

/**
 * What a loader knows about one file.
 *
 * The distinction between `leaf` and `unknown` is the whole point. An earlier
 * contract collapsed them into `null`, which meant a document type nobody had
 * taught the walker about was indistinguishable from a PNG — and the walk then
 * reported `none`, i.e. **proven acyclic**, for a file that might reference
 * anything. New apps would have joined the system pre-broken and silently.
 * Anything unrecognised now fails the walk closed.
 */
export type RefLoad =
	/** The file's outbound edges. An empty array means genuinely none. */
	| { kind: 'refs'; refs: DocRef[] }
	/** Known to hold no references by nature — an image, a video, a sound. */
	| { kind: 'leaf' }
	/**
	 * No extractor is registered for this file's type. NOT `leaf`: the file may
	 * reference others and nothing here can tell.
	 */
	| { kind: 'unknown'; fileType?: string };

/** Outbound edges for a file, by identity key. */
export type RefLoader = (key: string) => Promise<RefLoad> | RefLoad;

/** `RefLoad` constructors, so call sites stay short. */
export const load = {
	refs: (refs: DocRef[]): RefLoad => ({ kind: 'refs', refs }),
	leaf: (): RefLoad => ({ kind: 'leaf' }),
	unknown: (fileType?: string): RefLoad => ({ kind: 'unknown', ...(fileType ? { fileType } : {}) })
};

export type WalkBudget = {
	/** Distinct files the walk may visit. */
	maxNodes?: number;
	/** Longest path followed from the start. */
	maxDepth?: number;
};

export type CycleResult =
	/** Proven acyclic: every reachable file was understood and none looped. */
	| { kind: 'none' }
	/** A cycle. `path` starts and ends on the repeated key. */
	| { kind: 'cycle'; path: string[] }
	/**
	 * Budget spent before the walk finished — the answer is unknown, NOT "no".
	 * Callers must treat this as "cannot prove safe" and lean on the
	 * render-time guards (I7).
	 */
	| { kind: 'budget'; visited: number }
	/**
	 * The walk reached a file type no extractor understands. Also "cannot prove
	 * safe" — this is what a future app looks like before anyone registers it.
	 */
	| { kind: 'unknown'; key: string; fileType?: string };

/** Whether a result proves the absence of a cycle. Only `none` does. */
export function isProvenAcyclic(result: CycleResult): boolean {
	return result.kind === 'none';
}

const DEFAULT_BUDGET = { maxNodes: 64, maxDepth: 8 } as const;

/**
 * Depth-first search for a cycle reachable from `start`.
 *
 * Iterative on purpose: a recursive cycle detector that overflows the stack on
 * a cyclic graph is the bug it exists to prevent. `seen` is likewise not
 * optional — the walker traverses the same graph it is looking for loops in.
 */
export async function findCycle(
	start: string,
	loadRefs: RefLoader,
	budget: WalkBudget = {}
): Promise<CycleResult> {
	const maxNodes = budget.maxNodes ?? DEFAULT_BUDGET.maxNodes;
	const maxDepth = budget.maxDepth ?? DEFAULT_BUDGET.maxDepth;

	/** Fully explored — cannot reach a cycle, no need to revisit. */
	const done = new Set<string>();
	/** The current path, in order; membership is the back-edge test. */
	const path: string[] = [];
	const onPath = new Set<string>();
	let visited = 0;

	/** First unrecognised file seen. A cycle is a stronger answer, so the walk
	 *  continues and this is only reported if nothing looped. */
	let unknownAt: { key: string; fileType?: string } | null = null;

	type Frame = { key: string; refs: DocRef[] | null; next: number };
	const stack: Frame[] = [{ key: start, refs: null, next: 0 }];

	while (stack.length) {
		const frame = stack[stack.length - 1]!;

		if (frame.refs === null) {
			if (onPath.has(frame.key)) {
				const from = path.indexOf(frame.key);
				return { kind: 'cycle', path: [...path.slice(from), frame.key] };
			}
			if (done.has(frame.key)) {
				stack.pop();
				continue;
			}
			if (visited >= maxNodes) return { kind: 'budget', visited };
			visited += 1;
			path.push(frame.key);
			onPath.add(frame.key);
			if (path.length > maxDepth) {
				frame.refs = [];
				continue;
			}
			const loaded = await loadRefs(frame.key);
			if (loaded.kind === 'unknown' && !unknownAt) {
				unknownAt = { key: frame.key, ...(loaded.fileType ? { fileType: loaded.fileType } : {}) };
			}
			frame.refs = loaded.kind === 'refs' ? loaded.refs : [];
			continue;
		}

		const ref = frame.refs[frame.next];
		if (!ref) {
			path.pop();
			onPath.delete(frame.key);
			done.add(frame.key);
			stack.pop();
			continue;
		}
		frame.next += 1;
		if (!traverses(ref)) continue;
		stack.push({ key: ref.key, refs: null, next: 0 });
	}

	return unknownAt ? { kind: 'unknown', ...unknownAt } : { kind: 'none' };
}

/**
 * Would adding a `from → to` edge close a cycle?
 *
 * This is the bind-time question (W8), and it is asked *before* the edge
 * exists: an edge closes a cycle exactly when `to` already reaches `from`.
 *
 * A `none` here is not a safety guarantee. Half the real graph — a sketch's
 * timeline binding — lives in `sessionStorage` rather than in any file (F1),
 * and two tabs can each add one half of a cycle without either seeing it.
 * Refusing on `cycle` is good UX; correctness lives in the render-time guards.
 */
export async function wouldCycle(
	from: string,
	to: string,
	loadRefs: RefLoader,
	budget: WalkBudget = {}
): Promise<CycleResult> {
	if (from === to) return { kind: 'cycle', path: [from, to] };
	const found = await findCycle(to, loadRefs, budget);
	if (found.kind !== 'none') return found;
	const reached = await reaches(to, from, loadRefs, budget);
	switch (reached.kind) {
		case 'hit':
			return { kind: 'cycle', path: [from, ...reached.path] };
		case 'budget':
			return { kind: 'budget', visited: reached.visited };
		case 'unknown':
			return { kind: 'unknown', key: reached.key, ...(reached.fileType ? { fileType: reached.fileType } : {}) };
		default:
			return { kind: 'none' };
	}
}

type ReachResult =
	| { kind: 'hit'; path: string[] }
	| { kind: 'miss' }
	| { kind: 'budget'; visited: number }
	| { kind: 'unknown'; key: string; fileType?: string };

/** Breadth-first reachability with the same budget contract as `findCycle`. */
async function reaches(
	start: string,
	target: string,
	loadRefs: RefLoader,
	budget: WalkBudget
): Promise<ReachResult> {
	const maxNodes = budget.maxNodes ?? DEFAULT_BUDGET.maxNodes;
	const maxDepth = budget.maxDepth ?? DEFAULT_BUDGET.maxDepth;
	const seen = new Set<string>([start]);
	let frontier: Array<{ key: string; path: string[] }> = [{ key: start, path: [start] }];
	let visited = 0;
	let unknownAt: { key: string; fileType?: string } | null = null;

	for (let depth = 0; depth < maxDepth && frontier.length; depth += 1) {
		const next: Array<{ key: string; path: string[] }> = [];
		for (const node of frontier) {
			if (visited >= maxNodes) return { kind: 'budget', visited };
			visited += 1;
			const loaded = await loadRefs(node.key);
			if (loaded.kind === 'unknown' && !unknownAt) {
				unknownAt = { key: node.key, ...(loaded.fileType ? { fileType: loaded.fileType } : {}) };
			}
			const refs = loaded.kind === 'refs' ? loaded.refs : [];
			for (const ref of refs) {
				if (!traverses(ref)) continue;
				const path = [...node.path, ref.key];
				if (ref.key === target) return { kind: 'hit', path };
				if (seen.has(ref.key)) continue;
				seen.add(ref.key);
				next.push({ key: ref.key, path });
			}
		}
		frontier = next;
	}
	if (frontier.length) return { kind: 'budget', visited };
	return unknownAt ? { kind: 'unknown', ...unknownAt } : { kind: 'miss' };
}
