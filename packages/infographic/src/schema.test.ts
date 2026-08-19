import { describe, expect, it } from 'vitest';
import {
	createDocument,
	getActiveScene,
	getActiveTake,
	IGFX_FORMAT,
	MAX_DATASET_COLUMNS,
	MAX_DATASET_ROWS,
	parseIgfx,
	serializeIgfx,
	v1View,
	validate
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
});
