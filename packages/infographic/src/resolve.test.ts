import { describe, expect, it } from 'vitest';
import { createDocument, instantiateTemplate, resolve } from './index.js';
import type { IgfxDocument, ResolvedNode } from './types.js';

function findById(nodes: ResolvedNode[], id: string): ResolvedNode | undefined {
	for (const node of nodes) {
		if (node.id === id) return node;
		if (node.children) {
			const hit = findById(node.children, id);
			if (hit) return hit;
		}
	}
	return undefined;
}

function linearProgressDoc(kind: 'bar' | 'line' | 'stat'): IgfxDocument {
	const doc = createDocument('motion');
	doc.timeline.tracks = [
		{
			id: 'grow',
			target: 'mark:m.progress',
			keyframes: [
				{ tMs: 0, value: 0, easing: 'linear' },
				{ tMs: 1000, value: 1 }
			]
		}
	];
	if (kind === 'bar') {
		doc.datasets = [
			{
				id: 'd',
				label: 'D',
				columns: [
					{ id: 'cat', label: 'Cat', type: 'string' },
					{ id: 'n', label: 'N', type: 'number' }
				],
				rows: [
					{ cat: 'A', n: 10 },
					{ cat: 'B', n: 20 }
				]
			}
		];
		doc.marks = [
			{
				id: 'm',
				kind: 'bar',
				layout: { x: 0, y: 0, w: 200, h: 100 },
				bindings: { category: { ref: 'dataset:d.cat' }, value: { ref: 'dataset:d.n' } }
			}
		];
	} else if (kind === 'line') {
		doc.datasets = [
			{
				id: 'd',
				label: 'D',
				columns: [
					{ id: 't', label: 'T', type: 'number' },
					{ id: 'n', label: 'N', type: 'number' }
				],
				rows: [
					{ t: 0, n: 1 },
					{ t: 1, n: 3 },
					{ t: 2, n: 2 }
				]
			}
		];
		doc.marks = [
			{
				id: 'm',
				kind: 'line',
				layout: { x: 10, y: 10, w: 200, h: 100 },
				bindings: { x: { ref: 'dataset:d.t' }, y: { ref: 'dataset:d.n' } }
			}
		];
	} else {
		doc.scalars = [{ id: 'v', label: 'V', type: 'number', value: 100 }];
		doc.marks = [
			{
				id: 'm',
				kind: 'stat',
				layout: { x: 0, y: 0, w: 200, h: 80 },
				bindings: { value: { ref: 'scalar:v' } }
			}
		];
	}
	return doc;
}

describe('resolve progress', () => {
	it('changes bar length at 0 / 0.5 / 1', () => {
		const doc = linearProgressDoc('bar');
		const a = findById(resolve(doc, 0).nodes, 'm:1');
		const b = findById(resolve(doc, 500).nodes, 'm:1');
		const c = findById(resolve(doc, 1000).nodes, 'm:1');
		const l0 = Number(a?.attrs['data-length']);
		const lHalf = Number(b?.attrs['data-length']);
		const l1 = Number(c?.attrs['data-length']);
		expect(l0).toBe(0);
		expect(l1).toBeGreaterThan(0);
		expect(lHalf).toBeCloseTo(l1 * 0.5, 5);
		expect(Number(c?.attrs.height)).toBeGreaterThan(Number(a?.attrs.height));
	});

	it('changes line clip-rect width at 0 / 0.5 / 1', () => {
		const doc = linearProgressDoc('line');
		const g0 = findById(resolve(doc, 0).nodes, 'm');
		const gHalf = findById(resolve(doc, 500).nodes, 'm');
		const g1 = findById(resolve(doc, 1000).nodes, 'm');
		expect(Number(g0?.attrs['data-clip-width'])).toBe(0);
		expect(Number(gHalf?.attrs['data-clip-width'])).toBeCloseTo(100, 5);
		expect(Number(g1?.attrs['data-clip-width'])).toBe(200);
	});

	it('changes stat count-up at 0 / 0.5 / 1', () => {
		const doc = linearProgressDoc('stat');
		expect(findById(resolve(doc, 0).nodes, 'm:value')?.attrs['data-raw']).toBe('0');
		expect(findById(resolve(doc, 500).nodes, 'm:value')?.attrs['data-raw']).toBe('50');
		expect(findById(resolve(doc, 1000).nodes, 'm:value')?.attrs['data-raw']).toBe('100');
	});
});

describe('missing bindings', () => {
	it('yields empty series and warnings', () => {
		const doc = createDocument();
		doc.marks = [
			{
				id: 'bars',
				kind: 'bar',
				layout: { x: 0, y: 0, w: 100, h: 100 },
				bindings: { category: { ref: 'dataset:missing.cat' }, value: { ref: 'dataset:missing.n' } }
			},
			{
				id: 'trend',
				kind: 'line',
				layout: { x: 0, y: 0, w: 100, h: 100 },
				bindings: { x: { ref: 'dataset:missing.t' }, y: { ref: 'dataset:missing.n' } }
			},
			{
				id: 'kpi',
				kind: 'stat',
				layout: { x: 0, y: 0, w: 100, h: 100 },
				bindings: { value: { ref: 'scalar:gone' } }
			},
			{
				id: 'caption',
				kind: 'text',
				layout: { x: 0, y: 0, w: 100, h: 40 },
				bindings: {}
			},
			{
				id: 'leg',
				kind: 'legend',
				layout: { x: 0, y: 0, w: 100, h: 20 },
				bindings: {}
			},
			{
				id: 'ax',
				kind: 'axis',
				layout: { x: 0, y: 0, w: 100, h: 100 },
				bindings: {}
			}
		];
		const frame = resolve(doc, 0);
		expect(frame.warnings.length).toBeGreaterThan(0);
		expect(findById(frame.nodes, 'bars')?.children ?? []).toEqual([]);
		expect(findById(frame.nodes, 'trend:path')?.attrs.d).toBe('');
		expect(findById(frame.nodes, 'kpi:value')?.text).toBe('—');
		expect(findById(frame.nodes, 'caption:text')?.text).toBe('');
		expect(findById(frame.nodes, 'leg')?.attrs['data-hidden']).toBe('true');
		expect(findById(frame.nodes, 'ax')?.attrs['data-hidden']).toBe('true');
	});
});

describe('template motion vs poster', () => {
	it('bar-compare title is faded at t=0 and solid at posterMs', () => {
		const doc = instantiateTemplate('bar-compare');
		const start = findById(resolve(doc, 0).nodes, 'title');
		const end = findById(resolve(doc, doc.timeline.posterMs).nodes, 'title');
		expect(Number(start?.attrs.opacity)).toBe(0);
		expect(Number(end?.attrs.opacity)).toBe(1);
	});
});
