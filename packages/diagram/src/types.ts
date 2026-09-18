/** The diagram document's virtual canvas: the abstract coordinate space node
 *  frames live in, letterboxed and scaled to fit the pane at render time.
 *  Unlike the animation canvas it is free-size (not a locked ratio) — a
 *  diagram grows however its content needs. */
export type DigrCanvas = { w: number; h: number };

/** Default virtual canvas. Generous but arbitrary — resize via `set-canvas`. */
export const DEFAULT_DIGR_CANVAS: DigrCanvas = { w: 1600, h: 1000 };

/** Node fill/stroke colors. Optional: the renderer supplies defaults so a
 *  node with no style still reads as a box. Values are CSS color strings. */
export type DigrNodeStyle = {
	fill?: string;
	stroke?: string;
	/** Text color, distinct from the box fill. */
	textColor?: string;
};

/**
 * One box on the canvas. Placement vocabulary matches every other object
 * model in the monorepo (`id`, `x/y/w/h`, `rotation?`) so a diagram node can
 * later be bound into sketches/anims without a shape migration.
 *
 * `text` is the box's label — user-editable, and empty string renders as an
 * empty box. `rotation` is radians, clockwise, default 0 (optional so older
 * saves still load, same rule as AnimFrame).
 */
export type DigrNode = {
	id: string;
	x: number;
	y: number;
	w: number;
	h: number;
	rotation?: number;
	text: string;
	style?: DigrNodeStyle;
};

/** Window descriptor in the persisted `view` block. Roles are opaque strings:
 *  the diagram package stays app-agnostic; the host validates role ids against
 *  its own window catalog on load. (Same rule as `AnimWindowData`.) */
export type DigrWindowData = { role: string };

/** App/workspace state that travels with the document but is never authoring
 *  data: the window layout tree. Per-window pan/zoom cameras are session-only
 *  and deliberately absent — a saved file is a diagram, not an editing session. */
export type DigrDocView = {
	layout?: unknown;
	windows?: Record<string, DigrWindowData>;
};

export type DigrDocument = {
	schemaVersion: 1;
	nodes: DigrNode[];
	canvas: DigrCanvas;
	view?: DigrDocView;
};