/**
 * Line-level diff between two texts, grouped into hunks with surrounding
 * context — the model behind the commit panel's per-file expand.
 *
 * No dependency: this package stays dependency-light (isomorphic-git plus
 * two `file:` siblings), so the diff is a plain LCS (Wagner–Fischer) table
 * rather than pulling in a `diff` package for one file.
 *
 * LCS is O(N·M) time and space, which is fine for a changed region but not
 * for a whole large file — most edits are local, so the common prefix and
 * suffix are trimmed first and only the differing middle gets a table. A
 * file whose *inner* diff is still huge (a reformat, a generated file) comes
 * back `tooLarge` rather than building a table nobody will read line by line.
 */

export type DiffLineKind = 'ctx' | 'add' | 'del';

export type DiffLine = {
	kind: DiffLineKind;
	text: string;
	/** 1-based; null on the side that doesn't have this line. */
	oldNo: number | null;
	newNo: number | null;
	/** Index into the full (file-length) op sequence — the stable key for
	 *  "is this line/hunk included in the commit". Stable across `diffLines`
	 *  and `applySelection` as long as both are called with the same texts. */
	opIndex: number;
};

export type DiffHunk = {
	oldStart: number;
	oldLines: number;
	newStart: number;
	newLines: number;
	lines: DiffLine[];
};

export type FileDiff =
	| { kind: 'unchanged' }
	| { kind: 'binary' }
	| { kind: 'tooLarge' }
	| { kind: 'text'; hunks: DiffHunk[] };

/** Cells in the trimmed LCS table — bounds memory (a JS `number[][]` here,
 *  so keep this modest) rather than time; real edits rarely get near it once
 *  the common prefix/suffix is trimmed. */
const MAX_CELLS = 4_000_000;

type Op = { kind: DiffLineKind; aIdx?: number; bIdx?: number };

function splitLines(text: string): string[] {
	if (text === '') return [];
	const lines = text.split('\n');
	// A trailing '\n' produces a phantom empty last element — drop it so line
	// counts match what a reader sees, not the split artifact.
	if (lines[lines.length - 1] === '') lines.pop();
	return lines;
}

/** Longest common prefix / suffix run — trimmed before the O(N·M) table so
 *  only the actual edit needs one. */
function trimCommon(a: string[], b: string[]): { start: number; endA: number; endB: number } {
	const max = Math.min(a.length, b.length);
	let start = 0;
	while (start < max && a[start] === b[start]) start++;
	let endA = a.length;
	let endB = b.length;
	while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
		endA--;
		endB--;
	}
	return { start, endA, endB };
}

/** Classic LCS backtrack over a full DP table — only ever called on the
 *  trimmed (post common-prefix/suffix) slices. */
function lcsOps(a: string[], b: string[]): Op[] {
	const n = a.length;
	const m = b.length;
	if (n === 0) return b.map((_, bIdx) => ({ kind: 'add' as const, bIdx }));
	if (m === 0) return a.map((_, aIdx) => ({ kind: 'del' as const, aIdx }));
	const dp: Uint32Array[] = new Array(n + 1);
	for (let i = 0; i <= n; i++) dp[i] = new Uint32Array(m + 1);
	for (let i = n - 1; i >= 0; i--) {
		const dpi = dp[i]!;
		const dpi1 = dp[i + 1]!;
		for (let j = m - 1; j >= 0; j--) {
			dpi[j] = a[i] === b[j] ? dpi1[j + 1]! + 1 : Math.max(dpi1[j]!, dpi[j + 1]!);
		}
	}
	const ops: Op[] = [];
	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		if (a[i] === b[j]) {
			ops.push({ kind: 'ctx', aIdx: i, bIdx: j });
			i++;
			j++;
		} else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
			ops.push({ kind: 'del', aIdx: i });
			i++;
		} else {
			ops.push({ kind: 'add', bIdx: j });
			j++;
		}
	}
	while (i < n) ops.push({ kind: 'del', aIdx: i++ });
	while (j < m) ops.push({ kind: 'add', bIdx: j++ });
	return ops;
}

/** Full-file op sequence: `ctx` for the common runs (computed by index, no
 *  table needed), `add`/`del` from the LCS table over the trimmed middle.
 *  Returns null when the inner diff would exceed `MAX_CELLS`. */
function computeOps(a: string[], b: string[]): Op[] | null {
	const { start, endA, endB } = trimCommon(a, b);
	const innerA = a.slice(start, endA);
	const innerB = b.slice(start, endB);
	if (innerA.length * innerB.length > MAX_CELLS) return null;
	const prefix: Op[] = [];
	for (let k = 0; k < start; k++) prefix.push({ kind: 'ctx', aIdx: k, bIdx: k });
	const inner = lcsOps(innerA, innerB).map((op) => ({
		kind: op.kind,
		aIdx: op.aIdx != null ? op.aIdx + start : undefined,
		bIdx: op.bIdx != null ? op.bIdx + start : undefined
	}));
	const suffix: Op[] = [];
	for (let k = endA; k < a.length; k++) {
		suffix.push({ kind: 'ctx', aIdx: k, bIdx: endB + (k - endA) });
	}
	return [...prefix, ...inner, ...suffix];
}

/** Strip a trailing CR for display. `splitLines` only splits on `\n`, so a
 *  CRLF file's lines keep their `\r` — harmless for diffing/reconstruction
 *  (it round-trips byte-for-byte either way) but an invisible-ish stray
 *  character is a bad thing to render or let someone copy. Display-only:
 *  `applySelection` re-splits the raw texts itself and never reads this. */
function displayText(raw: string): string {
	return raw.endsWith('\r') ? raw.slice(0, -1) : raw;
}

function lineFor(a: string[], b: string[], op: Op, opIndex: number): DiffLine {
	if (op.kind === 'ctx') {
		return {
			kind: 'ctx',
			text: displayText(a[op.aIdx!]!),
			oldNo: op.aIdx! + 1,
			newNo: op.bIdx! + 1,
			opIndex
		};
	}
	if (op.kind === 'del') {
		return {
			kind: 'del',
			text: displayText(a[op.aIdx!]!),
			oldNo: op.aIdx! + 1,
			newNo: null,
			opIndex
		};
	}
	return {
		kind: 'add',
		text: displayText(b[op.bIdx!]!),
		oldNo: null,
		newNo: op.bIdx! + 1,
		opIndex
	};
}

/** Group ops into hunks: every op within `context` lines (by op position) of
 *  a change is shown; runs of shown ops become hunks. Unchanged regions far
 *  from any change are simply never emitted — this is display grouping only,
 *  `applySelection` walks the full op sequence independently. */
function groupHunks(a: string[], b: string[], ops: Op[], context: number): DiffHunk[] {
	const marked = new Array<boolean>(ops.length).fill(false);
	ops.forEach((op, i) => {
		if (op.kind === 'ctx') return;
		for (let k = Math.max(0, i - context); k <= Math.min(ops.length - 1, i + context); k++) {
			marked[k] = true;
		}
	});
	const hunks: DiffHunk[] = [];
	let i = 0;
	while (i < ops.length) {
		if (!marked[i]) {
			i++;
			continue;
		}
		let j = i;
		while (j < ops.length && marked[j]) j++;
		const lines = ops.slice(i, j).map((op, k) => lineFor(a, b, op, i + k));
		const oldNos = lines.map((l) => l.oldNo).filter((n): n is number => n != null);
		const newNos = lines.map((l) => l.newNo).filter((n): n is number => n != null);
		hunks.push({
			oldStart: oldNos[0] ?? 0,
			oldLines: oldNos.length,
			newStart: newNos[0] ?? 0,
			newLines: newNos.length,
			lines
		});
		i = j;
	}
	return hunks;
}

/** `context` lines of unchanged text shown around each change, unified-diff
 *  style. `oldText`/`newText` are whole-file text (not per-hunk). */
export function diffLines(oldText: string, newText: string, context = 3): FileDiff {
	if (oldText === newText) return { kind: 'unchanged' };
	const a = splitLines(oldText);
	const b = splitLines(newText);
	const ops = computeOps(a, b);
	if (!ops) return { kind: 'tooLarge' };
	return { kind: 'text', hunks: groupHunks(a, b, ops, context) };
}

/**
 * Reconstruct the bytes that should be staged when the ops at
 * `excludedOpIndexes` are left OUT of the commit: an excluded 'add' line is
 * dropped (its addition isn't applied), an excluded 'del' line is kept (its
 * removal isn't applied). Context and every non-excluded add/del land
 * exactly as `newText` / `oldText` would.
 *
 * Must be called with the SAME `oldText`/`newText` that produced the
 * `opIndex`es in `excludedOpIndexes` (from `diffLines` on that same pair) —
 * `opIndex` is only stable within one diff of one text pair.
 *
 * Output is always `\n`-terminated (or empty for no lines). A source file
 * with no trailing newline that gets a genuine partial-line commit picks one
 * up as a side effect — a minor cosmetic difference from the working file,
 * never a content loss, and the common case (no lines excluded) never hits
 * this function at all (the caller stages the whole working file as-is).
 */
export function applySelection(
	oldText: string,
	newText: string,
	excludedOpIndexes: ReadonlySet<number>
): string {
	const a = splitLines(oldText);
	const b = splitLines(newText);
	const ops = computeOps(a, b);
	if (!ops) throw new Error('Diff is too large to apply a line-level selection.');
	const out: string[] = [];
	ops.forEach((op, opIndex) => {
		if (op.kind === 'ctx') {
			out.push(a[op.aIdx!]!);
			return;
		}
		const excluded = excludedOpIndexes.has(opIndex);
		if (op.kind === 'del') {
			if (excluded) out.push(a[op.aIdx!]!); // removal not applied — keep the old line
			return;
		}
		if (!excluded) out.push(b[op.bIdx!]!); // addition applied
	});
	return out.length ? out.join('\n') + '\n' : '';
}
