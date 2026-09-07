/**
 * The resolution stack — the render-time half of cycle safety.
 *
 * `findCycle` (`refs.ts`) refuses to *create* a cycle, but it walks files and
 * half the real graph is not in a file, so it can never be authoritative
 * (scratch-pad `docs/design/live-reference-cycles.md`, F1/I7). This module is
 * the guard that runs where references are actually followed, and it holds
 * whatever the bind-time check missed.
 *
 * Two rules, both deliberate:
 *
 *  - **Never throw.** A cycle discovered inside a play loop must degrade to a
 *    placeholder, not lose the frame and the clock with it (I6). Every result
 *    is a value.
 *  - **Cap depth even when acyclic.** Cost is multiplicative — each hop can
 *    rasterize a page at 2x — so a legal but deep chain is its own hazard,
 *    distinct from a cycle and reported separately.
 *
 * Pure: no VFS, no DOM.
 */

/**
 * Depth cap. Chosen as "past any plausible authoring intent, small enough that
 * the worst case survives"; there is no measurement behind the exact number.
 */
export const DEFAULT_MAX_DEPTH = 4;

export type ResolveContext = {
	/** Keys currently being resolved, outermost first. See `refKey`. */
	readonly stack: readonly string[];
	readonly maxDepth: number;
};

export type EnterResult =
	| { kind: 'ok'; ctx: ResolveContext }
	/** `key` is already being resolved. `path` is the loop, `key` at both ends. */
	| { kind: 'cyclic'; path: readonly string[] }
	/** Acyclic but too deep to be worth resolving. */
	| { kind: 'too-deep'; depth: number };

/** Start resolving `key`. The root is on the stack, so self-reference is caught. */
export function rootContext(key: string, maxDepth: number = DEFAULT_MAX_DEPTH): ResolveContext {
	return { stack: [key], maxDepth: Math.max(1, maxDepth) };
}

/** An empty context, for a resolver with no document of its own to guard. */
export function emptyContext(maxDepth: number = DEFAULT_MAX_DEPTH): ResolveContext {
	return { stack: [], maxDepth: Math.max(1, maxDepth) };
}

/**
 * Descend into `key`.
 *
 * Returns a *new* context; the caller's own stays untouched, so sibling
 * branches cannot see each other's descent. Mutating a shared stack instead
 * would make a wide fan-out look like a deep one.
 */
export function enter(ctx: ResolveContext, key: string): EnterResult {
	const at = ctx.stack.indexOf(key);
	if (at >= 0) return { kind: 'cyclic', path: [...ctx.stack.slice(at), key] };
	if (ctx.stack.length >= ctx.maxDepth) return { kind: 'too-deep', depth: ctx.stack.length };
	return { kind: 'ok', ctx: { stack: [...ctx.stack, key], maxDepth: ctx.maxDepth } };
}

/** `linkState` value for a refused descent — both cases render the same badge. */
export function refusedLinkState(result: EnterResult): 'cyclic' | null {
	return result.kind === 'ok' ? null : 'cyclic';
}
