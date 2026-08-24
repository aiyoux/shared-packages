export const KB_FORMAT = 'kb' as const;
/** Max schemaVersion this client understands. Not a parse/write stamp. */
export const KB_SCHEMA_VERSION = 2;

export type Mark =
	| { type: 'bold' }
	| { type: 'italic' }
	| { type: 'code' }
	| { type: 'link'; href: string };

export type TextSpan = {
	type: 'text';
	text: string; // no '\n' in spans. `code.text` MAY contain `\n`.
	marks: Mark[]; // canonical order: bold, italic, code, link
};

export type Inline = TextSpan; // v1: text only. hard_break is a later inline.

export type ParagraphBlock = { id: string; type: 'paragraph'; content: Inline[] };
export type HeadingBlock = { id: string; type: 'heading'; level: 1 | 2 | 3; content: Inline[] };
export type ListItemBlock = { id: string; type: 'list_item'; ordered: boolean; content: Inline[] };
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

export type Block =
	| ParagraphBlock
	| HeadingBlock
	| ListItemBlock
	| CodeBlock
	| DividerBlock
	| ImageBlock
	| CalloutBlock
	| ToggleBlock;

export type TextLikeBlock = ParagraphBlock | HeadingBlock | ListItemBlock;
export type AtomicBlock = DividerBlock | ImageBlock;
export type ContainerBlock = CalloutBlock | ToggleBlock;

export type KbPage = {
	format: typeof KB_FORMAT;
	schemaVersion: number;
	/** Logical page identity. Never VfsNode.id / session.id. */
	id: string;
	title: string;
	createdAt: string; // ISO-8601
	updatedAt: string;
	children: string[]; // child folder names in sidebar order (git SoT)
	blocks: Block[];
};

export type Point = { blockId: string; offset: number }; // UTF-16 code units
export type Range = { anchor: Point; head: Point };

export type Op =
	| { kind: 'set-title'; title: string }
	| { kind: 'insert-text'; at: Point; text: string }
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
	| { kind: 'set-toggle'; id: string; open: boolean };
