import { describe, expect, it } from 'vitest';
import {
	DEFAULT_MAX_DEPTH,
	emptyContext,
	enter,
	refusedLinkState,
	rootContext
} from './resolveContext.js';

describe('rootContext', () => {
	it('puts the root on the stack so self-reference is caught', () => {
		const ctx = rootContext('vfs:a');
		expect(enter(ctx, 'vfs:a')).toEqual({ kind: 'cyclic', path: ['vfs:a', 'vfs:a'] });
	});

	it('floors maxDepth at 1 so a zero can never disable the cap', () => {
		expect(enter(emptyContext(0), 'vfs:a').kind).toBe('ok');
		expect(enter(rootContext('vfs:a', 0), 'vfs:b').kind).toBe('too-deep');
	});
});

describe('enter', () => {
	it('descends through an acyclic chain', () => {
		let ctx = rootContext('vfs:a');
		for (const key of ['vfs:b', 'vfs:c']) {
			const step = enter(ctx, key);
			expect(step.kind).toBe('ok');
			if (step.kind === 'ok') ctx = step.ctx;
		}
		expect(ctx.stack).toEqual(['vfs:a', 'vfs:b', 'vfs:c']);
	});

	// Depth is what E6 makes unbounded; the one-hop case is masked in the app by
	// an identity check (F7), so the deep shape is the one worth pinning.
	it('catches a cycle that closes several hops down', () => {
		let ctx = rootContext('S1');
		for (const key of ['A1', 'S2', 'A2']) {
			const step = enter(ctx, key);
			if (step.kind === 'ok') ctx = step.ctx;
		}
		expect(enter(ctx, 'S1')).toEqual({
			kind: 'cyclic',
			path: ['S1', 'A1', 'S2', 'A2', 'S1']
		});
	});

	it('reports a mid-stack cycle from the repeated key, not from the root', () => {
		let ctx = rootContext('a');
		for (const key of ['b', 'c']) {
			const step = enter(ctx, key);
			if (step.kind === 'ok') ctx = step.ctx;
		}
		expect(enter(ctx, 'b')).toEqual({ kind: 'cyclic', path: ['b', 'c', 'b'] });
	});

	it('separates too-deep from cyclic — an acyclic chain is not a loop', () => {
		let ctx = rootContext('n0', 3);
		for (const key of ['n1', 'n2']) {
			const step = enter(ctx, key);
			if (step.kind === 'ok') ctx = step.ctx;
		}
		expect(enter(ctx, 'n3')).toEqual({ kind: 'too-deep', depth: 3 });
	});

	// A shared stack would make a wide fan-out read as a deep one.
	it('does not leak one branch depth into its sibling', () => {
		const root = rootContext('a', DEFAULT_MAX_DEPTH);
		const left = enter(root, 'b');
		expect(left.kind).toBe('ok');
		expect(root.stack).toEqual(['a']);
		expect(enter(root, 'c').kind).toBe('ok');
	});

	it('never throws on a refused descent', () => {
		const ctx = rootContext('a', 1);
		expect(() => enter(ctx, 'a')).not.toThrow();
		expect(() => enter(ctx, 'b')).not.toThrow();
	});
});

describe('refusedLinkState', () => {
	it('maps both refusals to the one badge, and ok to none', () => {
		const ctx = rootContext('a', 1);
		expect(refusedLinkState(enter(ctx, 'a'))).toBe('cyclic');
		expect(refusedLinkState(enter(ctx, 'b'))).toBe('cyclic');
		expect(refusedLinkState(enter(emptyContext(), 'b'))).toBeNull();
	});
});
