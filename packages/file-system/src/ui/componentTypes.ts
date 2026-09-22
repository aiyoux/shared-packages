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

/**
 * Combining is atomic: `conflict` means both rooms are exactly as they were,
 * with `paths` naming what a human has to look at.
 */
export type ExplorerCombineResult =
	| { status: 'ok' }
	| { status: 'dirty' }
	| { status: 'live' }
	| { status: 'conflict'; paths: string[] }
	/** That person's copy of the room has not arrived on this device yet. */
	| { status: 'missing' };

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
	/**
	 * Which of this person's rooms this device keeps. The current room is
	 * always kept and cannot be unchecked — it is where the user is working.
	 */
	rooms?: readonly ExplorerPersonRoom[];
	/** What happens when this person's work arrives. */
	onArrival?: ExplorerArrivalPolicy;
};

export type ExplorerArrivalPolicy = 'auto' | 'inspect' | 'later';

export type ExplorerPersonRoom = {
	roomId: string;
	label: string;
	kept: boolean;
	/** The current room: kept for everyone, so the checkbox is locked on. */
	locked: boolean;
};

export type ExplorerUnlinkDrain = 'sync' | 'without';

/** Git history sizes for the Project storage panel, supplied by the host. */
export type ProjectHistoryStats = {
	historyBytes: number;
	looseObjects: number;
	looseBytes: number;
	rooms: readonly {
		roomId: string;
		label: string;
		current: boolean;
		uniqueBytes: number;
		sharedBytes: number;
	}[];
};

/**
 * Two live sessions met on one room (rule 3.8). Their seq counters are
 * independent, so joining them would compare two unrelated clocks — the
 * mistake rule 3.4 exists to stop.
 */
export type ExplorerSplitBrain = {
	roomLabel: string;
};

export type ExplorerSplitBrainChoice = 'wait' | 'new-room' | 'cancel';
