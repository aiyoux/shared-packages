/** OCR language packs. `eng` is the historical default; `jpn` reads Japanese
 * (its traineddata ships next to `eng` via hub `scripts/copy-tesseract.mjs`).
 * One cached worker per language — the OCR tool's `eng` worker is untouched.
 */
export type OcrLang = 'eng' | 'jpn';

/** Pixel bounding box in source-image coordinates. */
export type OcrBox = { x0: number; y0: number; x1: number; y1: number };

/** One recognized line of text with its location in the image. */
export type OcrRegion = { text: string; box: OcrBox };

export type OcrDetailedResult = {
	/** Whole-image text (same string `recognizeText` returns). */
	text: string;
	/** Non-empty lines, document order. */
	regions: OcrRegion[];
};

type OcrWorker = {
	recognize: (image: Blob) => Promise<{ data: { text?: string; blocks?: unknown } }>;
	terminate: () => Promise<void>;
};

/** Same-origin copies from hub `scripts/copy-tesseract.mjs`. No jsdelivr. */
export const OCR_ASSET_PATHS = {
	workerPath: '/vendor/tesseract/worker.min.js',
	corePath: '/vendor/tesseract',
	langPath: '/vendor/tesseract',
	gzip: true
} as const;

const workerPromises = new Map<OcrLang, Promise<OcrWorker>>();

async function getWorker(lang: OcrLang): Promise<OcrWorker> {
	let pending = workerPromises.get(lang);
	if (!pending) {
		pending = (async () => {
			const { createWorker } = await import('tesseract.js');
			return (await createWorker(lang, 1, { ...OCR_ASSET_PATHS })) as unknown as OcrWorker;
		})().catch((err) => {
			workerPromises.delete(lang);
			throw err;
		});
		workerPromises.set(lang, pending);
	}
	return pending;
}

function isBox(value: unknown): value is OcrBox {
	if (!value || typeof value !== 'object') return false;
	const box = value as Record<string, unknown>;
	return (
		typeof box.x0 === 'number' &&
		typeof box.y0 === 'number' &&
		typeof box.x1 === 'number' &&
		typeof box.y1 === 'number' &&
		Number.isFinite(box.x0) &&
		Number.isFinite(box.y0) &&
		Number.isFinite(box.x1) &&
		Number.isFinite(box.y1) &&
		box.x1 > box.x0 &&
		box.y1 > box.y0
	);
}

/**
 * Collect non-empty lines from a tesseract.js page (`blocks → paragraphs →
 * lines`), tolerating missing levels. Pure — exported for tests.
 */
export function linesFromPage(data: { blocks?: unknown }): OcrRegion[] {
	const regions: OcrRegion[] = [];
	const blocks = (data as { blocks?: unknown }).blocks;
	if (!Array.isArray(blocks)) return regions;
	for (const block of blocks) {
		const paragraphs = (block as { paragraphs?: unknown })?.paragraphs;
		if (!Array.isArray(paragraphs)) continue;
		for (const paragraph of paragraphs) {
			const lines = (paragraph as { lines?: unknown })?.lines;
			if (!Array.isArray(lines)) continue;
			for (const line of lines) {
				const text = (line as { text?: unknown })?.text;
				const box = (line as { bbox?: unknown })?.bbox;
				if (typeof text === 'string' && text.trim() && isBox(box)) {
					regions.push({ text: text.trim(), box });
				}
			}
		}
	}
	return regions;
}

async function toBlob(source: Blob | ImageData): Promise<Blob> {
	if (source instanceof Blob) return source;
	const { imageDataToBlob } = await import('./pixels.js');
	return imageDataToBlob(source, 'image/png');
}

export async function recognizeText(source: Blob | ImageData, lang: OcrLang = 'eng'): Promise<string> {
	const worker = await getWorker(lang);
	const { data } = await worker.recognize(await toBlob(source));
	return (data.text ?? '').trim();
}

/** Full text plus per-line regions with bounding boxes for overlays. */
export async function recognizeDetailed(
	source: Blob | ImageData,
	lang: OcrLang = 'eng'
): Promise<OcrDetailedResult> {
	const worker = await getWorker(lang);
	const { data } = await worker.recognize(await toBlob(source));
	return { text: (data.text ?? '').trim(), regions: linesFromPage(data) };
}

/**
 * Drop one cached worker (`lang`) or all of them (no arg — the historical
 * behaviour the OCR tool relies on). Anything still running re-creates its
 * worker lazily on the next call.
 */
export async function terminateOcr(lang?: OcrLang): Promise<void> {
	const langs = lang ? [lang] : [...workerPromises.keys()];
	for (const key of langs) {
		const pending = workerPromises.get(key);
		workerPromises.delete(key);
		if (pending) {
			try {
				(await pending).terminate();
			} catch {
				/* already gone */
			}
		}
	}
}
