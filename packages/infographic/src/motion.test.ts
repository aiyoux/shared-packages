import { describe, expect, it } from 'vitest';
import { createDocument, getActiveScene, getActiveTake } from './index.js';
import { applyEasing, sampleTake, sampleTrack, trackCovers } from './motion.js';
import type { MotionTrack, SceneTrack } from './types.js';

describe('motion', () => {
	it('holds the first and last keyframe', () => {
		const track: MotionTrack = {
			id: 't',
			target: 'mark:m.progress',
			keyframes: [
				{ tMs: 100, value: 0.2 },
				{ tMs: 300, value: 0.8 }
			]
		};
		expect(sampleTrack(track, 0)).toBe(0.2);
		expect(sampleTrack(track, 100)).toBe(0.2);
		expect(sampleTrack(track, 300)).toBe(0.8);
		expect(sampleTrack(track, 8000)).toBe(0.8);
	});

	it('treats unknown easing as linear', () => {
		expect(applyEasing(0.5, 'not-a-curve')).toBe(0.5);
		expect(applyEasing(0.5, 'linear')).toBe(0.5);
		expect(applyEasing(0.5, 'easeOut')).toBeGreaterThan(0.5);
	});
});

describe('trackCovers', () => {
	const track: SceneTrack = { id: 't', objectId: 'o', startMs: 0, durationMs: 8000, curves: [] };

	it('is closed at the end so posterMs = durationMs still covers', () => {
		expect(trackCovers(track, 0)).toBe(true);
		expect(trackCovers(track, 8000)).toBe(true);
		expect(trackCovers(track, 8001)).toBe(false);
		expect(trackCovers({ ...track, durationMs: 0 }, 0)).toBe(false);
	});
});

describe('sampleTake', () => {
	it('empty take is rest pose and unlinked objects stay visible', () => {
		const doc = createDocument();
		const scene = getActiveScene(doc);
		scene.objects = [
			{
				id: 't',
				name: 't',
				parentId: null,
				kind: 'text',
				visible: true,
				transform: { x: 8, y: 9, w: 10, h: 11, rotation: 0, opacity: 1 },
				bindings: { text: 'hi' }
			}
		];
		const { byObject, warnings } = sampleTake(scene, getActiveTake(scene), 400);
		expect(warnings).toEqual([]);
		expect(byObject.get('t')).toEqual({
			visible: true,
			motion: { progress: 1, opacity: 1, x: 0, y: 0, w: 10, h: 11, rotation: 0 }
		});
	});

	it('later covering track wins per prop', () => {
		const doc = createDocument();
		const scene = getActiveScene(doc);
		scene.objects = [
			{
				id: 't',
				name: 't',
				parentId: null,
				kind: 'text',
				visible: true,
				transform: { x: 0, y: 0, w: 10, h: 10, rotation: 0, opacity: 1 }
			}
		];
		const take = getActiveTake(scene);
		take.tracks = [
			{
				id: 'a',
				objectId: 't',
				startMs: 0,
				durationMs: 8000,
				curves: [{ id: 'a-op', prop: 'opacity', keyframes: [{ tMs: 0, value: 0.2 }] }]
			},
			{
				id: 'b',
				objectId: 't',
				startMs: 0,
				durationMs: 8000,
				curves: [{ id: 'b-op', prop: 'opacity', keyframes: [{ tMs: 0, value: 0.8 }] }]
			}
		];
		expect(sampleTake(scene, take, 0).byObject.get('t')?.motion.opacity).toBe(0.8);
	});

	it('hides an eye-off object even when a track covers tMs', () => {
		const doc = createDocument();
		const scene = getActiveScene(doc);
		scene.objects = [
			{
				id: 't',
				name: 't',
				parentId: null,
				kind: 'text',
				visible: false,
				transform: { x: 0, y: 0, w: 10, h: 10, rotation: 0, opacity: 1 }
			}
		];
		const take = getActiveTake(scene);
		take.tracks = [
			{ id: 'track-t', objectId: 't', startMs: 0, durationMs: 8000, curves: [] }
		];
		expect(sampleTake(scene, take, 400).byObject.get('t')?.visible).toBe(false);
	});

	it('hides a covering child when an ancestor group is eye-off', () => {
		const doc = createDocument();
		const scene = getActiveScene(doc);
		scene.objects = [
			{
				id: 'g',
				name: 'g',
				parentId: null,
				kind: 'group',
				visible: false,
				transform: { x: 0, y: 0, w: 10, h: 10, rotation: 0, opacity: 1 }
			},
			{
				id: 'child',
				name: 'child',
				parentId: 'g',
				kind: 'text',
				visible: true,
				transform: { x: 0, y: 0, w: 10, h: 10, rotation: 0, opacity: 1 }
			}
		];
		const take = getActiveTake(scene);
		take.tracks = [
			{ id: 'track-child', objectId: 'child', startMs: 0, durationMs: 8000, curves: [] }
		];
		const sampled = sampleTake(scene, take, 400);
		expect(sampled.byObject.get('g')?.visible).toBe(false);
		expect(sampled.byObject.get('child')?.visible).toBe(false);
	});

	it('hides unlinked and covering children when a linked ancestor is outside its place clip', () => {
		const doc = createDocument();
		const scene = getActiveScene(doc);
		scene.objects = [
			{
				id: 'g',
				name: 'g',
				parentId: null,
				kind: 'group',
				visible: true,
				transform: { x: 0, y: 0, w: 10, h: 10, rotation: 0, opacity: 1 }
			},
			{
				id: 'unlinked',
				name: 'unlinked',
				parentId: 'g',
				kind: 'text',
				visible: true,
				transform: { x: 0, y: 0, w: 10, h: 10, rotation: 0, opacity: 1 }
			},
			{
				id: 'covering',
				name: 'covering',
				parentId: 'g',
				kind: 'text',
				visible: true,
				transform: { x: 0, y: 20, w: 10, h: 10, rotation: 0, opacity: 1 }
			}
		];
		const take = getActiveTake(scene);
		take.tracks = [
			{ id: 'place-g', objectId: 'g', startMs: 1000, durationMs: 500, curves: [] },
			{ id: 'place-covering', objectId: 'covering', startMs: 0, durationMs: 8000, curves: [] }
		];
		const outside = sampleTake(scene, take, 0);
		expect(outside.byObject.get('unlinked')?.visible).toBe(false);
		expect(outside.byObject.get('covering')?.visible).toBe(false);
		const inside = sampleTake(scene, take, 1000);
		expect(inside.byObject.get('unlinked')?.visible).toBe(true);
		expect(inside.byObject.get('covering')?.visible).toBe(true);
		expect(sampleTake(scene, take, 1500).byObject.get('unlinked')?.visible).toBe(true);
		expect(sampleTake(scene, take, 1501).byObject.get('covering')?.visible).toBe(false);
	});
});

