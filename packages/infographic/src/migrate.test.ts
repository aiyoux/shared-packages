import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isV1, migrateV1ToV2 } from './migrate.js';
import {
	IGFX_FORMAT,
	IGFX_SCHEMA_VERSION,
	instantiateTemplate,
	MAX_KEYS_PER_CURVE,
	MAX_OBJECTS_PER_SCENE,
	MAX_SCENES,
	MAX_TAKES_PER_SCENE,
	MAX_TRACKS_PER_TAKE,
	parseIgfx,
	serializeIgfx,
	TEMPLATE_IDS,
	v1View,
	type PropertyCurve,
	type SceneTimeline,
	type SceneTrack
} from './index.js';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

describe('isV1', () => {
	it('treats missing schemaVersion as v1', () => {
		expect(isV1({ format: 'igfx', marks: [] })).toBe(true);
	});

	it('treats schemaVersion < 2 as v1', () => {
		expect(isV1({ schemaVersion: 1, scenes: [] })).toBe(true);
	});

	it('treats schemaVersion 2 without scenes but with marks as v1', () => {
		expect(isV1({ schemaVersion: 2, marks: [] })).toBe(true);
	});

	it('does not treat a v2 collection as v1', () => {
		expect(isV1({ schemaVersion: 2, scenes: [] })).toBe(false);
	});

	it('treats schemaVersion 1 with scenes as v1 (scenes ignored)', () => {
		expect(isV1({ schemaVersion: 1, scenes: [{ id: 'x' }], marks: [] })).toBe(true);
	});
});

describe('migrateV1ToV2', () => {
	it('folds marks into scene-default / take-1 with stable ids', () => {
		const raw = JSON.parse(readFileSync(join(fixturesDir, 'v1-hand-rolled.json'), 'utf8')) as Record<
			string,
			unknown
		>;
		const next = migrateV1ToV2(raw);
		expect(next.schemaVersion).toBe(IGFX_SCHEMA_VERSION);
		expect(next.marks).toBeUndefined();
		expect(next.timeline).toBeUndefined();
		expect(next.mediaBed).toBeUndefined();
		expect(next.activeSceneId).toBe('scene-default');
		const scenes = next.scenes as Array<Record<string, unknown>>;
		expect(scenes).toHaveLength(1);
		expect(scenes[0].id).toBe('scene-default');
		expect(scenes[0].mediaBed).toEqual({ nodeId: 'vid-1', offsetMs: 120, durationMs: 5400 });
		const objects = scenes[0].objects as Array<{ id: string; kind: string; name: string }>;
		expect(objects.map((o) => o.id)).toEqual(['title', 'bars']);
		expect(objects.every((o) => o.name === o.id)).toBe(true);
		const take = (scenes[0].timelines as SceneTimeline[])[0];
		expect(take.id).toBe('take-1');
		expect(take.tracks.map((t) => t.id)).toEqual(['track-bars', 'track-title']);
		const bars = take.tracks.find((t) => t.objectId === 'bars') as SceneTrack;
		expect(bars.startMs).toBe(0);
		expect(bars.durationMs).toBe(8000);
		expect(bars.curves).toHaveLength(1);
		expect(bars.curves[0].id).toBe('bars-progress');
		expect(bars.curves[0].keyframes).toEqual([{ tMs: 0, value: 0.5 }]);
		const title = take.tracks.find((t) => t.objectId === 'title') as SceneTrack;
		expect(title.curves.map((c: PropertyCurve) => c.id).sort()).toEqual(['title-opacity', 'title-x']);
	});

	it('ignores a hand-built scenes array on schemaVersion 1', () => {
		const next = migrateV1ToV2({
			schemaVersion: 1,
			scenes: [{ id: 'should-ignore', objects: [], timelines: [] }],
			marks: [{ id: 't', kind: 'text', layout: { x: 0, y: 0, w: 10, h: 10 }, bindings: { text: 'hi' } }]
		});
		const scenes = next.scenes as Array<{ id: string; objects: Array<{ id: string }> }>;
		expect(scenes[0].id).toBe('scene-default');
		expect(scenes[0].objects.map((o) => o.id)).toEqual(['t']);
	});

	it('accepts already-rewritten object: targets', () => {
		const next = migrateV1ToV2({
			schemaVersion: 1,
			marks: [{ id: 'm', kind: 'stat', layout: { x: 0, y: 0, w: 10, h: 10 }, bindings: {} }],
			timeline: {
				durationMs: 4000,
				posterMs: 4000,
				tracks: [
					{
						id: 'g',
						target: 'object:m.progress',
						keyframes: [
							{ tMs: 0, value: 0 },
							{ tMs: 400, value: 1 }
						]
					}
				]
			}
		});
		const take = ((next.scenes as Array<{ timelines: SceneTimeline[] }>)[0].timelines)[0];
		expect(take.tracks[0]).toMatchObject({
			id: 'track-m',
			objectId: 'm',
			durationMs: 4000
		});
		expect(take.tracks[0].curves[0].id).toBe('m-progress');
	});
});

describe('parseIgfx migration goldens', () => {
	it('round-trips v1 hand-rolled fixture through serialize', () => {
		const raw = JSON.parse(readFileSync(join(fixturesDir, 'v1-hand-rolled.json'), 'utf8'));
		const doc = parseIgfx(raw);
		const json = JSON.parse(serializeIgfx(doc)) as Record<string, unknown>;
		expect(json.marks).toBeUndefined();
		expect(json.timeline).toBeUndefined();
		expect(json.mediaBed).toBeUndefined();
		expect(json.schemaVersion).toBe(2);
		expect(json.format).toBe(IGFX_FORMAT);
		const again = parseIgfx(json);
		expect(again).toEqual(doc);
	});

	it.each(TEMPLATE_IDS)('%s migrates to scene-default / take-1 with folded track ids', (id) => {
		const doc = instantiateTemplate(id);
		expect(doc.schemaVersion).toBe(2);
		expect(doc.scenes).toHaveLength(1);
		expect(doc.scenes[0].id).toBe('scene-default');
		expect(doc.activeSceneId).toBe('scene-default');
		const take = doc.scenes[0].timelines[0];
		expect(take.id).toBe('take-1');
		expect(doc.scenes[0].activeTimelineId).toBe('take-1');
		for (const track of take.tracks) {
			expect(track.id).toBe(`track-${track.objectId}`);
			expect(track.startMs).toBe(0);
			expect(track.durationMs).toBe(8000);
			for (const curve of track.curves) {
				expect(curve.id).toBe(`${track.objectId}-${curve.prop}`);
			}
		}
		const view = v1View(doc);
		expect(view.timeline.tracks.some((t) => t.target.endsWith('.progress'))).toBe(true);
		expect(view.timeline.tracks.some((t) => t.target === 'mark:title.opacity')).toBe(true);
	});

	it('slices over-cap v2 input instead of validate-erroring', () => {
		const objects = Array.from({ length: MAX_OBJECTS_PER_SCENE + 10 }, (_, i) => ({
			id: `o${i}`,
			kind: 'text',
			transform: { x: 0, y: 0, w: 10, h: 10, rotation: 0, opacity: 1 }
		}));
		const tracks = Array.from({ length: MAX_TRACKS_PER_TAKE + 5 }, (_, i) => ({
			id: `tr${i}`,
			objectId: 'o0',
			startMs: 0,
			durationMs: 100,
			curves: [
				{
					id: `c${i}`,
					prop: 'opacity',
					keyframes: Array.from({ length: MAX_KEYS_PER_CURVE + 3 }, (_, k) => ({
						tMs: k,
						value: 1
					}))
				}
			]
		}));
		const timelines = Array.from({ length: MAX_TAKES_PER_SCENE + 2 }, (_, i) => ({
			id: `take-${i}`,
			name: `Take ${i}`,
			durationMs: 8000,
			posterMs: 8000,
			tracks: i === 0 ? tracks : []
		}));
		const scenes = Array.from({ length: MAX_SCENES + 4 }, (_, i) => ({
			id: `scene-${i}`,
			name: `Scene ${i}`,
			objects: i === 0 ? objects : [],
			timelines,
			activeTimelineId: 'take-0'
		}));
		const doc = parseIgfx({
			format: 'igfx',
			schemaVersion: 2,
			scenes
		});
		expect(doc.scenes).toHaveLength(MAX_SCENES);
		expect(doc.scenes[0].objects).toHaveLength(MAX_OBJECTS_PER_SCENE);
		expect(doc.scenes[0].timelines).toHaveLength(MAX_TAKES_PER_SCENE);
		expect(doc.scenes[0].timelines[0].tracks).toHaveLength(MAX_TRACKS_PER_TAKE);
		expect(doc.scenes[0].timelines[0].tracks[0].curves[0].keyframes).toHaveLength(MAX_KEYS_PER_CURVE);
	});
});
