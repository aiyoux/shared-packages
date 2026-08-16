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

export async function vectorizeWithPotrace(
	image: ImageData,
	options: PotraceOptions
): Promise<string> {
	await loadPotrace();
	const mod = await loadMod();
	return mod.potrace(image, {
		turdsize: options.turdsize ?? 2,
		turnpolicy: options.turnpolicy ?? 4,
		alphamax: options.alphamax ?? 1,
		opticurve: options.opticurve === false ? 0 : 1,
		opttolerance: options.opttolerance ?? 0.2,
		pathonly: options.pathonly ?? false,
		extractcolors: options.extractcolors ?? true,
		posterizelevel: options.posterizelevel ?? 2,
		posterizationalgorithm: options.posterizationalgorithm ?? 0
	});
}
