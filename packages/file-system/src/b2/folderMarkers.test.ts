import { describe, it, expect } from 'vitest';
import {
	baseNameFromKey,
	baseNameFromPrefix,
	isFolderMarkerKey,
	markerKeyForFolderPrefix,
	sanitizeSegment
} from './folderMarkers.js';

describe('folderMarkers', () => {
	it('marker keys', () => {
		expect(markerKeyForFolderPrefix('photos/')).toBe('photos/.bzEmpty');
		expect(isFolderMarkerKey('photos/.bzEmpty')).toBe(true);
		expect(isFolderMarkerKey('photos/img.png')).toBe(false);
	});

	it('base names', () => {
		expect(baseNameFromPrefix('a/b/c/')).toBe('c');
		expect(baseNameFromKey('a/b/file.skch')).toBe('file.skch');
	});

	it('sanitize', () => {
		expect(sanitizeSegment('ok')).toBe('ok');
		expect(() => sanitizeSegment('a/b')).toThrow();
		expect(() => sanitizeSegment('..')).toThrow();
	});

	it('directChildFolderFromMarker', async () => {
		const { directChildFolderFromMarker } = await import('./folderMarkers.js');
		expect(directChildFolderFromMarker('', 'photos/.bzEmpty')).toBe('photos/');
		expect(directChildFolderFromMarker('a/', 'a/b/.bzEmpty')).toBe('a/b/');
		expect(directChildFolderFromMarker('', 'photos/img.png')).toBeNull();
		expect(directChildFolderFromMarker('a/', 'other/b/.bzEmpty')).toBeNull();
	});
});
