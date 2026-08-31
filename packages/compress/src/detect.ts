import { CODEC_EXTENSION, type Codec, type DetectedFormat } from './types.js';

const EXT_TO_CODEC: Record<string, Codec> = {
	'.zip': 'zip',
	'.tar': 'tar',
	'.7z': '7z',
	'.rar': 'rar',
	'.gz': 'gzip',
	'.gzip': 'gzip',
	'.tgz': 'gzip',
	'.deflate': 'deflate',
	'.zz': 'zlib',
	'.zlib': 'zlib',
	'.br': 'brotli',
	'.brotli': 'brotli',
	'.lz4': 'lz4',
	'.zst': 'zstd',
	'.zstd': 'zstd',
	'.xz': 'xz',
	'.lzma': 'lzma',
	'.bz2': 'bzip2',
	'.bzip2': 'bzip2',
	'.sz': 'snappy',
	'.snappy': 'snappy'
};

function startsWith(bytes: Uint8Array, sig: number[]): boolean {
	if (bytes.length < sig.length) return false;
	for (let i = 0; i < sig.length; i++) {
		if (bytes[i] !== sig[i]) return false;
	}
	return true;
}

/** Sniff a compressed payload from magic bytes. Headerless codecs return null. */
export function detectFormatFromBytes(bytes: Uint8Array): DetectedFormat | null {
	if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) || startsWith(bytes, [0x50, 0x4b, 0x05, 0x06]) || startsWith(bytes, [0x50, 0x4b, 0x07, 0x08])) {
		return { codec: 'zip', confidence: 'high', label: 'ZIP archive', via: 'magic' };
	}
	// 7z: '7z' + 0xBC 0xAF 0x27 0x1C
	if (startsWith(bytes, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) {
		return { codec: '7z', confidence: 'high', label: '7z archive', via: 'magic' };
	}
	// RAR v4: Rar!\x1A\x07\x00 — RAR v5: Rar!\x1A\x07\x01\x00
	if (startsWith(bytes, [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07])) {
		return { codec: 'rar', confidence: 'high', label: 'RAR archive', via: 'magic' };
	}
	// tar: "ustar" magic at offset 257 (POSIX/USTAR format)
	if (bytes.length >= 263 && bytes[257] === 0x75 && bytes[258] === 0x73 && bytes[259] === 0x74 && bytes[260] === 0x61 && bytes[261] === 0x72) {
		return { codec: 'tar', confidence: 'high', label: 'TAR archive', via: 'magic' };
	}
	if (startsWith(bytes, [0x1f, 0x8b])) {
		return { codec: 'gzip', confidence: 'high', label: 'gzip', via: 'magic' };
	}
	if (startsWith(bytes, [0x28, 0xb5, 0x2f, 0xfd])) {
		return { codec: 'zstd', confidence: 'high', label: 'Zstandard', via: 'magic' };
	}
	if (startsWith(bytes, [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00])) {
		return { codec: 'xz', confidence: 'high', label: 'xz', via: 'magic' };
	}
	if (startsWith(bytes, [0x42, 0x5a, 0x68])) {
		return { codec: 'bzip2', confidence: 'high', label: 'bzip2', via: 'magic' };
	}
	if (startsWith(bytes, [0x04, 0x22, 0x4d, 0x18])) {
		return { codec: 'lz4', confidence: 'high', label: 'LZ4 frame', via: 'magic' };
	}
	if (bytes.length >= 2 && bytes[0] === 0x78 && (bytes[1] === 0x01 || bytes[1] === 0x5e || bytes[1] === 0x9c || bytes[1] === 0xda)) {
		return { codec: 'zlib', confidence: 'high', label: 'zlib', via: 'magic' };
	}
	return null;
}

export function detectFormatFromName(name: string): DetectedFormat | null {
	const lower = name.toLowerCase();
	// Prefer the last known suffix; handle .tar.gz as gzip of a tar.
	const parts = lower.split('.');
	if (parts.length < 2) return null;
	const last = `.${parts[parts.length - 1]}`;
	const double = parts.length >= 3 ? `.${parts[parts.length - 2]}.${parts[parts.length - 1]}` : '';
	if (double === '.tar.gz' || last === '.tgz') {
		return { codec: 'gzip', confidence: 'high', label: 'gzip', via: 'name' };
	}
	const codec = EXT_TO_CODEC[last];
	if (!codec) return null;
	return { codec, confidence: 'low', label: codec, via: 'name' };
}

export function detectFormat(bytes: Uint8Array, name?: string): DetectedFormat | null {
	return detectFormatFromBytes(bytes) ?? (name ? detectFormatFromName(name) : null);
}

export function extensionForCodec(codec: Codec): string {
	return CODEC_EXTENSION[codec];
}

export function stripCompressionExt(name: string, codec: Codec): string {
	const ext = CODEC_EXTENSION[codec];
	const lower = name.toLowerCase();
	if (lower.endsWith(ext)) return name.slice(0, -ext.length) || 'expanded';
	if (codec === 'gzip' && lower.endsWith('.gzip')) return name.slice(0, -5) || 'expanded';
	if (codec === 'gzip' && lower.endsWith('.tgz')) {
		const base = name.slice(0, -4);
		return `${base || 'archive'}.tar`;
	}
	return name.replace(/\.[^.]+$/, '') || 'expanded';
}

export function suggestArchiveName(
	entries: { name: string }[],
	fallback = 'archive',
	codec: Codec = 'zip'
): string {
	const ext = CODEC_EXTENSION[codec];
	if (entries.length === 1) {
		const base = entries[0]!.name.replace(/[/\\]+/g, '_').replace(/^\.+/, '');
		const stem = base.replace(/\.[^.]+$/, '') || fallback;
		return `${stem}${ext}`;
	}
	return `${fallback}${ext}`;
}
