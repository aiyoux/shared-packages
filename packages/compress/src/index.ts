export {
	CODEC_EXTENSION,
	CODEC_LABEL,
	DEFAULT_ENGINE,
	ENGINE_CATALOG,
	defaultCodecFor,
	engineInfo,
	engineSupports,
	type ArchiveEntry,
	type ArchiveMemberProgress,
	type Codec,
	type CompressOptions,
	type CompressionEngine,
	type UnzipProgressOpts,
	type DetectedFormat,
	type EngineId,
	type EngineInfo
} from './types.js';

export {
	detectFormat,
	detectFormatFromBytes,
	detectFormatFromName,
	extensionForCodec,
	stripCompressionExt,
	suggestArchiveName
} from './detect.js';

export { listEngines, loadEngine, peekEngine } from './engines.js';

export { expandBytes, packFiles, resolveExpandCodec, type PackedFile } from './operations.js';

export { isJunkArchivePath } from './junk.js';

export {
	compressBytes,
	decompressBytes,
	decompressBytesCapped,
	deflateRaw,
	gunzipBytes,
	gzipBytes,
	inflateRaw,
	readStreamToBytes,
	type NativeStreamCodec
} from './streams.js';
