type OcrWorker = {
	recognize: (image: Blob) => Promise<{ data: { text: string } }>;
	terminate: () => Promise<void>;
};

let workerPromise: Promise<OcrWorker> | null = null;

async function getWorker(): Promise<OcrWorker> {
	if (!workerPromise) {
		workerPromise = (async () => {
			const { createWorker } = await import('tesseract.js');
			return (await createWorker('eng')) as unknown as OcrWorker;
		})().catch((err) => {
			workerPromise = null;
			throw err;
		});
	}
	return workerPromise;
}

export async function recognizeText(source: Blob | ImageData): Promise<string> {
	const worker = await getWorker();
	let input: Blob;
	if (source instanceof Blob) {
		input = source;
	} else {
		const { imageDataToBlob } = await import('./pixels.js');
		input = await imageDataToBlob(source, 'image/png');
	}
	const { data } = await worker.recognize(input);
	return (data.text ?? '').trim();
}

export async function terminateOcr(): Promise<void> {
	if (!workerPromise) return;
	const worker = await workerPromise;
	await worker.terminate();
	workerPromise = null;
}
