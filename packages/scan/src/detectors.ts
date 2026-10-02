import type { ModelDef } from '@shared-packages/model-store';
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
	/** Where the weights come from. */
	weightHint: string;
	/**
	 * Browser-store model for learned detectors. No public weights exist, so
	 * the file is the user's own (`origin: user`), loaded in Settings → AI
	 * models; it has no expected hash.
	 */
	model?: ModelDef;
	/** ONNX output decoding for single-file `.onnx` detectors. */
	decode?: OnnxDecodeMode;
	/** Square model input edge in px. */
	modelInputSize?: number;
};

/** The one-file user model a learned detector runs. */
function userModel(id: ScanDetectorId, label: string, license: string): ModelDef {
	return { id: `scan:${id}`, task: 'scan-detect', label, license, files: [{ path: `${id}.onnx` }], origin: { kind: 'user' } };
}

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
	},
	scanic: {
		id: 'scanic',
		label: 'Scanic ML',
		runtime: 'scanic DocCornerNet (minimal ORT wasm, 1 thread)',
		license: 'MIT (scanic + scanic-ml)',
		docsUrl: 'https://github.com/marquaye/scanic',
		weightHint: 'Vendored at build: scanic-ml assets copied to /vendor/scanic-ml/.',
	},
	docquad: {
		id: 'docquad',
		label: 'DocQuadNet-256',
		runtime: 'onnxruntime-web (wasm)',
		license: 'Check the MakeACopy training page before vendoring weights',
		docsUrl: 'https://github.com/egdels/makeacopy',
		weightHint:
			'ONNX export (corner_heatmaps + mask_logits, 256x256 RGB) ships with the MakeACopy app; load its .onnx in Settings → AI models.',
		decode: 'heatmap',
		modelInputSize: 256,
		model: userModel('docquad', 'DocQuadNet-256', 'Check the MakeACopy training page before vendoring weights')
	},
	docaligner: {
		id: 'docaligner',
		label: 'DocAligner',
		runtime: 'onnxruntime-web (wasm)',
		license: 'Check DocsaidLab/DocAligner LICENSE before vendoring weights',
		docsUrl: 'https://github.com/DocsaidLab/DocAligner',
		weightHint:
			'Heatmap-regression ONNX export from the DocAligner project; load it in Settings → AI models.',
		decode: 'heatmap',
		modelInputSize: 256,
		model: userModel('docaligner', 'DocAligner', 'Check DocsaidLab/DocAligner LICENSE before vendoring weights')
	},
	'yolo-pose': {
		id: 'yolo-pose',
		label: 'YOLO-pose (custom)',
		runtime: 'onnxruntime-web (wasm)',
		license: 'COCO-pose weights are human-only; document weights are yours to train',
		docsUrl: 'https://docs.ultralytics.com/tasks/pose/',
		weightHint:
			'No pretrained document weights exist. Train 1 class + 4 keypoints from a COCO-pose checkpoint, export ONNX, and load it in Settings → AI models.',
		decode: 'yolo-pose',
		modelInputSize: 640,
		model: userModel('yolo-pose', 'YOLO-pose (custom)', 'COCO-pose weights are human-only; document weights are yours to train')
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
