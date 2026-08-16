import type { CloudParams, CloudPuffNode } from './types.js';

export const CLOUD_PUFF_NODES: CloudPuffNode[] = [
	{ offset: [0, 0.2, 0], scale: 1.1 },
	{ offset: [0, 0.8, 0.05], scale: 0.95 },
	{ offset: [-0.95, -0.05, -0.1], scale: 0.8 },
	{ offset: [0.95, -0.05, 0.1], scale: 0.85 },
	{ offset: [-0.55, 0.45, 0.15], scale: 0.75 },
	{ offset: [0.55, 0.45, -0.2], scale: 0.8 },
	{ offset: [-1.45, -0.25, 0], scale: 0.55 },
	{ offset: [1.45, -0.25, 0], scale: 0.6 }
];

export const CLOUD_DEFAULTS: Required<CloudParams> = {
	seed: 1,
	density: 1,
	amount: 8,
	size: 1,
	style: 'outline',
	weight: 1,
	taper: 0,
	edgeWeight: 0,
	creep: 0,
	rimCircles: 0,
	gloss: 0,
	shade: 0,
	hatch: 1,
	hatchLength: 1,
	inkiness: 0.5,
	tickVariety: 0.5
};

export const CLOUD_CONTROL_RANGES: Partial<
	Record<keyof CloudParams, { label: string; min: number; max: number; step: number }>
> = {
	amount: { label: 'Amount', min: 3, max: 24, step: 1 },
	density: { label: 'Density', min: 0.8, max: 1.8, step: 0.05 },
	size: { label: 'Size', min: 0.5, max: 1.8, step: 0.05 },
	weight: { label: 'Weight', min: 0.4, max: 2.6, step: 0.1 },
	taper: { label: 'Taper', min: 0, max: 1, step: 0.05 },
	edgeWeight: { label: 'Edge', min: 0, max: 1, step: 0.05 },
	shade: { label: 'Shade', min: 0, max: 1, step: 0.05 },
	creep: { label: 'Creep', min: 0, max: 1, step: 0.05 },
	rimCircles: { label: 'Rings', min: 0, max: 1, step: 0.05 },
	gloss: { label: 'Gloss', min: 0, max: 1, step: 0.05 },
	hatch: { label: 'Hatch', min: 0, max: 1.5, step: 0.05 },
	hatchLength: { label: 'Strokes', min: 0.4, max: 2, step: 0.05 },
	inkiness: { label: 'Inkiness', min: 0, max: 1, step: 0.05 },
	tickVariety: { label: 'Variety', min: 0, max: 1, step: 0.05 }
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export function randomFromSeed(seed: number) {
	let value = seed >>> 0;
	return () => {
		value += 0x6d2b79f5;
		let result = value;
		result = Math.imul((result ^ (result >>> 15)), result | 1);
		result ^= result + Math.imul((result ^ (result >>> 7)), result | 61);
		return ((result ^ (result >>> 14)) >>> 0) / 4294967296;
	};
}

export function getCloudPuffNodes(params: CloudParams = {}): CloudPuffNode[] {
	if (Object.keys(params).length === 0) return CLOUD_PUFF_NODES;
	const amountRange = CLOUD_CONTROL_RANGES.amount!;
	const densityRange = CLOUD_CONTROL_RANGES.density!;
	const sizeRange = CLOUD_CONTROL_RANGES.size!;
	const amount = clamp(Math.round(params.amount ?? CLOUD_DEFAULTS.amount), amountRange.min, amountRange.max);
	const density = clamp(params.density ?? CLOUD_DEFAULTS.density, densityRange.min, densityRange.max);
	const size = clamp(params.size ?? CLOUD_DEFAULTS.size, sizeRange.min, sizeRange.max);
	const random = randomFromSeed(params.seed ?? CLOUD_DEFAULTS.seed);
	const extraCount = Math.max(1, amount - CLOUD_PUFF_NODES.length);

	return Array.from({ length: amount }, (_, index) => {
		const base = CLOUD_PUFF_NODES[index];
		const extraIndex = index - CLOUD_PUFF_NODES.length;
		const span = (extraIndex + 0.5) / extraCount;
		const arch = Math.sin(span * Math.PI);
		const x = base ? base.offset[0] : (span * 2 - 1) * 1.7;
		const y = base ? base.offset[1] : 0.1 + arch * 0.5 + (random() - 0.5) * 0.16;
		const z = base ? base.offset[2] : (random() - 0.5) * 0.3;
		const baseScale = base ? base.scale : 0.5 + arch * 0.3;
		const jitter = (random() - 0.5) * 0.18;

		return {
			offset: [x / density + jitter, y / density + jitter * 0.55, z + (random() - 0.5) * 0.16],
			scale: baseScale * size * (0.9 + random() * 0.2)
		};
	});
}
