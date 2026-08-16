export {
	DEFAULT_POTRACE,
	DEFAULT_VTRACER,
	TRACER_CATALOG,
	VTRACER_PRESETS,
	parsePalette,
	suggestSvgName,
	type PotraceOptions,
	type PotraceTurnPolicy,
	type TracerId,
	type TracerInfo,
	type VectorizeInput,
	type VectorizedImage,
	type VtracerClustering,
	type VtracerFitMode,
	type VtracerHierarchical,
	type VtracerOptions,
	type VtracerPreset
} from './types.js';

export { listTracers, loadTracer, vectorizeImage, type VectorizeOptions } from './operations.js';
