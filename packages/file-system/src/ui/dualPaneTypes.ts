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
	/**
	 * Connection-switcher wrapper testid per pane. Optional: omit it and the
	 * component falls back to `conn-switcher-<id>`.
	 *
	 * Give it a value whenever a page can mount TWO explorers — /cm mounts the
	 * transfer panel's library alongside SharedFilesPanel, and while this id
	 * was hardcoded both rendered `conn-switcher-left`, so addressing either
	 * one failed strict mode with "resolved to 2 elements".
	 */
	connSwitcher?: (id: PaneId) => string;
	/**
	 * Namespace for the ids that are not worth a contract member each — the
	 * pane forms, the copy-across overlay, and the window-manager prefix.
	 *
	 * Default is identity, so a lone explorer keeps the ids it always had. A
	 * page that mounts two explorers must pass one, or both instances answer to
	 * the same id and `getByTestId` fails strict mode. That is not theoretical:
	 * `body` and `connSwitcher` became contract members only after they broke
	 * seven /cm specs that way, and the ids below are the same shape.
	 */
	scoped?: (tid: string) => string;
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
