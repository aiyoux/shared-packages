export type StickerMojiId = 'happy' | 'sad';
export type StickerStyleId = 'style-1' | 'style-2';

export type StickerPath = {
	d: string;
	stroke: string;
	fill: string;
	strokeWidth: number;
	fillRule?: 'nonzero' | 'evenodd';
	opacity?: number;
};

export type StickerStyle = {
	id: StickerStyleId;
	label: string;
};

export type StickerMoji = {
	id: StickerMojiId;
	name: string;
};

export interface StickerTemplate {
	id: string;
	mojiId: StickerMojiId;
	styleId: StickerStyleId;
	viewBoxWidth: number;
	viewBoxHeight: number;
	paths: StickerPath[];
}

export const STICKER_STYLES: readonly StickerStyle[] = [
	{ id: 'style-1', label: 'Classic' },
	{ id: 'style-2', label: 'Neon' }
];

export const STICKER_MOJIS: readonly StickerMoji[] = [
	{ id: 'happy', name: 'Happy' },
	{ id: 'sad', name: 'Sad' }
];

/** Older sketches stored the first happy face as `smiley`. */
export const STICKER_ID_ALIASES: Record<string, string> = {
	smiley: 'happy:style-1'
};

export function makeStickerId(mojiId: StickerMojiId, styleId: StickerStyleId): string {
	return `${mojiId}:${styleId}`;
}

const FACE_S1: StickerPath = {
	d: 'M 10 60 A 50 50 0 1 0 110 60 A 50 50 0 1 0 10 60 Z',
	fill: '#F7D44A',
	stroke: '#2C2416',
	strokeWidth: 5
};

const EYES_S1: StickerPath[] = [
	{
		d: 'M 35.5 50 A 6.5 8 0 1 0 48.5 50 A 6.5 8 0 1 0 35.5 50 Z',
		fill: '#2C2416',
		stroke: 'none',
		strokeWidth: 0
	},
	{
		d: 'M 71.5 50 A 6.5 8 0 1 0 84.5 50 A 6.5 8 0 1 0 71.5 50 Z',
		fill: '#2C2416',
		stroke: 'none',
		strokeWidth: 0
	}
];

const CHEEKS_S1: StickerPath[] = [
	{
		d: 'M 25 68 A 7 4.5 0 1 0 39 68 A 7 4.5 0 1 0 25 68 Z',
		fill: '#F0A07A',
		stroke: 'none',
		strokeWidth: 0,
		opacity: 0.55
	},
	{
		d: 'M 81 68 A 7 4.5 0 1 0 95 68 A 7 4.5 0 1 0 81 68 Z',
		fill: '#F0A07A',
		stroke: 'none',
		strokeWidth: 0,
		opacity: 0.55
	}
];

const NEON_FACE: StickerPath[] = [
	{
		d: 'M 14 60 A 46 46 0 1 0 106 60 A 46 46 0 1 0 14 60 Z',
		fill: '#070B14',
		stroke: '#38BDF8',
		strokeWidth: 3.5
	},
	{
		d: 'M 24 60 A 36 36 0 1 0 96 60 A 36 36 0 1 0 24 60 Z',
		fill: 'none',
		stroke: '#38BDF8',
		strokeWidth: 1.25,
		opacity: 0.32
	},
	{
		d: 'M 32 22 L 22 22 L 22 32',
		fill: 'none',
		stroke: '#7DD3FC',
		strokeWidth: 2.2
	},
	{
		d: 'M 88 22 L 98 22 L 98 32',
		fill: 'none',
		stroke: '#7DD3FC',
		strokeWidth: 2.2
	},
	{
		d: 'M 32 98 L 22 98 L 22 88',
		fill: 'none',
		stroke: '#7DD3FC',
		strokeWidth: 2.2
	},
	{
		d: 'M 88 98 L 98 98 L 98 88',
		fill: 'none',
		stroke: '#7DD3FC',
		strokeWidth: 2.2
	}
];

export const STICKER_LIBRARY: StickerTemplate[] = [
	{
		id: 'happy:style-1',
		mojiId: 'happy',
		styleId: 'style-1',
		viewBoxWidth: 120,
		viewBoxHeight: 120,
		paths: [
			FACE_S1,
			...EYES_S1,
			...CHEEKS_S1,
			{
				d: 'M 38 74 Q 60 94 82 74',
				fill: 'none',
				stroke: '#2C2416',
				strokeWidth: 5.5
			}
		]
	},
	{
		id: 'sad:style-1',
		mojiId: 'sad',
		styleId: 'style-1',
		viewBoxWidth: 120,
		viewBoxHeight: 120,
		paths: [
			FACE_S1,
			...EYES_S1,
			...CHEEKS_S1,
			{
				d: 'M 38 88 Q 60 70 82 88',
				fill: 'none',
				stroke: '#2C2416',
				strokeWidth: 5.5
			}
		]
	},
	{
		id: 'happy:style-2',
		mojiId: 'happy',
		styleId: 'style-2',
		viewBoxWidth: 120,
		viewBoxHeight: 120,
		paths: [
			...NEON_FACE,
			{
				d: 'M 42 50 A 5.5 5.5 0 1 0 53 50 A 5.5 5.5 0 1 0 42 50 Z',
				fill: '#7DD3FC',
				stroke: 'none',
				strokeWidth: 0
			},
			{
				d: 'M 67 50 A 5.5 5.5 0 1 0 78 50 A 5.5 5.5 0 1 0 67 50 Z',
				fill: '#7DD3FC',
				stroke: 'none',
				strokeWidth: 0
			},
			{
				d: 'M 40 70 Q 60 86 80 70',
				fill: 'none',
				stroke: '#38BDF8',
				strokeWidth: 3.2
			}
		]
	},
	{
		id: 'sad:style-2',
		mojiId: 'sad',
		styleId: 'style-2',
		viewBoxWidth: 120,
		viewBoxHeight: 120,
		paths: [
			...NEON_FACE,
			{
				d: 'M 40 48 Q 47.5 56 55 48',
				fill: 'none',
				stroke: '#7DD3FC',
				strokeWidth: 3
			},
			{
				d: 'M 65 48 Q 72.5 56 80 48',
				fill: 'none',
				stroke: '#7DD3FC',
				strokeWidth: 3
			},
			{
				d: 'M 40 82 Q 60 66 80 82',
				fill: 'none',
				stroke: '#38BDF8',
				strokeWidth: 3.2
			}
		]
	}
];

export function resolveStickerId(id: string): string {
	return STICKER_ID_ALIASES[id] ?? id;
}

export function getStickerById(id: string): StickerTemplate | undefined {
	const resolved = resolveStickerId(id);
	return STICKER_LIBRARY.find((sticker) => sticker.id === resolved);
}

export function stickersForStyle(styleId: StickerStyleId): StickerTemplate[] {
	return stickersMatching({ styleId, mojiId: 'all' });
}

export type StickerStyleFilter = StickerStyleId | 'all';
export type StickerMojiFilter = StickerMojiId | 'all';

export function stickersMatching(opts: {
	styleId?: StickerStyleFilter;
	mojiId?: StickerMojiFilter;
}): StickerTemplate[] {
	const style = opts.styleId ?? 'all';
	const moji = opts.mojiId ?? 'all';
	return STICKER_LIBRARY.filter(
		(sticker) =>
			(style === 'all' || sticker.styleId === style) && (moji === 'all' || sticker.mojiId === moji)
	);
}

export function getStickerVariant(
	mojiId: StickerMojiId,
	styleId: StickerStyleId
): StickerTemplate | undefined {
	return getStickerById(makeStickerId(mojiId, styleId));
}
