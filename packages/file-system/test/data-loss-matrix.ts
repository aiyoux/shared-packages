/** Shared content and structural oracle; used by Node and opt-in browser sweeps. */
import type { createVfs } from '../src/index.ts';
import * as pp from '../src/projectPack.ts';
import * as pm from '../src/projectMeta.ts';

/** Ops applied to the subject file. */
export const SUBJECT_OPS = ['update', 'trash', 'permanentDelete', 'move', 'copy', 'rename'] as const;
/** Ops applied to the target — the ones that reclaim or rewrite storage. */
export const TARGET_OPS = [
	'permanentDelete',
	'emptyTrash',
	'gc',
	'update',
	'trash',
	'projectDelete',
	'compact'
] as const;
/** Who the second op hits, relative to the subject. */
export const TARGETS = ['self', 'sibling', 'otherPack', 'unpacked'] as const;

type SubjectOp = (typeof SUBJECT_OPS)[number];
type TargetOp = (typeof TARGET_OPS)[number];
type Target = (typeof TARGETS)[number];

export type Case = { a: SubjectOp; b: TargetOp; target: Target; third?: string };
export type Failure = { case: string; kind: string; detail: string };

export function seq2Cases(): Case[] {
	const out: Case[] = [];
	for (const a of SUBJECT_OPS) {
		for (const b of TARGET_OPS) {
			for (const target of TARGETS) out.push({ a, b, target });
		}
	}
	return out;
}

export async function runDataLossMatrix(
	vfs: ReturnType<typeof createVfs>, cases: Case[], packed: boolean
): Promise<Failure[]> {
	/** Deterministic per-file content: no two seeds share a byte pattern. */
	const fill = (seed: number, size: number) => {
		const b = new Uint8Array(size);
		for (let k = 0; k < size; k++) b[k] = (seed * 131 + k * 17) & 0xff;
		return b;
	};
	const same = (a: Uint8Array, b: Uint8Array) => {
		if (a.byteLength !== b.byteLength) return false;
		for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
		return true;
	};

	const SIZE = 1024;
	type Expect = { seed: number; state: 'live' | 'trashed' | 'dead'; name: string };
	const failures: Array<{ case: string; kind: string; detail: string }> = [];

	for (const c of cases) {
		const label =
			`${c.a} then ${c.b}(${c.target})` +
			`${c.third ? ` then ${c.third}` : ''}${packed ? ' [packed]' : ''}`;
		try {
			await vfs.dangerClearAll();

			// Two packs plus an always-unpacked folder. Separate writeFiles
			// calls, because one call is one pack — which is what makes
			// `sibling` and `otherPack` genuinely different targets.
			const home = await vfs.mkdir(null, 'home');
			if (packed) {
				await pm.initProject(vfs, home.id, { name: 'dlm-project' });
			}
			const elsewhere = await vfs.mkdir(null, 'elsewhere');
			const fa = await vfs.mkdir(home.id, 'packA');
			const fb = await vfs.mkdir(home.id, 'packB');
			const fp = await vfs.mkdir(home.id, 'plain');

			const mk = async (parentId: string, tag: string, n: number, base: number, pack: boolean) =>
				vfs.writeFiles(
					Array.from({ length: n }, (_, i) => ({
						parentId,
						name: `${tag}-${i}.bin`,
						body: fill(base + i, SIZE)
					})),
					{ pack }
				);

			const A = await mk(fa.id, 'a', 4, 10, packed);
			const B = await mk(fb.id, 'b', 4, 30, packed);
			const P = await mk(fp.id, 'p', 2, 50, false);

			const model = new Map<string, Expect>();
			const note = (nodes: any[], base: number) =>
				nodes.forEach((n, i) =>
					model.set(n.id, { seed: base + i, state: 'live', name: n.name })
				);
			note(A, 10);
			note(B, 30);
			note(P, 50);

			const subject = A[0].id;
			const targetId = {
				self: A[0].id,
				sibling: A[1].id,
				otherPack: B[0].id,
				unpacked: P[0].id
			}[c.target];

			// Ops mutate both the store and the model. Anything that
			// changes bytes must update the model, or the oracle is
			// checking against a stale expectation.
			const NEW_SEED = 200;
			// An op the store legitimately refuses is not data loss — deleting
			// a deleted node SHOULD throw. But a blanket catch would hide
			// real bugs, so a refusal is only tolerated when the model
			// already knows the state that justifies it; every other throw
			// is still a failure, and the oracle runs either way.
			const refusalExpected = (op: string, before: Expect | undefined) => {
				if (!before) return false;
				if (before.state === 'dead') return true;
				if (before.state === 'trashed' && op === 'update') return true;
				return false;
			};

			const applyRaw = async (op: string, id: string) => {
				const cur = model.get(id);
				switch (op) {
					case 'update': {
						const node = await vfs.get(id);
						if (!node) return;
						await vfs.updateFile(id, fill(NEW_SEED, SIZE), { force: true });
						if (cur) cur.seed = NEW_SEED;
						return;
					}
					case 'trash':
						await vfs.trash(id);
						if (cur) cur.state = 'trashed';
						return;
					case 'restore':
						await vfs.restore(id);
						if (cur) cur.state = 'live';
						return;
					case 'permanentDelete':
						await vfs.permanentDelete(id, { recursive: true });
						if (cur) cur.state = 'dead';
						return;
					case 'emptyTrash':
						await vfs.emptyTrash();
						for (const e of model.values()) if (e.state === 'trashed') e.state = 'dead';
						return;
					case 'move':
						await vfs.move(id, elsewhere.id);
						return;
					case 'copy': {
						const copy = await vfs.copy(id, elsewhere.id);
						if (cur && copy) model.set(copy.id, { ...cur, name: copy.name });
						return;
					}
					case 'rename':
						await vfs.rename(id, `renamed-${Date.now()}.bin`);
						return;
					case 'gc':
						await vfs.gc();
						return;
					case 'projectDelete': {
						const node = await vfs.get(id);
						if (!node) return;
						await pp.deleteFromProject(vfs, [id]);
						if (cur) cur.state = 'dead';
						return;
					}
					case 'compact': {
						const refs = await vfs.db.blobRefs.toArray();
						const paths = [
							...new Set(
								refs.filter((r: { packOffset?: number }) => r.packOffset != null).map(
									(r: { opfsPath: string }) => r.opfsPath
								)
							)
						];
						if (paths.length) await vfs.compactPacks(paths);
						return;
					}
				}
			};

			const apply = async (op: string, id: string) => {
				const before = model.get(id);
				const snapshot = before ? { ...before } : undefined;
				try {
					await applyRaw(op, id);
				} catch (err) {
					if (refusalExpected(op, snapshot)) return;
					failures.push({
						case: label,
						kind: 'unexpected-throw',
						detail: `${op} on ${snapshot?.name ?? id} (${snapshot?.state ?? '?'}): ${String(err)}`
					});
					// The model may have been half-updated; put it back so
					// the oracle checks against what the store should hold.
					if (before && snapshot) Object.assign(before, snapshot);
				}
			};

			await apply(c.a, subject);
			await apply(c.b, targetId);
			// seq-3: the third op always reclaims, and always against a
			// store two operations deep rather than a fresh one.
			if (c.third) await apply(c.third, targetId);

			// --- Oracle 1: content. Every file the model says is readable
			// must return its OWN bytes, not a neighbour's.
			for (const [id, e] of model) {
				if (e.state === 'dead') continue;
				let got: Uint8Array | null = null;
				try {
					got = await vfs.readBytes(id);
				} catch (err) {
					failures.push({
						case: label,
						kind: 'unreadable',
						detail: `${e.name} (${e.state}) should be readable: ${String(err)}`
					});
					continue;
				}
				if (!got) {
					failures.push({ case: label, kind: 'wrong-bytes', detail: `${e.name} read back null` });
					continue;
				}
				if (!same(got, fill(e.seed, SIZE))) {
					failures.push({
						case: label,
						kind: 'wrong-bytes',
						detail:
							`${e.name} returned ${got.byteLength}B, first byte ${got[0]}, ` +
							`expected ${SIZE}B first byte ${fill(e.seed, SIZE)[0]}`
					});
				}
			}

			// --- Oracle 2: structure. Dangling refs, short packs, orphans.
			const report = await pp.checkFilesystem(vfs);
			for (const issue of report.issues) {
				failures.push({ case: label, kind: issue.kind, detail: issue.detail });
			}
		} catch (err) {
			failures.push({ case: label, kind: 'threw', detail: String(err) });
		}
	}
	return failures;
}
