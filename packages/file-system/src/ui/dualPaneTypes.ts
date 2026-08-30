/**
 * Types for {@link DualPaneExplorer}, kept in a `.ts` module (not the `.svelte`)
 * so the ui barrel can re-export them without the `*.svelte` named-export
 * limitation that plain `tsc` hits.
 */

export type PaneId = 'left' | 'right' | string;

export type DualPaneTids = {
	/** Outer body grid. */
	body: string;
	/** Pane container testid per pane id. */
	pane: (id: PaneId) => string;
	paneChrome: (id: PaneId) => string;
	paneLabel: (id: PaneId) => string;
	/** Optional wrapper testid around the FileExplorer (e.g. cm-library-explorer). */
	explorerHost: (id: PaneId) => string | undefined;
	/** Optional sub-label span testid per pane (e.g. cm-library-pane-sub). */
	paneSub: (id: PaneId) => { testid: string; text: string } | undefined;
	copyAcross: (id: PaneId) => string;
	copyAcrossError: string;
	/** "Send" button testid per pane (shown only when `onSend` is passed). */
	send: (id: PaneId) => string;
	sendError: string;
	dualToggle: string;
	rcloneToggle: string;
	monitorToggle: string;
	/** Persist-chip wrapper testid (e.g. files-storage-persist). */
	persist: string;
};
