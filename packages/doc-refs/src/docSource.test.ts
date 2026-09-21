import { describe, expect, it } from 'vitest';
import { BIND_MODES, type DocSource, type FsBackend } from './index.js';

describe('the reference vocabulary', () => {
	/**
	 * Pinned because these strings are on disk. A document saved by one build
	 * and opened by another agrees on a reference only if this list does, so a
	 * rename here is a file-format change, not a refactor.
	 */
	it('names every bind mode, in order', () => {
		expect([...BIND_MODES]).toEqual(['clone', 'live', 'snapshot', 'gitPin']);
	});

	/**
	 * The discriminant is the whole design: a reader switches on `backend` and
	 * the compiler tells it which fields exist. This fails to compile — not at
	 * runtime — if a third backend is added without a reader being updated,
	 * which is the property the structural pipeline depends on.
	 */
	it('discriminates on backend, exhaustively', () => {
		const describeSource = (src: DocSource): string => {
			switch (src.backend) {
				case 'shared-vfs':
					return src.nodeId;
				case 'monitor':
					return `${src.profileId}:${src.relPath}`;
				default: {
					const unreachable: never = src;
					return unreachable;
				}
			}
		};

		expect(describeSource({ backend: 'shared-vfs', nodeId: 'n1' })).toBe('n1');
		expect(describeSource({ backend: 'monitor', profileId: 'p', relPath: 'a/b.png' })).toBe(
			'p:a/b.png'
		);

		const backends: FsBackend[] = ['shared-vfs', 'monitor'];
		expect(backends).toHaveLength(2);
	});
});
