import { describe, expect, it } from 'vitest';
import { applySelection, diffLines, type DiffHunk } from './diffLines.js';

function flat(hunks: DiffHunk[]) {
	return hunks.flatMap((h) => h.lines.map((l) => `${l.kind}:${l.text}`));
}

describe('diffLines', () => {
	it('reports identical text as unchanged', () => {
		expect(diffLines('a\nb\n', 'a\nb\n')).toEqual({ kind: 'unchanged' });
	});

	it('diffs a pure addition', () => {
		const d = diffLines('a\nb\n', 'a\nx\nb\n');
		if (d.kind !== 'text') throw new Error('expected text');
		expect(flat(d.hunks)).toEqual(['ctx:a', 'add:x', 'ctx:b']);
	});

	it('diffs a pure deletion', () => {
		const d = diffLines('a\nb\nc\n', 'a\nc\n');
		if (d.kind !== 'text') throw new Error('expected text');
		expect(flat(d.hunks)).toEqual(['ctx:a', 'del:b', 'ctx:c']);
	});

	it('diffs a replaced line as del+add', () => {
		const d = diffLines('a\nb\nc\n', 'a\nB\nc\n');
		if (d.kind !== 'text') throw new Error('expected text');
		expect(flat(d.hunks)).toEqual(['ctx:a', 'del:b', 'add:B', 'ctx:c']);
	});

	it('diffs against an empty old text (a newly added file)', () => {
		const d = diffLines('', 'one\ntwo\n');
		if (d.kind !== 'text') throw new Error('expected text');
		expect(flat(d.hunks)).toEqual(['add:one', 'add:two']);
	});

	it('diffs against an empty new text (a deleted file)', () => {
		const d = diffLines('one\ntwo\n', '');
		if (d.kind !== 'text') throw new Error('expected text');
		expect(flat(d.hunks)).toEqual(['del:one', 'del:two']);
	});

	it('splits far-apart changes into separate hunks, dropping distant context', () => {
		const lines = Array.from({ length: 40 }, (_, i) => `line${i}`);
		const oldText = lines.join('\n') + '\n';
		const changed = [...lines];
		changed[5] = 'CHANGED5';
		changed[30] = 'CHANGED30';
		const newText = changed.join('\n') + '\n';
		const d = diffLines(oldText, newText, 2);
		if (d.kind !== 'text') throw new Error('expected text');
		expect(d.hunks).toHaveLength(2);
		// Each hunk carries only nearby context, not the whole 40-line file.
		expect(d.hunks[0]!.lines.length).toBeLessThan(10);
		expect(d.hunks[1]!.lines.length).toBeLessThan(10);
	});

	it('strips a trailing CR from displayed text but keeps it byte-exact on reconstruction', () => {
		const oldText = 'a\r\nb\r\nc\r\n';
		const newText = 'a\r\nB\r\nc\r\n';
		const d = diffLines(oldText, newText);
		if (d.kind !== 'text') throw new Error('expected text');
		const lines = d.hunks.flatMap((h) => h.lines);
		// Displayed text never carries a stray \r...
		for (const l of lines) expect(l.text.endsWith('\r')).toBe(false);
		// ...but a no-op selection still reconstructs the CRLF file exactly.
		expect(applySelection(oldText, newText, new Set())).toBe(newText);
	});

	it('assigns stable, increasing opIndex across hunks', () => {
		const d = diffLines('a\nb\nc\nd\ne\n', 'a\nB\nc\nD\ne\n', 0);
		if (d.kind !== 'text') throw new Error('expected text');
		const indexes = d.hunks.flatMap((h) => h.lines.map((l) => l.opIndex));
		for (let i = 1; i < indexes.length; i++) expect(indexes[i]!).toBeGreaterThan(indexes[i - 1]!);
	});
});

describe('applySelection', () => {
	it('with nothing excluded, reconstructs the new text', () => {
		const oldText = 'a\nb\nc\n';
		const newText = 'a\nB\nc\nd\n';
		expect(applySelection(oldText, newText, new Set())).toBe(newText);
	});

	it('excluding an add line drops just that addition', () => {
		const oldText = 'a\nb\n';
		const newText = 'a\nx\nb\ny\n';
		const d = diffLines(oldText, newText);
		if (d.kind !== 'text') throw new Error('expected text');
		const addY = d.hunks.flatMap((h) => h.lines).find((l) => l.kind === 'add' && l.text === 'y')!;
		const out = applySelection(oldText, newText, new Set([addY.opIndex]));
		expect(out).toBe('a\nx\nb\n');
	});

	it('excluding a del line keeps that old line', () => {
		const oldText = 'a\nb\nc\n';
		const newText = 'a\nc\n';
		const d = diffLines(oldText, newText);
		if (d.kind !== 'text') throw new Error('expected text');
		const delB = d.hunks.flatMap((h) => h.lines).find((l) => l.kind === 'del')!;
		const out = applySelection(oldText, newText, new Set([delB.opIndex]));
		expect(out).toBe('a\nb\nc\n');
	});

	it('excluding everything reconstructs the old text', () => {
		const oldText = 'a\nb\nc\n';
		const newText = 'a\nB\nc\nd\n';
		const d = diffLines(oldText, newText);
		if (d.kind !== 'text') throw new Error('expected text');
		const all = new Set(
			d.hunks.flatMap((h) => h.lines).filter((l) => l.kind !== 'ctx').map((l) => l.opIndex)
		);
		expect(applySelection(oldText, newText, all)).toBe(oldText);
	});

	it('reconstructs a partial delete: only the deselected removal survives', () => {
		const oldText = 'keep1\ngone1\nkeep2\ngone2\nkeep3\n';
		const newText = 'keep1\nkeep2\nkeep3\n';
		const d = diffLines(oldText, newText, 5);
		if (d.kind !== 'text') throw new Error('expected text');
		const dels = d.hunks.flatMap((h) => h.lines).filter((l) => l.kind === 'del');
		expect(dels).toHaveLength(2);
		// Exclude (i.e. don't apply) the removal of gone1 — keep it in the result.
		const out = applySelection(oldText, newText, new Set([dels[0]!.opIndex]));
		expect(out).toBe('keep1\ngone1\nkeep2\nkeep3\n');
	});
});
