export const KB_FORMAT = 'kb' as const;

/**
 * Font family is a picker id, never a CSS string — rendering maps it through
 * an allowlist. Font size is a canonical `"<n>px"` / `"<n>pt"` / `"<n>%"`
 * string validated at every entry point (coerce, apply, render).
 */
export type Mark =
	| { type: 'bold' }
	| { type: 'italic' }
	| { type: 'code' }
	| { type: 'font_family'; family: 'sans' | 'serif' | 'mono' }
	| { type: 'font_size'; size: string }
	| { type: 'link'; href: string };

export type TextSpan = {
	type: 'text';
	text: string; // MAY contain '\n' (Shift+Enter hard break). `code.text` MAY contain `\n`.
	marks: Mark[]; // canonical order: bold, italic, code, font_family, font_size, link
};

export type Inline = TextSpan; // v1: text spans only. A hard break is '\n' inside a span, not an inline node.

/** Horizontal alignment of a text-like block. Omitted means left. */
export type Align = 'left' | 'center' | 'right';
/** Vertical alignment of a table cell. Omitted means top. */
export type VAlign = 'top' | 'middle' | 'bottom';

export type ParagraphBlock = { id: string; type: 'paragraph'; content: Inline[]; align?: Align };
export type HeadingBlock = {
	id: string;
	type: 'heading';
	level: 1 | 2 | 3;
	content: Inline[];
	align?: Align;
};
export type ListItemBlock = {
	id: string;
	type: 'list_item';
	ordered: boolean;
	content: Inline[];
	align?: Align;
};
export type CodeBlock = { id: string; type: 'code'; language: string; text: string };
export type DividerBlock = { id: string; type: 'divider' };
export type ImageBlock = { id: string; type: 'image'; src: string; alt: string };

export type CalloutVariant = 'info' | 'warning' | 'note';

export type CalloutBlock = {
	id: string;
	type: 'callout';
	variant: CalloutVariant;
	children: Block[];
};

export type ToggleBlock = {
	id: string;
	type: 'toggle';
	open: boolean;
	children: Block[];
};

export type TableCellBlock = {
	id: string;
	type: 'table_cell';
	header?: boolean;
	content: Inline[];
	align?: Align;
	valign?: VAlign;
};

export type TableRowBlock = {
	id: string;
	type: 'table_row';
	children: TableCellBlock[];
};

export type TableBlock = {
	id: string;
	type: 'table';
	children: TableRowBlock[];
};

export type Block =
	| ParagraphBlock
	| HeadingBlock
	| ListItemBlock
	| CodeBlock
	| DividerBlock
	| ImageBlock
	| CalloutBlock
	| ToggleBlock
	| TableBlock
	| TableRowBlock
	| TableCellBlock;

/** Discriminant of every block. */
export type BlockType = Block['type'];

export type TextLikeBlock = ParagraphBlock | HeadingBlock | ListItemBlock | TableCellBlock;
export type AtomicBlock = DividerBlock | ImageBlock;
export type ContainerBlock = CalloutBlock | ToggleBlock;
export type TableStructureBlock = TableBlock | TableRowBlock;

/**
 * What both backends share: a title and a tree of blocks.
 *
 * Everything else about a document is envelope, and the envelope differs by
 * backend — a file has a format tag, timestamps and a child-page slug list; a
 * record has none of those because the graph carries them. The body functions
 * in this package are generic over `DocBody` so neither backend has to
 * fabricate the other's envelope to use them.
 */
export type DocBody = {
	title: string;
	blocks: Block[];
};

/** The file backend's envelope. `DocBody` plus what `index.kb` needs. */
export type KbPage = DocBody & {
	format: typeof KB_FORMAT;
	/** Logical page identity. Never VfsNode.id / session.id. */
	id: string;
	createdAt: string; // ISO-8601
	updatedAt: string;
	children: string[]; // child folder names in sidebar order (git SoT)
};

export type Point = { blockId: string; offset: number }; // UTF-16 code units
export type Range = { anchor: Point; head: Point };

export type Op =
	| { kind: 'set-title'; title: string }
	| { kind: 'insert-text'; at: Point; text: string; marks?: Mark[] }
	| { kind: 'delete-range'; range: Range }
	| { kind: 'format-range'; range: Range; mark: Mark; on: boolean }
	| { kind: 'split-block'; at: Point; newId: string }
	| { kind: 'merge-block'; keepId: string; dropId: string }
	| { kind: 'insert-block'; afterId: string | null; parentId?: string | null; block: Block }
	| { kind: 'delete-block'; id: string }
	| { kind: 'move-block'; id: string; afterId: string | null; parentId?: string | null }
	| { kind: 'convert-block'; id: string; to: Block['type']; level?: 1 | 2 | 3; ordered?: boolean }
	| { kind: 'set-code'; id: string; language: string }
	| { kind: 'set-children'; children: string[] }
	| { kind: 'set-toggle'; id: string; open: boolean }
	| { kind: 'set-align'; id: string; align: Align | null }
	| { kind: 'set-valign'; id: string; valign: VAlign | null }
	| { kind: 'insert-table-row'; tableId: string; afterId: string | null; row: TableRowBlock }
	| { kind: 'insert-table-column'; tableId: string; index: number; cells: TableCellBlock[] }
	| { kind: 'delete-table-row'; tableId: string; rowId: string }
	| { kind: 'delete-table-column'; tableId: string; index: number };

/**
 * Ops that act on the body alone — everything a backend without the KB
 * envelope can emit.
 */
export type BodyOp = Exclude<Op, { kind: 'set-children' }>;

/** Ops that act on the KB envelope. `set-children` is child-PAGE slug order. */
export type EnvelopeOp = Extract<Op, { kind: 'set-children' }>;
