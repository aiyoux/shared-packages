import type { ClipRenderer } from './types.js';

const renderers = new Map<string, ClipRenderer>();

export function registerClipRenderer(r: ClipRenderer): void {
	renderers.set(r.kind, r);
}

export function getClipRenderer(kind: string): ClipRenderer | undefined {
	return renderers.get(kind);
}
