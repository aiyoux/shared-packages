import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createEmptyPage } from './createEmptyPage.js';
import { normalizePage } from './normalize.js';
import { isSchemaUnderstood, schemaWriteAllowed } from './migrate.js';
import { parseKb, parseKbDocument } from './parse.js';
import { serializeKb } from './serialize.js';
import { KB_FORMAT, KB_SCHEMA_VERSION, type KbPage } from './types.js';

const goldensDir = join(dirname(fileURLToPath(import.meta.url)), 'goldens');

function page(partial: Partial<KbPage> & { blocks: KbPage['blocks'] }): KbPage {
	return normalizePage({
		format: KB_FORMAT,
		schemaVersion: 1,
		id: 'page-1',
		title: 'Title',
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
		children: [],
		...partial
	});
}

describe('parseKb', () => {
	it('rejects unknown format', () => {
		expect(() => parseKb('{"format":"md"}')).toThrow(/unknown format/i);
		expect(() => parseKb({ format: 'igfx' })).toThrow(/unknown format/i);
		expect(() => parseKb(null)).toThrow(/object/i);
		expect(() => parseKb('[]')).toThrow(/object/i);
	});

	it('round-trips serialize identity including trailing newline and indent 2', () => {
		const empty = createEmptyPage({ id: 'empty-1', title: 'Empty' });
		empty.createdAt = '2026-01-01T00:00:00.000Z';
		empty.updatedAt = '2026-01-01T00:00:00.000Z';
		const serialized = serializeKb(empty);
		expect(serialized.endsWith('\n')).toBe(true);
		expect(serialized.endsWith('\n\n')).toBe(false);
		expect(serialized.startsWith('{\n  "format": "kb"')).toBe(true);
		expect(parseKb(serialized)).toEqual(normalizePage(empty));
		expect(serializeKb(parseKb(serialized))).toBe(serialized);
	});

	it('parses the all-blocks golden with key-order identity', () => {
		const raw = readFileSync(join(goldensDir, 'all-blocks.json'), 'utf8');
		const parsed = parseKb(raw);
		expect(serializeKb(parsed)).toBe(raw.endsWith('\n') ? raw : `${raw}\n`);
		expect(parsed.format).toBe(KB_FORMAT);
		expect(parsed.blocks.map((b) => b.type)).toEqual([
			'paragraph',
			'heading',
			'list_item',
			'code',
			'divider',
			'image'
		]);
	});

	it('migrates missing schemaVersion as v1', () => {
		const parsed = parseKb({
			format: 'kb',
			id: 'p',
			title: 't',
			createdAt: '2026-01-01T00:00:00.000Z',
			updatedAt: '2026-01-01T00:00:00.000Z',
			children: [],
			blocks: [{ id: 'b', type: 'paragraph', content: [{ type: 'text', text: 'hi', marks: [] }] }]
		});
		expect(parsed.schemaVersion).toBe(1);
		expect(parsed.blocks[0]).toMatchObject({ type: 'paragraph' });
	});

	it('strips unknown leaf types to a plaintext paragraph', () => {
		const parsed = parseKb({
			format: 'kb',
			id: 'p',
			title: 't',
			createdAt: '2026-01-01T00:00:00.000Z',
			updatedAt: '2026-01-01T00:00:00.000Z',
			children: [],
			blocks: [
				{
					id: 'widget',
					type: 'embed',
					content: [{ type: 'text', text: 'inner', marks: [] }]
				}
			]
		});
		expect(parsed.blocks).toHaveLength(1);
		expect(parsed.blocks[0]).toEqual({
			id: 'widget',
			type: 'paragraph',
			content: [{ type: 'text', text: 'inner', marks: [] }]
		});
	});

	it('does not HTML-parse markup strings', () => {
		expect(() => parseKb('<p>hello</p>')).toThrow();
	});

	it('keeps a known page through parse(serialize)', () => {
		const src = page({
			blocks: [
				{ id: 'p', type: 'paragraph', content: [{ type: 'text', text: 'hi', marks: [{ type: 'bold' }] }] }
			],
			children: ['slug']
		});
		expect(parseKb(serializeKb(src))).toEqual(src);
	});

	it('keeps a v1 file at schemaVersion 1 when it has no nested types', () => {
		const raw = readFileSync(join(goldensDir, 'all-blocks.json'), 'utf8');
		const parsed = parseKb(raw);
		expect(parsed.schemaVersion).toBe(1);
		expect(serializeKb(parsed)).toContain('"schemaVersion": 1');
		expect(JSON.parse(serializeKb(parsed)).schemaVersion).toBe(1);
	});

	it('parses a v2 callout file as writable schema 2', () => {
		const doc = parseKbDocument({
			format: 'kb',
			schemaVersion: 2,
			id: 'p',
			title: 't',
			createdAt: '2026-01-01T00:00:00.000Z',
			updatedAt: '2026-01-01T00:00:00.000Z',
			children: [],
			blocks: [
				{
					id: 'c',
					type: 'callout',
					variant: 'info',
					children: [{ id: 'n', type: 'paragraph', content: [{ type: 'text', text: 'in', marks: [] }] }]
				}
			]
		});
		expect(doc.schemaVersion).toBe(2);
		expect(doc.understood).toBe(true);
		expect(doc.writable).toBe(true);
		expect(doc.page.blocks[0]).toMatchObject({ type: 'callout', variant: 'info' });
		expect(JSON.parse(serializeKb(doc.page)).schemaVersion).toBe(2);
	});

	it('stamps schemaVersion 2 only when serializing a nested type', () => {
		const v1 = parseKb({
			format: 'kb',
			schemaVersion: 1,
			id: 'p',
			title: 't',
			createdAt: '2026-01-01T00:00:00.000Z',
			updatedAt: '2026-01-01T00:00:00.000Z',
			children: [],
			blocks: [{ id: 'a', type: 'paragraph', content: [{ type: 'text', text: 'hi', marks: [] }] }]
		});
		expect(v1.schemaVersion).toBe(1);
		expect(JSON.parse(serializeKb(v1)).schemaVersion).toBe(1);

		const nested = parseKb({
			format: 'kb',
			schemaVersion: 1,
			id: 'p',
			title: 't',
			createdAt: '2026-01-01T00:00:00.000Z',
			updatedAt: '2026-01-01T00:00:00.000Z',
			children: [],
			blocks: [
				{
					id: 'c',
					type: 'callout',
					variant: 'note',
					children: [{ id: 'n', type: 'paragraph', content: [{ type: 'text', text: 'in', marks: [] }] }]
				}
			]
		});
		expect(nested.schemaVersion).toBe(1);
		expect(JSON.parse(serializeKb(nested)).schemaVersion).toBe(2);
		expect(KB_SCHEMA_VERSION).toBe(2);
	});

	it('does not clamp a future schemaVersion and does not smash unknown containers', () => {
		const raw = {
			format: 'kb',
			schemaVersion: 99,
			id: 'p',
			title: 't',
			createdAt: '2026-01-01T00:00:00.000Z',
			updatedAt: '2026-01-01T00:00:00.000Z',
			children: [],
			blocks: [
				{
					id: 'future',
					type: 'accordion',
					flag: true,
					children: [
						{ id: 'n', type: 'paragraph', content: [{ type: 'text', text: 'keep', marks: [] }] }
					]
				}
			]
		};
		const doc = parseKbDocument(raw);
		expect(doc.schemaVersion).toBe(99);
		expect(doc.understood).toBe(false);
		expect(doc.writable).toBe(false);
		expect(doc.flattenedUnknown).toBe(false);
		expect(isSchemaUnderstood(99)).toBe(false);
		expect(schemaWriteAllowed(99)).toBe(false);
		expect(doc.page.schemaVersion).toBe(99);
		expect(doc.page.blocks[0]).toMatchObject({
			id: 'future',
			type: 'accordion',
			flag: true
		});
		expect((doc.page.blocks[0] as { children: { id: string }[] }).children[0].id).toBe('n');
		expect(JSON.parse(serializeKb(doc.page)).schemaVersion).toBe(99);
		expect(JSON.parse(serializeKb(doc.page)).blocks[0].type).toBe('accordion');
	});

	it('flattens a future unknown container locally and marks the parse unwritable', () => {
		const doc = parseKbDocument({
			format: 'kb',
			schemaVersion: 2,
			id: 'p',
			title: 't',
			createdAt: '2026-01-01T00:00:00.000Z',
			updatedAt: '2026-01-01T00:00:00.000Z',
			children: [],
			blocks: [
				{ id: 'a', type: 'paragraph', content: [{ type: 'text', text: 'before', marks: [] }] },
				{
					id: 'acc',
					type: 'accordion',
					children: [
						{ id: 'n1', type: 'paragraph', content: [{ type: 'text', text: 'one', marks: [] }] },
						{ id: 'n2', type: 'paragraph', content: [{ type: 'text', text: 'two', marks: [] }] }
					]
				},
				{ id: 'z', type: 'paragraph', content: [{ type: 'text', text: 'after', marks: [] }] }
			]
		});
		expect(doc.understood).toBe(true);
		expect(doc.flattenedUnknown).toBe(true);
		expect(doc.writable).toBe(false);
		expect(schemaWriteAllowed(2, { flattenedUnknown: true })).toBe(false);
		expect(doc.page.blocks.map((b) => b.id)).toEqual(['a', 'n1', 'n2', 'z']);
		expect(doc.page.blocks.every((b) => b.type === 'paragraph')).toBe(true);
	});

	it('marks an empty unknown container unwritable even when children is empty', () => {
		const doc = parseKbDocument({
			format: 'kb',
			schemaVersion: 2,
			id: 'p',
			title: 't',
			createdAt: '2026-01-01T00:00:00.000Z',
			updatedAt: '2026-01-01T00:00:00.000Z',
			children: [],
			blocks: [
				{ id: 'a', type: 'paragraph', content: [{ type: 'text', text: 'keep', marks: [] }] },
				{ id: 'acc', type: 'accordion', children: [] }
			]
		});
		expect(doc.understood).toBe(true);
		expect(doc.flattenedUnknown).toBe(true);
		expect(doc.writable).toBe(false);
		expect(doc.page.blocks.map((b) => b.id)).toEqual(['a']);
	});
});
