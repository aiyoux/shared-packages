import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createEmptyPage } from './createEmptyPage.js';
import { normalizePage } from './normalize.js';
import { parseKb } from './parse.js';
import { serializeKb } from './serialize.js';
import { KB_FORMAT, type KbPage } from './types.js';

const goldensDir = join(dirname(fileURLToPath(import.meta.url)), 'goldens');

function page(partial: Partial<KbPage> & { blocks: KbPage['blocks'] }): KbPage {
	return normalizePage({
		format: KB_FORMAT,
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

	it('rejects empty documents without Unexpected end of JSON', () => {
		expect(() => parseKb('')).toThrow(/empty/i);
		expect(() => parseKb('   \n')).toThrow(/empty/i);
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

	it('ignores a legacy schemaVersion key on read and drops it on resave', () => {
		const raw = {
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
		};
		const parsed = parseKb(raw);
		expect(parsed).not.toHaveProperty('schemaVersion');
		expect(parsed.blocks[0]).toMatchObject({ type: 'callout', variant: 'info' });
		const resaved = JSON.parse(serializeKb(parsed)) as Record<string, unknown>;
		expect(resaved).not.toHaveProperty('schemaVersion');
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
});