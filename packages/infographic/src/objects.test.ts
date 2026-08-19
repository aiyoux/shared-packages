import { describe, expect, it } from 'vitest';
import { createDocument, getActiveScene } from './index.js';
import {
	ancestorsOf,
	childrenOf,
	hasParentCycle,
	objectToMark,
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
