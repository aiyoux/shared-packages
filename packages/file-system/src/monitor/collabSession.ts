/**
 * Monitor CollabSession adapter. Persist is `submitPage` (acked prefix).
 * Replicas must not call `sendSnapshot`. One SSE multiplexes many paths.
 */
import {
	REPLICA_SEND_SNAPSHOT_ERROR,
	applyRemoteMany,
	schemaCompatible,
	type AwarenessState,
	type CollabFrame,
	type CollabSessionOpts,
	type KbPage,
	type MonitorCollabAdapter,
	type Op
} from '@shared-packages/kb-model';
import {
	CollabConflictError,
	getSnapshot,
	postOps,
	postPresence,
	postSubs,
	submitPage as postSnapshot,
	subscribe,
	type CollabHttpOptions
} from './collab.js';

export type CreateMonitorCollabSessionOpts = CollabSessionOpts & {
	kind?: 'monitor';
	baseUrl: string;
	/** Canonical host path of `index.kb`. */
	path: string;
	fetchImpl?: typeof fetch;
	signal?: AbortSignal;
	/** Used when GET snapshot is `{ seq: 0, page: null }` (no CAS yet). */
	seedPage?: KbPage;
};

type InFlight = { clientOpId: string; ops: Op[]; baseSeq: number };

type SnapshotVia = 'join' | 'nack' | 'resync' | 'cas';

type DocState = {
	opts: CreateMonitorCollabSessionOpts;
	handlers: Set<(frame: CollabFrame) => void>;
	closed: boolean;
	ackedPage: KbPage | null;
	localSeq: number;
	snapshotSeq: number;
	inFlight: InFlight[];
	wonSeq: number | null;
	appliedSeq: number;
	/** Last seq whose ops are already in `ackedPage` (own-echo vs sendOps). */
	appliedToAckedSeq: number;
	nackHeadSeq: number | null;
	sendTail: Promise<void>;
	lastHello: CollabFrame | null;
	lastJoinSnapshot: CollabFrame | null;
	readyResolve: () => void;
	readyReject: (err: unknown) => void;
	readySettled: boolean;
};

const docsByAdapter = new WeakMap<MonitorCollabAdapter, DocState>();

type Mux = {
	key: string;
	http: CollabHttpOptions;
	clientId: string | null;
	helloWaiters: Array<(id: string) => void>;
	sse: { abort: () => void } | null;
	starting: Promise<void> | null;
	docs: Map<string, Set<DocState>>;
	pathBySubId: Map<string, string>;
	subIdByPath: Map<string, string>;
	refs: number;
};

const muxes = new Map<string, Mux>();

function muxKey(baseUrl: string): string {
	return baseUrl.replace(/\/$/, '');
}

function asRecord(data: unknown): Record<string, unknown> | null {
	return data && typeof data === 'object' && !Array.isArray(data)
		? (data as Record<string, unknown>)
		: null;
}

function asString(v: unknown): string | null {
	return typeof v === 'string' && v ? v : null;
}

function asNum(v: unknown): number | null {
	if (typeof v === 'number' && Number.isFinite(v)) return v;
	if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v);
	return null;
}

function asPage(raw: unknown): KbPage | null {
	const o = asRecord(raw);
	if (!o) return null;
	if (typeof o.id !== 'string' || !Array.isArray(o.blocks)) return null;
	return raw as KbPage;
}

function asOps(raw: unknown): Op[] {
	return Array.isArray(raw) ? (raw as Op[]) : [];
}

function roomIdFor(path: string): string {
	let h = 2166136261;
	for (let i = 0; i < path.length; i++) {
		h ^= path.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return (h >>> 0).toString(16);
}

function emit(doc: DocState, frame: CollabFrame): void {
	if (doc.closed) return;
	for (const handler of [...doc.handlers]) {
		try {
			handler(frame);
		} catch {
			/* subscriber */
		}
	}
}

function clonePage(page: KbPage): KbPage {
	return structuredClone(page);
}

/** Persist body is the acked prefix — never optimistic in-flight groups. */
export function stripInFlightPage(
	live: KbPage,
	acked: KbPage | null,
	inFlightCount: number
): KbPage {
	if (inFlightCount > 0) {
		if (!acked) return live;
		return acked;
	}
	return live;
}

/**
 * Winner of POST /ops for `seq`, or a replica that applied that batch with no
 * in-flight groups, may submit. Others skip.
 */
export function maySubmitMonitorPage(opts: {
	seq: number;
	wonSeq: number | null;
	appliedSeq: number;
	inFlightCount: number;
}): boolean {
	if (opts.seq <= 0) return false;
	if (opts.wonSeq === opts.seq) return true;
	return opts.inFlightCount === 0 && opts.appliedSeq === opts.seq;
}

export function clearMonitorCollabMuxForTests(): void {
	for (const mux of muxes.values()) {
		mux.sse?.abort();
	}
	muxes.clear();
}

/** Seed the acked prefix when GET snapshot has no CAS page yet. */
export function seedMonitorSessionPage(session: MonitorCollabAdapter, page: KbPage): void {
	const doc = docsByAdapter.get(session);
	if (!doc || doc.closed) return;
	if (!doc.ackedPage) doc.ackedPage = clonePage(page);
}

function getMux(opts: CreateMonitorCollabSessionOpts): Mux {
	const key = muxKey(opts.baseUrl);
	let mux = muxes.get(key);
	if (mux) return mux;
	mux = {
		key,
		http: { baseUrl: key, fetchImpl: opts.fetchImpl, signal: opts.signal },
		clientId: null,
		helloWaiters: [],
		sse: null,
		starting: null,
		docs: new Map(),
		pathBySubId: new Map(),
		subIdByPath: new Map(),
		refs: 0
	};
	muxes.set(key, mux);
	return mux;
}

function docsForSub(mux: Mux, subId: string | null, pathHint?: string | null): DocState[] {
	const path = (subId && mux.pathBySubId.get(subId)) || pathHint || null;
	if (!path) return [];
	return [...(mux.docs.get(path) ?? [])];
}

function waitHello(mux: Mux): Promise<string> {
	if (mux.clientId) return Promise.resolve(mux.clientId);
	return new Promise((resolve) => {
		mux.helloWaiters.push(resolve);
	});
}

function settleHello(mux: Mux, clientId: string): void {
	mux.clientId = clientId;
	const waiters = mux.helloWaiters;
	mux.helloWaiters = [];
	for (const w of waiters) w(clientId);
}

async function ensureSse(mux: Mux): Promise<void> {
	if (mux.sse) return;
	if (mux.starting) {
		await mux.starting;
		return;
	}
	mux.starting = (async () => {
		mux.sse = await subscribe({
			...mux.http,
			onEvent: (event, data) => onMuxEvent(mux, event, data)
		});
	})();
	try {
		await mux.starting;
	} finally {
		mux.starting = null;
	}
}

function onMuxEvent(mux: Mux, event: string, data: unknown): void {
	const o = asRecord(data) ?? {};
	if (event === 'collab.hello' || o.type === 'collab.hello') {
		const id = asString(o.client_id) ?? asString(o.clientId);
		if (id) settleHello(mux, id);
		return;
	}
	if (event === 'collab.subscribed' || o.type === 'collab.subscribed') {
		const subId = asString(o.sub_id) ?? asString(o.subId);
		const path = asString(o.path);
		if (subId && path) {
			mux.pathBySubId.set(subId, path);
			mux.subIdByPath.set(path, subId);
		}
		return;
	}
	if (event === 'collab.unsubscribed' || o.type === 'collab.unsubscribed') {
		const subId = asString(o.sub_id) ?? asString(o.subId);
		const path = asString(o.path) ?? (subId ? mux.pathBySubId.get(subId) : undefined);
		if (subId) mux.pathBySubId.delete(subId);
		if (path) mux.subIdByPath.delete(path);
		return;
	}

	const subId = asString(o.sub_id) ?? asString(o.subId);
	const path = asString(o.path);
	const docs = docsForSub(mux, subId, path);
	if (!docs.length) return;

	if (event === 'collab.op_batch' || o.type === 'collab.op_batch') {
		const seq = asNum(o.seq);
		const clientId = asString(o.client_id) ?? asString(o.clientId) ?? '';
		const ops = asOps(o.ops);
		if (seq == null) return;
		for (const doc of docs) onOpBatch(mux, doc, seq, clientId, ops);
		return;
	}
	if (event === 'collab.snapshot' || o.type === 'collab.snapshot') {
		const seq = asNum(o.seq);
		const page = asPage(o.page);
		if (seq == null || !page) return;
		for (const doc of docs) {
			const via: SnapshotVia = doc.nackHeadSeq != null ? 'nack' : 'cas';
			applySnapshot(doc, seq, page, via);
		}
		return;
	}
	if (event === 'collab.presence' || o.type === 'collab.presence') {
		const clientId = asString(o.client_id) ?? asString(o.clientId) ?? '';
		const state = (o.state ?? null) as AwarenessState | null;
		for (const doc of docs) {
			emit(doc, { kind: 'presence', clientId, state });
		}
		return;
	}
	if (event === 'collab.resync_required' || o.type === 'collab.resync_required') {
		const reason = asString(o.reason) ?? 'resync_required';
		for (const doc of docs) void resyncDoc(mux, doc, reason);
		return;
	}
	if (event === 'collab.error' || o.type === 'collab.error') {
		const reason = asString(o.message) ?? asString(o.code) ?? 'collab.error';
		for (const doc of docs) {
			emit(doc, { kind: 'resync', pageId: doc.opts.pageId, reason });
		}
	}
}

function applyWonOnce(doc: DocState, seq: number, ops: Op[]): void {
	if (seq <= doc.appliedToAckedSeq) return;
	if (doc.ackedPage) doc.ackedPage = applyRemoteMany(doc.ackedPage, ops);
	doc.appliedToAckedSeq = seq;
	doc.localSeq = Math.max(doc.localSeq, seq);
	doc.appliedSeq = Math.max(doc.appliedSeq, seq);
}

function onOpBatch(mux: Mux, doc: DocState, seq: number, clientId: string, ops: Op[]): void {
	if (doc.closed) return;
	const own = clientId === mux.clientId;
	if (own) {
		applyWonOnce(doc, seq, ops);
		doc.inFlight = doc.inFlight.filter((g) => g.baseSeq >= seq);
		emit(doc, {
			kind: 'ops',
			pageId: doc.opts.pageId,
			clientId,
			clientOpId: '',
			baseSeq: seq - 1,
			seq,
			ops
		});
		return;
	}
	applyWonOnce(doc, seq, ops);
	emit(doc, {
		kind: 'ops',
		pageId: doc.opts.pageId,
		clientId,
		clientOpId: '',
		baseSeq: seq - 1,
		seq,
		ops
	});
	void maybeSubmit(mux, doc, seq);
}

function applySnapshot(doc: DocState, seq: number, page: KbPage, via: SnapshotVia): void {
	if (doc.closed) return;
	doc.ackedPage = clonePage(page);
	doc.localSeq = Math.max(doc.localSeq, seq);
	doc.snapshotSeq = Math.max(doc.snapshotSeq, seq);
	doc.appliedSeq = Math.max(doc.appliedSeq, seq);
	doc.appliedToAckedSeq = Math.max(doc.appliedToAckedSeq, seq);
	doc.inFlight = doc.inFlight.filter((g) => g.baseSeq >= seq);
	if (doc.wonSeq != null && doc.wonSeq <= seq) doc.wonSeq = null;
	if (page.schemaVersion > doc.opts.schemaVersion) {
		emit(doc, {
			kind: 'schema-mismatch',
			local: doc.opts.schemaVersion,
			remote: page.schemaVersion
		});
	}
	if (via === 'cas') return;
	const frame: CollabFrame = {
		kind: 'snapshot',
		pageId: doc.opts.pageId,
		seq,
		page: clonePage(page),
		reason: via
	};
	if (via === 'join') doc.lastJoinSnapshot = frame;
	if (via === 'nack' && doc.nackHeadSeq != null && seq >= doc.nackHeadSeq) {
		doc.nackHeadSeq = null;
	}
	emit(doc, frame);
	if (!doc.readySettled) {
		doc.readySettled = true;
		doc.readyResolve();
	}
}

async function resyncDoc(mux: Mux, doc: DocState, reason: string): Promise<void> {
	if (doc.closed) return;
	emit(doc, { kind: 'resync', pageId: doc.opts.pageId, reason });
	try {
		const snap = await getSnapshot(mux.http, doc.opts.path);
		const page = asPage(snap.page);
		if (page) applySnapshot(doc, snap.seq, page, 'resync');
	} catch {
		/* keep waiting for SSE snapshot */
	}
}

async function waitUntil(
	doc: DocState,
	pred: () => boolean,
	timeoutMs = 5_000
): Promise<boolean> {
	if (pred()) return true;
	const start = Date.now();
	while (!doc.closed && Date.now() - start < timeoutMs) {
		await new Promise((r) => setTimeout(r, 5));
		if (pred()) return true;
	}
	return pred();
}

async function recoverNack(mux: Mux, doc: DocState, clientOpId: string, headSeq: number): Promise<void> {
	doc.nackHeadSeq = headSeq;
	emit(doc, { kind: 'nack', clientOpId, headSeq });
	const reached = await waitUntil(doc, () => doc.localSeq >= headSeq);
	if (doc.closed) {
		doc.nackHeadSeq = null;
		return;
	}
	if (!reached) {
		emit(doc, { kind: 'resync', pageId: doc.opts.pageId, reason: 'nack_wait_timeout' });
		doc.nackHeadSeq = null;
		return;
	}

	try {
		const snap = await getSnapshot(mux.http, doc.opts.path);
		if (snap.seq >= headSeq) {
			const page = asPage(snap.page);
			if (page) {
				applySnapshot(doc, snap.seq, page, 'nack');
				return;
			}
		}
	} catch {
		/* wait for SSE */
	}

	const got = await waitUntil(doc, () => doc.snapshotSeq >= headSeq);
	if (!got && !doc.closed) {
		emit(doc, { kind: 'resync', pageId: doc.opts.pageId, reason: 'nack_snapshot_timeout' });
	}
	if (doc.nackHeadSeq === headSeq) doc.nackHeadSeq = null;
}

async function maybeSubmit(mux: Mux, doc: DocState, seq: number): Promise<void> {
	if (doc.closed) return;
	if (
		!maySubmitMonitorPage({
			seq,
			wonSeq: doc.wonSeq,
			appliedSeq: doc.appliedSeq,
			inFlightCount: doc.inFlight.length
		})
	) {
		return;
	}
	const page = doc.ackedPage;
	if (!page) return;
	await submitAcked(mux, doc, seq, page);
}

async function submitAcked(mux: Mux, doc: DocState, seq: number, live: KbPage): Promise<void> {
	if (doc.closed) return;
	if (
		!maySubmitMonitorPage({
			seq,
			wonSeq: doc.wonSeq,
			appliedSeq: doc.appliedSeq,
			inFlightCount: doc.inFlight.length
		})
	) {
		return;
	}
	const page = stripInFlightPage(live, doc.ackedPage, doc.inFlight.length);
	const clientId = mux.clientId;
	try {
		await postSnapshot(
			{ ...mux.http, clientId: clientId ?? undefined, path: doc.opts.path },
			seq,
			page
		);
	} catch (err) {
		if (err instanceof CollabConflictError) {
			await recoverNack(mux, doc, '', err.headSeq);
			return;
		}
		throw err;
	}
}

async function bindPath(mux: Mux, path: string): Promise<void> {
	const clientId = mux.clientId;
	if (!clientId) return;
	if (mux.subIdByPath.has(path)) return;
	const res = await postSubs(mux.http, {
		clientId,
		subscribe: [{ path }]
	});
	for (const row of res.subscribed ?? []) {
		if (row.path && row.sub_id) {
			mux.pathBySubId.set(row.sub_id, row.path);
			mux.subIdByPath.set(row.path, row.sub_id);
		}
	}
}

async function unbindPath(mux: Mux, path: string): Promise<void> {
	const clientId = mux.clientId;
	const subId = mux.subIdByPath.get(path);
	if (!clientId || !subId) return;
	mux.subIdByPath.delete(path);
	mux.pathBySubId.delete(subId);
	try {
		await postSubs(mux.http, { clientId, unsubscribe: [path] });
	} catch {
		/* closing */
	}
}

function addDoc(mux: Mux, path: string, doc: DocState): void {
	let set = mux.docs.get(path);
	if (!set) {
		set = new Set();
		mux.docs.set(path, set);
	}
	set.add(doc);
	mux.refs += 1;
}

async function removeDoc(mux: Mux, path: string, doc: DocState): Promise<void> {
	const set = mux.docs.get(path);
	set?.delete(doc);
	if (set && set.size === 0) {
		mux.docs.delete(path);
		await unbindPath(mux, path);
	}
	mux.refs -= 1;
	if (mux.refs <= 0) {
		mux.sse?.abort();
		mux.sse = null;
		muxes.delete(mux.key);
	}
}

async function startDoc(mux: Mux, doc: DocState): Promise<void> {
	try {
		await ensureSse(mux);
		const clientId = await waitHello(mux);
		void clientId;
		await bindPath(mux, doc.opts.path);
		try {
			const snap = await getSnapshot(mux.http, doc.opts.path);
			const remotePage = asPage(snap.page);
			const seed = remotePage ?? doc.opts.seedPage ?? doc.ackedPage;
			if (seed && !doc.ackedPage) doc.ackedPage = clonePage(seed);
			if (remotePage) {
				if (
					!schemaCompatible(doc.opts.schemaVersion, doc.opts.schemaVersion, remotePage.schemaVersion)
				) {
					emit(doc, {
						kind: 'schema-mismatch',
						local: doc.opts.schemaVersion,
						remote: remotePage.schemaVersion
					});
				}
				applySnapshot(doc, snap.seq, remotePage, 'join');
			}
		} catch {
			if (doc.opts.seedPage && !doc.ackedPage) doc.ackedPage = clonePage(doc.opts.seedPage);
		}
		const hello: CollabFrame = {
			kind: 'hello',
			pageId: doc.opts.pageId,
			schemaVersion: doc.opts.schemaVersion,
			clientId: mux.clientId ?? doc.opts.clientId,
			role: 'replica',
			roomId: roomIdFor(doc.opts.path)
		};
		doc.lastHello = hello;
		emit(doc, hello);
		if (!doc.readySettled) {
			doc.readySettled = true;
			doc.readyResolve();
		}
	} catch (err) {
		if (!doc.readySettled) {
			doc.readySettled = true;
			doc.readyReject(err);
		}
	}
}

export function createMonitorCollabSession(
	opts: CreateMonitorCollabSessionOpts
): MonitorCollabAdapter {
	const mux = getMux(opts);
	let readyResolve!: () => void;
	let readyReject!: (err: unknown) => void;
	const ready = new Promise<void>((resolve, reject) => {
		readyResolve = resolve;
		readyReject = reject;
	});
	void ready.catch(() => {});
	const doc: DocState = {
		opts: { ...opts, kind: 'monitor', role: 'replica' },
		handlers: new Set(),
		closed: false,
		ackedPage: opts.seedPage ? clonePage(opts.seedPage) : null,
		localSeq: 0,
		snapshotSeq: 0,
		inFlight: [],
		wonSeq: null,
		appliedSeq: 0,
		appliedToAckedSeq: 0,
		nackHeadSeq: null,
		sendTail: Promise.resolve(),
		lastHello: null,
		lastJoinSnapshot: null,
		readyResolve,
		readyReject,
		readySettled: false
	};
	addDoc(mux, opts.path, doc);
	void startDoc(mux, doc);

	const adapter: MonitorCollabAdapter = {
		kind: 'monitor',
		role: 'replica',
		pageId: opts.pageId,
		schemaVersion: opts.schemaVersion,
		get clientId() {
			return mux.clientId ?? opts.clientId;
		},
		ready,
		async sendOps(ops, clientOpId, _baseSeq) {
			if (doc.closed) return;
			const run = async () => {
				await ready;
				if (doc.closed) return;
				const clientId = mux.clientId;
				if (!clientId) throw new Error('Monitor collab SSE has no client_id');
				const baseSeq = doc.localSeq;
				doc.inFlight.push({ clientOpId, ops, baseSeq });
				try {
					const { seq } = await postOps(mux.http, {
						clientId,
						path: opts.path,
						baseSeq,
						ops
					});
					doc.inFlight = doc.inFlight.filter((g) => g.clientOpId !== clientOpId);
					applyWonOnce(doc, seq, ops);
					doc.wonSeq = seq;
					emit(doc, { kind: 'ack', clientOpId, seq });
					await maybeSubmit(mux, doc, seq);
				} catch (err) {
					doc.inFlight = doc.inFlight.filter((g) => g.clientOpId !== clientOpId);
					if (err instanceof CollabConflictError) {
						await recoverNack(mux, doc, clientOpId, err.headSeq);
						return;
					}
					throw err;
				}
			};
			const p = doc.sendTail.then(run, run);
			doc.sendTail = p.then(
				() => {},
				() => {}
			);
			await p;
		},
		sendPresence(state) {
			if (doc.closed) return;
			const clientId = mux.clientId;
			if (!clientId) return;
			void postPresence(mux.http, {
				clientId,
				path: opts.path,
				state
			});
		},
		async sendSnapshot(_seq, _page) {
			throw new Error(REPLICA_SEND_SNAPSHOT_ERROR);
		},
		async submitPage(seq, page) {
			if (doc.closed) return;
			await ready;
			if (!doc.ackedPage) doc.ackedPage = clonePage(page);
			if (seq <= 0) return;
			await submitAcked(mux, doc, seq, page);
		},
		subscribe(handler) {
			doc.handlers.add(handler);
			if (doc.lastHello) handler(doc.lastHello);
			if (doc.lastJoinSnapshot) handler(doc.lastJoinSnapshot);
			return () => {
				doc.handlers.delete(handler);
			};
		},
		close() {
			if (doc.closed) return;
			doc.closed = true;
			doc.handlers.clear();
			void removeDoc(mux, opts.path, doc);
		}
	};
	docsByAdapter.set(adapter, doc);
	return adapter;
}
