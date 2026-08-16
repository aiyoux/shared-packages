export {
	encodeSceneToSvg,
	encodeSceneToSvgAsync,
	generatePseudoEffectPaths,
	generateDynamic3DCloudPaths,
	prepareHiddenLine,
	applyVisibleSpans,
	type HiddenLinePreparation,
	type HiddenLineGeometryUpload,
	type CloudOccluder
} from './svgBake.js';

export {
	computeVisibleSpans,
	type HiddenLineRequest,
	type HiddenLineMeshData,
	type HiddenLineEdgeData,
	type BoundsTreeResolver,
	type EdgePositionsResolver
} from './hiddenLine.js';

export {
	computeSpansWithFallback,
	computeSpansOnWorker,
	getBakeWorker,
	invalidateBakeWorkerUploads,
	resetBakeWorkerClient,
	SupersededError,
	type OcclusionEngine
} from './bakeWorkerClient.js';

export type {
	BakeGeometryUpload,
	BakeWorkerRequest,
	BakeWorkerResponse
} from './bake.worker.js';

export {
	loadHiddenLineWasm,
	isHiddenLineWasmAvailable,
	resetHiddenLineWasmForTests,
	wasmAssetUrl,
	type HiddenLineWasmApi
} from './hiddenLineWasm.js';

export {
	CLOUD_CONTROL_RANGES,
	CLOUD_DEFAULTS,
	CLOUD_PUFF_NODES,
	getCloudPuffNodes,
	randomFromSeed
} from './primitives.js';

export type { CloudParams, CloudPuffNode, CloudStyle, PathData, PseudoEffectParams } from './types.js';
