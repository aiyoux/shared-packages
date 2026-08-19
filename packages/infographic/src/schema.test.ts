import { describe, expect, it } from 'vitest';
import {
	createDocument,
	createScene,
	getActiveScene,
	getActiveTake,
	IGFX_FORMAT,
	MAX_DATASET_COLUMNS,
	MAX_DATASET_ROWS,
	MAX_KEYS_PER_CURVE,
	MAX_OBJECTS_PER_SCENE,
	MAX_POINTS_PER_SERIES,
	MAX_SCENES,
	MAX_TAKES_PER_SCENE,
	MAX_TRACKS_PER_TAKE,
	parseIgfx,
	serializeIgfx,
	v1View,
	validate,
	type IgfxObject,
	type SceneTimeline,
	type SceneTrack
} from './index.js';

describe('parseIgfx', () => {
	it('rejects the wrong format', () => {
		expect(() => parseIgfx({ format: 'skch' })).toThrow(/format/i);
		expect(() => parseIgfx({ format: 'info' })).toThrow(/format/i);
		expect(() => parseIgfx(null)).toThrow(/object/i);
	});

	it('accepts format igfx and fills defaults as a one-scene v2 collection', () => {
		const doc = parseIgfx({ format: IGFX_FORMAT });
		expect(doc.format).toBe('igfx');
		expect(doc.schemaVersion).toBe(2);
		expect(doc.artboard).toEqual({ width: 1920, height: 1080 });
		expect(doc.scenes).toHaveLength(1);
		expect(doc.scenes[0].id).toBe('scene-default');
		expect(doc.activeSceneId).toBe('scene-default');
		const take = getActiveTake(doc.scenes[0]);
		expect(take.id).toBe('take-1');
		expect(take.durationMs).toBe(8000);
		expect(take.posterMs).toBe(8000);
		expect(take.tracks).toEqual([]);
		expect(doc.scenes[0].mediaBed).toBeUndefined();
		expect(doc.lastExport).toBeUndefined();
		expect(('marks' in doc) as boolean).toBe(false);
		expect(('timeline' in doc) as boolean).toBe(false);
		expect(('mediaBed' in doc) as boolean).toBe(false);
		expect(typeof doc.theme.fontFamily).toBe('string');
		expect(typeof doc.theme.fontMono).toBe('string');
		const view = v1View(doc);
		expect(view.marks).toEqual([]);
		expect(view.timeline.durationMs).toBe(8000);
	});

	it('strips unknown mark kinds rather than failing', () => {
		const doc = parseIgfx({
			format: 'igfx',
			marks: [
				{ id: 'blob', kind: 'blob', layout: { x: 0, y: 0, w: 10, h: 10 }, bindings: {} },
				{ id: 't', kind: 'text', layout: { x: 0, y: 0, w: 10, h: 10 }, bindings: { text: 'hi' } }
			]
		});
		expect(getActiveScene(doc).objects.map((o) => o.kind)).toEqual(['text']);
	});

	it('keeps scene3d persist shape and drops previewPaths', () => {
		const doc = parseIgfx({
			format: 'igfx',
			marks: [
				{
					id: 'cube',
					kind: 'scene3d',
					layout: { x: 10, y: 20, w: 200, h: 150 },
					scene: {
						objects: [
							{
								id: 'box',
								primitive: 'box',
								position: [0, 0, 0],
								rotation: [0, 0.2, 0],
								scale: [1, 1, 1],
								color: '#f00'
							}
						],
						camera: { position: [2, 2, 2], target: [0, 0, 0], fov: 40 }
					},
					bindings: { values: { ref: 'dataset:d.n' } },
					previewPaths: [{ d: 'M0 0', stroke: '#000', fill: 'none', strokeWidth: 1 }]
				}
			]
		});
		const objects = getActiveScene(doc).objects;
		expect(objects).toHaveLength(1);
		const obj = objects[0];
		expect(obj.kind).toBe('scene3d');
		expect(obj.scene?.objects[0]?.primitive).toBe('box');
		expect(obj.scene?.camera.fov).toBe(40);
		expect(obj.bindings?.values).toEqual({ ref: 'dataset:d.n' });
		expect('previewPaths' in obj).toBe(false);
		const again = parseIgfx(JSON.parse(serializeIgfx(doc)));
		expect(getActiveScene(again).objects[0]?.kind).toBe('scene3d');
		expect(JSON.stringify(again)).not.toContain('previewPaths');
	});

	it('caps datasets at 500 rows and 20 columns', () => {
		const columns = Array.from({ length: 25 }, (_, i) => ({
			id: `c${i}`,
			label: `C${i}`,
			type: 'number' as const
		}));
		const rows = Array.from({ length: 600 }, (_, i) => {
			const row: Record<string, number> = {};
			for (let c = 0; c < 25; c += 1) row[`c${c}`] = i + c;
			return row;
		});
		const doc = parseIgfx({
			format: 'igfx',
			datasets: [{ id: 'big', label: 'Big', columns, rows }]
		});
		expect(doc.datasets[0].rows).toHaveLength(MAX_DATASET_ROWS);
		expect(doc.datasets[0].columns).toHaveLength(MAX_DATASET_COLUMNS);
	});

	it('round-trips through serializeIgfx', () => {
		const created = createDocument('Demo');
		const again = parseIgfx(JSON.parse(serializeIgfx(created)));
		expect(again.name).toBe('Demo');
		expect(again.format).toBe('igfx');
		expect(again.schemaVersion).toBe(2);
		expect(again.scenes).toHaveLength(1);
		expect(JSON.parse(serializeIgfx(created)).marks).toBeUndefined();
		expect(JSON.parse(serializeIgfx(created)).timeline).toBeUndefined();
		expect(JSON.parse(serializeIgfx(created)).mediaBed).toBeUndefined();
	});

	it('synthesizes a scene when v2 scenes are empty', () => {
		const doc = parseIgfx({ format: 'igfx', schemaVersion: 2, scenes: [] });
		expect(doc.scenes).toHaveLength(1);
		expect(doc.scenes[0].timelines).toHaveLength(1);
		expect(doc.activeSceneId).toBe(doc.scenes[0].id);
	});

	it('fills a partial scene artboard from the collection default', () => {
		const doc = parseIgfx({
			format: 'igfx',
			schemaVersion: 2,
			artboard: { width: 1920, height: 1080 },
			scenes: [
				{
					id: 's',
					name: 'Scene',
					artboard: { width: 1080 },
					objects: [],
					timelines: [{ id: 't', name: 'Take 1', durationMs: 8000, posterMs: 8000, tracks: [] }],
					activeTimelineId: 't'
				}
			],
			activeSceneId: 's'
		});
		expect(doc.scenes[0].artboard).toEqual({ width: 1080, height: 1080 });
	});

	it('strips orphan points before applying the 256-object cap', () => {
		const orphans = Array.from({ length: MAX_OBJECTS_PER_SCENE }, (_, i) => ({
			id: `p${i}`,
			kind: 'point',
			parentId: null,
			point: { x: 0, y: 0 }
		}));
		const doc = parseIgfx({
			format: 'igfx',
			schemaVersion: 2,
			scenes: [
				{
					id: 's',
					name: 'Scene',
					objects: [
						...orphans,
						{
							id: 'keep',
							kind: 'text',
							transform: { x: 0, y: 0, w: 10, h: 10, rotation: 0, opacity: 1 },
							bindings: { text: 'kept' }
						}
					],
					timelines: [{ id: 't', name: 'Take 1', durationMs: 8000, posterMs: 8000, tracks: [] }],
					activeTimelineId: 't'
				}
			],
			activeSceneId: 's'
		});
		expect(doc.scenes[0].objects.map((o) => o.id)).toEqual(['keep']);
	});
});

describe('validate', () => {
	it('flags a live document over the row cap', () => {
		const doc = createDocument();
		doc.datasets.push({
			id: 'd',
			label: 'D',
			columns: [{ id: 'n', label: 'N', type: 'number' }],
			rows: Array.from({ length: 501 }, (_, i) => ({ n: i }))
		});
		const result = validate(doc);
		expect(result.ok).toBe(false);
		expect(result.errors.some((e) => /500/.test(e))).toBe(true);
	});

	it('accepts a fresh createDocument', () => {
		const doc = createDocument();
		expect(doc.schemaVersion).toBe(2);
		expect(doc.scenes).toHaveLength(1);
		expect(doc.scenes[0].objects).toEqual([]);
		expect(validate(doc).ok).toBe(true);
	});

	it('warns when a track objectId is missing', () => {
		const doc = createDocument();
		getActiveTake(getActiveScene(doc)).tracks.push({
			id: 'track-gone',
			objectId: 'gone',
			startMs: 0,
			durationMs: 8000,
			curves: []
		});
		const result = validate(doc);
		expect(result.ok).toBe(true);
		expect(result.warnings.some((w) => /objectId "gone"/.test(w))).toBe(true);
	});

	it('refuses in-memory adds that exceed scene/object/take/track/key/point caps', () => {
		const stubObject = (id: string, extra: Partial<IgfxObject> = {}): IgfxObject => ({
			id,
			name: id,
			parentId: null,
			kind: 'text',
			visible: true,
			transform: { x: 0, y: 0, w: 10, h: 10, rotation: 0, opacity: 1 },
			...extra
		});

		const overScenes = createDocument();
		overScenes.scenes = Array.from({ length: MAX_SCENES + 1 }, (_, i) => {
			const scene = createScene(`S${i}`);
			scene.id = `s${i}`;
			return scene;
		});
		overScenes.activeSceneId = overScenes.scenes[0].id;
		expect(validate(overScenes).ok).toBe(false);
		expect(validate(overScenes).errors).toContain(`scene cap ${MAX_SCENES}`);

		const overObjects = createDocument();
		getActiveScene(overObjects).objects = Array.from({ length: MAX_OBJECTS_PER_SCENE + 1 }, (_, i) =>
			stubObject(`o${i}`)
		);
		expect(validate(overObjects).errors).toContain(`object cap ${MAX_OBJECTS_PER_SCENE}`);

		const overTakes = createDocument();
		const takeScene = getActiveScene(overTakes);
		takeScene.timelines = Array.from({ length: MAX_TAKES_PER_SCENE + 1 }, (_, i) => ({
			id: `take-${i}`,
			name: `Take ${i}`,
			durationMs: 8000,
			posterMs: 8000,
			tracks: []
		}));
		takeScene.activeTimelineId = takeScene.timelines[0].id;
		expect(validate(overTakes).errors).toContain(`take cap ${MAX_TAKES_PER_SCENE}`);

		const overTracks = createDocument();
		const trackTake = getActiveTake(getActiveScene(overTracks));
		trackTake.tracks = Array.from({ length: MAX_TRACKS_PER_TAKE + 1 }, (_, i) => ({
			id: `tr${i}`,
			objectId: 'missing',
			startMs: 0,
			durationMs: 100,
			curves: []
		})) as SceneTrack[];
		expect(validate(overTracks).errors).toContain(`track cap ${MAX_TRACKS_PER_TAKE}`);

		const overKeys = createDocument();
		getActiveTake(getActiveScene(overKeys)).tracks.push({
			id: 'track-k',
			objectId: 'missing',
			startMs: 0,
			durationMs: 100,
			curves: [
				{
					id: 'c',
					prop: 'opacity',
					keyframes: Array.from({ length: MAX_KEYS_PER_CURVE + 1 }, (_, i) => ({ tMs: i, value: 1 }))
				}
			]
		});
		expect(validate(overKeys).errors).toContain(`key cap ${MAX_KEYS_PER_CURVE}`);

		const overPoints = createDocument();
		const pointScene = getActiveScene(overPoints);
		pointScene.objects = [
			stubObject('series', { kind: 'series', series: { mode: 'bars' } }),
			...Array.from({ length: MAX_POINTS_PER_SERIES + 1 }, (_, i) =>
				stubObject(`p${i}`, { kind: 'point', parentId: 'series', point: { x: i, y: 1 } })
			)
		];
		expect(validate(overPoints).errors).toContain(`point cap ${MAX_POINTS_PER_SERIES}`);
	});

	it('does not fail validate on a freshly parsed over-cap file (already sliced)', () => {
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
		})) as SceneTimeline[];
		const scenes = Array.from({ length: MAX_SCENES + 4 }, (_, i) => ({
			id: `scene-${i}`,
			name: `Scene ${i}`,
			objects: i === 0 ? objects : [],
			timelines,
			activeTimelineId: 'take-0'
		}));
		const parsed = parseIgfx({ format: 'igfx', schemaVersion: 2, scenes });
		expect(parsed.scenes).toHaveLength(MAX_SCENES);
		expect(validate(parsed).ok).toBe(true);
	});
});
