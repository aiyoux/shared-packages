import { browserModelStore } from '@shared-packages/model-store';
import { PADDLE_MODEL, PPOCR_JPN_MODEL } from '../models.js';
import { inputToCanvas } from '../pixels.js';
import type { OcrBox, OcrEngine, OcrInput, OcrLang, OcrRegion, OcrResult } from '../types.js';

type PaddleItem = {
	text?: string;
	score?: number;
	poly?: number[][] | number[];
};

type PaddleOcrHandle = {
	predict: (image: HTMLCanvasElement) => Promise<Array<{ items?: PaddleItem[] }>>;
	dispose?: () => Promise<void> | void;
};

let sharedEng = null as PaddleOcrHandle | null;
let loadingEng: Promise<PaddleOcrHandle> | null = null;
let sharedJpn = null as PaddleOcrHandle | null;
let loadingJpn: Promise<PaddleOcrHandle> | null = null;

function polyBounds(poly: number[][] | number[] | undefined): { x: number; y: number; width: number; height: number } | undefined {
	if (!poly || poly.length === 0) return undefined;
	const pts: { x: number; y: number }[] = [];
	if (typeof poly[0] === 'number') {
		const flat = poly as number[];
		for (let i = 0; i + 1 < flat.length; i += 2) pts.push({ x: flat[i]!, y: flat[i + 1]! });
	} else {
		for (const p of poly as number[][]) {
			if (p && p.length >= 2) pts.push({ x: p[0]!, y: p[1]! });
		}
	}
	if (pts.length === 0) return undefined;
	const xs = pts.map((p) => p.x);
	const ys = pts.map((p) => p.y);
	const x = Math.min(...xs);
	const y = Math.min(...ys);
	return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

function polyBox(poly: number[][] | number[] | undefined): OcrBox | undefined {
	const bounds = polyBounds(poly);
	return bounds ? { x0: bounds.x, y0: bounds.y, x1: bounds.x + bounds.width, y1: bounds.y + bounds.height } : undefined;
}

/** Catalog ids in `@paddleocr/paddleocr-js` — not PaddleX names like `en_PP-OCRv5_mobile_rec`. */
export const PADDLE_DET_MODEL = 'PP-OCRv5_mobile_det';
export const PADDLE_REC_MODEL = 'PP-OCRv5_mobile_rec';

/** The Japanese rec pack swaps only the recognition stage; its name must
 * match the `Global.model_name` the synthesized yml declares (paddleocr-js
 * validates one against the other). */
export const PPOCR_JPN_REC_MODEL = 'japan_PP-OCRv4_rec_mobile';

/** One ustar archive of `entries` — the packaging paddleocr-js reads a model from. */
export function tarOf(entries: ReadonlyArray<{ name: string; bytes: Uint8Array }>): Uint8Array<ArrayBuffer> {
	const blocks = (size: number) => Math.ceil(size / 512) * 512;
	const out = new Uint8Array(entries.reduce((n, e) => n + 512 + blocks(e.bytes.length), 0) + 1024);
	const ascii = new TextEncoder();
	let offset = 0;
	for (const entry of entries) {
		const header = out.subarray(offset, offset + 512);
		const put = (at: number, text: string) => header.set(ascii.encode(text), at);
		put(0, entry.name);
		put(100, '0000644\0');
		put(108, '0000000\0');
		put(116, '0000000\0');
		put(124, entry.bytes.length.toString(8).padStart(11, '0') + '\0');
		put(136, '00000000000\0');
		put(156, '0');
		put(257, 'ustar\0');
		put(263, '00');
		put(148, '        ');
		const sum = header.reduce((n, b) => n + b, 0);
		put(148, sum.toString(8).padStart(6, '0') + '\0 ');
		out.set(entry.bytes, offset + 512);
		offset += 512 + blocks(entry.bytes.length);
	}
	return out;
}

/** The inference.yml paddleocr-js expects on a rec tarball, synthesized for
 * the RapidOCR Japan pack (which ships its charset as a separate file).
 * `character_dict` is one quoted scalar per line; parseRecModelConfigText
 * appends the space class itself. Shape matches PP-OCRv5's own rec yml. */
export function japanRecConfigText(dictText: string): string {
	const chars = dictText
		.split('\n')
		.map((line) => line.replace(/\r$/, ''))
		.filter((line) => line.length > 0);
	if (!chars.length) throw new Error('The japan rec dict is empty');
	const header = [
		'Global:',
		`  model_name: ${PPOCR_JPN_REC_MODEL}`,
		'PreProcess:',
		'  transform_ops:',
		'  - RecResizeImg:',
		'      image_shape:',
		'      - 3',
		'      - 48',
		'      - 320',
		'PostProcess:',
		'  name: CTCLabelDecode',
		'  character_dict:'
	];
	return [...header, ...chars.map((char) => '  - ' + JSON.stringify(char))].join('\n');
}

/** Each stage's two stored files, packed as the tarball paddleocr-js would
 * download. `jpn` swaps the rec slot for the `ocr:ppocr-jpn` pack; det
 * always comes from the shared v5 model. */
export async function stagePaddleArchives(lang: OcrLang = 'eng'): Promise<Map<string, Uint8Array<ArrayBuffer>>> {
	const detEntries = await browserModelStore.readReady(PADDLE_MODEL, async (files) => {
		const entries: { name: string; bytes: Uint8Array<ArrayBuffer> }[] = [];
		for (const name of ['inference.onnx', 'inference.yml']) {
			entries.push({ name, bytes: new Uint8Array(await (await files.file(`${PADDLE_DET_MODEL}_onnx/${name}`)).arrayBuffer()) });
		}
		return entries;
	});
	let recEntries: { name: string; bytes: Uint8Array<ArrayBuffer> }[];
	if (lang === 'jpn') {
		const dictText = await browserModelStore.readReady(PPOCR_JPN_MODEL, async (files) => (await (await files.file('japan_dict.txt')).text()));
		const onnxBytes = await browserModelStore.readReady(PPOCR_JPN_MODEL, async (files) => new Uint8Array(await (await files.file('japan_PP-OCRv4_rec_mobile.onnx')).arrayBuffer()));
		recEntries = [
			{ name: 'inference.onnx', bytes: onnxBytes },
			{ name: 'inference.yml', bytes: new TextEncoder().encode(japanRecConfigText(dictText)) }
		];
	} else {
		recEntries = await browserModelStore.readReady(PADDLE_MODEL, async (files) => {
			const entries: { name: string; bytes: Uint8Array<ArrayBuffer> }[] = [];
			for (const name of ['inference.onnx', 'inference.yml']) {
				entries.push({ name, bytes: new Uint8Array(await (await files.file(`${PADDLE_REC_MODEL}_onnx/${name}`)).arrayBuffer()) });
			}
			return entries;
		});
	}
	const archives = new Map<string, Uint8Array<ArrayBuffer>>();
	archives.set(`browser-models:${PADDLE_DET_MODEL}`, tarOf(detEntries));
	archives.set(`browser-models:${langRecStage(lang)}`, tarOf(recEntries));
	return archives;
}

function langRecStage(lang: OcrLang): string {
	return lang === 'jpn' ? PPOCR_JPN_REC_MODEL : PADDLE_REC_MODEL;
}

async function createPaddle(lang: OcrLang = 'eng'): Promise<PaddleOcrHandle> {
	const archives = await stagePaddleArchives(lang);
	const recStage = langRecStage(lang);
	const { PaddleOCR } = await import('@paddleocr/paddleocr-js');
	const ocr = await PaddleOCR.create({
		lang: 'en',
		ocrVersion: 'PP-OCRv5',
		textDetectionModelName: PADDLE_DET_MODEL,
		textRecognitionModelName: recStage,
		textDetectionModelAsset: { url: `browser-models:${PADDLE_DET_MODEL}` },
		textRecognitionModelAsset: { url: `browser-models:${recStage}` },
		// Assets resolve only to the stored files; nothing is downloaded.
		fetch: async (url: string | URL | Request) => {
			const archive = archives.get(String(url));
			return archive ? new Response(archive) : new Response(null, { status: 404, statusText: `${String(url)} is not a stored model` });
		},
		worker: false,
		ortOptions: {
			backend: 'wasm',
			// Same-origin, copied from the installed onnxruntime-web by
			// scripts/copy-onnxruntime-wasm.mjs. This used to point at
			// jsdelivr's 1.22.0, which broke HWR offline and — because npm
			// hoists a different version for the JS glue — paired mismatched
			// glue and WASM. Vendoring keeps the two the same build by
			// construction.
			wasmPaths: '/vendor/ort/',
			numThreads: 1,
			simd: true
		}
	});
	return ocr as PaddleOcrHandle;
}

/** One handle per language — the v5 rec handle and the v4 japan handle hold
 * different weights, so they are cached and terminated separately. */
export async function getPaddleHandle(lang: OcrLang = 'eng'): Promise<PaddleOcrHandle> {
	if (lang === 'jpn') {
		if (sharedJpn) return sharedJpn;
		loadingJpn ??= createPaddle('jpn')
			.then((h) => {
				sharedJpn = h;
				return h;
			})
			.catch((err) => {
				loadingJpn = null;
				throw err;
			});
		return loadingJpn;
	}
	if (sharedEng) return sharedEng;
	loadingEng ??= createPaddle('eng')
		.then((h) => {
			sharedEng = h;
			return h;
		})
		.catch((err) => {
			loadingEng = null;
			throw err;
		});
	return loadingEng;
}

/** The page OCR engine: detection finds line boxes, recognition reads them. */
export function createPaddleEngine(): OcrEngine {
	return {
		id: 'paddle',
		async recognize(input: OcrInput, options: { lang?: OcrLang } = {}): Promise<OcrResult> {
			const lang = options.lang ?? 'eng';
			const ocr = await getPaddleHandle(lang);
			const canvas = await inputToCanvas(input);
			const [result] = await ocr.predict(canvas);
			const mapped = (result?.items ?? []).map((it) => ({
				text: (it.text ?? '').trim(),
				score: it.score,
				box: polyBox(it.poly)
			}));
			const regions: OcrRegion[] = [];
			for (const it of mapped) {
				if (!it.text || !it.box) continue;
				regions.push({ text: it.text, box: it.box, ...(it.score === undefined ? {} : { score: it.score }) });
			}
			return { text: regions.map((region) => region.text).join('\n'), regions };
		}
	};
}