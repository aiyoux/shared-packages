import {
	createLeaf,
	splitLeaf,
	closeLeaf,
	listLeaves,
	leafCount
} from '@shared-packages/ui';
import type { LayoutNode, SplitDirection, AppWindowRoleDef } from '@shared-packages/ui';
import type { ExplorerContext, ExplorerDriver } from './explorerDriver.js';
import type { ConnectionKind, B2ConnectionProfileV1 } from '../b2/types.js';
import type { RcloneConnectionProfileV1 } from '../rclone/types.js';
import type { MonitorConnectionProfileV1 } from '../monitor/types.js';

export const FILE_WINDOW_LEAF_PREFIX = 'fe-win';
export const DEFAULT_FILE_WINDOW_ID = 'fe-left';

export interface FileWindowState {
	role: string;
	activeId: 'local' | 'memory' | 'disk' | string;
	activeKind: ConnectionKind;
	remoteDriver: ExplorerDriver | null;
	memoryDriver: ExplorerDriver | null;
	busy: boolean;
	error: string;
	showB2Form: boolean;
	showRcloneForm: boolean;
	showMonitorForm: boolean;
	explorerKey: number;
	diskName: string;
	ctx: ExplorerContext;
}

export function emptyFileContext(backend = 'local'): ExplorerContext {
	return { parentId: null, selectedIds: [], backend, entries: [] };
}

export function emptyFileWindowState(kind: ConnectionKind = 'local', role?: string): FileWindowState {
	return {
		role: role ?? kind,
		activeId: kind === 'memory' ? 'memory' : 'local',
		activeKind: kind,
		remoteDriver: null,
		memoryDriver: null,
		busy: false,
		error: '',
		showB2Form: false,
		showRcloneForm: false,
		showMonitorForm: false,
		explorerKey: 0,
		diskName: '',
		ctx: emptyFileContext(kind)
	};
}

export function createFileWindowRoot(singleOrDual: boolean | LayoutNode = false): LayoutNode {
	if (typeof singleOrDual === 'object' && singleOrDual) return singleOrDual;
	if (singleOrDual) {
		const root = createLeaf('left');
		const split = splitLeaf(root, 'left', 'row');
		return split?.root ?? root;
	}
	return createLeaf('left');
}

export function defaultFileWindows(
	leftDefault: ConnectionKind = 'local',
	rightDefault: ConnectionKind = 'local'
): Record<string, FileWindowState> {
	return {
		left: emptyFileWindowState(leftDefault, leftDefault),
		right: emptyFileWindowState(rightDefault, rightDefault)
	};
}

export function buildFileWindowRoles(
	b2Profiles: B2ConnectionProfileV1[] = [],
	rcloneProfiles: RcloneConnectionProfileV1[] = [],
	monitorProfiles: MonitorConnectionProfileV1[] = [],
	options: { showMemory?: boolean; hasPeer?: boolean } = {}
): AppWindowRoleDef<string>[] {
	const roles: AppWindowRoleDef<string>[] = [
		{ id: 'local', label: 'Local (Browser files)', required: false }
	];
	if (options.showMemory !== false) {
		roles.push({ id: 'memory', label: 'In memory', required: false });
	}
	roles.push({ id: 'disk', label: 'Local folder (Disk)', required: false });

	for (const p of b2Profiles) {
		roles.push({
			id: `b2:${p.id}`,
			label: `B2: ${p.name || p.bucketName}`
		});
	}
	for (const p of rcloneProfiles) {
		roles.push({
			id: `rclone:${p.id}`,
			label: `Rclone: ${p.name || p.fs}`
		});
	}
	for (const p of monitorProfiles) {
		roles.push({
			id: `monitor:${p.id}`,
			label: `Monitor: ${p.name || p.baseUrl}`
		});
	}
	if (options.hasPeer) {
		roles.push({ id: 'peer', label: 'Peer filesystem' });
	}
	return roles;
}

export function resolveTargetFilePaneId(
	windows: Record<string, FileWindowState>,
	focusedId: string,
	previousTarget?: string
): string {
	if (windows[focusedId]) return focusedId;
	if (previousTarget && windows[previousTarget]) return previousTarget;
	return Object.keys(windows)[0] ?? 'left';
}
