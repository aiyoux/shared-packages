/**
 * One presence table for every app. A seat is a client in one place
 * (a cursor, a caret, or a file row). Apps paint `place`. Nobody sweeps it
 * on a clock: a seat goes when its peer leaves, or when the transport it came
 * over says that peer is gone.
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
		list(): PresenceSeat<T>[] {
			return [...map.values()] as PresenceSeat<T>[];
		}
	};
}
