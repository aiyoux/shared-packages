/**
 * Connection registry (platform-services W9): one record per device link,
 * visible to every tab of the origin. The tab that holds the RTCPeerConnection
 * owns the record; it is alive exactly while its context lock is held
 * (owner.ts), so a link whose tab closed is marked ended by whichever
 * surviving tab is granted that lock first — never by a clock.
 *
 * Records say how a link was made; they never change how links are made
 * (direct and "Use as RTC face" stay the user's choice, D-7).
 */
import { createLiveBus, type LiveBus } from '../live/bus.js';
import { serviceContextId } from '../leaseOwner.js';
import { tabOwner, watchOwner, currentTabDirectory, type Owner } from './owner.js';
import { serviceNames } from './names.js';
import { createRecordStore, type RecordStore } from './store.js';

export type ConnectionPurpose = 'hub' | 'files' | 'screen-recording' | 'connections';
export type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'handing-over' | 'ended';
export type ConnectionRecord = {
	id: string;
	purpose: ConnectionPurpose;
	peer: { label: string; deviceId?: string; pairingId?: string };
	/** How it was made: straight to the device, or through a monitor ("Use as RTC face"). */
	route: 'p2p' | 'face';
	face?: { profileId: string; name: string; relayJobId?: string };
	crypto: 'end-to-end' | 'server-terminated' | 'dtls';
	owner: Owner;
	state: ConnectionState;
	endedReason?: string;
	/** Lanes in use, e.g. `presence`, `join:creative`, `files`. */
	apps: string[];
	createdAt: number;
	endedAt?: number;
	dismissed?: number;
};
/** What another tab may ask a link's owner to do. */
export type ConnectionAction = 'disconnect';
export type ConnectionFrame =
	| { kind: 'changed'; id: string }
	| { kind: 'request'; id: string; action: ConnectionAction };
export type RegisterConnection = Omit<ConnectionRecord, 'id' | 'owner' | 'state' | 'createdAt' | 'endedAt' | 'dismissed' | 'endedReason'> & {
	id?: string;
	state?: Exclude<ConnectionState, 'ended'>;
};
export type ConnectionHandle = {
	id: string;
	update(patch: Partial<Pick<ConnectionRecord, 'peer' | 'state' | 'apps' | 'crypto' | 'face'>>): Promise<void>;
	/** The owner ended it on purpose (Disconnect, the far device left): the row goes. */
	end(): Promise<void>;
	onRequest(fn: (action: ConnectionAction) => void): () => void;
};

export const OWNER_GONE_REASON = 'Ended: its tab closed';
const isLive = (row: ConnectionRecord) => row.state !== 'ended';

export function createConnectionsService(options: {
	ctx: string;
	store: RecordStore<ConnectionRecord>;
	bus: LiveBus<ConnectionFrame>;
	watch?: (owner: Owner, signal: AbortSignal) => Promise<void>;
	/** This tab as an owner, once its context lock is confirmed held. */
	self?: () => Promise<Extract<Owner, { kind: 'tab' }>>;
}) {
	const { ctx, store, bus } = options;
	const watch = options.watch ?? watchOwner;
	const self = options.self ?? (() => tabOwner());
	const rows = new Map<string, ConnectionRecord>();
	const watches = new Map<string, AbortController>();
	const listeners = new Set<() => void>();
	const requestHandlers = new Map<string, Set<(action: ConnectionAction) => void>>();
	let disposed = false;
	let refreshTail: Promise<void> = Promise.resolve();
	const notify = () => {
		if (!disposed) for (const fn of listeners) fn();
	};

	function unwatch(id: string) {
		watches.get(id)?.abort();
		watches.delete(id);
	}
	function observe(row: ConnectionRecord) {
		rows.set(row.id, row);
		if (!isLive(row) || row.owner.kind !== 'tab' || row.owner.ctx === ctx) return unwatch(row.id);
		if (watches.has(row.id)) return;
		const ctl = new AbortController();
		watches.set(row.id, ctl);
		const ownerCtx = row.owner.ctx;
		void watch(row.owner, ctl.signal)
			.then(async () => {
				if (disposed || ctl.signal.aborted) return;
				watches.delete(row.id);
				currentTabDirectory()?.markGone(ownerCtx);
				await change(row.id, (current) =>
					isLive(current) && current.owner.kind === 'tab' && current.owner.ctx === ownerCtx
						? { ...current, state: 'ended', endedReason: OWNER_GONE_REASON, endedAt: Date.now() }
						: current
				);
			})
			.catch((error) => {
				if (!ctl.signal.aborted) console.error('Could not watch connection owner', error);
			});
	}
	function refresh(): Promise<void> {
		refreshTail = refreshTail
			.catch(() => {})
			.then(async () => {
				if (disposed) return;
				const next = await store.list();
				const ids = new Set(next.map((row) => row.id));
				for (const id of [...rows.keys()]) {
					if (!ids.has(id)) {
						rows.delete(id);
						unwatch(id);
					}
				}
				for (const row of next) observe(row);
				notify();
			});
		return refreshTail;
	}
	async function change(id: string, update: (row: ConnectionRecord) => ConnectionRecord): Promise<void> {
		const next = await store.mutate(id, (current) => (current ? update(current) : undefined));
		if (!next) return;
		observe(next);
		notify();
		bus.broadcast({ kind: 'changed', id });
	}
	function handleRequest(id: string, action: ConnectionAction) {
		for (const fn of requestHandlers.get(id) ?? []) fn(action);
	}
	const stopBus = bus.onMessage((frame) => {
		if (frame.kind === 'changed') void refresh().catch((error) => console.error('Could not read connections', error));
		else handleRequest(frame.id, frame.action);
	});
	const ready = refresh();

	return {
		ready,
		refresh,
		/** Live links first, then ended ones not yet dismissed. */
		list: () =>
			[...rows.values()]
				.filter((row) => !row.dismissed)
				.sort((a, b) => Number(isLive(b)) - Number(isLive(a)) || b.createdAt - a.createdAt),
		get: (id: string) => rows.get(id),
		subscribe(fn: () => void) {
			listeners.add(fn);
			return () => {
				listeners.delete(fn);
			};
		},
		/** Owner side: this tab holds the link. The record is written once the tab's lock is confirmed. */
		async register(input: RegisterConnection): Promise<ConnectionHandle> {
			await ready;
			const owner = await self();
			if (owner.ctx !== ctx) throw new Error('A tab cannot register a link held by another tab');
			const id = input.id ?? crypto.randomUUID();
			const row = await store.mutate(id, (current) => {
				// Re-registering our own live link (a remount) keeps its row.
				if (current && isLive(current) && !(current.owner.kind === 'tab' && current.owner.ctx === ctx)) {
					throw new Error(`Connection ${id} is held by another tab`);
				}
				return {
					...input,
					id,
					owner,
					state: input.state ?? 'connected',
					createdAt: current && isLive(current) ? current.createdAt : Date.now()
				};
			});
			if (!row) throw new Error('Connection was not saved');
			observe(row);
			notify();
			bus.broadcast({ kind: 'changed', id });
			const handlers = new Set<(action: ConnectionAction) => void>();
			requestHandlers.set(id, handlers);
			const mine = (current: ConnectionRecord) => current.owner.kind === 'tab' && current.owner.ctx === ctx && isLive(current);
			return {
				id,
				update: (patch) => change(id, (current) => (mine(current) ? { ...current, ...patch } : current)),
				async end() {
					requestHandlers.delete(id);
					await store.remove(id);
					rows.delete(id);
					notify();
					bus.broadcast({ kind: 'changed', id });
				},
				onRequest(fn) {
					handlers.add(fn);
					return () => {
						handlers.delete(fn);
					};
				}
			};
		},
		/** Ask a link's owner (this tab or another) to act. The owner decides; nothing here waits on a clock. */
		request(id: string, action: ConnectionAction) {
			handleRequest(id, action);
			bus.broadcast({ kind: 'request', id, action });
		},
		dismiss: (id: string) => change(id, (row) => (isLive(row) ? row : { ...row, dismissed: row.dismissed ?? Date.now() })),
		async dispose() {
			disposed = true;
			for (const ctl of watches.values()) ctl.abort();
			watches.clear();
			stopBus();
			bus.destroy();
			listeners.clear();
			requestHandlers.clear();
			await store.close();
		}
	};
}
export type ConnectionsService = ReturnType<typeof createConnectionsService>;

let singleton: Promise<ConnectionsService> | null = null;
export function connectionsService(): Promise<ConnectionsService> {
	return (singleton ??= serviceContextId()
		.then(async (ctx) => {
			const service = createConnectionsService({
				ctx,
				store: createRecordStore<ConnectionRecord>(serviceNames.connectionsDb),
				bus: createLiveBus(serviceNames.connections, ctx)
			});
			await service.ready;
			return service;
		})
		.catch((error) => {
			singleton = null;
			throw error;
		}));
}
