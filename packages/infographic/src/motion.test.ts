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
});

