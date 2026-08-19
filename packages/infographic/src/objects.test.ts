import { describe, expect, it } from 'vitest';
import { createDocument, getActiveScene } from './index.js';
import type { ObjectSample } from './motion.js';
import {
	ancestorsOf,
	childrenOf,
	hasParentCycle,
	mappedGlyph,
	objectToMark,
	pointHandleBox,
	reparent,
	subtreeIds,
	wouldCreateCycle,
	worldTransforms
} from './objects.js';
import type { IgfxObject } from './types.js';

function obj(id: string, extra: Partial<IgfxObject> = {}): IgfxObject {
	return {
		id,
		name: id,
		parentId: extra.parentId ?? null,
		kind: extra.kind ?? 'text',
		visible: extra.visible ?? true,
		transform: extra.transform ?? { x: 0, y: 0, w: 10, h: 10, rotation: 0, opacity: 1 },
		...extra
	};
}

describe('object tree helpers', () => {
	it('lists children in objects[] order', () => {
		const doc = createDocument();
		const scene = getActiveScene(doc);
		scene.objects = [obj('a'), obj('b', { parentId: 'a' }), obj('c', { parentId: 'a' }), obj('d')];
		expect(childrenOf(scene, null).map((o) => o.id)).toEqual(['a', 'd']);
		expect(childrenOf(scene, 'a').map((o) => o.id)).toEqual(['b', 'c']);
	});

	it('walks ancestors and subtree ids', () => {
		const doc = createDocument();
		const scene = getActiveScene(doc);
		scene.objects = [obj('root'), obj('mid', { parentId: 'root' }), obj('leaf', { parentId: 'mid' })];
		expect(ancestorsOf(scene, 'leaf').map((o) => o.id)).toEqual(['mid', 'root']);
		expect(subtreeIds(scene, 'root')).toEqual(['root', 'mid', 'leaf']);
	});

	it('worldTransforms is one memoized pass and composes parent rotation', () => {
		const doc = createDocument();
		const scene = getActiveScene(doc);
		scene.objects = [
			obj('parent', { transform: { x: 200, y: 50, w: 10, h: 10, rotation: 90, opacity: 0.5 } }),
			obj('child', {
				parentId: 'parent',
				transform: { x: 100, y: 0, w: 20, h: 30, rotation: 10, opacity: 0.5 }
			})
		];
		const sampled = new Map([
			['parent', { x: 200, y: 50, w: 10, h: 10, rotation: 90, opacity: 0.5 }],
			['child', { x: 100, y: 0, w: 20, h: 30, rotation: 10, opacity: 0.5 }]
		]);
		const worlds = worldTransforms(scene, sampled);
		expect(worlds.get('parent')).toEqual({ x: 200, y: 50, w: 10, h: 10, rotation: 90, opacity: 0.5 });
		const child = worlds.get('child');
		expect(child?.x).toBeCloseTo(200);
		expect(child?.y).toBeCloseTo(150);
		expect(child?.w).toBe(20);
		expect(child?.h).toBe(30);
		expect(child?.rotation).toBe(100);
		expect(child?.opacity).toBe(0.25);
		expect(worlds.size).toBe(2);
	});

	it('samples local pose before parent compose', () => {
		const doc = createDocument();
		const scene = getActiveScene(doc);
		scene.objects = [
			obj('parent', { transform: { x: 0, y: 0, w: 10, h: 10, rotation: 0, opacity: 1 } }),
			obj('child', {
				parentId: 'parent',
				transform: { x: 0, y: 0, w: 20, h: 30, rotation: 0, opacity: 1 }
			})
		];
		const sampled = new Map([
			['parent', { x: 200, y: 50, w: 10, h: 10, rotation: 90, opacity: 0.5 }],
			['child', { x: 100, y: 0, w: 20, h: 30, rotation: 10, opacity: 0.5 }]
		]);
		const child = worldTransforms(scene, sampled).get('child');
		expect(child?.x).toBeCloseTo(200);
		expect(child?.y).toBeCloseTo(150);
		expect(child?.rotation).toBe(100);
		expect(child?.opacity).toBe(0.25);
	});

	it('reparents a field write and rejects cycles and point→non-series', () => {
		const doc = createDocument();
		const scene = getActiveScene(doc);
		scene.objects = [
			obj('root'),
			obj('mid', { parentId: 'root' }),
			obj('leaf', { parentId: 'mid' }),
			obj('series', { kind: 'series', series: { mode: 'bars' } }),
			obj('pt', { kind: 'point', parentId: 'series', point: { x: 0, y: 1 } }),
			obj('other')
		];
		expect(reparent(scene, 'leaf', null)).toBe(true);
		expect(scene.objects.find((o) => o.id === 'leaf')?.parentId).toBeNull();
		expect(reparent(scene, 'leaf', 'mid')).toBe(true);
		expect(wouldCreateCycle(scene, 'root', 'leaf')).toBe(true);
		expect(reparent(scene, 'root', 'leaf')).toBe(false);
		expect(scene.objects.find((o) => o.id === 'root')?.parentId).toBeNull();
		expect(reparent(scene, 'root', 'root')).toBe(false);
		expect(reparent(scene, 'leaf', 'gone')).toBe(false);
		expect(reparent(scene, 'missing', 'root')).toBe(false);
		expect(reparent(scene, 'pt', 'root')).toBe(false);
		expect(reparent(scene, 'pt', null)).toBe(false);
		expect(scene.objects.find((o) => o.id === 'pt')?.parentId).toBe('series');
		const extra = obj('series2', { kind: 'series', series: { mode: 'line' } });
		scene.objects.push(extra);
		expect(reparent(scene, 'pt', 'series2')).toBe(true);
		expect(scene.objects.find((o) => o.id === 'pt')?.parentId).toBe('series2');
		expect(reparent(scene, 'other', 'root')).toBe(true);
		expect(hasParentCycle(scene, 'leaf')).toBe(false);
		scene.objects.find((o) => o.id === 'root')!.parentId = 'leaf';
		expect(hasParentCycle(scene, 'root')).toBe(true);
	});

	it('objectToMark shims layout from the world box', () => {
		const mark = objectToMark(
			obj('bars', { kind: 'bar', bindings: { category: { ref: 'dataset:d.cat' } } }),
			{ x: 10, y: 20, w: 30, h: 40 }
		);
		expect(mark).toMatchObject({ id: 'bars', kind: 'bar', layout: { x: 10, y: 20, w: 30, h: 40 } });
	});
});

describe('mappedGlyph / pointHandleBox', () => {
	const seriesWorld = { x: 160, y: 200, w: 800, h: 400, rotation: 0, opacity: 1 };
	const rest = (): ObjectSample => ({
		visible: true,
		motion: { progress: 1, opacity: 1, x: 0, y: 0, w: 16, h: 16, rotation: 0 }
	});
	const points: IgfxObject[] = [
		obj('p1', {
			kind: 'point',
			name: 'P1',
			parentId: 'series',
			point: { x: 0, y: 10, value: 10 },
			transform: { x: 999, y: 999, w: 1, h: 1, rotation: 0, opacity: 1 }
		}),
		obj('p2', { kind: 'point', name: 'P2', parentId: 'series', point: { x: 1, y: 24, value: 24 } }),
		obj('p3', { kind: 'point', name: 'P3', parentId: 'series', point: { x: 2, y: 18, value: 18 } }),
		obj('p4', { kind: 'point', name: 'P4', parentId: 'series', point: { x: 3, y: 32, value: 32 } })
	];
	const siblings = points.map((point) => ({ point, sample: rest() }));

	it('maps bar-mode points to the glyph center and ignores persist transform', () => {
		const p1 = mappedGlyph(seriesWorld, 'bars', points[0], rest(), siblings);
		expect(p1).toEqual({ x: 263, y: 537.5 });
		expect(pointHandleBox(seriesWorld, 'bars', points[0], rest(), siblings)).toEqual({
			x: 255,
			y: 529.5,
			w: 16,
			h: 16
		});
		expect(mappedGlyph(seriesWorld, 'bars', points[1], rest(), siblings)).toEqual({ x: 461, y: 450 });
		expect(mappedGlyph(seriesWorld, 'bars', points[2], rest(), siblings)).toEqual({ x: 659, y: 487.5 });
		expect(mappedGlyph(seriesWorld, 'bars', points[3], rest(), siblings)).toEqual({ x: 857, y: 400 });
	});

	it('maps line-mode points through lineDomain', () => {
		const p1 = mappedGlyph(seriesWorld, 'line', points[0], rest(), siblings);
		expect(p1).toEqual({ x: 160, y: 600 });
		const p2 = mappedGlyph(seriesWorld, 'line', points[1], rest(), siblings);
		expect(p2.x).toBeCloseTo(426.67, 1);
		expect(p2.y).toBeCloseTo(345.45, 1);
		const p4 = mappedGlyph(seriesWorld, 'scatter', points[3], rest(), siblings);
		expect(p4).toEqual({ x: 960, y: 200 });
	});
});
