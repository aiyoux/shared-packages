/** Human-readable size for file lists and transfer UIs.
 *
 * One decimal below 10 of the unit, whole numbers at or above, scaling
 * through TB. Transfer sizes exceed GB and storage quotas reach TB, so the
 * scale never truncates and large values do not print as `2048.0 MB`. */
export function formatBytes(n: number): string {
	if (!Number.isFinite(n) || n < 0) return '—';
	if (n < 1024) return `${n} B`;
	const units = ['KB', 'MB', 'GB', 'TB'];
	let v = n;
	let i = -1;
	do {
		v /= 1024;
		i += 1;
	} while (v >= 1024 && i < units.length - 1);
	return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

/** Copy into a plain ArrayBuffer so Blob/File constructors accept the view. */
export function bytesToArrayBuffer(data: Uint8Array): ArrayBuffer {
	const copy = new Uint8Array(data.byteLength);
	copy.set(data);
	return copy.buffer;
}

export function downloadBytes(
	name: string,
	data: Uint8Array,
	mime = 'application/octet-stream'
): void {
	const blob = new Blob([bytesToArrayBuffer(data)], { type: mime });
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = name;
	document.body.appendChild(a);
	a.click();
	a.remove();
	URL.revokeObjectURL(url);
}

export function fileFromBytes(
	name: string,
	data: Uint8Array,
	mime = 'application/octet-stream'
): File {
	return new File([bytesToArrayBuffer(data)], name, { type: mime });
}
