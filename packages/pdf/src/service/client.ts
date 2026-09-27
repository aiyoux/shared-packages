import { PDFIUM_WASM_URL } from './assets.js';
import type { PdfInterpretResult, PdfPageSize } from '../types.js';
import {
	openServiceDoc,
	type EngineAssets,
	type PdfEngineId,
	type RenderFormat,
	type ServiceDoc
} from './engines.js';
import type { PdfServiceRequest, PdfServiceResponse } from './protocol.js';

/**
 * One PDF pipeline for every app: open a document once, then run page jobs
 * (images, editable objects) on a worker pool. It never switches image
 * engine or thread by itself: `thread` says where it runs — the pool, or the
 * calling thread where a browser cannot host workers — so apps can show it,
 * and a failure is reported, not retried elsewhere.
 */
export interface PdfService {
	readonly engine: PdfEngineId;
	readonly thread: 'worker' | 'main';
	/** Jobs it can run at once. */
	readonly concurrency: number;
	open(docId: string, bytes: Uint8Array): Promise<PdfPageSize[]>;
	/** `bytes` lets a worker open the document on first use. */
	render(docId: string, bytes: Uint8Array, index: number, width: number, format?: RenderFormat): Promise<Blob>;
	interpret(
		docId: string,
		bytes: Uint8Array,
		index: number,
		target: { targetWidth: number; targetHeight: number }
	): Promise<PdfInterpretResult>;
	close(docId: string): void;
	dispose(): void;
}

const ASSETS: EngineAssets = {
	// Absolute: a worker resolves relative URLs against its own script.
	pdfiumWasmUrl: new URL(PDFIUM_WASM_URL, globalThis.location?.href ?? 'http://localhost/').href
};

/** Each worker keeps its own parsed copy: past this size one worker holds it. */
const SPREAD_MAX_BYTES = 32 * 1024 * 1024;

type Job = Extract<PdfServiceRequest, { type: 'render' | 'interpret' }>;
/** A job minus its routing fields, kept per variant (plain Omit collapses the union). */
type JobBody = Job extends infer J ? (J extends Job ? Omit<J, 'reqId' | 'docId'> : never) : never;
type Slot = { worker: Worker; open: Set<string>; busy: number; dead: boolean };
type Pending = { slot: Slot; resolve: (value: never) => void; reject: (err: Error) => void };

class WorkerPoolService implements PdfService {
	readonly thread = 'worker' as const;
	private slots: Slot[];
	private pending = new Map<number, Pending>();
	private nextReq = 1;

	readonly engine: PdfEngineId;
	private create: () => Worker;
	private maxSize: number;

	/** One worker starts now (the engine loads while the user picks a file);
	 *  the rest start when jobs queue up behind it. */
	constructor(engine: PdfEngineId, create: () => Worker, maxSize: number) {
		this.engine = engine;
		this.create = create;
		this.maxSize = maxSize;
		this.slots = [this.spawn(create())];
	}

	get concurrency(): number {
		const dead = this.slots.filter((s) => s.dead).length;
		return Math.max(1, this.maxSize - dead);
	}

	private spawn(worker: Worker): Slot {
		const slot: Slot = { worker, open: new Set(), busy: 0, dead: false };
		worker.onmessage = (e: MessageEvent<PdfServiceResponse>) => {
			const msg = e.data;
			const p = msg && typeof msg === 'object' ? this.pending.get(msg.reqId) : undefined;
			if (!p) return;
			this.pending.delete(msg.reqId);
			slot.busy -= 1;
			if (msg.type === 'failed') p.reject(new Error(msg.message));
			else if (msg.type === 'opened') p.resolve(msg.sizes as never);
			else if (msg.type === 'rendered') p.resolve(msg.blob as never);
			else p.resolve(msg.result as never);
		};
		worker.onerror = (e) => {
			e.preventDefault();
			slot.dead = true;
			for (const [reqId, p] of this.pending) {
				if (p.slot !== slot) continue;
				this.pending.delete(reqId);
				p.reject(new Error(`The PDF worker stopped: ${e.message || 'unknown error'}`));
			}
		};
		return slot;
	}

	private pick(docId: string, bytes: Uint8Array): Slot {
		let live = this.slots.filter((s) => !s.dead);
		if (live.every((s) => s.busy > 0) && this.slots.length < this.maxSize) {
			this.slots.push(this.spawn(this.create()));
			live = this.slots.filter((s) => !s.dead);
		}
		if (!live.length) throw new Error('The PDF workers stopped. Reload the page to restart them.');
		const holding = live.filter((s) => s.open.has(docId));
		const pool = holding.length && bytes.byteLength > SPREAD_MAX_BYTES ? holding : live;
		return pool.reduce((best, s) => {
			if (s.busy !== best.busy) return s.busy < best.busy ? s : best;
			return s.open.has(docId) && !best.open.has(docId) ? s : best;
		});
	}

	private send<T>(slot: Slot, msg: PdfServiceRequest & { reqId: number }): Promise<T> {
		slot.busy += 1;
		return new Promise<T>((resolve, reject) => {
			this.pending.set(msg.reqId, { slot, resolve: resolve as (v: never) => void, reject });
			slot.worker.postMessage(msg);
		});
	}

	private openIn(slot: Slot, docId: string, bytes: Uint8Array): Promise<PdfPageSize[]> {
		slot.open.add(docId);
		const opening = this.send<PdfPageSize[]>(slot, {
			type: 'open',
			reqId: this.nextReq++,
			docId,
			bytes,
			engine: this.engine,
			assets: ASSETS
		});
		opening.catch(() => slot.open.delete(docId));
		return opening;
	}

	private job<T>(docId: string, bytes: Uint8Array, job: JobBody): Promise<T> {
		let slot: Slot;
		try {
			slot = this.pick(docId, bytes);
		} catch (err) {
			return Promise.reject(err);
		}
		// Answered in order before the job, which reports any open failure.
		if (!slot.open.has(docId)) void this.openIn(slot, docId, bytes).catch(() => {});
		return this.send(slot, { ...job, reqId: this.nextReq++, docId } as Job);
	}

	async open(docId: string, bytes: Uint8Array): Promise<PdfPageSize[]> {
		return this.openIn(this.pick(docId, bytes), docId, bytes);
	}

	render(docId: string, bytes: Uint8Array, index: number, width: number, format?: RenderFormat): Promise<Blob> {
		return this.job(docId, bytes, { type: 'render', index, width, format });
	}

	interpret(
		docId: string,
		bytes: Uint8Array,
		index: number,
		target: { targetWidth: number; targetHeight: number }
	): Promise<PdfInterpretResult> {
		return this.job(docId, bytes, { type: 'interpret', index, target });
	}

	close(docId: string): void {
		for (const slot of this.slots) {
			if (slot.open.delete(docId) && !slot.dead) slot.worker.postMessage({ type: 'close', docId });
		}
	}

	dispose(): void {
		for (const slot of this.slots) {
			slot.dead = true;
			slot.worker.terminate();
		}
		for (const p of this.pending.values()) p.reject(new Error('PDF service closed.'));
		this.pending.clear();
	}
}

/** Same jobs on the calling thread: browsers without module workers or
 *  OffscreenCanvas, and Node tests. Apps say when this is in use. */
class InThreadService implements PdfService {
	readonly thread = 'main' as const;
	readonly concurrency = 1;
	private docs = new Map<string, Promise<ServiceDoc>>();

	readonly engine: PdfEngineId;

	constructor(engine: PdfEngineId) {
		this.engine = engine;
	}

	private doc(docId: string, bytes: Uint8Array): Promise<ServiceDoc> {
		let held = this.docs.get(docId);
		if (!held) {
			held = openServiceDoc(this.engine, bytes, ASSETS);
			this.docs.set(docId, held);
			held.catch(() => this.docs.delete(docId));
		}
		return held;
	}

	async open(docId: string, bytes: Uint8Array): Promise<PdfPageSize[]> {
		return (await this.doc(docId, bytes)).sizes;
	}

	async render(docId: string, bytes: Uint8Array, index: number, width: number, format?: RenderFormat): Promise<Blob> {
		return (await this.doc(docId, bytes)).render(index, width, format);
	}

	async interpret(
		docId: string,
		bytes: Uint8Array,
		index: number,
		target: { targetWidth: number; targetHeight: number }
	): Promise<PdfInterpretResult> {
		return (await this.doc(docId, bytes)).interpret(index, target);
	}

	close(docId: string): void {
		const held = this.docs.get(docId);
		this.docs.delete(docId);
		void held?.then((d) => d.close(), () => {});
	}

	dispose(): void {
		for (const docId of [...this.docs.keys()]) this.close(docId);
	}
}

export function pdfWorkersAvailable(): boolean {
	return typeof Worker !== 'undefined' && typeof OffscreenCanvas !== 'undefined';
}

export async function createPdfService(engine: PdfEngineId): Promise<PdfService> {
	if (!pdfWorkersAvailable()) return new InThreadService(engine);
	const { default: PdfServiceWorker } = await import('./pdf.worker.ts?worker');
	const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 2 : 2;
	const size = Math.max(1, Math.min(3, cores - 1));
	return new WorkerPoolService(engine, () => new PdfServiceWorker(), size);
}

let docSeq = 0;

/** A document id no other open document in this service shares. */
export function newPdfDocId(): string {
	docSeq += 1;
	return `pdf-${Date.now().toString(36)}-${docSeq}`;
}

/**
 * Interpret `pages` (indices, or every page) across the pool, as many at
 * once as it has workers. Results come back in page order; `onProgress`
 * counts finished pages. The first failure rejects (the caller reports it);
 * the rest are dropped. Pass `opened` to reuse a document the caller already
 * opened (and will close); otherwise it is opened and closed here.
 */
export async function interpretPages(
	service: PdfService,
	bytes: Uint8Array,
	pages: number[] | 'all',
	targetFor: (index: number, size: PdfPageSize) => { targetWidth: number; targetHeight: number },
	onProgress?: (done: number, total: number) => void,
	opened?: { docId: string; sizes: PdfPageSize[] }
): Promise<(PdfInterpretResult & { pageIndex: number })[]> {
	const docId = opened?.docId ?? newPdfDocId();
	try {
		const sizes = opened?.sizes ?? (await service.open(docId, bytes));
		const indices = pages === 'all' ? sizes.map((_, i) => i) : pages;
		const out = new Array<PdfInterpretResult & { pageIndex: number }>(indices.length);
		let next = 0;
		let done = 0;
		onProgress?.(0, indices.length);
		const lane = async () => {
			while (next < indices.length) {
				const slot = next++;
				const pageIndex = indices[slot];
				const size = sizes[pageIndex];
				if (!size) throw new Error(`PDF page ${pageIndex + 1} does not exist.`);
				const result = await service.interpret(docId, bytes, pageIndex, targetFor(pageIndex, size));
				out[slot] = { pageIndex, ...result };
				done += 1;
				onProgress?.(done, indices.length);
			}
		};
		const lanes = Math.max(1, Math.min(service.concurrency, indices.length));
		await Promise.all(Array.from({ length: lanes }, lane));
		return out;
	} finally {
		if (!opened) service.close(docId);
	}
}
