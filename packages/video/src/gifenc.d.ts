declare module 'gifenc' {
	export type GifPalette = number[][];
	export type WriteFrameOptions = {
		palette?: GifPalette;
		first?: boolean;
		transparent?: boolean;
		transparentIndex?: number;
		delay?: number;
		repeat?: number;
		dispose?: number;
	};

	export function quantize(
		rgba: Uint8Array | Uint8ClampedArray,
		maxColors: number,
		options?: { format?: string; oneBitAlpha?: boolean | number; clearAlpha?: boolean }
	): GifPalette;

	export function applyPalette(
		rgba: Uint8Array | Uint8ClampedArray,
		palette: GifPalette,
		format?: 'rgb565' | 'rgb444' | 'rgba4444'
	): number[];

	export function GIFEncoder(): {
		writeFrame(index: number[], width: number, height: number, options?: WriteFrameOptions): void;
		finish(): void;
		bytes(): Uint8Array;
		bytesView(): Uint8Array;
		reset(): void;
	};

	const gifenc: {
		quantize: typeof quantize;
		applyPalette: typeof applyPalette;
		GIFEncoder: typeof GIFEncoder;
	};
	export default gifenc;
}