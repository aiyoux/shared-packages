import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createEmptyPage } from './createEmptyPage.js';
import { normalizePage } from './normalize.js';
import { parseKb } from './parse.js';
import { serializeKb } from './serialize.js';
import { KB_FORMAT, type Block, type KbPage } from './types.js';

const goldenPath = join(dirname(fileURLToPath(import.meta.url)), 'goldens/all-blocks.json');

const PAGE_KEYS = [
	'format',
	'schemaVersion',
	'id',
	'title',
	'createdAt',
	'updatedAt',
	'children',
	'blocks'
];

function shuffledPage(): KbPage {
	const page = {
		blocks: [
			{
				content: [
					{
						marks: [{ type: 'bold' as const }],
						text: 'Hello',
						type: 'text' as const
					}
				],
				type: 'paragraph' as const,
				id: 'p1'
			},
			{
				content: [{ marks: [], text: 'Section', type: 'text' as const }],
				level: 2 as const,
				type: 'heading' as const,
				id: 'h1'
			},
			{
				content: [{ marks: [{ type: 'code' as const }], text: 'Item', type: 'text' as const }],
				ordered: true,
				type: 'list_item' as const,
				id: 'li1'
			},
			{ text: 'const n = 1;\n', language: 'ts', type: 'code' as const, id: 'c1' },
			{ type: 'divider' as const, id: 'd1' },
			{ alt: 'Diagram', src: 'assets/diagram.png', type: 'image' as const, id: 'i1' }
		] as Block[],
		children: ['child-a', 'child-b'],
		updatedAt: '2026-01-01T00:00:00.000Z',
		createdAt: '2026-01-01T00:00:00.000Z',
		title: 'Golden',
		id: 'page-gold',
		schemaVersion: 1,
		format: KB_FORMAT
	};
	return page;
}

describe('serializeKb', () => {
	it('pretty-prints indent 2 with a single trailing newline', () => {
		const page = createEmptyPage({ id: 'id', title: 'T' });
		page.createdAt = '2026-01-01T00:00:00.000Z';
		page.updatedAt = '2026-01-01T00:00:00.000Z';
		const raw = serializeKb(page);
		expect(raw.endsWith('\n')).toBe(true);
		expect(raw.slice(0, -1).endsWith('\n')).toBe(false);
		expect(raw).toMatch(/^{\n  "format": "kb",\n  "schemaVersion": 1,/);
		expect(raw).toContain('\n  "blocks": [');
	});

	it('emits keys in the locked order even if the input was shuffled', () => {
		const raw = serializeKb(shuffledPage());
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		expect(Object.keys(parsed)).toEqual(PAGE_KEYS);
		const blocks = parsed.blocks as Record<string, unknown>[];
		expect(Object.keys(blocks[0])).toEqual(['id', 'type', 'content']);
		expect(Object.keys(blocks[1])).toEqual(['id', 'type', 'level', 'content']);
		expect(Object.keys(blocks[2])).toEqual(['id', 'type', 'ordered', 'content']);
		expect(Object.keys(blocks[3])).toEqual(['id', 'type', 'language', 'text']);
		expect(Object.keys(blocks[4])).toEqual(['id', 'type']);
		expect(Object.keys(blocks[5])).toEqual(['id', 'type', 'src', 'alt']);
		const span = (blocks[0].content as Record<string, unknown>[])[0];
		expect(Object.keys(span)).toEqual(['type', 'text', 'marks']);
		expect(raw.indexOf('"format"')).toBeLessThan(raw.indexOf('"schemaVersion"'));
		expect(raw.indexOf('"schemaVersion"')).toBeLessThan(raw.indexOf('"id"'));
		expect(raw.indexOf('"children"')).toBeLessThan(raw.indexOf('"blocks"'));
	});

	it('matches the all-blocks golden byte-for-byte', () => {
		const golden = readFileSync(goldenPath, 'utf8');
		expect(golden.endsWith('\n')).toBe(true);
		expect(serializeKb(parseKb(golden))).toBe(golden);
	});
});
