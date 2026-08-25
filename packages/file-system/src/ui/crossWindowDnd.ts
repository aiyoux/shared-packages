/**
 * Cross-instance drag session for `<DualPaneExplorer>`.
 *
 * Each workspace pane mounts its own `<DualPaneExplorer>` instance in the same
 * document (no iframes). When the user splits the screen and opens File Manager
 * in two panes — both in single-pane mode — a row drag started in one instance
 * needs to be accepted as a copy-across drop by the other. The native
 * `DataTransfer` carries the entry IDs (`FE_EXPLORER_IDS_MIME`) across elements,
 * but the destination instance also needs the source driver + entries to perform
 * `copyAcross`. This module-level store bridges that gap: the source registers
 * on `dragstart`, the destination reads on `drop`, and `dragend` clears it.
 *
 * @see docs/design/dnd-inmem-copy.md
 */
import type { ExplorerDriver, ExplorerEntry } from './explorerDriver.js';

export type CrossWindowDragSession = {
	sourceDriver: ExplorerDriver;
	sourceEntries: ExplorerEntry[];
	selectedIds: string[];
	/** Connection label for dual-phase confirm (not the driver id). */
	sourceLabel?: string;
};

let activeDrag: CrossWindowDragSession | null = null;
/** True while FileExplorer is driving a touch/pen drag (no HTML5 DragEvents). */
let pointerDragActive = false;

/** Register the source info for an ongoing drag. Called on pane `dragstart`. */
export function setCrossWindowDrag(session: CrossWindowDragSession): void {
	activeDrag = session;
}

/** Touch/pen drag (HTML5 DnD does not fire on most mobile browsers). */
export function setPointerDragActive(on: boolean): void {
	pointerDragActive = on;
}

export function isPointerDragActive(): boolean {
	return pointerDragActive;
}

/**
 * Read the source info for an ongoing cross-instance drag.
 * Returns `null` when no drag is active or the drag is same-instance
 * (the caller should check `crossDragFrom` first to disambiguate).
 */
export function getCrossWindowDrag(): CrossWindowDragSession | null {
	return activeDrag;
}

/** Clear the shared session. Called on pane `dragend`. */
export function clearCrossWindowDrag(): void {
	activeDrag = null;
}
