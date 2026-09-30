/**
 * Hidden archive dialogs need a way back. `FeArchiveDialog` can hide mid-job
 * (Hide button, Escape, scrim click), leaving the job running with only the
 * progress chip in the header — and, before this registry, no affordance to
 * bring the dialog back. The chip lives in the host chrome while the dialog
 * lives in each pane's FileExplorer, so the request crosses that boundary
 * through this module: panes register a show callback once, and the progress
 * header chip asks the registry before falling back to its transfer menu.
 */
type ShowArchiveDialog = (opId?: string) => boolean;

const shows = new Set<ShowArchiveDialog>();

/** Register a pane's reshow callback. Returns the unregister function. */
export function registerArchiveDialogShow(show: ShowArchiveDialog): () => void {
	shows.add(show);
	return () => shows.delete(show);
}

/** Ask registered panes to reshow a hidden archive dialog. True when one did. */
export function requestArchiveDialogShow(opId?: string): boolean {
	for (const show of shows) {
		if (show(opId)) return true;
	}
	return false;
}