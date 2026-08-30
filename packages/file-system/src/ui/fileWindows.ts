import {
	createLeaf,
	splitLeaf,
	closeLeaf,
	listLeaves,
	leafCount
} from '@shared-packages/ui';
import type { LayoutNode, SplitDirection, AppWindowRoleDef } from '@shared-packages/ui';
import type { ExplorerDriver } from './explorerDriver.js';
import type { ExplorerContext } from './componentTypes.js';
import type { ConnectionKind } from './connectionInfo.js';
import type { B2ConnectionProfileV1 } from '../b2/types.js';
import type { RcloneConnectionProfileV1 } from '../rclone/types.js';
import type { MonitorConnectionProfileV1 } from '../monitor/types.js';

export const FILE_WINDOW_LEAF_PREFIX = 'fe-win';
export const DEFAULT_FILE_WINDOW_ID = 'fe-left';

export type FileWindowRole =
	| 'local'
	| 'memory'
	| 'disk'
	| 'peer'
	| string;

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

export function saveFileWindows(
	key: string,
	data: {
		root: LayoutNode;
		windows: Record<string, FileWindowState>;
		focusedId: string;
		targetPaneId: string;
	}
) {
	if (typeof localStorage === 'undefined') return;
	try {
		const serializedWindows: Record<string, { role: string; activeId: string; activeKind: ConnectionKind }> = {};
		for (const [id, w] of Object.entries(data.windows)) {
			serializedWindows[id] = {
				role: w.role,
				activeId: w.activeId,
				activeKind: w.activeKind
			};
		}
		localStorage.setItem(
			key,
			JSON.stringify({
				root: data.root,
				windows: serializedWindows,
				focusedId: data.focusedId,
				targetPaneId: data.targetPaneId
			})
		);
	} catch {
		/* ignore */
	}
}

export function loadFileWindows(
	key: string,
	leftDefault: ConnectionKind = 'local',
	rightDefault: ConnectionKind = 'local'
): {
	root: LayoutNode;
	windows: Record<string, FileWindowState>;
	focusedId: string;
	targetPaneId: string;
} | null {
	if (typeof localStorage === 'undefined') return null;
	try {
		const raw = localStorage.getItem(key);
		if (!raw) return null;
		if (raw === '0' || raw === '1') {
			const isDual = raw === '1';
			return {
				root: createFileWindowRoot(isDual),
				windows: defaultFileWindows(leftDefault, rightDefault),
				focusedId: 'left',
				targetPaneId: 'left'
			};
		}
		const parsed = JSON.parse(raw);
		if (!parsed || typeof parsed !== 'object' || !parsed.root) return null;
		const windows: Record<string, FileWindowState> = {};
		if (parsed.windows && typeof parsed.windows === 'object') {
			for (const [id, w] of Object.entries(
				parsed.windows as Record<string, { role?: string; activeId?: string; activeKind?: ConnectionKind }>
			)) {
				const state = emptyFileWindowState(w.activeKind || 'local', w.role || 'local');
				if (w.activeId) state.activeId = w.activeId;
				windows[id] = state;
			}
		}
		return {
			root: parsed.root,
			windows,
			focusedId: parsed.focusedId || Object.keys(windows)[0] || 'left',
			targetPaneId: parsed.targetPaneId || Object.keys(windows)[0] || 'left'
		};
	} catch {
		return null;
	}
}

