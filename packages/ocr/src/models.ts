import type { ModelDef } from '@shared-packages/model-store';

/**
 * OCR weights in the browser model store, installed in Settings → AI models.
 * Sizes and Blake3 hashes were streamed from the pinned URLs by
 * `model-store/scripts/hash-catalog.mjs`; engines never download.
 */

/** PP-OCRv5 mobile detection + recognition: PaddlePaddle's official ONNX repos
 *  on Hugging Face, the same exports paddleocr-js packs into its tarballs. */
export const PADDLE_MODEL: ModelDef = {
	id: 'hwr:paddle',
	task: 'handwriting',
	label: 'PaddleOCR PP-OCRv5 (mobile)',
	license: 'Apache-2.0',
	files: [
		{ path: 'PP-OCRv5_mobile_det_onnx/inference.onnx', bytes: 4826518, blake3: '046952fb02f0b6c8825a87e2d35b5a2d38965f2ecaa364148d3e58ecde32cc3f', url: 'https://huggingface.co/PaddlePaddle/PP-OCRv5_mobile_det_onnx/resolve/e6f4fa85f00e168c862bc462aebca69eef9b3d3d/inference.onnx' },
		{ path: 'PP-OCRv5_mobile_det_onnx/inference.yml', bytes: 903, blake3: '24dfe7a00977d53baface73994ea8a16300c06c09b3c29d674a8f16ce2ac3826', url: 'https://huggingface.co/PaddlePaddle/PP-OCRv5_mobile_det_onnx/resolve/e6f4fa85f00e168c862bc462aebca69eef9b3d3d/inference.yml' },
		{ path: 'PP-OCRv5_mobile_rec_onnx/inference.onnx', bytes: 16534782, blake3: '7d3460d6b01044a934b80ab64ce6ca5bca97c29070812d0bede359f81cc21466', url: 'https://huggingface.co/PaddlePaddle/PP-OCRv5_mobile_rec_onnx/resolve/ed152b8b495f84de93cda5709d768548a9127622/inference.onnx' },
		{ path: 'PP-OCRv5_mobile_rec_onnx/inference.yml', bytes: 148345, blake3: 'c1baeb5aacd99d60368e0c975c169629f7aed2c9b69b17f6f1a24b130a79ffae', url: 'https://huggingface.co/PaddlePaddle/PP-OCRv5_mobile_rec_onnx/resolve/ed152b8b495f84de93cda5709d768548a9127622/inference.yml' }
	],
	origin: { kind: 'url' }
};

/** docTR's OnnxTR CRNN MobileNet v3 large export, pinned on Hugging Face.
 * Recognition-quality evidence: docs/design/doctr-onnxtr-quality.md. */
export const MINDEE_MODEL: ModelDef = {
	id: 'hwr:mindee',
	task: 'handwriting',
	label: 'doctr CRNN (OnnxTR)',
	license: 'Apache-2.0',
	files: [
		{ path: 'model.onnx', bytes: 18065061, blake3: 'fee57a2ab4223a399663c4edea8c2433be307f6a79b45e7885795433fff7e68e', url: 'https://huggingface.co/Felix92/onnxtr-crnn-mobilenet-v3-large/resolve/5ac37cda638653cad294d7da0323acb27326f34e/model.onnx' },
		{ path: 'config.json', bytes: 638, blake3: '97eebbcdd6101c81d3252ff23bec6496be3835feb9b807452722a23cfd14a03a', url: 'https://huggingface.co/Felix92/onnxtr-crnn-mobilenet-v3-large/resolve/5ac37cda638653cad294d7da0323acb27326f34e/config.json' }
	],
	origin: { kind: 'url' }
};

/** PP-OCRv4 Japan recognition pack — RapidOCR's ONNX export of PaddlePaddle's
 * dedicated Japanese recognizer. Detection stays on the shared PP-OCRv5
 * mobile det stage; only the rec slot swaps. RapidOCR pins SHA-256
 * `e1075a67dba758ecfc7ebc78a10ae61c95ac8fb66a9c86fab5541e33f085cb7a` for the
 * onnx below (verified at pin time); the blake3 hashes were streamed from the
 * downloaded bytes. The rec yml is synthesized from the dict (see
 * `japanRecConfigText`) because RapidOCR ships the charset separately. */
export const PPOCR_JPN_MODEL: ModelDef = {
	id: 'ocr:ppocr-jpn',
	task: 'ocr',
	label: 'PaddleOCR PP-OCRv4 (Japanese)',
	license: 'Apache-2.0',
	files: [
		{ path: 'japan_PP-OCRv4_rec_mobile.onnx', bytes: 9753335, blake3: 'fc6b3a045539a240861c4149b94e87627b13bdb9bb1239839b67db2c94c161a5', url: 'https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.9.2/onnx/PP-OCRv4/rec/japan_PP-OCRv4_rec_mobile.onnx' },
		{ path: 'japan_dict.txt', bytes: 17332, blake3: '80a47b72285d646f26210e0cd1b187105bcdd685b9a66a87a2dd08108bb63483', url: 'https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.9.2/paddle/PP-OCRv4/rec/japan_PP-OCRv4_rec_mobile/japan_dict.txt' }
	],
	origin: { kind: 'url' }
};