import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
	createParsedPathEntries,
	findCoincidentNodes,
	findCoincidentNodesInParsedPaths,
	parsePath,
	parseTranslate,
	polygonToPath,
	stringifyPath,
	updateCoincidentNodes,
	updateCoincidentParsedNodes
} from '../src/path.ts';
import type { PathData } from '../src/types';

const bakedPath = (d: string, transform?: string): PathData => ({
	d,
	fill: '#ddd',
	stroke: '#111',
	strokeWidth: 2,
	bakeGroupId: 'bake-1',
	transform
});

describe('path utilities', () => {
	it('parses and stringifies mixed SVG path commands', () => {
		const commands = parsePath('M 0 0 L 10 5 C 1 2 3 4 5 6 Z');
		assert.deepEqual(commands, [
			{ type: 'M', args: [0, 0] },
			{ type: 'L', args: [10, 5] },
			{ type: 'C', args: [1, 2, 3, 4, 5, 6] },
			{ type: 'Z', args: [] }
		]);
		assert.equal(stringifyPath(commands), 'M 0 0 L 10 5 C 1 2 3 4 5 6 Z');
	});

	it('parses comma, space, negative, and exponent translate forms', () => {
		assert.deepEqual(parseTranslate('translate(12.5, -3)'), [12.5, -3]);
		assert.deepEqual(parseTranslate('translate(-1e2 2.5e1)'), [-100, 25]);
		assert.deepEqual(parseTranslate('rotate(10)'), [0, 0]);
	});

	it('converts SVG polygon points into a closed path', () => {
		assert.equal(polygonToPath('0,0 10,0 10,5'), 'M 0 0 L 10 0 L 10 5 Z');
	});

	it('links coincident baked nodes using world coordinates across path transforms', () => {
		const paths = [
			bakedPath('M 0 0 L 10 0', 'translate(100, 50)'),
			bakedPath('M 110 50 L 120 50'),
			bakedPath('M 10 0 L 10 10', 'translate(100, 50)'),
			{ ...bakedPath('M 110 50 L 110 60'), bakeGroupId: 'other-bake' }
		];

		const linked = findCoincidentNodes(paths, 0, 1, 0, 0.001);

		assert.deepEqual(linked, [
			{ pathIndex: 0, cmdIndex: 1, argOffset: 0 },
			{ pathIndex: 1, cmdIndex: 0, argOffset: 0 },
			{ pathIndex: 2, cmdIndex: 0, argOffset: 0 }
		]);
	});

	it('updates linked baked nodes in each path local coordinate space', () => {
		const paths = [
			bakedPath('M 0 0 L 10 0', 'translate(100, 50)'),
			bakedPath('M 110 50 L 120 50')
		];
		const linked = findCoincidentNodes(paths, 0, 1, 0, 0.001);

		updateCoincidentNodes(paths, linked, 130, 70);

		assert.equal(paths[0].d, 'M 0 0 L 30 20');
		assert.equal(paths[1].d, 'M 130 70 L 120 50');
	});

	it('links and updates coincident nodes from reusable parsed path entries', () => {
		const paths = [
			bakedPath('M 0 0 L 10 0', 'translate(100, 50)'),
			bakedPath('M 110 50 L 120 50'),
			bakedPath('M 10 0 L 10 10', 'translate(100, 50)'),
			{ ...bakedPath('M 110 50 L 110 60'), bakeGroupId: 'other-bake' }
		];
		const entries = createParsedPathEntries(paths);

		const linked = findCoincidentNodesInParsedPaths(entries, 0, 1, 0, 0.001);
		updateCoincidentParsedNodes(paths, entries, linked, 140, 75);

		assert.deepEqual(linked, [
			{ pathIndex: 0, cmdIndex: 1, argOffset: 0 },
			{ pathIndex: 1, cmdIndex: 0, argOffset: 0 },
			{ pathIndex: 2, cmdIndex: 0, argOffset: 0 }
		]);
		assert.equal(paths[0].d, 'M 0 0 L 40 25');
		assert.equal(paths[1].d, 'M 140 75 L 120 50');
		assert.equal(paths[2].d, 'M 40 25 L 10 10');
		assert.equal(entries[0].commands[1].args[0], 40);
		assert.equal(entries[1].commands[0].args[0], 140);
	});
});
