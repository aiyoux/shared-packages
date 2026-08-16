declare module './wasm/vtracer_wasm.js' {
	export function vectorize_rgba(
		data: Uint8Array,
		width: number,
		height: number,
		options: unknown
	): string;
}
