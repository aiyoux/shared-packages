import { describe, expect, it } from 'vitest';
import {
	createDocument,
	IGFX_FORMAT,
	MAX_DATASET_COLUMNS,
	MAX_DATASET_ROWS,
	parseIgfx,
	serializeIgfx,
	validate
} from './index.js';

describe('parseIgfx', () => {
	it('rejects the wrong format', () => {
		expect(() => parseIgfx({ format: 'skch' })).toThrow(/format/i);
		expect(() => parseIgfx({ format: 'info' })).toThrow(/format/i);
		expect(() => parseIgfx(null)).toThrow(/object/i);
	});

	it('accepts format igfx and fills defaults', () => {
		const doc = parseIgfx({ format: IGFX_FORMAT });
		expect(doc.format).toBe('igfx');
		expect(doc.schemaVersion).toBe(1);
		expect(doc.artboard).toEqual({ width: 1920, height: 1080 });
		expect(doc.timeline.durationMs).toBe(8000);
		expect(doc.timeline.posterMs).toBe(8000);
		expect(doc.timeline.tracks).toEqual([]);
		expect(doc.mediaBed).toBeUndefined();
		expect(doc.lastExport).toBeUndefined();
		expect(typeof doc.theme.fontFamily).toBe('string');
		expect(typeof doc.theme.fontMono).toBe('string');
	});

	it('strips unknown mark kinds rather than failing', () => {
		const doc = parseIgfx({
			format: 'igfx',
			marks: [
				{ id: 'cube', kind: 'scene3d', layout: { x: 0, y: 0, w: 10, h: 10 }, bindings: {} },
				{ id: 't', kind: 'text', layout: { x: 0, y: 0, w: 10, h: 10 }, bindings: { text: 'hi' } }
			]
		});
		expect(doc.marks.map((m) => m.kind)).toEqual(['text']);
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
		expect(validate(createDocument()).ok).toBe(true);
	});
});
