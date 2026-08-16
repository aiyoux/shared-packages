import { OPENCV_WORKER_SOURCE } from './opencv.worker-source.js';
import type { DetectOptions, EnhanceOptions, Quad, ScanEngine, WarpOptions } from '../types.js';

type ProgressFn = (info: {
	phase: 'download' | 'init';
	loaded?: number;
	total?: number;
}) => void;

type Pending = {
	resolve: (value: unknown) => void;
	reject: (err: Error) => void;
};

let worker: Worker | null = null;
let ready = false;
let loadPromise: Promise<void> | null = null;
let rpcId = 0;
const pending = new Map<number, Pending>();
let progressFn: ProgressFn | undefined;

export function setOpenCvProgress(fn?: ProgressFn) {
	progressFn = fn;
}

function report(info: { phase: 'download' | 'init'; loaded?: number; total?: number }) {
	try {
		progressFn?.(info);
	} catch {
		/* UI progress must not break load */
	}
}

function copyImageBuffer(image: ImageData): ArrayBuffer {
	const copy = new Uint8ClampedArray(image.data);
	return copy.buffer;
}

function fromWorkerImage(msg: { buffer: ArrayBuffer; width: number; height: number }): ImageData {
	return new ImageData(new Uint8ClampedArray(msg.buffer), msg.width, msg.height);
}

function spawnWorker(): Worker {
	const blob = new Blob([OPENCV_WORKER_SOURCE], { type: 'text/javascript' });
	const url = URL.createObjectURL(blob);
	const next = new Worker(url);
	URL.revokeObjectURL(url);
	next.onmessage = (event: MessageEvent) => {
		const msg = event.data as { id?: number; ok?: boolean; error?: string } | undefined;
		if (!msg || typeof msg.id !== 'number') return;
		const wait = pending.get(msg.id);
		if (!wait) return;
		pending.delete(msg.id);
		if (msg.ok) wait.resolve(msg);
		else wait.reject(new Error(msg.error || 'OpenCV worker failed'));
	};
	next.onerror = (event) => {
		const err = new Error(event.message || 'OpenCV worker crashed');
		for (const wait of pending.values()) wait.reject(err);
		pending.clear();
		worker = null;
		ready = false;
		loadPromise = null;
	};
	return next;
}

function call<T>(payload: Record<string, unknown>, transfer: Transferable[] = []): Promise<T> {
	if (!worker) throw new Error('OpenCV.js is not loaded. Call load() first.');
	const id = ++rpcId;
	return new Promise<T>((resolve, reject) => {
		pending.set(id, {
			resolve: (value) => resolve(value as T),
			reject
		});
		worker!.postMessage({ ...payload, id }, transfer);
	});
}

async function downloadOpenCv(url: string): Promise<ArrayBuffer> {
	const res = await fetch(url);
	if (!res.ok) {
		throw new Error(`Failed to load OpenCV.js from ${url} (${res.status})`);
	}
	const total = Number(res.headers.get('content-length')) || 0;
	if (!res.body) {
		const buf = await res.arrayBuffer();
		report({ phase: 'download', loaded: buf.byteLength, total: buf.byteLength });
		return buf;
	}
	const reader = res.body.getReader();
	const chunks: Uint8Array[] = [];
	let loaded = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		if (value) {
			chunks.push(value);
			loaded += value.byteLength;
			report({ phase: 'download', loaded, total });
		}
	}
	const out = new Uint8Array(loaded);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	report({ phase: 'download', loaded, total: total || loaded });
	return out.buffer;
}

async function loadInWorker(): Promise<void> {
	if (ready) return;
	if (!loadPromise) {
		loadPromise = (async () => {
			if (typeof Worker === 'undefined') {
				throw new Error('OpenCV.js needs a Web Worker. This browser cannot start one.');
			}
			const { getOpenCvUrl } = await import('../engines.js');
			const url = getOpenCvUrl();
			if (!url) {
				throw new Error(
					'OpenCV.js URL missing. Call loadScanEngine({ opencvUrl }) with a classic-script URL (Vite: /vendor/opencv.js).'
				);
			}
			await downloadOpenCv(url);
			report({ phase: 'init' });
			worker = spawnWorker();
			const abs = new URL(url, globalThis.location.href).href;
			await call({ type: 'init', url: abs });
			ready = true;
		})().catch((err) => {
			loadPromise = null;
			ready = false;
			if (worker) {
				worker.terminate();
				worker = null;
			}
			throw err;
		});
	}
	await loadPromise;
}

export const opencvEngine: ScanEngine = {
	id: 'opencv',

	async load() {
		await loadInWorker();
	},

	async detectQuad(image, opts: DetectOptions = {}) {
		const buffer = copyImageBuffer(image);
		const msg = await call<{ quad: Quad | null }>(
			{ type: 'detect', buffer, width: image.width, height: image.height, opts },
			[buffer]
		);
		return msg.quad;
	},

	async warp(image, quad, opts: WarpOptions = {}) {
		const buffer = copyImageBuffer(image);
		const msg = await call<{ buffer: ArrayBuffer; width: number; height: number }>(
			{ type: 'warp', buffer, width: image.width, height: image.height, quad, opts },
			[buffer]
		);
		return fromWorkerImage(msg);
	},

	async enhance(image, opts: EnhanceOptions = {}) {
		const buffer = copyImageBuffer(image);
		const msg = await call<{ buffer: ArrayBuffer; width: number; height: number }>(
			{ type: 'enhance', buffer, width: image.width, height: image.height, opts },
			[buffer]
		);
		return fromWorkerImage(msg);
	}
};
