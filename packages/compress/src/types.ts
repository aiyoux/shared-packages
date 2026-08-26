export type EngineId = 'fflate' | 'zipkit' | 'addmaple' | 'tarjs' | 'nanotar';

export type Codec =
	| 'zip'
	| 'tar'
	| 'gzip'
	| 'deflate'
	| 'zlib'
	| 'brotli'
	| 'lz4'
	| 'zstd'
	| 'xz'
	| 'lzma'
	| 'bzip2'
	| 'snappy';

export type ArchiveEntry = {
	name: string;
	data: Uint8Array;
};

export type EngineInfo = {
	id: EngineId;
	label: string;
	description: string;
	codecs: readonly Codec[];
	supportsZip: boolean;
	supportsTar: boolean;
};

export type CompressOptions = {
	/** Hint only — engines map this onto their own level/mode knobs. */
	level?: 'speed' | 'balanced' | 'ratio';
};

/** One archive member while unzipping (path as stored in the archive). */
export type ArchiveMemberProgress = {
	name: string;
	transferred: number;
	size?: number;
	done: boolean;
};

export type UnzipProgressOpts = {
	onMember?: (ev: ArchiveMemberProgress) => void;
	/** Drop Finder `__MACOSX` / `._*` / `.DS_Store`. Default true. */
	skipSystemFiles?: boolean;
	signal?: AbortSignal;
};

export type DetectedFormat = {
	codec: Codec;
	confidence: 'high' | 'low';
	label: string;
	via: 'magic' | 'name';
};

export interface CompressionEngine {
	readonly info: EngineInfo;
	load(): Promise<void>;
	compress(bytes: Uint8Array, codec: Exclude<Codec, 'zip' | 'tar'>, options?: CompressOptions): Promise<Uint8Array>;
	decompress(bytes: Uint8Array, codec: Exclude<Codec, 'zip' | 'tar'>): Promise<Uint8Array>;
	zip?(entries: ArchiveEntry[], options?: CompressOptions): Promise<Uint8Array>;
	unzip?(bytes: Uint8Array, opts?: UnzipProgressOpts): Promise<ArchiveEntry[]>;
	tar?(entries: ArchiveEntry[], options?: CompressOptions): Promise<Uint8Array>;
	untar?(bytes: Uint8Array): Promise<ArchiveEntry[]>;
}

export const ENGINE_CATALOG: readonly EngineInfo[] = [
	{
		id: 'fflate',
		label: 'fflate',
		description: 'Pure JavaScript — gzip, deflate, zlib, and ZIP. Smallest download.',
		codecs: ['zip', 'gzip', 'deflate', 'zlib'],
		supportsZip: true,
		supportsTar: false
	},
	{
		id: 'zipkit',
		label: 'ZipKit (WASM)',
		description: 'One WASM engine — gzip through zstd, brotli, xz, and ZIP.',
		codecs: ['zip', 'gzip', 'deflate', 'zlib', 'brotli', 'lz4', 'zstd', 'xz', 'lzma', 'bzip2', 'snappy'],
		supportsZip: true,
		supportsTar: false
	},
	{
		id: 'addmaple',
		label: 'AddMaple (3× WASM)',
		description: 'SIMD WASM modules for gzip, brotli, and lz4. No ZIP container.',
		codecs: ['gzip', 'brotli', 'lz4'],
		supportsZip: false,
		supportsTar: false
	},
	{
		id: 'tarjs',
		label: 'tarjs',
		description: 'Pure JavaScript tar reader/writer. Read and write .tar archives.',
		codecs: ['tar'],
		supportsZip: false,
		supportsTar: true
	},
	{
		id: 'nanotar',
		label: 'nanotar',
		description: 'Tiny zero-dependency tar parser/writer for any JS runtime.',
		codecs: ['tar'],
		supportsZip: false,
		supportsTar: true
	}
] as const;

export const DEFAULT_ENGINE: EngineId = 'fflate';

export const CODEC_LABEL: Record<Codec, string> = {
	zip: 'ZIP archive',
	tar: 'TAR archive',
	gzip: 'gzip',
	deflate: 'raw deflate',
	zlib: 'zlib',
	brotli: 'Brotli',
	lz4: 'LZ4',
	zstd: 'Zstandard',
	xz: 'xz',
	lzma: 'LZMA',
	bzip2: 'bzip2',
	snappy: 'Snappy'
};

export const CODEC_EXTENSION: Record<Codec, string> = {
	zip: '.zip',
	tar: '.tar',
	gzip: '.gz',
	deflate: '.deflate',
	zlib: '.zz',
	brotli: '.br',
	lz4: '.lz4',
	zstd: '.zst',
	xz: '.xz',
	lzma: '.lzma',
	bzip2: '.bz2',
	snappy: '.sz'
};

export function engineInfo(id: EngineId): EngineInfo {
	const found = ENGINE_CATALOG.find((e) => e.id === id);
	if (!found) throw new Error(`Unknown compression engine: ${id}`);
	return found;
}

export function engineSupports(id: EngineId, codec: Codec): boolean {
	return engineInfo(id).codecs.includes(codec);
}

export function defaultCodecFor(id: EngineId): Codec {
	const info = engineInfo(id);
	if (info.supportsZip) return 'zip';
	if (info.supportsTar) return 'tar';
	return info.codecs[0] ?? 'gzip';
}
