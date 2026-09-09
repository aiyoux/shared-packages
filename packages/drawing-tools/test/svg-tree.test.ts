import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { SvgElement, SvgPathElement } from '../src/types.ts';
import {
	cloneSvgElement,
	deleteSvgElements,
	findSvgElement,
	flattenSvgElements,
	groupSvgElements,
	mapSvgElement,
	reparentSvgElements,
	ungroupSvgElement
} from '../src/svgTree.ts';

function path(id: string): SvgPathElement {
	return {
		type: 'path',
		id,
		d: 'M 0 0 L 1 1',
		stroke: '#000',
		fill: 'none',
		strokeWidth: 1
	};
}

describe('svgTree', () => {
	it('flattenSvgElements walks nested groups', () => {
		const tree: SvgElement[] = [
			{
				type: 'group',
				id: 'g1',
				children: [path('a'), { type: 'group', id: 'g2', children: [path('b')] }]
			},
			path('c')
		];
		assert.deepEqual(
			flattenSvgElements(tree).map((el) => el.id),
			['g1', 'a', 'g2', 'b', 'c']
		);
	});

	it('findSvgElement reaches nested children', () => {
		const tree: SvgElement[] = [
			{ type: 'group', id: 'g1', children: [path('a'), path('b')] }
		];
		assert.equal(findSvgElement(tree, 'b')?.id, 'b');
		assert.equal(findSvgElement(tree, 'missing'), null);
	});

	it('cloneSvgElement assigns new ids and keeps structure', () => {
		const src: SvgElement = {
			type: 'group',
			id: 'g1',
			children: [path('a')]
		};
		const cloned = cloneSvgElement(src);
		assert.equal(cloned.type, 'group');
		assert.notEqual(cloned.id, 'g1');
		if (cloned.type === 'group') {
			assert.equal(cloned.children.length, 1);
			assert.notEqual(cloned.children[0]!.id, 'a');
			assert.equal(cloned.children[0]!.type, 'path');
		}
	});

	it('deleteSvgElements drops nested ids', () => {
		const tree: SvgElement[] = [
			{ type: 'group', id: 'g1', children: [path('a'), path('b')] },
			path('c')
		];
		const next = deleteSvgElements(tree, ['a', 'c']);
		assert.equal(next.length, 1);
		assert.equal(next[0]!.type, 'group');
		if (next[0]!.type === 'group') {
			assert.deepEqual(
				next[0].children.map((el) => el.id),
				['b']
			);
		}
	});

	it('mapSvgElement updates a nested child', () => {
		const tree: SvgElement[] = [{ type: 'group', id: 'g1', children: [path('a')] }];
		const next = mapSvgElement(tree, 'a', (el) =>
			el.type === 'path' ? { ...el, stroke: '#f00' } : el
		);
		const found = findSvgElement(next, 'a');
		assert.equal(found?.type, 'path');
		if (found?.type === 'path') assert.equal(found.stroke, '#f00');
	});

	it('groupSvgElements wraps sibling ids and inserts at the first sibling', () => {
		const tree: SvgElement[] = [path('a'), path('b'), path('c')];
		const next = groupSvgElements(tree, ['b', 'c']);
		assert.equal(next.length, 2);
		assert.equal(next[0]!.id, 'a');
		assert.equal(next[1]!.type, 'group');
		if (next[1]!.type === 'group') {
			assert.deepEqual(
				next[1].children.map((el) => el.id),
				['b', 'c']
			);
		}
	});

	it('groupSvgElements recurses when the ids are nested siblings', () => {
		const tree: SvgElement[] = [
			{
				type: 'group',
				id: 'outer',
				children: [path('a'), path('b'), path('c')]
			}
		];
		const next = groupSvgElements(tree, ['a', 'b']);
		assert.equal(next[0]!.type, 'group');
		if (next[0]!.type === 'group') {
			assert.equal(next[0].children.length, 2);
			assert.equal(next[0].children[0]!.type, 'group');
			assert.equal(next[0].children[1]!.id, 'c');
		}
	});

	it('ungroupSvgElement splices children in place', () => {
		const tree: SvgElement[] = [
			path('a'),
			{ type: 'group', id: 'g1', children: [path('b'), path('c')] }
		];
		const next = ungroupSvgElement(tree, 'g1');
		assert.deepEqual(
			next.map((el) => el.id),
			['a', 'b', 'c']
		);
	});

	it('reparentSvgElements moves siblings into a group', () => {
		const tree: SvgElement[] = [
			path('a'),
			{ type: 'group', id: 'g1', children: [path('b')] },
			path('c')
		];
		const next = reparentSvgElements(tree, ['c'], { groupId: 'g1' });
		assert.deepEqual(
			next.map((el) => el.id),
			['a', 'g1']
		);
		assert.equal(next[1]!.type, 'group');
		if (next[1]!.type === 'group') {
			assert.deepEqual(
				next[1].children.map((el) => el.id),
				['b', 'c']
			);
		}
	});

	it('reparentSvgElements can lift a child back to the root before a sibling', () => {
		const tree: SvgElement[] = [
			path('a'),
			{ type: 'group', id: 'g1', children: [path('b'), path('c')] }
		];
		const next = reparentSvgElements(tree, ['c'], { groupId: null, beforeId: 'a' });
		assert.deepEqual(
			next.map((el) => el.id),
			['c', 'a', 'g1']
		);
	});
});
