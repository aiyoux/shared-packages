import { describe, expect, it } from 'vitest';
import {
	assertFrozen,
	freezeDocument,
	frozenViolations,
	isFrozen,
	isFrozenSnapshot,
	NotFrozenError
} from './frozen.js';
import type { AnimClip, AnimDocument } from './types.js';

const base = { startMs: 0, durationMs: 1000, frame: { x: 0, y: 0, w: 10, h: 10 } };

const live = (id: string, nodeId: string): AnimClip =>
	({ id, bind: 'live', source: { backend: 'shared-vfs', nodeId }, ...base }) as AnimClip;

const frozen = (id: string, bytesRef = 'data:image/png;base64,AA'): AnimClip =>
	({ id, bind: 'clone', snapshot: { bytesRef }, ...base }) as AnimClip;

const doc = (clips: AnimClip[]): AnimDocument => ({
	schemaVersion: 1,
	durationMs: 10_000,
	clips
});

describe('isFrozenSnapshot', () => {
	it('accepts embedded bytes', () => {
		expect(isFrozenSnapshot({ bytesRef: 'data:image/png;base64,AA' })).toBe(true);
	});

	it('accepts a git pin with a commit', () => {
		expect(isFrozenSnapshot({ bytesRef: 'gitpin:root:a.png', atCommit: 'abc123' })).toBe(true);
	});

	// The F4 hole: without a sha the ref can only be read at HEAD, which follows
	// a moving branch. That is a live edge, whatever the bind mode says.
	it('rejects a git pin with no commit', () => {
		expect(isFrozenSnapshot({ bytesRef: 'gitpin:root:a.png' })).toBe(false);
		expect(isFrozenSnapshot({ bytesRef: 'gitpin:root:a.png', atCommit: '' })).toBe(false);
	});

	it('rejects a missing snapshot', () => {
		expect(isFrozenSnapshot(undefined)).toBe(false);
	});
});

describe('frozenViolations', () => {
	it('passes a document of embedded clones', () => {
		expect(frozenViolations(doc([frozen('a'), frozen('b')]))).toEqual([]);
		expect(isFrozen(doc([frozen('a')]))).toBe(true);
	});

	// F3/F5 — the finding this module exists for. A document whose embedded
	// clips still carry `source` is not frozen, however it is labelled.
	it('rejects any clip that still carries a source', () => {
		expect(frozenViolations(doc([frozen('a'), live('b', 'n1')]))).toEqual([
			{ clipId: 'b', reason: 'has-source' }
		]);
	});

	it('rejects a clone with no bytes at all', () => {
		expect(frozenViolations(doc([{ id: 'a', bind: 'clone', ...base } as AnimClip]))).toEqual([
			{ clipId: 'a', reason: 'no-bytes' }
		]);
	});

	it('rejects an unpinned git ref', () => {
		expect(frozenViolations(doc([frozen('a', 'gitpin:root:a.png')]))).toEqual([
			{ clipId: 'a', reason: 'unpinned-snapshot' }
		]);
	});

	it('reports every violation, not just the first', () => {
		expect(frozenViolations(doc([live('a', 'n1'), live('b', 'n2')]))).toHaveLength(2);
	});
});

describe('assertFrozen', () => {
	it('throws with the violations attached', () => {
		try {
			assertFrozen(doc([live('a', 'n1')]));
			expect.unreachable('should have thrown');
		} catch (err) {
			expect(err).toBeInstanceOf(NotFrozenError);
			expect((err as NotFrozenError).violations).toEqual([{ clipId: 'a', reason: 'has-source' }]);
		}
	});

	it('is silent on a frozen document', () => {
		expect(() => assertFrozen(doc([frozen('a')]))).not.toThrow();
	});
});

describe('freezeDocument', () => {
	const bytes = () => 'data:image/png;base64,AAAA';

	it('strips every source and satisfies its own gate', async () => {
		const result = await freezeDocument(doc([live('a', 'n1')]), 'vfs:self', { bytes });
		expect(result.kind).toBe('frozen');
		if (result.kind !== 'frozen') return;
		expect(isFrozen(result.doc)).toBe(true);
		expect(result.doc.clips[0]).toMatchObject({ bind: 'clone' });
		expect('source' in result.doc.clips[0]!).toBe(false);
	});

	it('keeps an already-frozen clip untouched', async () => {
		const input = doc([frozen('a', 'data:image/png;base64,KEEP')]);
		const result = await freezeDocument(input, 'vfs:self', {
			bytes: () => 'data:image/png;base64,REPLACED'
		});
		if (result.kind !== 'frozen') return expect.unreachable('should freeze');
		expect(result.doc.clips[0]).toMatchObject({
			snapshot: { bytesRef: 'data:image/png;base64,KEEP' }
		});
	});

	it('re-resolves an unpinned git ref rather than keeping it', async () => {
		const input = doc([frozen('a', 'gitpin:root:a.png')]);
		const result = await freezeDocument(input, 'vfs:self', { bytes });
		if (result.kind !== 'frozen') return expect.unreachable('should freeze');
		expect(isFrozen(result.doc)).toBe(true);
	});

	it('refuses a self-referencing document', async () => {
		const result = await freezeDocument(doc([live('a', 'self')]), 'vfs:self', {
			bytes,
			doc: () => doc([])
		});
		expect(result).toEqual({ kind: 'cyclic', path: ['vfs:self', 'vfs:self'] });
	});

	// The reason a freeze cannot simply recurse: the graph it walks may loop.
	it('refuses a two-hop cycle between documents', async () => {
		const docs: Record<string, AnimDocument> = {
			'vfs:A': doc([live('a', 'B')]),
			'vfs:B': doc([live('b', 'A')])
		};
		const result = await freezeDocument(docs['vfs:A']!, 'vfs:A', {
			bytes,
			doc: (key) => docs[key] ?? null
		});
		expect(result.kind).toBe('cyclic');
	});

	it('refuses an acyclic chain past the depth cap', async () => {
		const docs: Record<string, AnimDocument> = {};
		for (let i = 0; i < 10; i++) docs[`vfs:n${i}`] = doc([live(`c${i}`, `n${i + 1}`)]);
		const result = await freezeDocument(docs['vfs:n0']!, 'vfs:n0', {
			bytes,
			doc: (key) => docs[key] ?? null
		});
		expect(result.kind).toBe('too-deep');
	});

	// W13 — refuse loudly rather than emit a document nobody can broadcast.
	it('refuses once the inlined bytes exceed the cap', async () => {
		const big = 'data:image/png;base64,' + 'A'.repeat(500);
		const result = await freezeDocument(doc([live('a', 'n1'), live('b', 'n2')]), 'vfs:self', {
			bytes: () => big
		});
		expect(result.kind).toBe('frozen');
		const capped = await freezeDocument(doc([live('a', 'n1'), live('b', 'n2')]), 'vfs:self', {
			bytes: () => big
		}, { maxBytesRefChars: 600 });
		expect(capped).toMatchObject({ kind: 'too-large', limit: 600 });
	});

	it('reports which clip could not be resolved', async () => {
		const result = await freezeDocument(doc([live('a', 'n1')]), 'vfs:self', { bytes: () => null });
		expect(result).toEqual({ kind: 'unresolved', clipId: 'a' });
	});
});
