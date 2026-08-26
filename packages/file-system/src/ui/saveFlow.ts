/**
 * Shared save-flow primitives (apps plug into these rather than re-implementing):
 *
 * - `saveWithConflictConfirm` — the cross-tab GENERATION_CONFLICT → confirm →
 *   `force: true` retry pattern, previously copy-pasted in each app.
 * - `openFileWithGuard` — the "open a file while the current doc is dirty"
 *   3-option guard (Discard / Save+open / Continue editing), driven by the
 *   shared `UnsavedChangesDialog` (mounted in `dirtyOpenDialog.ts`).
 *
 * This module must stay free of `.svelte` imports so it runs under node:test;
 * the Svelte dialog lives in `dirtyOpenDialog.ts`.
 */
import { VfsError } from '../types.js';

/** Thrown when the user declines a cross-tab overwrite (save was cancelled). */
export class SaveCancelledError extends Error {
	constructor(message = 'Save cancelled') {
		super(message);
		this.name = 'SaveCancelledError';
	}
}

export const DEFAULT_CONFLICT_MSG =
	'This file was changed in another tab. Overwrite with your version?';

export type SaveConflictConfirmOpts = {
	message?: string;
	/** Injectable confirm fn (defaults to window.confirm) for tests / non-dialog hosts. */
	confirm?: (message: string) => boolean;
};

/**
 * Save a bound document, resolving the cross-tab GENERATION_CONFLICT by
 * confirming and retrying with `force: true`. Throws `SaveCancelledError` when
 * the user declines; rethrows anything that is not a GENERATION_CONFLICT.
 */
export async function saveWithConflictConfirm<T>(
	save: (force?: boolean) => Promise<T>,
	opts: SaveConflictConfirmOpts = {}
): Promise<T> {
	try {
		return await save();
	} catch (e) {
		if (!(e instanceof VfsError && e.code === 'GENERATION_CONFLICT')) throw e;
		const confirmFn =
			opts.confirm ??
			((msg: string) => (typeof window !== 'undefined' ? window.confirm(msg) : true));
		const ok = confirmFn(opts.message ?? DEFAULT_CONFLICT_MSG);
		if (!ok) throw new SaveCancelledError();
		return await save(true);
	}
}

export type DirtyOpenChoice = 'discard' | 'save' | 'continue';

export type OpenFileWithGuardOpts = {
	isDirty: boolean;
	title?: string;
	message?: string;
	fileName?: string;
	/**
	 * Save the current doc (silently to its target, or through the app's
	 * save-as picker when it has none). Resolves `true` once saved, `false`
	 * when the user cancels the save flow (stay on the current doc).
	 */
	onSaveAndOpen: () => Promise<boolean>;
	/** Perform the open (called after a clean doc, discard, or successful save). */
	onDiscardAndOpen: () => void | Promise<void>;
	/**
	 * Override the dialog shown (tests / custom hosts). Defaults to
	 * `showDirtyOpenDialog` from `dirtyOpenDialog.ts` (lazy, to stay node-safe).
	 */
	showDialog?: (opts: {
		title?: string;
		message?: string;
		fileName?: string;
	}) => Promise<DirtyOpenChoice>;
};

function defaultShowDialog(opts: {
	title?: string;
	message?: string;
	fileName?: string;
}): Promise<DirtyOpenChoice> {
	return import('./dirtyOpenDialog.js').then((m) => m.showDirtyOpenDialog(opts));
}

/**
 * Guard an "open a file" command against a dirty document. Returns
 * `'opened'` when the requested file was loaded, `'continue-editing'` when the
 * user chose to stay on the current document.
 */
export async function openFileWithGuard(
	opts: OpenFileWithGuardOpts
): Promise<'opened' | 'continue-editing'> {
	if (!opts.isDirty) {
		await opts.onDiscardAndOpen();
		return 'opened';
	}
	const showDialog = opts.showDialog ?? defaultShowDialog;
	const choice = await showDialog({
		title: opts.title,
		message: opts.message,
		fileName: opts.fileName
	});
	if (choice === 'discard') {
		await opts.onDiscardAndOpen();
		return 'opened';
	}
	if (choice === 'save') {
		const saved = await opts.onSaveAndOpen();
		if (saved) {
			await opts.onDiscardAndOpen();
			return 'opened';
		}
	}
	return 'continue-editing';
}
