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

/** Window descriptor in the stored view record. Roles are opaque strings: the
 *  diagram package stays app-agnostic; the host validates role ids against its
 *  own window catalog on load. (Same rule as `AnimWindowData`.) */
export type DigrWindowData = { role: string };

/** Per-user workspace state for one diagram: the window layout tree. Per-window
 *  pan/zoom cameras are session-only and deliberately absent — a saved file is a
 *  diagram, not an editing session.
 *
 *  **Not part of the document. Never write it into the file.** It describes one
 *  person's machine, so a document carrying it cannot produce identical bytes on
 *  two devices — which is what `offline-project-collab.md` §5.2 needs for a
 *  deterministic checkpoint — and it makes every room combine conflict on layout
 *  drift that has nothing to do with the diagram. The host persists it per
 *  `(viewer, document id)`; see `docViewStore.ts`. `parseDigrView` validates a
 *  stored record: the shape belongs with the format even though the data does
 *  not. Same conclusion `AnimDocView` reached first. */
export type DigrDocView = {
	layout?: unknown;
	windows?: Record<string, DigrWindowData>;
};

export type DigrDocument = {
	schemaVersion: 1;
	/** Travelling document identity. Never a VFS node id. */
	id?: string;
	/** Epoch ms. Travels with `id`; never a VFS `createdAt`. */
	createdAt?: number;
	nodes: DigrNode[];
	canvas: DigrCanvas;
};