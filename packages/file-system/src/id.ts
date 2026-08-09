export function generateId(prefix = 'n'): string {
	if (typeof crypto !== 'undefined' && crypto.randomUUID) {
		return `${prefix}_${crypto.randomUUID()}`;
	}
	return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function legacySketchId(id: number | string): string {
	return `legacy:sketch:${id}`;
}

export function legacySketchFolderId(path: string): string {
	return `legacy:sk-folder:${encodeURIComponent(path)}`;
}

export function legacyVrecId(id: string): string {
	return `legacy:vrec:${id}`;
}

export function legacyVrecFolderId(id: string): string {
	return `legacy:vfolder:${id}`;
}
