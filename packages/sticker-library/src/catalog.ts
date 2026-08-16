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
	name: string;
	description: string;
	viewBoxWidth: number;
	viewBoxHeight: number;
	paths: StickerPath[];
}

export const STICKER_STYLES: readonly StickerStyle[] = [
	{ id: 'style-1', label: 'Style 1' },
	{ id: 'style-2', label: 'Style 2' }
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

const VINYL_BACKING: StickerPath[] = [
	{
		d: 'M 22 70 A 50 46 0 1 0 118 70 A 50 46 0 1 0 22 70 Z',
		fill: '#000000',
		stroke: 'none',
		strokeWidth: 0,
		opacity: 0.12
	},
	{
		d: 'M 8 58 A 52 52 0 1 0 112 58 A 52 52 0 1 0 8 58 Z',
		fill: '#FFFDF7',
		stroke: '#1F1A14',
		strokeWidth: 4
	},
	{
		d: 'M 18 58 A 42 42 0 1 0 102 58 A 42 42 0 1 0 18 58 Z',
		fill: '#FFC93C',
		stroke: '#1F1A14',
		strokeWidth: 3.5
	}
];

const EYES_S2: StickerPath[] = [
	{
		d: 'M 38 48 A 7 8.5 0 1 0 52 48 A 7 8.5 0 1 0 38 48 Z',
		fill: '#1F1A14',
		stroke: 'none',
		strokeWidth: 0
	},
	{
		d: 'M 68 48 A 7 8.5 0 1 0 82 48 A 7 8.5 0 1 0 68 48 Z',
		fill: '#1F1A14',
		stroke: 'none',
		strokeWidth: 0
	},
	{
		d: 'M 42 45 A 2.2 2.2 0 1 0 46.4 45 A 2.2 2.2 0 1 0 42 45 Z',
		fill: '#FFFFFF',
		stroke: 'none',
		strokeWidth: 0
	},
	{
		d: 'M 72 45 A 2.2 2.2 0 1 0 76.4 45 A 2.2 2.2 0 1 0 72 45 Z',
		fill: '#FFFFFF',
		stroke: 'none',
		strokeWidth: 0
	},
	{
		d: 'M 32 36 Q 28 56 36 72',
		fill: 'none',
		stroke: '#FFF8E1',
		strokeWidth: 4,
		opacity: 0.7
	}
];

export const STICKER_LIBRARY: StickerTemplate[] = [
	{
		id: 'happy:style-1',
		mojiId: 'happy',
		styleId: 'style-1',
		name: 'Happy',
		description: 'Classic yellow smiley',
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
		name: 'Sad',
		description: 'Classic yellow frown',
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
			},
			{
				d: 'M 28 64 C 28 76 38 84 42 74 C 36 74 28 70 28 64 Z',
				fill: '#6EC4E8',
				stroke: '#2C2416',
				strokeWidth: 2
			}
		]
	},
	{
		id: 'happy:style-2',
		mojiId: 'happy',
		styleId: 'style-2',
		name: 'Happy',
		description: 'Die-cut vinyl smiley',
		viewBoxWidth: 120,
		viewBoxHeight: 120,
		paths: [
			...VINYL_BACKING,
			...EYES_S2,
			{
				d: 'M 40 70 Q 60 90 80 70',
				fill: 'none',
				stroke: '#1F1A14',
				strokeWidth: 5
			}
		]
	},
	{
		id: 'sad:style-2',
		mojiId: 'sad',
		styleId: 'style-2',
		name: 'Sad',
		description: 'Die-cut vinyl frown',
		viewBoxWidth: 120,
		viewBoxHeight: 120,
		paths: [
			...VINYL_BACKING,
			...EYES_S2,
			{
				d: 'M 40 84 Q 60 66 80 84',
				fill: 'none',
				stroke: '#1F1A14',
				strokeWidth: 5
			},
			{
				d: 'M 30 62 C 30 76 42 86 46 74 C 38 74 30 68 30 62 Z',
				fill: '#5BB8E0',
				stroke: '#1F1A14',
				strokeWidth: 2.2
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
	return STICKER_MOJIS.map((moji) =>
		STICKER_LIBRARY.find((sticker) => sticker.mojiId === moji.id && sticker.styleId === styleId)
	).filter((sticker): sticker is StickerTemplate => !!sticker);
}

export function getStickerVariant(
	mojiId: StickerMojiId,
	styleId: StickerStyleId
): StickerTemplate | undefined {
	return getStickerById(makeStickerId(mojiId, styleId));
}
