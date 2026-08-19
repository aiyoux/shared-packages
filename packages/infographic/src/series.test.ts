import { describe, expect, it } from 'vitest';
import { bindObject } from './bindings.js';
import { createDocument, getActiveScene, getActiveTake, resolve } from './index.js';
import type { IgfxDocument, IgfxObject, ResolvedNode, SeriesMode } from './types.js';

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

function collectText(nodes: ResolvedNode[]): string[] {
	const out: string[] = [];
	const walk = (list: ResolvedNode[]) => {
		for (const node of list) {
			if (node.text !== undefined) out.push(node.text);
			if (node.children) walk(node.children);
		}
	};
	walk(nodes);
	return out;
}

function dummyPointTransform() {
	return { x: 0, y: 0, w: 16, h: 16, rotation: 0, opacity: 1 };
}

const POINT_SPECS = [
	{ id: 'p1', name: 'P1', x: 0, y: 10, value: 10 },
	{ id: 'p2', name: 'P2', x: 1, y: 24, value: 24 },
	{ id: 'p3', name: 'P3', x: 2, y: 18, value: 18 },
	{ id: 'p4', name: 'P4', x: 3, y: 32, value: 32 }
] as const;

function defaultPoints(): IgfxObject[] {
	return POINT_SPECS.map((p) => ({
		id: p.id,
		name: p.name,
		parentId: 'series',
		kind: 'point' as const,
		visible: true,
		transform: dummyPointTransform(),
		point: { x: p.x, y: p.y, value: p.value }
	}));
}

function seriesObject(mode: SeriesMode = 'bars'): IgfxObject {
	return {
		id: 'series',
		name: 'Series',
		parentId: null,
		kind: 'series',
		visible: true,
		transform: { x: 160, y: 200, w: 800, h: 400, rotation: 0, opacity: 1 },
		series: { mode }
	};
}

function axisObject(): IgfxObject {
	return {
		id: 'axis',
		name: 'axis',
		parentId: null,
		kind: 'axis',
		visible: true,
		transform: { x: 160, y: 200, w: 800, h: 400, rotation: 0, opacity: 1 },
		bindings: { forMark: 'series' }
	};
}

function seriesDoc(mode: SeriesMode = 'bars', extra: IgfxObject[] = []): IgfxDocument {
	const doc = createDocument();
	getActiveScene(doc).objects = [seriesObject(mode), ...defaultPoints(), ...extra];
	return doc;
}

function setProgress(doc: IgfxDocument, value: number): void {
	getActiveTake(getActiveScene(doc)).tracks = [
		{
			id: 'track-series',
			objectId: 'series',
			startMs: 0,
			durationMs: 8000,
			curves: [{ id: 'series-progress', prop: 'progress', keyframes: [{ tMs: 0, value }] }]
		}
	];
}

function boxOf(node: ResolvedNode | undefined): { x: number; y: number; w: number; h: number } {
	return {
		x: Number(node?.attrs.x),
		y: Number(node?.attrs.y),
		w: Number(node?.attrs.width),
		h: Number(node?.attrs.height)
	};
}

function pathPoints(d: string): { x: number; y: number }[] {
	const out: { x: number; y: number }[] = [];
	const re = /[ML]\s*([-\d.eE]+)\s+([-\d.eE]+)/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(d)) !== null) {
		out.push({ x: Number(m[1]), y: Number(m[2]) });
	}
	return out;
}

describe('§4.4 series bars (grow-only)', () => {
	it('locks the worked example at progress 1', () => {
		const frame = resolve(seriesDoc('bars'), 0);
		expect(boxOf(findById(frame.nodes, 'series:0'))).toEqual({ x: 168, y: 475, w: 190, h: 125 });
		expect(boxOf(findById(frame.nodes, 'series:1'))).toEqual({ x: 366, y: 300, w: 190, h: 300 });
		expect(boxOf(findById(frame.nodes, 'series:2'))).toEqual({ x: 564, y: 375, w: 190, h: 225 });
		expect(boxOf(findById(frame.nodes, 'series:3'))).toEqual({ x: 762, y: 200, w: 190, h: 400 });
		expect(Number(findById(frame.nodes, 'series:0')?.attrs['data-length'])).toBe(125);
		expect(findById(frame.nodes, 'p1')).toBeUndefined();
	});

	it('grows all four bars at progress 0.5 and does not slice to k', () => {
		const doc = seriesDoc('bars');
		setProgress(doc, 0.5);
		const frame = resolve(doc, 0);
		expect(boxOf(findById(frame.nodes, 'series:0'))).toEqual({ x: 168, y: 537.5, w: 190, h: 62.5 });
		expect(boxOf(findById(frame.nodes, 'series:1'))).toEqual({ x: 366, y: 450, w: 190, h: 150 });
		expect(boxOf(findById(frame.nodes, 'series:2'))).toEqual({ x: 564, y: 487.5, w: 190, h: 112.5 });
		expect(boxOf(findById(frame.nodes, 'series:3'))).toEqual({ x: 762, y: 400, w: 190, h: 200 });
		expect(Number(findById(frame.nodes, 'series:0')?.attrs['data-length'])).toBe(62.5);
		expect(Number(findById(frame.nodes, 'series:1')?.attrs['data-length'])).toBe(150);
		expect(Number(findById(frame.nodes, 'series:2')?.attrs['data-length'])).toBe(112.5);
		expect(Number(findById(frame.nodes, 'series:3')?.attrs['data-length'])).toBe(200);
	});
});

describe('§4.4 series line / scatter', () => {
	it('locks the line path at progress 1', () => {
		const frame = resolve(seriesDoc('line'), 0);
		const pts = pathPoints(findById(frame.nodes, 'series:path')?.attrs.d ?? '');
		expect(pts).toHaveLength(4);
		expect(pts[0]).toEqual({ x: 160, y: 600 });
		expect(pts[1].x).toBeCloseTo(426.67, 1);
		expect(pts[1].y).toBeCloseTo(345.45, 1);
		expect(pts[2].x).toBeCloseTo(693.33, 1);
		expect(pts[2].y).toBeCloseTo(454.55, 1);
		expect(pts[3]).toEqual({ x: 960, y: 200 });
		expect(Number(findById(frame.nodes, 'series:clip-rect')?.attrs.width)).toBe(800);
	});

	it('clips the line and keeps only k=2 points at progress 0.5', () => {
		const doc = seriesDoc('line');
		setProgress(doc, 0.5);
		const frame = resolve(doc, 0);
		const pts = pathPoints(findById(frame.nodes, 'series:path')?.attrs.d ?? '');
		expect(pts).toHaveLength(2);
		expect(pts[0]).toEqual({ x: 160, y: 600 });
		expect(pts[1].x).toBeCloseTo(426.67, 1);
		expect(Number(findById(frame.nodes, 'series:clip-rect')?.attrs.width)).toBe(400);
		expect(findById(frame.nodes, 'series:clip-rect')?.attrs.x).toBe('160');
	});

	it('shows the first k scatter markers and no clip-rect', () => {
		const full = resolve(seriesDoc('scatter'), 0);
		expect(findById(full.nodes, 'series:0')?.tag).toBe('circle');
		expect(Number(findById(full.nodes, 'series:0')?.attrs.cx)).toBe(160);
		expect(Number(findById(full.nodes, 'series:0')?.attrs.cy)).toBe(600);
		expect(Number(findById(full.nodes, 'series:3')?.attrs.cx)).toBe(960);
		expect(findById(full.nodes, 'series:clip-rect')).toBeUndefined();
		const doc = seriesDoc('scatter');
		setProgress(doc, 0.5);
		const half = resolve(doc, 0);
		expect(findById(half.nodes, 'series:0')).toBeTruthy();
		expect(findById(half.nodes, 'series:1')).toBeTruthy();
		expect(findById(half.nodes, 'series:2')).toBeUndefined();
		expect(findById(half.nodes, 'series:clip-rect')).toBeUndefined();
	});
});

describe('series binding + axis forMark adapter', () => {
	it('builds BoundSeries from child points (label ?? name, pv)', () => {
		const doc = seriesDoc('bars');
		const bound = bindObject(doc, seriesObject('bars'), [], doc.theme, { scene: getActiveScene(doc) });
		expect(bound.series).toEqual({
			categories: ['P1', 'P2', 'P3', 'P4'],
			values: [10, 24, 18, 32],
			xs: [],
			ys: [],
			color: '#2563eb',
			datasetLabel: 'Series'
		});
	});

	it('default 4-point series + axis at progress 1 emits P1–P4 and value ticks through 32', () => {
		const doc = seriesDoc('bars', [axisObject()]);
		const frame = resolve(doc, 0);
		expect(findById(frame.nodes, 'axis:cat:0')?.text).toBe('P1');
		expect(findById(frame.nodes, 'axis:cat:1')?.text).toBe('P2');
		expect(findById(frame.nodes, 'axis:cat:2')?.text).toBe('P3');
		expect(findById(frame.nodes, 'axis:cat:3')?.text).toBe('P4');
		const ticks = [0, 1, 2, 3, 4].map((i) => findById(frame.nodes, `axis:tick:${i}`)?.text);
		expect(ticks).toContain('32');
		expect(ticks[0]).toBe('0');
		expect(ticks[ticks.length - 1]).toBe('32');
		expect(collectText(frame.nodes)).toEqual(expect.arrayContaining(['P1', 'P2', 'P3', 'P4', '32']));
	});

	it('line-mode series + axis ticks x on [0, 3] and y on [10, 32]', () => {
		const doc = seriesDoc('line', [axisObject()]);
		const frame = resolve(doc, 0);
		const xs = [0, 1, 2, 3, 4].map((i) => findById(frame.nodes, `axis:xt:${i}`)?.text);
		const ys = [0, 1, 2, 3, 4].map((i) => findById(frame.nodes, `axis:yt:${i}`)?.text);
		expect(xs[0]).toBe('0');
		expect(xs[xs.length - 1]).toBe('3');
		expect(ys[0]).toBe('10');
		expect(ys[ys.length - 1]).toBe('32');
	});

	it('uses a sampled point value for bar magnitude', () => {
		const doc = seriesDoc('bars');
		getActiveTake(getActiveScene(doc)).tracks = [
			{
				id: 'track-p1',
				objectId: 'p1',
				startMs: 0,
				durationMs: 8000,
				curves: [{ id: 'p1-value', prop: 'value', keyframes: [{ tMs: 0, value: 32 }] }]
			}
		];
		const frame = resolve(doc, 0);
		expect(boxOf(findById(frame.nodes, 'series:0'))).toEqual({ x: 168, y: 200, w: 190, h: 400 });
		expect(Number(findById(frame.nodes, 'series:0')?.attrs['data-length'])).toBe(400);
	});

	it('drops a hidden point from the category slot', () => {
		const doc = seriesDoc('bars');
		const p2 = getActiveScene(doc).objects.find((o) => o.id === 'p2');
		if (p2) p2.visible = false;
		const frame = resolve(doc, 0);
		expect(findById(frame.nodes, 'series:3')).toBeUndefined();
		expect(Number(findById(frame.nodes, 'series:0')?.attrs.width)).toBeCloseTo((800 - 8 * 4) / 3);
	});
});
