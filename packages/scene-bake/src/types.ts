export type { PathData } from '@shared-packages/drawing-tools';

export type CloudStyle = 'outline' | 'sketch' | 'puffy' | 'bold';

export interface CloudParams {
	seed?: number;
	density?: number;
	amount?: number;
	size?: number;
	style?: CloudStyle;
	weight?: number;
	taper?: number;
	edgeWeight?: number;
	creep?: number;
	rimCircles?: number;
	gloss?: number;
	shade?: number;
	hatch?: number;
	hatchLength?: number;
	inkiness?: number;
	tickVariety?: number;
}

export interface PseudoEffectParams {
	rayCount?: number;
	outerRadius?: number;
	style?: 'cartoon_burst' | 'semi_realistic_flare' | 'aura_ring';
	cloud?: CloudParams;
}

export type CloudPuffNode = { offset: [number, number, number]; scale: number };
