import { describe, expect, it } from 'vitest';
import {
	DigrParseError,
	parseDigrDocument,
	serializeDigrDocument
} from './document.js';
import type { DigrDocument } from './types.js';

const doc: DigrDocument = {
	schemaVersion: 1,
	nodes: [
		{ id: 'n1', x: 10, y: 20, w: 120, h: 60, text: 'Hello', style: { fill: '#ff0055' } },
		{ id: 'n2', x: 0, y: 0, w: 80, h: 40, rotation: 0.5, text: '' }
	],
	canvas: { w: 1600, h: 1000 }
};

describe('parseDigrDocument', () => {
	it('round-trips a document through serialize + parse', () => {
		const parsed = parseDigrDocument(serializeDigrDocument(doc));
		expect(parsed).toEqual(doc);
	});

	it('is byte-stable across a re-serialize', () => {
		const once = serializeDigrDocument(doc);
		const twice = serializeDigrDocument(parseDigrDocument(once));
		expect(twice).toBe(once);
	});

	it('parses from bytes and from JSON strings', () => {
		const bytes = new TextEncoder().encode(JSON.stringify(doc));
		expect(parseDigrDocument(bytes)).toEqual(doc);
		expect(parseDigrDocument(JSON.stringify(doc))).toEqual(doc);
	});

	it('accepts Uint8Array views over a larger buffer', () => {
		const bytes = new TextEncoder().encode(JSON.stringify(doc));
		const padded = new Uint8Array(bytes.length + 4);
		padded.set(bytes, 2);
		const view = new Uint8Array(padded.buffer, 2, bytes.length);
		expect(parseDigrDocument(view)).toEqual(doc);
	});

	it('defaults the canvas and empty text', () => {
		const parsed = parseDigrDocument({ schemaVersion: 1, nodes: [{ id: 'a', x: 0, y: 0, w: 10, h: 10 }] });
		expect(parsed.canvas).toEqual({ w: 1600, h: 1000 });
		expect(parsed.nodes[0].text).toBe('');
		expect(parsed.view).toBeUndefined();
	});

	it('keeps a persisted view block', () => {
		const parsed = parseDigrDocument({
			schemaVersion: 1,
			nodes: [],
			canvas: { w: 100, h: 100 },
			view: { layout: { kind: 'leaf' }, windows: { leaf1: { role: 'canvas' } } }
		});
		expect(parsed.view).toEqual({
			layout: { kind: 'leaf' },
			windows: { leaf1: { role: 'canvas' } }
		});
	});

	it('rejects the wrong schemaVersion', () => {
		expect(() => parseDigrDocument({ schemaVersion: 2, nodes: [] })).toThrow(DigrParseError);
	});

	it('rejects malformed nodes', () => {
		expect(() => parseDigrDocument({ schemaVersion: 1, nodes: [{}] })).toThrow(DigrParseError);
		expect(() =>
			parseDigrDocument({ schemaVersion: 1, nodes: [{ id: 'a', x: NaN, y: 0, w: 1, h: 1 }] })
		).toThrow(DigrParseError);
		expect(() =>
			parseDigrDocument({
				schemaVersion: 1,
				nodes: [{ id: 'a', x: 0, y: 0, w: 1, h: 1, style: { fill: 'red' } }]
			})
		).toThrow(DigrParseError);
	});

	it('rejects non-positive canvas dimensions', () => {
		expect(() =>
			parseDigrDocument({ schemaVersion: 1, nodes: [], canvas: { w: 0, h: 100 } })
		).toThrow(DigrParseError);
	});

	it('rejects invalid input shapes', () => {
		expect(() => parseDigrDocument('not json')).toThrow(DigrParseError);
		expect(() => parseDigrDocument([])).toThrow(DigrParseError);
		expect(() => parseDigrDocument({ schemaVersion: 1 })).toThrow(DigrParseError);
	});
});

describe('serializeDigrDocument', () => {
	it('drops unknown fields', () => {
		const dirty = { ...doc, someday: 'maybe' } as unknown as DigrDocument;
		const clean = JSON.parse(serializeDigrDocument(dirty)) as Record<string, unknown>;
		expect(Object.keys(clean)).toEqual(['schemaVersion', 'nodes', 'canvas']);
	});

	it('omits absent optional fields rather than writing nulls', () => {
		const minimal: DigrDocument = { schemaVersion: 1, nodes: [], canvas: { w: 10, h: 10 } };
		expect(JSON.parse(serializeDigrDocument(minimal))).toEqual({
			schemaVersion: 1,
			nodes: [],
			canvas: { w: 10, h: 10 }
		});
	});
});

