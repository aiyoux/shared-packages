import { describe, expect, it } from 'vitest';
import { createDocument, getActiveScene } from './index.js';
import { ancestorsOf, childrenOf, objectToMark, subtreeIds, worldTransforms } from './objects.js';
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

	it('worldTransforms is one memoized pass and keeps identity parents', () => {
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
		// S2 identity parents — no rotation compose yet.
		expect(worlds.get('parent')).toEqual({ x: 200, y: 50, w: 10, h: 10, rotation: 90, opacity: 0.5 });
		expect(worlds.get('child')).toEqual({ x: 100, y: 0, w: 20, h: 30, rotation: 10, opacity: 0.5 });
		expect(worlds.size).toBe(2);
	});

	it('objectToMark shims layout from the world box', () => {
		const mark = objectToMark(
			obj('bars', { kind: 'bar', bindings: { category: { ref: 'dataset:d.cat' } } }),
			{ x: 10, y: 20, w: 30, h: 40 }
		);
		expect(mark).toMatchObject({ id: 'bars', kind: 'bar', layout: { x: 10, y: 20, w: 30, h: 40 } });
	});
});
