/** `m:ss` or `m:ss.cc` for editor / player chrome. */
export function formatTimecode(seconds: number, withCentis = false): string {
	if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
	const m = Math.floor(seconds / 60);
	const s = Math.floor(seconds % 60);
	if (!withCentis) {
		return `${m}:${s.toString().padStart(2, '0')}`;
	}
	const cs = Math.floor((seconds % 1) * 100);
	return `${m}:${s.toString().padStart(2, '0')}.${cs.toString().padStart(2, '0')}`;
}
