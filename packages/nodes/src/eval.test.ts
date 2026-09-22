import { describe, expect, it } from 'vitest';
import { evaluateOutput, type EvalHost } from './index.js';
import type { FlowNode, NodeDocument, Wire } from './index.js';

function stubHost<I>(): EvalHost<I> {
	return {
		loadImage: async () => {
			throw new Error('loadImage should not be called');
		},
		applyFilter: async () => {
			throw new Error('applyFilter should not be called');
		}
	};
}

function docOf(nodes: FlowNode[], wires: Wire[]): NodeDocument {
	return { schemaVersion: 1, nodes, wires };
}

function wire(id: string, from: string, fromSocket: string, to: string, toSocket: string): Wire {
	return { id, fromNodeId: from, fromSocket, toNodeId: to, toSocket };
}

describe('evaluateOutput', () => {
	it('evaluates a float const wired to a float output', async () => {
		const doc = docOf(
			[
				{ id: 'out', x: 0, y: 0, kind: 'output', valueType: { kind: 'float' } },
				{ id: 'c', x: 0, y: 0, kind: 'float', value: 1.5 }
			],
			[wire('w', 'c', 'out', 'out', 'in')]
		);
		expect(await evaluateOutput(doc, stubHost())).toEqual({
			ok: true,
			type: { kind: 'float' },
			value: 1.5
		});
	});

	it('coerces an int const into a float output, truncating the int first', async () => {
		const doc = docOf(
			[
				{ id: 'out', x: 0, y: 0, kind: 'output', valueType: { kind: 'float' } },
				{ id: 'c', x: 0, y: 0, kind: 'int', value: 2.9 }
			],
			[wire('w', 'c', 'out', 'out', 'in')]
		);
		expect(await evaluateOutput(doc, stubHost())).toEqual({
			ok: true,
			type: { kind: 'float' },
			value: 2
		});
	});

	it('evaluates a pack of two ints', async () => {
		const doc = docOf(
			[
				{ id: 'out', x: 0, y: 0, kind: 'output', valueType: { kind: 'array', of: 'int' } },
				{ id: 'p', x: 0, y: 0, kind: 'pack', element: 'int', inputCount: 2 },
				{ id: 'a', x: 0, y: 0, kind: 'int', value: 10 },
				{ id: 'b', x: 0, y: 0, kind: 'int', value: 20 }
			],
			[
				wire('b', 'b', 'out', 'p', 'in-1'),
				wire('a', 'a', 'out', 'p', 'in-0'),
				wire('o', 'p', 'out', 'out', 'in')
			]
		);
		expect(await evaluateOutput(doc, stubHost())).toEqual({
			ok: true,
			type: { kind: 'array', of: 'int' },
			items: [
				{ kind: 'int', value: 10 },
				{ kind: 'int', value: 20 }
			]
		});
	});

	it('coerces packed ints when the output asks for floats', async () => {
		const doc = docOf(
			[
				{ id: 'out', x: 0, y: 0, kind: 'output', valueType: { kind: 'array', of: 'float' } },
				{ id: 'p', x: 0, y: 0, kind: 'pack', element: 'int', inputCount: 2 },
				{ id: 'a', x: 0, y: 0, kind: 'int', value: 1 },
				{ id: 'b', x: 0, y: 0, kind: 'int', value: 2 }
			],
			[
				wire('a', 'a', 'out', 'p', 'in-0'),
				wire('b', 'b', 'out', 'p', 'in-1'),
				wire('o', 'p', 'out', 'out', 'in')
			]
		);
		expect(await evaluateOutput(doc, stubHost())).toEqual({
			ok: true,
			type: { kind: 'array', of: 'float' },
			items: [
				{ kind: 'float', value: 1 },
				{ kind: 'float', value: 2 }
			]
		});
	});

	it('reports an unwired output, including when only a later output is wired', async () => {
		const bare = docOf([{ id: 'out', x: 0, y: 0, kind: 'output', valueType: { kind: 'float' } }], []);
		expect(await evaluateOutput(bare, stubHost())).toEqual({ ok: false, message: 'Output is not wired.' });

		const secondWired = docOf(
			[
				{ id: 'first', x: 0, y: 0, kind: 'output', valueType: { kind: 'float' } },
				{ id: 'second', x: 0, y: 0, kind: 'output', valueType: { kind: 'float' } },
				{ id: 'c', x: 0, y: 0, kind: 'float', value: 1 }
			],
			[wire('w', 'c', 'out', 'second', 'in')]
		);
		expect(await evaluateOutput(secondWired, stubHost())).toEqual({
			ok: false,
			message: 'Output is not wired.'
		});
	});

	it('names the node and socket when a required input is unwired', async () => {
		const doc = docOf(
			[
				{ id: 'out', x: 0, y: 0, kind: 'output', valueType: { kind: 'array', of: 'int' } },
				{ id: 'p', x: 0, y: 0, name: 'Pair', kind: 'pack', element: 'int', inputCount: 2 },
				{ id: 'a', x: 0, y: 0, kind: 'int', value: 1 }
			],
			[wire('a', 'a', 'out', 'p', 'in-0'), wire('o', 'p', 'out', 'out', 'in')]
		);
		expect(await evaluateOutput(doc, stubHost())).toEqual({
			ok: false,
			message: 'Pair In 2 is not wired.'
		});
	});

	it('does not evaluate through a loop reachable from the output', async () => {
		let loads = 0;
		const host: EvalHost<string> = {
			loadImage: async () => {
				loads += 1;
				return 'pixels';
			},
			applyFilter: async (image) => image
		};
		const filter = (id: string): FlowNode => ({
			id,
			x: 0,
			y: 0,
			kind: 'filter',
			filter: 'invert',
			amount: 1,
			radius: 4,
			brightness: 0,
			contrast: 0
		});
		const doc = docOf(
			[filter('a'), filter('b'), { id: 'out', x: 0, y: 0, kind: 'output', valueType: { kind: 'image' } }],
			[
				wire('ab', 'a', 'out', 'b', 'image'),
				wire('ba', 'b', 'out', 'a', 'image'),
				wire('bo', 'b', 'out', 'out', 'in')
			]
		);
		expect(await evaluateOutput(doc, host)).toEqual({ ok: false, message: 'The graph contains a loop.' });
		expect(loads).toBe(0);
	});

	it('loads an image once, applies a filter, and lets host throws surface', async () => {
		let loads = 0;
		const host: EvalHost<string> = {
			loadImage: async (node) => {
				loads += 1;
				return node.id === 'img' ? 'pixels' : null;
			},
			applyFilter: async (image, filter, params) => `${image}:${filter}:${params.amount}`
		};
		const doc = docOf(
			[
				{ id: 'out', x: 0, y: 0, kind: 'output', valueType: { kind: 'image' } },
				{
					id: 'flt',
					x: 0,
					y: 0,
					kind: 'filter',
					filter: 'grayscale',
					amount: 0.5,
					radius: 4,
					brightness: 0,
					contrast: 0
				},
				{ id: 'img', x: 0, y: 0, kind: 'image', bind: 'clone' },
				{ id: 'amt', x: 0, y: 0, kind: 'int', value: 3 }
			],
			[
				wire('i', 'img', 'out', 'flt', 'image'),
				wire('a', 'amt', 'out', 'flt', 'amount'),
				wire('o', 'flt', 'out', 'out', 'in')
			]
		);
		expect(await evaluateOutput(doc, host)).toEqual({
			ok: true,
			type: { kind: 'image' },
			image: 'pixels:grayscale:3'
		});

		const storedParam = docOf(
			[
				{ id: 'out', x: 0, y: 0, kind: 'output', valueType: { kind: 'image' } },
				{
					id: 'flt',
					x: 0,
					y: 0,
					kind: 'filter',
					filter: 'grayscale',
					amount: 0.25,
					radius: 4,
					brightness: 0,
					contrast: 0
				},
				{ id: 'img', x: 0, y: 0, kind: 'image', bind: 'clone' }
			],
			[wire('i', 'img', 'out', 'flt', 'image'), wire('o', 'flt', 'out', 'out', 'in')]
		);
		expect(await evaluateOutput(storedParam, host)).toEqual({
			ok: true,
			type: { kind: 'image' },
			image: 'pixels:grayscale:0.25'
		});

		const shared = docOf(
			[
				{ id: 'out', x: 0, y: 0, kind: 'output', valueType: { kind: 'array', of: 'image' } },
				{ id: 'p', x: 0, y: 0, kind: 'pack', element: 'image', inputCount: 2 },
				{ id: 'img', x: 0, y: 0, kind: 'image', bind: 'clone' }
			],
			[
				wire('a', 'img', 'out', 'p', 'in-0'),
				wire('b', 'img', 'out', 'p', 'in-1'),
				wire('o', 'p', 'out', 'out', 'in')
			]
		);
		loads = 0;
		expect(await evaluateOutput(shared, host)).toMatchObject({ ok: true, type: { kind: 'array', of: 'image' } });
		expect(loads).toBe(1);

		const missing = docOf(
			[
				{ id: 'out', x: 0, y: 0, kind: 'output', valueType: { kind: 'image' } },
				{ id: 'gone', x: 0, y: 0, kind: 'image', bind: 'clone' }
			],
			[wire('w', 'gone', 'out', 'out', 'in')]
		);
		expect(await evaluateOutput(missing, host)).toEqual({ ok: false, message: 'Image source is missing.' });

		const failed = docOf(
			[
				{ id: 'out', x: 0, y: 0, kind: 'output', valueType: { kind: 'image' } },
				{
					id: 'flt',
					x: 0,
					y: 0,
					name: 'Blur',
					kind: 'filter',
					filter: 'blur',
					amount: 1,
					radius: 4,
					brightness: 0,
					contrast: 0
				}
			],
			[]
		);
		expect(await evaluateOutput(failed, host)).toEqual({ ok: false, message: 'Output is not wired.' });

		const unwiredImage = docOf(
			[
				{ id: 'out', x: 0, y: 0, kind: 'output', valueType: { kind: 'image' } },
				{
					id: 'flt',
					x: 0,
					y: 0,
					name: 'Blur',
					kind: 'filter',
					filter: 'blur',
					amount: 1,
					radius: 9,
					brightness: 0,
					contrast: 0
				}
			],
			[wire('o', 'flt', 'out', 'out', 'in')]
		);
		expect(await evaluateOutput(unwiredImage, host)).toEqual({
			ok: false,
			message: 'Blur Image is not wired.'
		});

		const filterFail = docOf(
			[
				{ id: 'out', x: 0, y: 0, kind: 'output', valueType: { kind: 'image' } },
				{
					id: 'flt',
					x: 0,
					y: 0,
					kind: 'filter',
					filter: 'blur',
					amount: 1,
					radius: 4,
					brightness: 1,
					contrast: 2
				},
				{ id: 'img', x: 0, y: 0, kind: 'image', bind: 'clone' }
			],
			[wire('i', 'img', 'out', 'flt', 'image'), wire('o', 'flt', 'out', 'out', 'in')]
		);
		const nullFilter: EvalHost<string> = {
			loadImage: async () => 'pixels',
			applyFilter: async () => null
		};
		expect(await evaluateOutput(filterFail, nullFilter)).toEqual({ ok: false, message: 'Filter failed.' });

		const boom: EvalHost<string> = {
			loadImage: async () => {
				throw new Error('boom');
			},
			applyFilter: async () => null
		};
		const imageOut = docOf(
			[
				{ id: 'out', x: 0, y: 0, kind: 'output', valueType: { kind: 'image' } },
				{ id: 'img', x: 0, y: 0, kind: 'image', bind: 'live', source: { backend: 'shared-vfs', nodeId: 'n' } }
			],
			[wire('w', 'img', 'out', 'out', 'in')]
		);
		await expect(evaluateOutput(imageOut, boom)).rejects.toThrow('boom');
	});
});
