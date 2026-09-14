import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { flattenSvgElements, reparentSvgElements } from '../src/svgTree.ts';
import type { SvgElement } from '../src/types.ts';

const line = (id: string): SvgElement => ({
	type: 'line',
	id,
	x1: 0,
	y1: 0,
	x2: 1,
	y2: 1,
	stroke: '#000',
	strokeWidth: 1
});

const group = (id: string, children: SvgElement[]): SvgElement => ({ type: 'group', id, children });

describe('reparentSvgElements refuses a destination that leaves with the drag', () => {
	/** outer ⊃ inner ⊃ a, plus a loose sibling. */
	const tree = (): SvgElement[] => [group('outer', [group('inner', [line('a')])]), line('loose')];

	it('does not delete a group dropped into its own descendant', () => {
		const before = tree();
		const after = reparentSvgElements(before, ['outer'], { groupId: 'inner' });

		// The whole point: `outer` and everything under it must still be there.
		const ids = flattenSvgElements(after).map((el) => el.id).sort();
		assert.deepEqual(ids, ['a', 'inner', 'loose', 'outer']);
		assert.deepEqual(after, before, 'refused, so the tree is untouched');
	});

	it('does not delete when the destination was removed since the drag began', () => {
		const before = tree();
		const after = reparentSvgElements(before, ['loose'], { groupId: 'gone' });
		assert.deepEqual(after, before);
	});

	it('still performs a legitimate reparent', () => {
		const after = reparentSvgElements(tree(), ['loose'], { groupId: 'inner' });
		const inner = flattenSvgElements(after).find((el) => el.id === 'inner');
		assert.equal(inner?.type, 'group');
		assert.deepEqual(
			(inner as { children: SvgElement[] }).children.map((c) => c.id).sort(),
			['a', 'loose']
		);
	});

	it('still moves to the layer root', () => {
		const after = reparentSvgElements(tree(), ['a'], { groupId: null });
		assert.equal(after.at(-1)?.id, 'a');
	});
});
