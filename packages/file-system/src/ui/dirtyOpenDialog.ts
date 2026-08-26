/**
 * Svelte-side mount for the shared 3-option unsaved-changes dialog.
 * Kept separate from `saveFlow.ts` so the pure orchestration logic stays
 * unit-testable under node:test (which cannot import .svelte files).
 */
import { mount, unmount } from 'svelte';
import UnsavedChangesDialog from './UnsavedChangesDialog.svelte';
import type { DirtyOpenChoice } from './saveFlow.js';

/**
 * Show the shared 3-option unsaved-changes dialog (dynamically mounted so it
 * works from both components and plain TS modules like the open-with handoff).
 * Resolves with the chosen action; `continue` = stay on the current doc.
 */
export function showDirtyOpenDialog(opts: {
	title?: string;
	message?: string;
	fileName?: string;
}): Promise<DirtyOpenChoice> {
	return new Promise((resolve) => {
		if (typeof document === 'undefined') {
			// SSR / non-client: safest is to not discard — treat as continue.
			resolve('continue');
			return;
		}
		const host = document.createElement('div');
		host.style.cssText = 'position:fixed;inset:0;z-index:300;';
		document.body.appendChild(host);
		let app: ReturnType<typeof mount> | undefined;
		const finish = (choice: DirtyOpenChoice) => {
			if (app) unmount(app);
			app = undefined;
			host.remove();
			resolve(choice);
		};
		app = mount(UnsavedChangesDialog, {
			target: host,
			props: {
				title: opts.title,
				message: opts.message,
				fileName: opts.fileName,
				onDiscard: () => finish('discard'),
				onSave: () => finish('save'),
				onContinue: () => finish('continue')
			}
		});
	});
}
