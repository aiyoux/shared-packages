export type SplitDirection = 'row' | 'col';

export type LayoutLeaf = {
	kind: 'leaf';
	id: string;
};

export type LayoutSplit = {
	kind: 'split';
	id: string;
	direction: SplitDirection;
	/** First-child share in (0, 1). */
	ratio: number;
	first: LayoutNode;
	second: LayoutNode;
};

export type LayoutNode = LayoutLeaf | LayoutSplit;

export type SplitPlacement = 'before' | 'after';
