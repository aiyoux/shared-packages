/**
 * Types shared by FileExplorer / RemoteConnectionsDialog.
 * Defined here (not in the `.svelte` files) because svelte-check cannot resolve
 * type exports from `.svelte` modules in cross-package checks (e.g. the git
 * package's check could not find `ExplorerMode` re-exported via the ui index).
 */
import type { ExplorerEntry } from './explorerDriver.js';
import type { FeIconName } from './feIcons.js';

export type ExplorerMode = 'manage' | 'open' | 'save' | 'browse';

export type ExplorerNewMenuItem = {
	id: string;
	label: string;
	icon: FeIconName;
	testId?: string;
};

export type ExplorerContext = {
	parentId: string | null;
	selectedIds: string[];
	backend: string;
	entries: ExplorerEntry[];
};

export type RemoteKind = 'b2' | 'rclone' | 'monitor';

/** Color dot on a file row — same shape the Documents tree paints. */
export type ExplorerPresenceDot = {
	clientId: string;
	color: string;
	name: string;
};

/** Hub git checkout / new-room. `dirty` means the tree has unsaved work. */
export type ExplorerRoomActionResult = 'ok' | 'dirty';

/** People-sheet row. Presence dots stay room-scoped; other rooms live here. */
export type ExplorerPersonNow =
	| { kind: 'here' }
	| { kind: 'offline' }
	| { kind: 'room'; label: string };

export type ExplorerPersonGrant = 'edit' | 'view';

export type ExplorerPerson = {
	pairingId: string;
	label: string;
	color?: string;
	now: ExplorerPersonNow;
	lastSyncAt?: number;
	sessionGrant?: ExplorerPersonGrant | null;
	/** Host-only. Guest with write still shows Can edit, not Revoke. */
	canRevoke?: boolean;
	linked: boolean;
};

export type ExplorerUnlinkDrain = 'sync' | 'without';
