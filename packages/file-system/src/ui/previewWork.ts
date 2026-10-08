import type { ExplorerDriver, ExplorerEntry } from './explorerDriver.js';

/** One observer for every tile. The margin preloads just ahead of scrolling. */
const targets = new Map<Element, { callback: (visible: boolean) => void; visible: boolean }>();
let observer: IntersectionObserver | null = null;

export function observePreviewVisibility(node: Element, callback: (visible: boolean) => void) {
	if (typeof IntersectionObserver === 'undefined') {
		callback(true);
		return { update(next: typeof callback) { next(true); }, destroy() {} };
	}
	observer ??= new IntersectionObserver((entries) => {
		for (const entry of entries) {
			const target = targets.get(entry.target);
			if (!target) continue;
			target.visible = entry.isIntersecting;
			target.callback(target.visible);
		}
	}, { rootMargin: '200px' });
	targets.set(node, { callback, visible: false });
	observer.observe(node);
	return {
		update(next: typeof callback) {
			const target = targets.get(node);
			if (!target) return;
			target.callback = next;
			next(target.visible);
		},
		destroy() {
			observer?.unobserve(node);
			targets.delete(node);
			if (!targets.size) { observer?.disconnect(); observer = null; }
		}
	};
}

type Job = { run: () => void; signal: AbortSignal };
const queue: Job[] = [];
let active = 0;
const CONCURRENCY = 4;

/** Limit network reads and browser decoders; cancelled queued work never starts. */
export function schedulePreviewWork<T>(signal: AbortSignal, task: () => Promise<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		const abort = () => {
			const index = queue.indexOf(job);
			if (index >= 0) queue.splice(index, 1);
			reject(signal.reason ?? new DOMException('Cancelled', 'AbortError'));
		};
		const job: Job = { signal, run() {
			signal.removeEventListener('abort', abort);
			active++;
			Promise.resolve().then(task).then(resolve, reject).finally(() => { active--; drain(); });
		} };
		if (signal.aborted) { abort(); return; }
		signal.addEventListener('abort', abort, { once: true });
		queue.push(job);
		drain();
	});
}

function drain() {
	while (active < CONCURRENCY && queue.length) {
		const job = queue.shift()!;
		if (!job.signal.aborted) job.run();
	}
}

type SharedJob<T> = { controller: AbortController; promise: Promise<T>; users: number };
const inflight = new Map<string, SharedJob<unknown>>();

/** Share generation between panes. Abort the underlying job when its last tile leaves. */
export function sharedPreviewWork<T>(key: string | null, signal: AbortSignal, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
	if (signal.aborted) return Promise.reject(signal.reason);
	if (!key) return schedulePreviewWork(signal, () => task(signal));
	let job = inflight.get(key) as SharedJob<T> | undefined;
	if (!job || job.controller.signal.aborted) {
		const controller = new AbortController();
		job = { controller, users: 0, promise: schedulePreviewWork(controller.signal, () => task(controller.signal)) };
		inflight.set(key, job);
		const current = job;
		void job.promise.finally(() => { if (inflight.get(key) === current) inflight.delete(key); }).catch(() => {});
	}
	const current = job;
	current.users++;
	return new Promise((resolve, reject) => {
		let settled = false;
		const release = () => {
			if (settled) return false;
			settled = true;
			signal.removeEventListener('abort', abort);
			if (--current.users === 0) current.controller.abort();
			return true;
		};
		const abort = () => { if (release()) reject(signal.reason ?? new DOMException('Cancelled', 'AbortError')); };
		signal.addEventListener('abort', abort, { once: true });
		current.promise.then((value) => { if (release()) resolve(value); }, (err) => { if (release()) reject(err); });
	});
}

/** Coalesce folder decks and project badges looking at the same children. */
const folders = new WeakMap<ExplorerDriver, Map<string | null, { at: number; entries: Promise<ExplorerEntry[]> }>>();
export function previewFolderEntries(driver: ExplorerDriver, parentId: string | null): Promise<ExplorerEntry[]> {
	let cache = folders.get(driver);
	if (!cache) { cache = new Map(); folders.set(driver, cache); }
	const hit = cache.get(parentId);
	if (hit && Date.now() - hit.at < 2_000) return hit.entries;
	const entries = driver.list({ parentId, probe: true }).then(async (listed) => {
		if (listed.truncated && driver.listAll) {
			try { return await driver.listAll({ parentId, probe: true }); } catch { /* keep visible markers */ }
		}
		return listed.entries;
	});
	cache.set(parentId, { at: Date.now(), entries });
	if (cache.size > 256) cache.delete(cache.keys().next().value!);
	void entries.catch(() => { if (cache?.get(parentId)?.entries === entries) cache.delete(parentId); });
	return entries;
}

export function invalidatePreviewFolders(driver: ExplorerDriver) { folders.delete(driver); }

export function invalidatePreviewFolder(driver: ExplorerDriver, parentId: string) { folders.get(driver)?.delete(parentId); }

export function seedPreviewFolderEntries(driver: ExplorerDriver, parentId: string | null, entries: ExplorerEntry[], truncated: boolean) {
	if (truncated) { folders.get(driver)?.delete(parentId); return; }
	let cache = folders.get(driver);
	if (!cache) { cache = new Map(); folders.set(driver, cache); }
	cache.set(parentId, { at: Date.now(), entries: Promise.resolve(entries) });
	if (cache.size > 256) cache.delete(cache.keys().next().value!);
}
