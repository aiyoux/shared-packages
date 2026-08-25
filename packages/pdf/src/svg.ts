import type { PdfIrElement, PdfTransform } from './types.js';

function escapeXml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;');
}

function n(value: number): string {
	if (!Number.isFinite(value)) return '0';
	const r = Math.round(value * 1000) / 1000;
	return String(r);
}

function transformAttr(t?: PdfTransform): string {
	if (!t) return '';
	const parts: string[] = [];
	if (t.x || t.y) parts.push(`translate(${n(t.x)},${n(t.y ?? 0)})`);
	if (t.rotation) parts.push(`rotate(${n((t.rotation * 180) / Math.PI)})`);
	if (t.sx != null || t.sy != null) parts.push(`scale(${n(t.sx ?? 1)},${n(t.sy ?? 1)})`);
	return parts.length ? ` transform="${parts.join(' ')}"` : '';
}

function opacityAttr(opacity?: number): string {
	if (opacity == null || opacity === 1) return '';
	return ` opacity="${n(opacity)}"`;
}

function elementToSvg(el: PdfIrElement): string {
	if (el.hidden) return '';
	switch (el.type) {
		case 'text': {
			const extra = `${transformAttr(el.transform)}${opacityAttr(el.opacity)}`;
			if (el.d) {
				return `<path d="${escapeXml(el.d)}" fill="${escapeXml(el.fill)}"${extra}/>`;
			}
			const y = el.y + el.fontSize;
			return `<text x="${n(el.x)}" y="${n(y)}" fill="${escapeXml(el.fill)}" font-size="${n(el.fontSize)}"${extra}>${escapeXml(el.str)}</text>`;
		}
		case 'image':
		case 'chip': {
			const extra = `${transformAttr(el.transform)}${el.type === 'image' ? opacityAttr(el.opacity) : ''}`;
			return `<image href="${escapeXml(el.src)}" x="${n(el.x)}" y="${n(el.y)}" width="${n(el.width)}" height="${n(el.height)}"${extra}/>`;
		}
		case 'path': {
			const fillRule = el.fillRule === 'evenodd' ? ' fill-rule="evenodd"' : '';
			const extra = `${transformAttr(el.transform)}${opacityAttr(el.opacity)}`;
			return `<path d="${escapeXml(el.d)}" fill="${escapeXml(el.fill)}" stroke="${escapeXml(el.stroke)}" stroke-width="${n(el.strokeWidth)}"${fillRule}${extra}/>`;
		}
		case 'group': {
			const extra = `${transformAttr(el.transform)}${opacityAttr(el.opacity)}`;
			const kids = el.children.map(elementToSvg).join('');
			return `<g${extra}>${kids}</g>`;
		}
	}
}

export function irToSvg(elements: PdfIrElement[], width: number, height: number): string {
	const body = elements.map(elementToSvg).join('');
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${n(width)}" height="${n(height)}" viewBox="0 0 ${n(width)} ${n(height)}">${body}</svg>`;
}
