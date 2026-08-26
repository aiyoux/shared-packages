/**
 * macOS Finder (and some zip tools) stuff AppleDouble metadata into archives:
 * a `__MACOSX/` tree and `._filename` siblings. `.DS_Store` is the same class
 * of junk. Skip these on expand so they never land in the dest listing.
 */
export function isJunkArchivePath(path: string): boolean {
	const parts = path.replace(/\\/g, '/').split('/').filter(Boolean);
	for (const part of parts) {
		if (part === '.DS_Store') return true;
		if (part.startsWith('._')) return true;
		if (part.toUpperCase() === '__MACOSX') return true;
	}
	return false;
}
