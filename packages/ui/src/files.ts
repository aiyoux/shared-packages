/** Human-readable size for file lists and transfer UIs. */
export function formatBytes(n: number): string {
	if (!Number.isFinite(n) || n < 0) return '—';
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(2)} MB`;
	return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
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
