/**
 * Persistent browser pool for ZipKit raw deflate.
 *
 * ZipKit's own pool imports `node:worker_threads`. Vite serves that as an empty
 * browser module, so `new Worker` throws (`e.Worker is not a constructor` once
 * minified) instead of falling back. These are real module workers, which Vite
 * emits in dev and in the production build.
 *
 * The pool stays warm: each worker holds its own WASM engine, and paying that
 * load on every archive is slower than deflating inline.
 */

type Entry = {
	data: Uint8Array;
	level: number;
};

type Response = {
	id: number;
	result?: Uint8Array;
	error?: string;
};

type Waiter = {
	resolve: (bytes: Uint8Array) => void;
	reject: (error: Error) => void;
};

let workers: Worker[] | null = null;
let broken = false;
let seq = 0;
let next = 0;
const waiters = new Map<number, Waiter>();

function poolSize(): number {
	const cores = globalThis.navigator?.hardwareConcurrency ?? 4;
	// Cap below ZipKit's node pool (8). Each worker compiles the 1.4 MB engine.
	return Math.max(1, Math.min(cores, 4));
}

function failPool(error: Error): void {
	broken = true;
	const live = workers;
	workers = null;
	for (const waiter of waiters.values()) waiter.reject(error);
	waiters.clear();
	if (!live) return;
	for (const worker of live) {
		try {
			worker.terminate();
		} catch {
			/* already gone */
		}
	}
}

function start(): Worker[] | null {
	if (broken) return null;
	if (workers) return workers;
	if (typeof Worker === 'undefined') return null;
	try {
		const created: Worker[] = [];
		const size = poolSize();
		for (let i = 0; i < size; i++) {
			const worker = new Worker(new URL('./zipkitEntry.worker.ts', import.meta.url), {
				type: 'module',
				name: 'zipkit-deflate'
			});
			worker.onmessage = (event: MessageEvent<Response>) => {
				const { id, result, error } = event.data;
				const waiter = waiters.get(id);
				if (!waiter) return;
				waiters.delete(id);
				if (result) waiter.resolve(result);
				else waiter.reject(new Error(error || 'ZipKit worker failed'));
			};
			worker.onerror = (event) => {
				failPool(new Error(event.message || 'ZipKit worker failed to load'));
			};
			created.push(worker);
		}
		workers = created;
		return created;
	} catch {
		broken = true;
		workers = null;
		return null;
	}
}

/**
 * Deflate every entry, or null when no browser worker can be started.
 * Rejects when a worker accepts the job and then fails.
 */
export async function deflateEntries(entries: Entry[]): Promise<Uint8Array[] | null> {
	const pool = start();
	if (!pool || pool.length === 0) return null;
	return Promise.all(
		entries.map(
			(entry) =>
				new Promise<Uint8Array>((resolve, reject) => {
					const id = seq++;
					waiters.set(id, { resolve, reject });
					// Transfer a copy. The archive writer still needs the caller's bytes for the CRC.
					const copy = entry.data.slice();
					pool[next++ % pool.length]!.postMessage(
						{ id, data: copy, level: entry.level },
						[copy.buffer]
					);
				})
		)
	);
}
