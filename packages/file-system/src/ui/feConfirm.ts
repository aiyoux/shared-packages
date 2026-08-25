/**
 * Copy for FileExplorer destructive confirms (hard-delete, delete forever, empty trash).
 * In-memory is not a remote; it still confirms because there is no trash.
 */
import { isRemoteClass } from './explorerDriver.js';

export type FeConfirmCopy = {
	title: string;
	body: string;
	confirmLabel: string;
};

export type HardDeletePlace = 'remote' | 'memory' | 'disk' | 'generic';

export function hardDeletePlace(driverId: string): HardDeletePlace {
	if (driverId === 'memory') return 'memory';
	if (driverId === 'disk') return 'disk';
	if (isRemoteClass(driverId)) return 'remote';
	return 'generic';
}

export function hardDeleteCopy(args: {
	driverId: string;
	count: number;
	folderCount: number;
	name: string;
}): FeConfirmCopy {
	const place = hardDeletePlace(args.driverId);
	const title = 'Delete';
	const confirmLabel = 'Delete';
	const irreversible =
		place === 'memory'
			? 'In-memory files have no trash — this cannot be undone.'
			: 'This cannot be undone.';
	if (args.count === 1) {
		if (args.folderCount) {
			return {
				title,
				confirmLabel,
				body: `Delete folder “${args.name}” and everything inside it? ${irreversible}`
			};
		}
		if (place === 'remote') {
			return {
				title,
				confirmLabel,
				body: `Delete “${args.name}” permanently from remote storage? ${irreversible}`
			};
		}
		if (place === 'disk') {
			return {
				title,
				confirmLabel,
				body: `Permanently delete “${args.name}” from this computer? ${irreversible}`
			};
		}
		if (place === 'memory') {
			return {
				title,
				confirmLabel,
				body: `Permanently delete “${args.name}”? ${irreversible}`
			};
		}
		return {
			title,
			confirmLabel,
			body: `Permanently delete “${args.name}”? ${irreversible}`
		};
	}
	if (args.folderCount) {
		const folders = `${args.folderCount} folder${args.folderCount === 1 ? '' : 's'}`;
		return {
			title,
			confirmLabel,
			body: `Delete ${args.count} items, including ${folders} and everything inside them? ${irreversible}`
		};
	}
	if (place === 'remote') {
		return {
			title,
			confirmLabel,
			body: `Delete ${args.count} items permanently from remote storage? ${irreversible}`
		};
	}
	if (place === 'memory') {
		return {
			title,
			confirmLabel,
			body: `Permanently delete ${args.count} in-memory items? ${irreversible}`
		};
	}
	if (place === 'disk') {
		return {
			title,
			confirmLabel,
			body: `Permanently delete ${args.count} items from this computer? ${irreversible}`
		};
	}
	return {
		title,
		confirmLabel,
		body: `Permanently delete ${args.count} items? ${irreversible}`
	};
}

export function permanentDeleteCopy(name: string): FeConfirmCopy {
	return {
		title: 'Delete forever',
		confirmLabel: 'Delete forever',
		body: `Permanently delete “${name}”? This cannot be undone.`
	};
}

export function emptyTrashCopy(): FeConfirmCopy {
	return {
		title: 'Empty trash',
		confirmLabel: 'Empty trash',
		body: 'Permanently delete all items in trash? This cannot be undone.'
	};
}
