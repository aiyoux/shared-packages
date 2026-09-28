import type { ScanDetectorId } from './types.js';

export type OnnxDecodeMode = 'heatmap' | 'yolo-pose';

export type ScanDetectorMeta = {
	id: ScanDetectorId;
	label: string;
	/** Where inference runs, e.g. `worker (OpenCV.js)` or `onnxruntime-web (wasm)`. */
	runtime: string;
	/** Weight/model license the deployer must accept. */
	license: string;
	/** Project page describing the model and its weights. */
	docsUrl: string;
	/** Where the weights come from when no explicit model URL is configured. */
	weightHint: string;
	/**
	 * Default weight URL. Empty everywhere on purpose: no weight URL is
	 * invented here — configure one per detector or install its package.
	 */
	defaultModelUrl?: string;
	/** ONNX output decoding for single-file `.onnx` detectors. */
	decode?: OnnxDecodeMode;
	/** Square model input edge in px. */
	modelInputSize?: number;
	/** True when the detector cannot run until a model URL is configured. */
	needsModelUrl: boolean;
};

export const DEFAULT_DETECTOR: ScanDetectorId = 'opencv';

export const SCAN_DETECTOR_ORDER: ScanDetectorId[] = [
	'opencv',
	'scanic',
	'docquad',
	'docaligner',
	'yolo-pose'
];

export const SCAN_DETECTORS: Record<ScanDetectorId, ScanDetectorMeta> = {
	opencv: {
		id: 'opencv',
		label: 'OpenCV (classical)',
		runtime: 'Web Worker (OpenCV.js)',
		license: 'Apache-2.0 (opencv.js build)',
		docsUrl: 'https://docs.opencv.org',
		weightHint: 'No weights. Ships with the app at /vendor/opencv.js.',
		needsModelUrl: false
	},
	scanic: {
		id: 'scanic',
		label: 'Scanic ML',
		runtime: 'scanic DocCornerNet (minimal ORT wasm, 1 thread)',
		license: 'MIT (scanic + scanic-ml)',
		docsUrl: 'https://github.com/marquaye/scanic',
		weightHint: 'Vendored at build: scanic-ml assets copied to /vendor/scanic-ml/.',
		needsModelUrl: false
	},
	docquad: {
		id: 'docquad',
		label: 'DocQuadNet-256',
		runtime: 'onnxruntime-web (wasm)',
		license: 'Check the MakeACopy training page before vendoring weights',
		docsUrl: 'https://github.com/egdels/makeacopy',
		weightHint:
			'ONNX export (corner_heatmaps + mask_logits, 256x256 RGB) ships with the MakeACopy app; host it and set its model URL.',
		decode: 'heatmap',
		modelInputSize: 256,
		needsModelUrl: true
	},
	docaligner: {
		id: 'docaligner',
		label: 'DocAligner',
		runtime: 'onnxruntime-web (wasm)',
		license: 'Check DocsaidLab/DocAligner LICENSE before vendoring weights',
		docsUrl: 'https://github.com/DocsaidLab/DocAligner',
		weightHint:
			'Heatmap-regression ONNX export from the DocAligner project; host it and set its model URL.',
		decode: 'heatmap',
		modelInputSize: 256,
		needsModelUrl: true
	},
	'yolo-pose': {
		id: 'yolo-pose',
		label: 'YOLO-pose (custom)',
		runtime: 'onnxruntime-web (wasm)',
		license: 'COCO-pose weights are human-only; document weights are yours to train',
		docsUrl: 'https://docs.ultralytics.com/tasks/pose/',
		weightHint:
			'No pretrained document weights exist. Train 1 class + 4 keypoints from a COCO-pose checkpoint, export ONNX, and set its model URL.',
		decode: 'yolo-pose',
		modelInputSize: 640,
		needsModelUrl: true
	}
};

/**
 * Normalize a persisted detector choice. Unknown or missing values repair to
 * the default; a known id is always returned unchanged — selecting OpenCV
 * never silently becomes a learned model or vice versa.
 */
export function resolveDetectorId(saved: unknown): ScanDetectorId {
	if (typeof saved === 'string' && saved in SCAN_DETECTORS) return saved as ScanDetectorId;
	return DEFAULT_DETECTOR;
}
