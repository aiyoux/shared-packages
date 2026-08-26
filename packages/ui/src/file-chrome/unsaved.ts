/** Prompt before replacing a dirty document. Returns false if the user cancels. */
export function confirmDiscardUnsaved(
	isDirty: boolean,
	message = 'You have unsaved changes. Discard them?',
	confirmFn: ((msg: string) => boolean) | undefined = typeof window !== 'undefined'
		? window.confirm.bind(window)
		: undefined
): boolean {
	if (!isDirty) return true;
	if (typeof confirmFn !== 'function') return true;
	return confirmFn(message);
}

/** Install a beforeunload prompt while the document is dirty. */
export function installBeforeUnload(getDirty: () => boolean): () => void {
	if (typeof window === 'undefined') return () => {};
	const onBeforeUnload = (event: BeforeUnloadEvent) => {
		if (!getDirty()) return;
		event.preventDefault();
		event.returnValue = '';
	};
	window.addEventListener('beforeunload', onBeforeUnload);
	return () => window.removeEventListener('beforeunload', onBeforeUnload);
}

/** Ctrl/Cmd+S → save. Prevents the browser's download-page shortcut. */
export function installSaveHotkey(onSave: () => void): () => void {
	if (typeof window === 'undefined') return () => {};
	const onKey = (event: KeyboardEvent) => {
		if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 's') return;
		event.preventDefault();
		onSave();
	};
	window.addEventListener('keydown', onKey);
	return () => window.removeEventListener('keydown', onKey);
}

export const DEFAULT_CONFLICT_MSG =
	'This file was changed in another tab. Overwrite with your version?';
