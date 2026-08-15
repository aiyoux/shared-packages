import { detectFormat, extensionForCodec, stripCompressionExt, suggestArchiveName } from './detect.js';
import { loadEngine } from './engines.js';
import {
	engineSupports,
	type ArchiveEntry,
	type Codec,
	type CompressOptions,
	type EngineId
} from './types.js';

export type PackedFile = ArchiveEntry & {
	codec: Codec;
	sourceBytes: number;
};

export async function packFiles(
	engineId: EngineId,
	files: ArchiveEntry[],
	codec: Codec,
	options?: CompressOptions
): Promise<PackedFile[]> {
	if (!files.length) throw new Error('Nothing to compress');
	if (!engineSupports(engineId, codec)) {
		throw new Error(`${engineId} does not support ${codec}`);
	}

	const engine = await loadEngine(engineId);

	if (codec === 'zip') {
		if (!engine.zip) throw new Error(`${engine.info.label} cannot create ZIP archives`);
		const data = await engine.zip(files, options);
		const name = suggestArchiveName(files);
		const sourceBytes = files.reduce((n, f) => n + f.data.byteLength, 0);
		return [{ name, data, codec, sourceBytes }];
	}

	return Promise.all(
		files.map(async (file) => {
			const data = await engine.compress(file.data, codec, options);
			return {
				name: `${file.name}${extensionForCodec(codec)}`,
				data,
				codec,
				sourceBytes: file.data.byteLength
			};
		})
	);
}

export async function expandBytes(
	engineId: EngineId,
	bytes: Uint8Array,
	codec: Codec,
	name = 'file'
): Promise<ArchiveEntry[]> {
	if (!engineSupports(engineId, codec)) {
		throw new Error(`${engineId} does not support ${codec}`);
	}
	const engine = await loadEngine(engineId);
	if (codec === 'zip') {
		if (!engine.unzip) throw new Error(`${engine.info.label} cannot expand ZIP archives`);
		return engine.unzip(bytes);
	}
	const data = await engine.decompress(bytes, codec);
	return [{ name: stripCompressionExt(name, codec), data }];
}

/** Pick a codec for expand: magic bytes, then filename, then the UI fallback. */
export function resolveExpandCodec(
	bytes: Uint8Array,
	name: string | undefined,
	fallback: Codec
): Codec {
	return detectFormat(bytes, name)?.codec ?? fallback;
}
