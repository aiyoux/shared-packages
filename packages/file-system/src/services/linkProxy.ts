/**
 * Use a device link from a tab that does not hold it (platform-services W9.2).
 *
 * An RTCPeerConnection cannot leave its document, so the owner tab serves the
 * link's lanes over a `link:<id>` LiveBus: frames the far device sends on a
 * lane some other tab has attached are relayed to the bus, and frames another
 * tab sends are put on the wire by the owner. LiveBus delivery is ordered per
 * sender, so a lane keeps its order end to end.
 *
 * Lanes are retained per tab: the owner forwards a lane only while some tab
 * holds it, and forgets a tab's lanes the moment that tab is gone (its bus
 * sender lock is granted to the owner — exact, no clock).
 *
 * Media (camera, screen) cannot cross tabs and never travels here.
 */
import { createLiveBus, type LiveBus } from '../live/bus.js';
import { serviceNames } from './names.js';

export type LinkWire<M> = {
	sendKb: (msg: M) => void;
	onKb: (handler: (msg: M) => void) => () => void;
};
export type LinkFrame<M> =
	| { kind: 'hello' }
	| { kind: 'attach'; lanes: string[] }
	| { kind: 'send'; msg: M }
	| { kind: 'recv'; lane: string; msg: M };

/** Owner side. Returns the stop function; the link itself is untouched. */
export function serveLink<M>(opts: {
	wire: LinkWire<M>;
	laneOf: (msg: M) => string;
	bus: LiveBus<LinkFrame<M>>;
}): () => void {
	const { wire, laneOf, bus } = opts;
	const retained = new Map<string, Set<string>>();
	const wanted = (lane: string) => [...retained.values()].some((lanes) => lanes.has(lane));
	const stopWire = wire.onKb((msg) => {
		const lane = laneOf(msg);
		if (wanted(lane)) bus.broadcast({ kind: 'recv', lane, msg });
	});
	const stopBus = bus.onMessage((frame, sender) => {
		if (frame.kind === 'attach') retained.set(sender, new Set(frame.lanes));
		else if (frame.kind === 'send') wire.sendKb(frame.msg);
	});
	const stopGone = bus.onSenderGone((sender) => {
		retained.delete(sender);
	});
	// A proxy that started before us learns we are here and re-attaches.
	bus.broadcast({ kind: 'hello' });
	return () => {
		stopWire();
		stopBus();
		stopGone();
		bus.destroy();
	};
}

/** Non-owner side: a wire onto a link another tab holds, for the given lanes. */
export function proxyLink<M>(opts: { bus: LiveBus<LinkFrame<M>>; lanes: string[] }): LinkWire<M> & { close: () => void } {
	const { bus } = opts;
	const lanes = [...new Set(opts.lanes)];
	const handlers = new Set<(msg: M) => void>();
	const attach = () => bus.broadcast({ kind: 'attach', lanes });
	const stop = bus.onMessage((frame) => {
		if (frame.kind === 'hello') attach();
		else if (frame.kind === 'recv' && lanes.includes(frame.lane)) for (const fn of [...handlers]) fn(frame.msg);
	});
	attach();
	return {
		sendKb: (msg) => bus.broadcast({ kind: 'send', msg }),
		onKb(handler) {
			handlers.add(handler);
			return () => {
				handlers.delete(handler);
			};
		},
		close() {
			stop();
			handlers.clear();
			bus.destroy();
		}
	};
}

/**
 * The bus for one link, named in one place. Each bus gets its own sender id:
 * two buses of one tab sharing an id would wait on each other's sender lock.
 */
export function linkBus<M>(linkId: string, ctx: string): LiveBus<LinkFrame<M>> {
	return createLiveBus<LinkFrame<M>>(serviceNames.link(linkId), `${ctx}:${crypto.randomUUID()}`);
}
