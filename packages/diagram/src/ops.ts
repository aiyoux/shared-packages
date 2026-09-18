/**
 * The diagram document's op vocabulary and reducer.
 *
 * Same contract as `AnimOp`: every mutation — local or arriving from another
 * tab — goes through `applyDiagramOp`, which is the single seam a live
 * documents layer plugs into.
 *
 *  - **Idempotent.** Applying the same op twice must equal applying it once.
 *    Poses are absolute, never relative.
 *  - **One user action = one op.** A drag emits transient previews while it
 *    runs and exactly ONE op on release.
 */

import type { DigrCanvas, DigrDocument, DigrNode, DigrNodeStyle } from './types.js';

export type DigrOp =
	/** Absolute frame for a node. */
	| { t: 'set-node-frame'; nodeId: string; frame: DigrNodeFrame }
	/** Replace a node's text. Empty string renders as an empty box. */
	| { t: 'set-node-text'; nodeId: string; text: string }
	/** Upsert a whole node (add, or an undo restoring one). */
	| { t: 'put-node'; node: DigrNode }
	| { t: 'remove-node'; nodeId: string }
	/** Empty style clears it, restoring the renderer defaults. */
	| { t: 'set-node-style'; nodeId: string; style: DigrNodeStyle | null }
	| { t: 'set-canvas'; canvas: DigrCanvas };

/** The placement half of a node: everything `set-node-frame` writes. */
export type DigrNodeFrame = { x: number; y: number; w: number; h: number; rotation?: number };

function mapNode(
	doc: DigrDocument,
	nodeId: string,
	fn: (node: DigrNode) => DigrNode
): DigrDocument {
	let changed = false;
	const nodes = doc.nodes.map((n) => {
		if (n.id !== nodeId) return n;
		const next = fn(n);
		if (next !== n) changed = true;
		return next;
	});
	return changed ? { ...doc, nodes } : doc;
}

export function applyDiagramOp(doc: DigrDocument, op: DigrOp): DigrDocument {
	switch (op.t) {
		case 'set-node-frame': {
			const { rotation, ...rect } = op.frame;
			// The frame is a full replacement: absent / zero rotation clears the
			// stored field rather than leaving the previous rotation in place.
			return mapNode(doc, op.nodeId, (node) => {
				const next: DigrNode = { ...node, ...rect };
				if (rotation) next.rotation = rotation;
				else delete next.rotation;
				return next;
			});
		}

		case 'set-node-text':
			return mapNode(doc, op.nodeId, (node) =>
				node.text === op.text ? node : { ...node, text: op.text }
			);

		case 'put-node': {
			const exists = doc.nodes.some((n) => n.id === op.node.id);
			if (exists) return mapNode(doc, op.node.id, () => ({ ...op.node }));
			return { ...doc, nodes: [...doc.nodes, { ...op.node }] };
		}

		case 'remove-node': {
			if (!doc.nodes.some((n) => n.id === op.nodeId)) return doc;
			return { ...doc, nodes: doc.nodes.filter((n) => n.id !== op.nodeId) };
		}

		case 'set-node-style':
			return mapNode(doc, op.nodeId, (node) => {
				const style = op.style && hasStyle(op.style) ? { ...op.style } : undefined;
				if ((node.style ?? undefined) === style) return node;
				if (!style) {
					const { style: _drop, ...rest } = node;
					return rest;
				}
				return { ...node, style };
			});

		case 'set-canvas':
			return doc.canvas.w === op.canvas.w && doc.canvas.h === op.canvas.h
				? doc
				: { ...doc, canvas: { ...op.canvas } };

		default: {
			// Exhaustiveness: a new op must be handled, not silently ignored —
			// a dropped op means replicas diverge with nothing to show for it.
			const never: never = op;
			void never;
			return doc;
		}
	}
}

function hasStyle(style: DigrNodeStyle): boolean {
	return Boolean(style.fill || style.stroke || style.textColor);
}