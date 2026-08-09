/** B2 empty-folder marker convention (K12): `…/folderName/.bzEmpty` */

export const FOLDER_MARKER = '.bzEmpty';

export function isFolderMarkerKey(fileName: string): boolean {
	return fileName.endsWith(`/${FOLDER_MARKER}`) || fileName === FOLDER_MARKER;
}

export function folderPrefixFromMarker(markerKey: string): string {
	if (markerKey === FOLDER_MARKER) return '';
	if (markerKey.endsWith(`/${FOLDER_MARKER}`)) {
		// photos/.bzEmpty → photos/
		return markerKey.slice(0, -FOLDER_MARKER.length);
	}
	return markerKey;
}

/**
 * If `fileName` is a direct-child folder marker under `listPrefix`, return the
 * folder prefix id (absolute). Otherwise null.
 * listPrefix '' + 'photos/.bzEmpty' → 'photos/'
 * listPrefix 'a/' + 'a/b/.bzEmpty' → 'a/b/'
 */
export function directChildFolderFromMarker(
	listPrefix: string,
	fileName: string
): string | null {
	if (!isFolderMarkerKey(fileName)) return null;
	if (!fileName.startsWith(listPrefix)) return null;
	const rel = fileName.slice(listPrefix.length);
	const m = rel.match(/^([^/]+)\/\.bzEmpty$/);
	if (!m) return null;
	return `${listPrefix}${m[1]}/`;
}

export function markerKeyForFolderPrefix(folderPrefix: string): string {
	const p = folderPrefix.endsWith('/') ? folderPrefix : `${folderPrefix}/`;
	return `${p}${FOLDER_MARKER}`;
}

export function baseNameFromPrefix(folderPrefix: string): string {
	const trimmed = folderPrefix.replace(/\/+$/, '');
	const i = trimmed.lastIndexOf('/');
	return i >= 0 ? trimmed.slice(i + 1) : trimmed;
}

export function baseNameFromKey(fileName: string): string {
	const i = fileName.lastIndexOf('/');
	return i >= 0 ? fileName.slice(i + 1) : fileName;
}

export function sanitizeSegment(name: string): string {
	const n = name.trim();
	if (!n || n === '.' || n === '..' || n.includes('/')) {
		throw new Error('INVALID_NAME');
	}
	return n;
}
