import { isOffsetOutOfBounds, MAX_POTRACE_PIXELS, packImageData } from '../pixels.js';
import type { PotraceOptions } from '../types.js';

type PotraceMod = {
	init: () => Promise<void>;
	potrace: (source: ImageBitmapSource, options?: Record<string, unknown>) => Promise<string>;
};

let ready = false;

async function loadMod(): Promise<PotraceMod> {
	return (await import('esm-potrace-wasm')) as unknown as PotraceMod;
}

export async function loadPotrace(): Promise<void> {
	if (ready) return;
	const mod = await loadMod();
	await mod.init();
	ready = true;
}

export function potraceReady(): boolean {
	return ready;
}

function potraceOpts(options: PotraceOptions): Record<string, unknown> {
	return {
		turdsize: options.turdsize ?? 2,
		turnpolicy: options.turnpolicy ?? 4,
		alphamax: options.alphamax ?? 1,
		opticurve: options.opticurve === false ? 0 : 1,
		opttolerance: options.opttolerance ?? 0.2,
		pathonly: options.pathonly ?? false,
		extractcolors: options.extractcolors ?? true,
		posterizelevel: options.posterizelevel ?? 2,
		posterizationalgorithm: options.posterizationalgorithm ?? 0
	};
}

function wrapPotraceError(err: unknown): Error {
	if (isOffsetOutOfBounds(err)) {
		return new Error(
			'Potrace could not fit this PNG in WASM memory. Try a smaller size, or turn off Extract colors.'
		);
	}
	return err instanceof Error ? err : new Error(String(err));
}

export async function vectorizeWithPotrace(
	image: ImageData,
	options: PotraceOptions
): Promise<string> {
	await loadPotrace();
	const mod = await loadMod();
	const opts = potraceOpts(options);
	let work = packImageData(image, MAX_POTRACE_PIXELS);
	let last: unknown;
	for (let attempt = 0; attempt < 4; attempt++) {
		try {
			return await mod.potrace(work, opts);
		} catch (err) {
			last = err;
			if (!isOffsetOutOfBounds(err)) throw wrapPotraceError(err);
			const nextMax = Math.max(8_000, Math.floor((work.width * work.height) / 2));
			work = packImageData(work, nextMax);
		}
	}
	throw wrapPotraceError(last);
}
