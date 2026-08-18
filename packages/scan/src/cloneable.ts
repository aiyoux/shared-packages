import type { Point, Quad } from './types.js';

/** Coerce a reactive/proxy number into a real finite primitive. */
export function plainNumber(value: unknown, fallback = 0): number {
	const n = Number(value);
	return Number.isFinite(n) ? n : fallback;
}

export function plainPoint(p: Point): Point {
	return { x: plainNumber(p.x), y: plainNumber(p.y) };
}

/**
 * Unwrap Svelte `$state` (or any other Proxy) into a structured-cloneable quad.
 * `Worker.postMessage` throws DataCloneError on the reactive object itself.
 */
export function plainQuad(quad: Quad): Quad {
	return [plainPoint(quad[0]), plainPoint(quad[1]), plainPoint(quad[2]), plainPoint(quad[3])];
}

/** JSON round-trip: strips Proxies and drops `undefined`. */
export function plainJson<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Build a worker payload that `postMessage` can clone.
 * ArrayBuffers / typed-array views are left intact so they can be transferred.
 */
export function workerPayload(payload: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(payload)) {
		if (value === undefined) continue;
		if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
			out[key] = value;
			continue;
		}
		out[key] = plainJson(value);
	}
	return out;
}
