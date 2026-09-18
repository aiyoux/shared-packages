/**
 * Refcounted open-file session for a parsed document — the app-level layer
 * that sits on `createOpenDocument` (documentSession.ts) and is shared by
 * every op-reducer format: the animation timeline (`.anim`) and diagrams
 * (`.digr`) sessions in scratch-pad are thin instantiations of this factory.
 *
 * Two invariants move here so every host gets them for free:
 *
 *  - **Refcounting.** Two panes holding the same file share one hold; the
 *    last `release` closes the OpenDocument.
 *  - **W7b anti-echo.** A save whose serialization has not changed must not
 *    reach the VFS. `notifyTabChannel` fires after `db.persist()`, so an
 *    unconditional save is what would let two tabs holding documents that
 *    reference each other wake each other forever — every hop looks like a
 *    legitimate new op and no depth counter can see it. Skipping the write
 *    cuts that at the source (docs/design/live-reference-cycles.md).
 *
 * The hold is deliberately plain data (not a $state proxy): apps snapshot
 * their document into `hold.value` on every dirty mark, and save compares
 * fingerprints of `serialize(value)`.
 */
import { getSharedVfs, type VfsService } from './vfs.js';
import type { OpenDocument } from './types.js';
import { fingerprintText } from '@shared-packages/bytes-gate';

export type DocSessionHold<Doc> = {
	nodeId: string;
	doc: OpenDocument;
	/** The parsed document as the app last pushed it (see markDirty). */
	value: Doc;
	dirty: boolean;
	generation: number;
	refs: number;
	error: string;
	/** Fingerprint of the last serialization known to be on disk (W7b). */
	savedFingerprint: string;
	listeners: Set<() => void>;
};

export type DocSession<Doc> = {
	retain(nodeId: string): Promise<DocSessionHold<Doc>>;
	release(nodeId: string): void;
	markDirty(hold: DocSessionHold<Doc>): void;
	save(hold: DocSessionHold<Doc>): Promise<void>;
	subscribe(hold: DocSessionHold<Doc>, fn: () => void): () => void;
};

export function createDocSession<Doc>(options: {
	/** A blank document — used when the file is empty or fails to parse. */
	empty: () => Doc;
	/** Strict parser. A malformed file falls back to `empty()` on retain and
	 *  re-reads surface the parse error on `hold.error` instead. */
	parse: (bytes: Uint8Array) => Doc;
	/** Stable serializer; the fingerprint gate compares its output. */
	serialize: (doc: Doc) => string;
}): DocSession<Doc> {
	const holds = new Map<string, DocSessionHold<Doc>>();

	function notify(hold: DocSessionHold<Doc>): void {
		for (const fn of hold.listeners) fn();
	}

	async function retain(nodeId: string): Promise<DocSessionHold<Doc>> {
		const existing = holds.get(nodeId);
		if (existing) {
			existing.refs += 1;
			return existing;
		}
		const vfs: VfsService = getSharedVfs();
		await vfs.ready();
		const open = await vfs.openDocument(nodeId);
		let value: Doc = options.empty();
		try {
			const bytes = await vfs.readBytes(nodeId);
			if (bytes.byteLength > 0) value = options.parse(bytes);
		} catch {
			value = options.empty();
		}
		const hold: DocSessionHold<Doc> = {
			nodeId,
			doc: open,
			value,
			dirty: false,
			generation: open.generation,
			refs: 1,
			error: '',
			// Fingerprint the *serialization*, not the bytes read: the two need
			// not be byte-identical, and it is the serialization a save compares
			// against.
			savedFingerprint: fingerprintText(options.serialize(value)),
			listeners: new Set()
		};
		open.subscribe((event) => {
			if (event.type === 'content' && !event.conflict && !hold.dirty) {
				void vfs.readBytes(nodeId).then((bytes) => {
					if (hold.dirty) return;
					try {
						hold.value = options.parse(bytes);
						hold.generation = open.generation;
						hold.savedFingerprint = fingerprintText(options.serialize(hold.value));
						notify(hold);
					} catch (err) {
						hold.error = err instanceof Error ? err.message : 'Could not parse document';
						notify(hold);
					}
				});
			}
			if (event.type === 'content' && event.conflict) {
				hold.error = 'File changed in another tab. Reload or Save As.';
				notify(hold);
			}
			if (event.type === 'deleted') {
				hold.error = 'File was deleted.';
				notify(hold);
			}
		});
		holds.set(nodeId, hold);
		return hold;
	}

	function release(nodeId: string): void {
		const hold = holds.get(nodeId);
		if (!hold) return;
		hold.refs -= 1;
		if (hold.refs > 0) return;
		hold.doc.close();
		holds.delete(nodeId);
	}

	function markDirty(hold: DocSessionHold<Doc>): void {
		hold.dirty = true;
		hold.doc.markDirty();
		notify(hold);
	}

	async function save(hold: DocSessionHold<Doc>): Promise<void> {
		const serialized = options.serialize(hold.value);
		const fingerprint = fingerprintText(serialized);
		// W7b — a save that changes nothing must not reach the VFS.
		if (hold.savedFingerprint === fingerprint) {
			hold.dirty = false;
			hold.error = '';
			notify(hold);
			return;
		}
		const payload = JSON.parse(serialized) as Doc;
		const node = await hold.doc.save(payload);
		hold.savedFingerprint = fingerprint;
		hold.generation = node.generation;
		hold.dirty = false;
		hold.error = '';
		notify(hold);
	}

	function subscribe(hold: DocSessionHold<Doc>, fn: () => void): () => void {
		hold.listeners.add(fn);
		return () => hold.listeners.delete(fn);
	}

	return { retain, release, markDirty, save, subscribe };
}