/**
 * Types shared by FileExplorer / RemoteConnectionsDialog.
 * Defined here (not in the `.svelte` files) because svelte-check cannot resolve
 * type exports from `.svelte` modules in cross-package checks (e.g. the git
 * package's check could not find `ExplorerMode` re-exported via the ui index).
 */
import type { ExplorerEntry } from './explorerDriver.js';

export type ExplorerMode = 'manage' | 'open' | 'save' | 'browse';

export type ExplorerContext = {
	parentId: string | null;
	selectedIds: string[];
	backend: string;
	entries: ExplorerEntry[];
};

export type RemoteKind = 'b2' | 'rclone' | 'monitor';
