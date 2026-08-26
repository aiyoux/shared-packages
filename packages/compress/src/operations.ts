import { detectFormat, extensionForCodec, stripCompressionExt, suggestArchiveName } from './detect.js';
import { isJunkArchivePath } from './junk.js';
import { loadEngine } from './engines.js';
import {
	engineSupports,
	type ArchiveEntry,
	type Codec,
	type CompressOptions,
	type EngineId,
	type UnzipProgressOpts
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
		const name = suggestArchiveName(files, 'archive', 'zip');
		const sourceBytes = files.reduce((n, f) => n + f.data.byteLength, 0);
		return [{ name, data, codec, sourceBytes }];
	}

	if (codec === 'tar') {
		if (!engine.tar) throw new Error(`${engine.info.label} cannot create TAR archives`);
		const data = await engine.tar(files, options);
		const name = suggestArchiveName(files, 'archive', 'tar');
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
	name = 'file',
	opts?: UnzipProgressOpts
): Promise<ArchiveEntry[]> {
	if (!engineSupports(engineId, codec)) {
		throw new Error(`${engineId} does not support ${codec}`);
	}
	const engine = await loadEngine(engineId);
	const skipSystemFiles = opts?.skipSystemFiles !== false;
	const keep = (path: string) => !skipSystemFiles || !isJunkArchivePath(path);
	if (codec === 'zip') {
		if (!engine.unzip) throw new Error(`${engine.info.label} cannot expand ZIP archives`);
		const files = await engine.unzip(bytes, {
			onMember: (ev) => {
				if (!keep(ev.name)) return;
				opts?.onMember?.(ev);
			}
		});
		return files.filter((f) => keep(f.name));
	}
	if (codec === 'tar') {
		if (!engine.untar) throw new Error(`${engine.info.label} cannot expand TAR archives`);
		const files = (await engine.untar(bytes)).filter((f) => keep(f.name));
		for (const f of files) {
			opts?.onMember?.({
				name: f.name,
				transferred: f.data.byteLength,
				size: f.data.byteLength,
				done: true
			});
		}
		return files;
	}
	const destName = stripCompressionExt(name, codec);
	opts?.onMember?.({ name: destName, transferred: 0, size: bytes.byteLength, done: false });
	const data = await engine.decompress(bytes, codec);
	opts?.onMember?.({
		name: destName,
		transferred: data.byteLength,
		size: data.byteLength,
		done: true
	});
	return [{ name: destName, data }];
}

/** Pick a codec for expand: magic bytes, then filename, then the UI fallback. */
export function resolveExpandCodec(
	bytes: Uint8Array,
	name: string | undefined,
	fallback: Codec
): Codec {
	return detectFormat(bytes, name)?.codec ?? fallback;
}
