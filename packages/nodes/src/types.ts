import type { BindMode, DocSource, ViewSource } from '@shared-packages/doc-refs';

export type { BindMode, DocSource, ViewSource };

export type ScalarKind = 'image' | 'int' | 'float' | 'string';
export type ValueType = { kind: ScalarKind } | { kind: 'array'; of: ScalarKind };

export type NodeSnapshot = { bytesRef: string; atGeneration?: number; atCommit?: string };

type FlowNodeBase = { id: string; x: number; y: number; name?: string };

export type OutputNode = FlowNodeBase & { kind: 'output'; valueType: ValueType };

export type ImageNode = FlowNodeBase & { kind: 'image'; snapshot?: NodeSnapshot } & (
	| { bind: 'clone' }
	| { bind: Exclude<BindMode, 'clone'>; source: DocSource }
);

export type ConstNode = FlowNodeBase & { kind: 'int' | 'float' | 'string'; value: number | string };
export type PackNode = FlowNodeBase & { kind: 'pack'; element: ScalarKind; inputCount: number };

export type FilterKind = 'grayscale' | 'blur' | 'brightness-contrast' | 'invert';
export type FilterNode = FlowNodeBase & {
	kind: 'filter';
	filter: FilterKind;
	amount: number;
	radius: number;
	brightness: number;
	contrast: number;
};

/** Reads one saved view of a `.data` file. `viewId` is also on `source` when a source exists. */
export type QueryNode = FlowNodeBase & {
	kind: 'query';
	viewId: string;
	valueType: ValueType;
	snapshot?: NodeSnapshot;
} & (
	| { bind: 'clone' }
	| { bind: Exclude<BindMode, 'clone'>; source: ViewSource }
);

export type FlowNode = OutputNode | ImageNode | ConstNode | PackNode | FilterNode | QueryNode;
export type Wire = {
	id: string;
	fromNodeId: string;
	fromSocket: string;
	toNodeId: string;
	toSocket: string;
};

export type NodeDocument = {
	schemaVersion: 1;
	id?: string;
	createdAt?: number;
	nodes: FlowNode[];
	wires: Wire[];
};

/** Window descriptor in the stored view record. Roles are opaque strings: the
 *  nodes package stays app-agnostic; the host validates role ids against its
 *  own window catalog on load. */
export type NodeWindowData = { role: string };

/**
 * Per-user workspace state for one node graph. Not part of the document — never
 * written into the file. `parseNodeDocument` ignores `view`; `parseNodeView`
 * validates a record the host stored on its own.
 */
export type NodeDocView = {
	layout?: unknown;
	windows?: Record<string, NodeWindowData>;
};

export type FilterParams = { amount: number; radius: number; brightness: number; contrast: number };
