export type PdfTransform = { x: number; y: number; rotation?: number; sx?: number; sy?: number };

export type PdfIrTextElement = {
	type: 'text';
	id: string;
	str: string;
	x: number;
	y: number;
	width: number;
	height: number;
	fill: string;
	fontSize: number;
	d: string;
	fontName?: string;
	transform?: PdfTransform;
	opacity?: number;
	hidden?: boolean;
};

export type PdfIrImageElement = {
	type: 'image';
	id: string;
	src: string;
	x: number;
	y: number;
	width: number;
	height: number;
	transform?: PdfTransform;
	opacity?: number;
	hidden?: boolean;
};

export type PdfIrPathElement = {
	type: 'path';
	id: string;
	d: string;
	fill: string;
	stroke: string;
	strokeWidth: number;
	fillRule?: 'nonzero' | 'evenodd';
	transform?: PdfTransform;
	opacity?: number;
	hidden?: boolean;
};

export type PdfIrGroupElement = {
	type: 'group';
	id: string;
	children: PdfIrElement[];
	transform?: PdfTransform;
	opacity?: number;
	hidden?: boolean;
};

export type PdfIrRasterChip = {
	type: 'chip';
	id: string;
	src: string;
	x: number;
	y: number;
	width: number;
	height: number;
	transform?: PdfTransform;
	hidden?: boolean;
};

export type PdfIrElement =
	| PdfIrTextElement
	| PdfIrImageElement
	| PdfIrPathElement
	| PdfIrGroupElement
	| PdfIrRasterChip;

export type PdfPageSize = { width: number; height: number };

export type PdfPageFit = {
	width: number;
	height: number;
	x: number;
	y: number;
	scale: number;
};

export type PdfInterpretStats = {
	texts: number;
	images: number;
	paths: number;
	groups: number;
	chips: number;
	unmappedOps: number;
};

export type PdfInterpretResult = {
	width: number;
	height: number;
	elements: PdfIrElement[];
	stats: PdfInterpretStats;
};

export type PdfRasterResult = {
	width: number;
	height: number;
	png: Uint8Array;
};

export type PdfHandle = {
	readonly id: number;
};
