import type { ResolvedFrame, ResolvedNode } from './types.js';

export function escapeXml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;');
}

function emitAttrs(attrs: Record<string, string>): string {
	let out = '';
	for (const [key, value] of Object.entries(attrs)) {
		out += ` ${escapeXml(key)}="${escapeXml(value)}"`;
	}
	return out;
}

function emitNode(node: ResolvedNode): string {
	const attrs = { ...node.attrs };
	if (node.id && attrs.id === undefined) attrs.id = node.id;
	const open = `<${node.tag}${emitAttrs(attrs)}>`;
	const children = node.children?.map(emitNode).join('') ?? '';
	const text = node.text !== undefined ? escapeXml(node.text) : '';
	return `${open}${text}${children}</${node.tag}>`;
}

export function renderSvg(frame: ResolvedFrame): string {
	const w = frame.width;
	const h = frame.height;
	const bg = `<rect x="0" y="0" width="${w}" height="${h}" fill="${escapeXml(frame.background)}"></rect>`;
	const body = frame.nodes.map(emitNode).join('');
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${bg}${body}</svg>`;
}

/**
 * SVG → bitmap via DOM Image. Do not use createImageBitmap on an SVG Blob —
 * Chromium throws DOMException (WHATWG html#923).
 */
export async function rasterize(
	frame: ResolvedFrame,
	canvas: OffscreenCanvas | HTMLCanvasElement
): Promise<void> {
	const svg = renderSvg(frame);
	const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
	try {
		const img = new Image();
		img.src = url;
		await img.decode();
		canvas.width = frame.width;
		canvas.height = frame.height;
		// getContext('2d') widens to the union of every context type when `canvas`
		// may be an OffscreenCanvas, and ImageBitmapRenderingContext has neither
		// clearRect nor drawImage. Narrow to the 2d context we actually asked for.
		const ctx = canvas.getContext('2d') as
			| CanvasRenderingContext2D
			| OffscreenCanvasRenderingContext2D
			| null;
		if (!ctx) throw new Error('2d context unavailable');
		ctx.clearRect(0, 0, canvas.width, canvas.height);
		ctx.drawImage(img, 0, 0);
	} finally {
		URL.revokeObjectURL(url);
	}
}
