import { staleIds } from './liveness.js';

/**
 * One presence table for every app. A seat is a client in one place
 * (a cursor, a caret, or a file row). Apps paint `place`. They do not
 * keep a second clock.
 */

export type PresenceSeat<T> = {
	clientId: string;
	at: number;
	place: T;
};

const boards = new Map<string, Map<string, PresenceSeat<unknown>>>();

export function presenceBoard<T>(key: string) {
	let seats = boards.get(key);
	if (!seats) {
		seats = new Map();
		boards.set(key, seats);
	}
	const map = seats;
	return {
		note(clientId: string, place: T, at = Date.now()) {
			map.set(clientId, { clientId, at, place });
		},
		drop(clientId: string) {
			map.delete(clientId);
		},
		clear() {
			map.clear();
		},
		sweep(now = Date.now(), staleMs?: number): string[] {
			const gone = staleIds(new Map([...map].map(([id, row]) => [id, row.at])), now, staleMs);
			for (const id of gone) map.delete(id);
			return gone;
		},
		list(): PresenceSeat<T>[] {
			return [...map.values()] as PresenceSeat<T>[];
		}
	};
}
