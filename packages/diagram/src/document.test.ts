import { describe, expect, it } from 'vitest';
import {
	DigrParseError,
	ensureDigrIdentity,
	parseDigrDocument,
	parseDigrView,
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
		expect(parsed.id).toBeUndefined();
	});

	it('never writes a view into the document, and ignores one on read', () => {
		// The view is per-viewer state kept outside the file (docViewStore), so
		// the serialized bytes must be identical on two machines whose layouts
		// differ — that is what offline-project-collab.md 5.2 needs, and it is
		// what lets `.digr` be merged without conflicting on window chrome.
		const stale = parseDigrDocument({
			schemaVersion: 1,
			nodes: [],
			canvas: { w: 100, h: 100 },
			view: { layout: { kind: 'leaf' }, windows: { leaf1: { role: 'canvas' } } }
		});
		expect('view' in stale).toBe(false);
		expect(JSON.parse(serializeDigrDocument(stale))).not.toHaveProperty('view');
	});

	it('round-trips travelling identity and mints it once', () => {
		const parsed = parseDigrDocument({
			schemaVersion: 1,
			id: 'digr-1',
			createdAt: 42,
			nodes: [],
			canvas: { w: 100, h: 100 }
		});
		expect(parsed.id).toBe('digr-1');
		expect(parsed.createdAt).toBe(42);
		expect(JSON.parse(serializeDigrDocument(parsed))).toMatchObject({
			id: 'digr-1',
			createdAt: 42
		});

		const fresh = ensureDigrIdentity({ schemaVersion: 1, nodes: [], canvas: { w: 1, h: 1 } });
		expect(typeof fresh.id).toBe('string');
		expect(fresh.id).not.toBe('');
		// Idempotent: a document that already has identity keeps the same object,
		// so a save cannot quietly re-mint and orphan the stored view record.
		expect(ensureDigrIdentity(fresh)).toBe(fresh);
	});

	it('validates a stored view record without it being part of the document', () => {
		const view = {
			layout: { kind: 'split', id: 'digr-root', direction: 'row', ratio: 0.5 },
			windows: { 'digr-canvas': { role: 'canvas' } }
		};
		expect(parseDigrView(view)).toEqual(view);
		expect(parseDigrView(undefined)).toBeUndefined();
		expect(parseDigrView({ windows: {} })).toBeUndefined();
		expect(() => parseDigrView({ windows: { a: { role: '' } } })).toThrow(DigrParseError);
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

