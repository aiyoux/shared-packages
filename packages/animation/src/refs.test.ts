import { describe, expect, it } from 'vitest';
import {
	documentRefs,
	findCycle,
	isProvenAcyclic,
	liveRefs,
	load,
	refKey,
	traverses,
	wouldCycle,
	type DocRef,
	type RefLoader
} from './refs.js';
import type { AnimClip, AnimDocument, BindMode } from './types.js';

function bound(id: string, nodeId: string, bind: Exclude<BindMode, 'clone'> = 'live'): AnimClip {
	return {
		id,
		bind,
		source: { backend: 'shared-vfs', nodeId },
		startMs: 0,
		durationMs: 4000,
		frame: { x: 0, y: 0, w: 100, h: 100 }
	} as AnimClip;
}

function cloned(id: string): AnimClip {
	return {
		id,
		bind: 'clone',
		startMs: 0,
		durationMs: 4000,
		frame: { x: 0, y: 0, w: 100, h: 100 }
	} as AnimClip;
}

function doc(clips: AnimClip[]): AnimDocument {
	return { schemaVersion: 1, durationMs: 10_000, clips };
}

/**
 * Graph as `key -> outbound keys`. A key absent from the graph is a `leaf`;
 * `unknownKeys` is how a file type nobody has registered is simulated.
 */
function loader(
	graph: Record<string, string[]>,
	bind: Exclude<BindMode, 'clone'> = 'live',
	unknownKeys: string[] = []
) {
	const calls: string[] = [];
	const unknown = new Set(unknownKeys);
	const load2: RefLoader = (key) => {
		calls.push(key);
		if (unknown.has(key)) return load.unknown('made-up-app');
		const outs = graph[key];
		if (!outs) return load.leaf();
		return load.refs(
			outs.map((k, i): DocRef => ({ key: k, backend: 'shared-vfs', bind, clipId: `${key}:${i}` }))
		);
	};
	return { load: load2, calls };
}

describe('refKey', () => {
	it('separates the two backends', () => {
		expect(refKey({ backend: 'shared-vfs', nodeId: 'n1' })).toBe('vfs:n1');
		expect(refKey({ backend: 'monitor', profileId: 'p', relPath: 'a/b.png' })).toBe(
			'mon:p:a/b.png'
		);
	});
});

describe('documentRefs', () => {
	it('reports one edge per bound clip', () => {
		const refs = documentRefs(doc([bound('c1', 'n1'), bound('c2', 'n2', 'snapshot')]));
		expect(refs.map((r) => [r.key, r.bind])).toEqual([
			['vfs:n1', 'live'],
			['vfs:n2', 'snapshot']
		]);
	});

	// F5: the clone arm of the union has no `source`, so a cloned *document*
	// contributes nothing here. That is the hole `assertFrozen` has to cover —
	// this test pins the limitation so nobody reads a `[]` as "acyclic".
	it('cannot see through a clone', () => {
		expect(documentRefs(doc([cloned('c1')]))).toEqual([]);
	});

	it('liveRefs keeps only the edges that re-read their source', () => {
		const d = doc([bound('c1', 'n1'), bound('c2', 'n2', 'snapshot'), bound('c3', 'n3', 'gitPin')]);
		expect(liveRefs(d).map((r) => r.key)).toEqual(['vfs:n1']);
		expect(documentRefs(d).filter((r) => !traverses(r)).length).toBe(2);
	});
});

describe('findCycle', () => {
	it('returns none for a DAG', async () => {
		const { load } = loader({ a: ['b', 'c'], b: ['d'], c: ['d'], d: [] });
		expect(await findCycle('a', load)).toEqual({ kind: 'none' });
	});

	it('finds a direct self-reference', async () => {
		const { load } = loader({ a: ['a'] });
		expect(await findCycle('a', load)).toEqual({ kind: 'cycle', path: ['a', 'a'] });
	});

	// W15 — a multi-hop cycle. E6 (a sketch page embedding an animation) is the
	// edge that makes resolution recursive, and its cycles are arbitrarily deep,
	// while F7's identity check masks the one-hop self-reference in the app. A
	// detector exercised only on the direct case would be tuned to the one shape
	// that cannot break. The S/A names are the worked example from the design
	// doc, not a live hazard — that pairing is a containment edge (E2).
	it('finds a multi-hop cycle through four documents', async () => {
		const { load } = loader({ S1: ['A1'], A1: ['S2'], S2: ['A2'], A2: ['S1'] });
		const found = await findCycle('S1', load);
		expect(found).toEqual({ kind: 'cycle', path: ['S1', 'A1', 'S2', 'A2', 'S1'] });
	});

	it('finds a cycle that does not pass through the start', async () => {
		const { load } = loader({ a: ['b'], b: ['c'], c: ['b'] });
		const found = await findCycle('a', load);
		expect(found).toEqual({ kind: 'cycle', path: ['b', 'c', 'b'] });
	});

	// The walker traverses the same graph it is hunting loops in; without its
	// own visited set it would never return.
	it('terminates on a cycle rather than looping', async () => {
		const { load, calls } = loader({ a: ['b'], b: ['a'] });
		await findCycle('a', load);
		expect(calls.length).toBeLessThan(10);
	});

	it('does not traverse non-live edges', async () => {
		const { load } = loader({ a: ['b'], b: ['a'] }, 'snapshot');
		expect(await findCycle('a', load)).toEqual({ kind: 'none' });
	});

	it('treats a file with no entry as a leaf', async () => {
		const { load } = loader({ a: ['missing'] });
		expect(await findCycle('a', load)).toEqual({ kind: 'none' });
	});

	// The fail-closed property. A future app whose documents nothing can parse
	// must not be reported as proven acyclic — that is how a new app would join
	// the system already broken, and silently.
	it('reports unknown rather than none when a file type is unrecognised', async () => {
		const { load } = loader({ a: ['b'] }, 'live', ['b']);
		expect(await findCycle('a', load)).toEqual({
			kind: 'unknown',
			key: 'b',
			fileType: 'made-up-app'
		});
	});

	it('still reports a cycle it can see, even past an unknown file', async () => {
		const { load } = loader({ a: ['unreadable', 'b'], b: ['a'] }, 'live', ['unreadable']);
		expect((await findCycle('a', load)).kind).toBe('cycle');
	});

	it('only none proves acyclicity', async () => {
		expect(isProvenAcyclic({ kind: 'none' })).toBe(true);
		expect(isProvenAcyclic({ kind: 'unknown', key: 'x' })).toBe(false);
		expect(isProvenAcyclic({ kind: 'budget', visited: 1 })).toBe(false);
		expect(isProvenAcyclic({ kind: 'cycle', path: ['a', 'a'] })).toBe(false);
	});

	it('visits a shared child once', async () => {
		const { load, calls } = loader({ a: ['b', 'c'], b: ['d'], c: ['d'], d: [] });
		await findCycle('a', load);
		expect(calls.filter((k) => k === 'd')).toHaveLength(1);
	});

	// `budget` is "unknown", never "no" — a caller that reads it as safe has
	// silently dropped the guard (I7).
	it('reports budget exhaustion distinctly from none', async () => {
		const graph: Record<string, string[]> = {};
		for (let i = 0; i < 40; i++) graph[`n${i}`] = [`n${i + 1}`];
		const { load } = loader(graph);
		const found = await findCycle('n0', load, { maxNodes: 5 });
		expect(found).toEqual({ kind: 'budget', visited: 5 });
	});

	it('stops following a path past maxDepth without claiming a cycle', async () => {
		const graph: Record<string, string[]> = {};
		for (let i = 0; i < 40; i++) graph[`n${i}`] = [`n${i + 1}`];
		const { load } = loader(graph);
		expect(await findCycle('n0', load, { maxDepth: 3 })).toEqual({ kind: 'none' });
	});
});

describe('wouldCycle', () => {
	it('refuses a self-bind', async () => {
		const { load } = loader({});
		expect(await wouldCycle('a', 'a', load)).toEqual({ kind: 'cycle', path: ['a', 'a'] });
	});

	it('allows an edge into an unrelated document', async () => {
		const { load } = loader({ b: ['c'], c: [] });
		expect(await wouldCycle('a', 'b', load)).toEqual({ kind: 'none' });
	});

	it('propagates unknown rather than permitting the bind', async () => {
		const { load } = loader({ b: ['c'] }, 'live', ['c']);
		expect((await wouldCycle('a', 'b', load)).kind).toBe('unknown');
	});

	it('refuses an edge whose target already reaches back', async () => {
		const { load } = loader({ A1: ['S2'], S2: ['A2'], A2: ['S1'], S1: [] });
		const found = await wouldCycle('S1', 'A1', load);
		expect(found).toEqual({ kind: 'cycle', path: ['S1', 'A1', 'S2', 'A2', 'S1'] });
	});

	it('reports a cycle already present in the target subgraph', async () => {
		const { load } = loader({ b: ['c'], c: ['b'] });
		expect((await wouldCycle('a', 'b', load)).kind).toBe('cycle');
	});
});
