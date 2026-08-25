/**
 * Shared connection labels + capability rows for switcher / pair-info tooltips.
 */
import type { ExplorerCapabilities } from './explorerDriver.js';

export type ConnectionKind = 'local' | 'memory' | 'disk' | 'b2' | 'rclone' | 'monitor';

export function connectionKindNote(kind: string): string {
	if (kind === 'memory') return 'This tab only — cleared when the tab closes.';
	if (kind === 'disk') return 'Folder on this computer (browser permission).';
	if (kind === 'b2') {
		return 'Remote Backblaze B2. Keys stay in this browser (optional passphrase lock in B2 settings).';
	}
	if (kind === 'monitor') return 'Live folder via monitor (same connection can server-copy).';
	if (kind === 'rclone') return 'Remote folder via rclone.';
	if (kind === 'peer-fs') return 'Folder on the other device.';
	return 'Saved in this browser (Dexie + OPFS).';
}

export function capabilityRows(
	c: ExplorerCapabilities | undefined
): Array<{ label: string; on: boolean }> {
	return [
		{ label: 'Trash', on: !!c?.supportsTrash },
		{ label: 'Soft delete', on: !!c?.supportsSoftDelete },
		{ label: 'Rename', on: !!c?.supportsRename },
		{ label: 'Move', on: !!c?.supportsMove },
		{ label: 'Copy', on: !!c?.supportsCopy },
		{ label: 'New folders', on: !!c?.supportsMkdir },
		{ label: 'Select file / drop from PC', on: !!c?.supportsUpload },
		{ label: 'Download', on: !!c?.supportsDownload },
		{ label: 'Drag to reorder', on: !!c?.supportsSiblingOrder },
		{ label: 'Drag files out', on: !!c?.supportsDragOut }
	];
}
