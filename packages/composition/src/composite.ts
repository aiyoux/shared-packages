import { getClipRenderer } from './protocol.js';
import { sample } from './sample.js';
import type { ActiveSample, CompositionDoc } from './types.js';

function roleOrder(role: ActiveSample['track']['role']): number {
	return role === 'media' ? 0 : 1;
}

/**
 * Stateless: a new OffscreenCanvas every call. Media first, then graphics.
 * Do not cache last-frame bitmaps — `pull(t)` must not depend on call order.
 */
export async function composite(
	comp: CompositionDoc,
	tMs: number,
	size: { w: number; h: number }
): Promise<OffscreenCanvas> {
	const canvas = new OffscreenCanvas(size.w, size.h);
	const ctx = canvas.getContext('2d');
	if (!ctx) throw new Error('OffscreenCanvas 2d context unavailable');

	const samples = sample(comp, tMs).slice().sort((a, b) => roleOrder(a.track.role) - roleOrder(b.track.role));

	for (const active of samples) {
		const renderer = getClipRenderer(active.clip.kind);
		if (!renderer) {
			throw new Error(`No ClipRenderer registered for kind "${active.clip.kind}"`);
		}
		const frame = await renderer.pullFrame(active.clip, active.localMs, size);
		ctx.drawImage(frame as CanvasImageSource, 0, 0);
	}

	return canvas;
}
