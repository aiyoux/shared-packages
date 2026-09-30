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
import { tabOwner, watchOwner, ownerLiveness, currentTabDirectory, type Owner } from './owner.js';
import { serviceNames } from './names.js';
import { createRecordStore, type RecordStore } from './store.js';

export type ConnectionPurpose = 'hub' | 'files' | 'screen-recording' | 'connections';
export type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'handing-over' | 'ended';
export type ConnectionRecord = {
	id: string;
	purpose: ConnectionPurpose;
	/** Changes whenever a replacement PC is published, fencing adapters from the old transport. */
	transportId?: string;
	peer: { label: string; deviceId?: string; pairingId?: string };
	/** How it was made: straight to the device, or through a monitor ("Use as RTC face"). */
	route: 'p2p' | 'face';
	/**
	 * A face link: the monitor holding the far device, and the relay job a tab
	 * reattaches to. `relayToken` is that job's loopback bearer; it stays in
	 * this origin's storage like the monitor credentials themselves (D-22).
	 * `salt` is the passcode KDF salt (base64url, public as in every sealed
	 * payload): a later tab re-derives the session after asking for the
	 * passcode again (D-19, D-23).
	 */
	face?: { profileId: string; name: string; relayJobId?: string; relayToken?: string; salt?: string };
	crypto: 'end-to-end' | 'server-terminated' | 'dtls';
	/** Who keeps the link: the tab holding the PC, or (a face link) the monitor. */
	owner: Owner;
	/**
	 * A monitor-owned link's attached tab, if any. It goes when that tab does;
	 * the link stays, parked on the monitor, for any tab to resume.
	 */
	holder?: Extract<Owner, { kind: 'tab' }>;
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
export type RegisterConnection = Omit<ConnectionRecord, 'id' | 'owner' | 'holder' | 'state' | 'createdAt' | 'endedAt' | 'dismissed' | 'endedReason'> & {
	id?: string;
	state?: Exclude<ConnectionState, 'ended'>;
	/** A face link is owned by its monitor; this tab becomes its holder. */
	monitor?: Extract<Owner, { kind: 'monitor' }>;
};
export type ConnectionHandle = {
	id: string;
	update(patch: Partial<Pick<ConnectionRecord, 'peer' | 'state' | 'apps' | 'crypto' | 'face' | 'transportId'>>): Promise<void>;
	/** The owner ended it on purpose (Disconnect, the far device left): the row goes. */
	end(): Promise<void>;
	/**
	 * A monitor-owned link: this tab lets go (its pane closed) and the link
	 * stays parked on the monitor. For a tab-owned link this is `end`.
	 */
	detach(): Promise<void>;
	onRequest(fn: (action: ConnectionAction) => void): () => void;
};

export const OWNER_GONE_REASON = 'Ended: its tab closed';
export const PARKED_STATE_NOTE = 'Held by the monitor — resume it in any tab';
const isLive = (row: ConnectionRecord) => row.state !== 'ended';

export function createConnectionsService(options: {
	ctx: string;
	store: RecordStore<ConnectionRecord>;
	bus: LiveBus<ConnectionFrame>;
	watch?: (owner: Owner, signal: AbortSignal) => Promise<void>;
	/** This tab as an owner, once its context lock is confirmed held. */
	self?: () => Promise<Extract<Owner, { kind: 'tab' }>>;
	live?: typeof ownerLiveness;
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
		const ctl = watches.get(id);
		ctl?.abort();
		watches.delete(id);
		for (const [key, other] of watches) if (other === ctl) watches.delete(key);
	}
	/** The tab this row lives or dies with: a tab owner, or a monitor-owned row's holder. */
	function tabOf(row: ConnectionRecord): Extract<Owner, { kind: 'tab' }> | undefined {
		return row.owner.kind === 'tab' ? row.owner : row.holder;
	}
	function observe(row: ConnectionRecord) {
		rows.set(row.id, row);
		const tab = tabOf(row);
		if (!isLive(row) || !tab || tab.ctx === ctx) return unwatch(row.id);
		const key = `${row.id}:${tab.ctx}`;
		if (watches.has(key)) return;
		unwatch(row.id);
		const ctl = new AbortController();
		watches.set(row.id, ctl);
		watches.set(key, ctl);
		const tabCtx = tab.ctx;
		void watch(tab, ctl.signal)
			.then(async () => {
				if (disposed || ctl.signal.aborted) return;
				watches.delete(row.id);
				watches.delete(key);
				currentTabDirectory()?.markGone(tabCtx);
				await change(row.id, (current) => {
					if (!isLive(current)) return current;
					// A tab-owned link ends with its tab.
					if (current.owner.kind === 'tab' && current.owner.ctx === tabCtx) {
						return { ...current, state: 'ended', endedReason: OWNER_GONE_REASON, endedAt: Date.now() };
					}
					// A face link outlives it: parked on the monitor until a tab resumes it.
					if (current.holder?.ctx === tabCtx) return { ...current, holder: undefined, state: 'reconnecting' };
					return current;
				});
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

	/** This tab's handle on a row it owns or holds. */
	function handleFor(id: string): ConnectionHandle {
		const handlers = requestHandlers.get(id) ?? new Set<(action: ConnectionAction) => void>();
		requestHandlers.set(id, handlers);
		let transportId = rows.get(id)?.transportId;
        const mine = (current: ConnectionRecord) => isLive(current) && tabOf(current)?.ctx === ctx && current.transportId === transportId;
		const remove = async () => {
			requestHandlers.delete(id);
			await store.remove(id, (current) => !!current && mine(current));
			await refresh();
			notify();
			bus.broadcast({ kind: 'changed', id });
		};
		return {
			id,
			async update(patch) {
                await change(id, (current) => (mine(current) ? { ...current, ...patch } : current));
                if (patch.transportId && rows.get(id)?.transportId === patch.transportId && tabOf(rows.get(id)!)?.ctx === ctx) transportId = patch.transportId;
            },
			end: remove,
			async detach() {
				const row = rows.get(id);
				if (row?.owner.kind !== 'monitor') return remove();
				requestHandlers.delete(id);
				await change(id, (current) => (mine(current) ? { ...current, holder: undefined, state: 'reconnecting' } : current));
			},
			onRequest(fn) {
				handlers.add(fn);
				return () => {
					handlers.delete(fn);
				};
			}
		};
	}
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
			const me = await self();
			if (me.ctx !== ctx) throw new Error('A tab cannot register a link held by another tab');
			const { monitor, ...fields } = input;
			const id = input.id ?? crypto.randomUUID();
			const row = await store.mutate(id, (current) => {
				// Re-registering our own live link (a remount) keeps its row;
				// a parked face link is ours to take.
				if (current && isLive(current) && tabOf(current) && tabOf(current)!.ctx !== ctx) {
					throw new Error(`Connection ${id} is held by another tab`);
				}
				return {
					...fields,
					id,
					transportId: input.transportId ?? current?.transportId ?? crypto.randomUUID(),
					owner: monitor ?? me,
					holder: monitor ? me : undefined,
					state: input.state ?? 'connected',
					createdAt: current && isLive(current) ? current.createdAt : Date.now()
				};
			});
			if (!row) throw new Error('Connection was not saved');
			observe(row);
			notify();
			bus.broadcast({ kind: 'changed', id });
			return handleFor(id);
		},
		/** Transfer the same row after a verified replacement PC is ready. Only its current owner may release it. */
		async handover(id: string, nextOwner: Extract<Owner, { kind: 'tab' }>): Promise<void> {
			await ready;
			if (await (options.live ?? ownerLiveness)(nextOwner) !== 'alive') throw new Error('The tab taking this connection is no longer alive');
			await change(id, (current) => {
				if (!isLive(current) || current.owner.kind !== 'tab' || current.owner.ctx !== ctx) throw new Error('This tab no longer owns the connection');
				return { ...current, owner: nextOwner, state: 'connected' };
			});
			requestHandlers.delete(id);
		},
		/**
		 * Resume a parked face link in this tab: become its holder. Refused
		 * while another live tab holds it, or once it has ended.
		 */
		async claim(id: string): Promise<ConnectionHandle> {
			await ready;
			const me = await self();
			const row = await store.mutate(id, (current) => {
				if (!current || !isLive(current)) throw new Error('That connection has ended');
				if (current.owner.kind !== 'monitor') throw new Error('Only a link held by a monitor can be resumed');
				if (current.holder && current.holder.ctx !== ctx) throw new Error(`Connection ${id} is held by another tab`);
				return { ...current, holder: me, transportId: crypto.randomUUID() };
			});
			if (!row) throw new Error('Connection was not saved');
			observe(row);
			notify();
			bus.broadcast({ kind: 'changed', id });
			return handleFor(id);
		},
		/** The monitor says a relay is over (its far device left): end its face link. */
		async endRelay(profileId: string, relayJobId: string, reason = 'Ended: the other device left') {
			for (const row of [...rows.values()]) {
				if (!isLive(row) || row.face?.profileId !== profileId || row.face.relayJobId !== relayJobId) continue;
				await change(row.id, (current) => (isLive(current) ? { ...current, state: 'ended', holder: undefined, endedReason: reason, endedAt: Date.now() } : current));
			}
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
