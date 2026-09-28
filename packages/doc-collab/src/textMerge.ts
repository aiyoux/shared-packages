import fastDiff from 'fast-diff';

export type TextEdit = { start: number; end: number; text: string };

/** Replacement regions in base UTF-16 coordinates; adjacent diff runs coalesce. */
export function diffTextEdits(base: string, next: string): TextEdit[] {
	const edits: TextEdit[] = [];
	let pos = 0;
	let edit: TextEdit | null = null;
	const flush = () => {
		if (edit) edits.push(edit);
		edit = null;
	};
	for (const [op, text] of fastDiff(base, next)) {
		if (op === 0) {
			flush();
			pos += text.length;
			continue;
		}
		edit ??= { start: pos, end: pos, text: '' };
		if (op === -1) {
			pos += text.length;
			edit.end = pos;
		} else edit.text += text;
	}
	flush();
	return edits;
}

function overlaps(a: TextEdit, b: TextEdit): boolean {
	// Two inserts at one point are two people typing there: both stay, in
	// sequence order. Only the same insert (a rebase meeting its own text) is one.
	if (a.start === a.end && b.start === b.end)
		return a.start === b.start && a.text === b.text;
	if (a.start === a.end) return a.start > b.start && a.start < b.end;
	if (b.start === b.end) return b.start > a.start && b.start < a.end;
	return Math.max(a.start, b.start) < Math.min(a.end, b.end);
}

/**
 * Merge a submitted text change onto the sequencer's current text. Disjoint
 * edits survive, and so do different inserts at one point (the earlier
 * numbered first). On overlap the incoming (last numbered) replacement wins;
 * identical concurrent edits appear once. This is a state merge hook, not a
 * character CRDT: overlapping replacements are deliberately last-writer-wins.
 */
export function mergeTextChanges(
	base: string,
	incoming: string,
	current: string
): string {
	if (incoming === base || incoming === current) return current;
	if (current === base) return incoming;
	const proposed = diffTextEdits(base, incoming);
	const existing = diffTextEdits(base, current).filter(
		(edit) => !proposed.some((next) => overlaps(edit, next))
	);
	const edits = [...existing, ...proposed].sort(
		(a, b) => a.start - b.start || a.end - b.end
	);
	let result = '';
	let pos = 0;
	for (const edit of edits) {
		result += base.slice(pos, edit.start) + edit.text;
		pos = edit.end;
	}
	return result + base.slice(pos);
}
