/**
 * The open-document list is one record for every tab. Which document this
 * tab is showing is not part of that record — a second tab must not steal it.
 */
import {
	applyClosed,
	joinOrCreate,
	mergeClosed,
	mergeSessions,
	retargetConnected,
	sessionMergeKey,
	type ClosedSession,
	type OpenSession,
	type OpenSessionIndex
} from './openSessions.js';

export type SessionBoard = {
	current(): OpenSessionIndex;
	remember(input: Parameters<typeof joinOrCreate>[1]): OpenSession;
	/** Join or create without adopting this tab's connected unsaved session. */
	note(input: Parameters<typeof joinOrCreate>[1]): OpenSession;
	connect(id: string): void;
	/** Close one session for every tab. Returns the row it closed. */
	forget(sessionId: string): OpenSession | undefined;
	forgetFile(fileId: string): OpenSession | undefined;
	/** Write the list this tab holds. Used after a merge the other tab has not seen. */
	flush(): void;
	/**
	 * Apply a list another tab just wrote. `publish` means this tab still holds
	 * sessions the write lacked. `closed` lists this tab's rows that another tab
	 * closed, so the caller can drop what it holds for them.
	 */
	absorb(raw: string | null): { changed: boolean; publish: boolean; closed: OpenSession[] };
};

type Parsed = { sessions: OpenSession[]; closed: ClosedSession[]; legacyConnectedId?: string };

function parseSessions(raw: string | null): Parsed {
	if (!raw) return { sessions: [], closed: [] };
	try {
		const parsed = JSON.parse(raw) as OpenSessionIndex;
		if (!parsed || !Array.isArray(parsed.sessions)) return { sessions: [], closed: [] };
		return {
			sessions: parsed.sessions,
			closed: mergeClosed(Array.isArray(parsed.closed) ? parsed.closed : []),
			legacyConnectedId: parsed.connectedId
		};
	} catch {
		return { sessions: [], closed: [] };
	}
}

function sameSessions(a: readonly OpenSession[], b: readonly OpenSession[]): boolean {
	if (a.length !== b.length) return false;
	const times = new Map(b.map((session) => [session.id, session.updatedAt]));
	return a.every((session) => times.get(session.id) === session.updatedAt);
}

function sameClosed(a: readonly ClosedSession[], b: readonly ClosedSession[]): boolean {
	if (a.length !== b.length) return false;
	const times = new Map(b.map((item) => [item.key, item.at]));
	return a.every((item) => times.get(item.key) === item.at);
}

export type SessionBoardStorage = {
	load(): string | null;
	save(json: string): void;
	tabGet(): string | null;
	tabSet(id: string | null): void;
};

export function createSessionBoard(opts: SessionBoardStorage): SessionBoard {
	const parsed = parseSessions(opts.load());
	let connectedId = opts.tabGet() ?? parsed.legacyConnectedId;
	if (!opts.tabGet() && parsed.legacyConnectedId) opts.tabSet(parsed.legacyConnectedId);
	let index: OpenSessionIndex = { sessions: applyClosed(parsed.sessions, parsed.closed), connectedId };
	let closed: ClosedSession[] = parsed.closed;

	function persist() {
		opts.tabSet(index.connectedId ?? null);
		opts.save(JSON.stringify({ sessions: index.sessions, closed }));
	}

	/** A note after a close is a new open, so it must sort after the tombstone. */
	function stamp(input: Parameters<typeof joinOrCreate>[1]): Parameters<typeof joinOrCreate>[1] {
		const now = input.now ?? Date.now();
		const probe = input.fileId?.trim()
			? `file:${input.fileId.trim()}`
			: input.sessionId
				? `id:${input.sessionId}`
				: input.id
					? `id:${input.id}`
					: null;
		const tomb = probe ? closed.find((item) => item.key === probe) : undefined;
		return { ...input, now: tomb && tomb.at >= now ? tomb.at + 1 : now };
	}

	function apply(next: ReturnType<typeof joinOrCreate>): OpenSession {
		if (!next.changed) return next.session;
		index = { sessions: next.index.sessions, connectedId: next.index.connectedId };
		persist();
		return next.session;
	}

	function close(row: OpenSession | undefined): OpenSession | undefined {
		if (!row) return undefined;
		closed = mergeClosed(closed, [{ key: sessionMergeKey(row), at: Math.max(Date.now(), row.updatedAt) }]);
		const sessions = index.sessions.filter((session) => session.id !== row.id);
		const nextConnected = index.connectedId === row.id ? undefined : index.connectedId;
		index = { sessions, connectedId: nextConnected };
		persist();
		return row;
	}

	return {
		current: () => index,
		remember(input) {
			return apply(joinOrCreate(index, stamp({ ...input, sessionId: index.connectedId })));
		},
		note(input) {
			return apply(joinOrCreate(index, stamp(input)));
		},
		connect(id) {
			if (!index.sessions.some((session) => session.id === id) || index.connectedId === id) return;
			index = { ...index, connectedId: id };
			persist();
		},
		forget(sessionId) {
			return close(index.sessions.find((session) => session.id === sessionId));
		},
		forgetFile(fileId) {
			return close(index.sessions.find((session) => session.fileId === fileId));
		},
		flush() {
			persist();
		},
		absorb(raw) {
			const remote = parseSessions(raw);
			const before = index.sessions;
			const learned = remote.closed.filter((item) => {
				const known = closed.find((mine) => mine.key === item.key);
				return !known || known.at < item.at;
			});
			// A close this tab has not seen covers this tab's own copy of the row,
			// however recently it was noted here: the person closed the session,
			// and this tab had not heard. Re-stamp so the other tabs drop it too.
			const dropped: OpenSession[] = [];
			const restamp: ClosedSession[] = [];
			for (const item of learned) {
				for (const row of before) {
					if (sessionMergeKey(row) !== item.key) continue;
					dropped.push(row);
					if (row.updatedAt > item.at) restamp.push({ key: item.key, at: row.updatedAt });
				}
			}
			const nextClosed = mergeClosed(closed, [...remote.closed, ...restamp]);
			const droppedIds = new Set(dropped.map((row) => row.id));
			const kept = before.filter((row) => !droppedIds.has(row.id));
			const sessions = applyClosed(mergeSessions(kept, remote.sessions), nextClosed);
			const connected = retargetConnected(index.connectedId, before, sessions);
			const changed =
				!sameSessions(before, sessions) || connected !== index.connectedId || !sameClosed(closed, nextClosed);
			index = { sessions, connectedId: connected };
			closed = nextClosed;
			if (changed) opts.tabSet(connected ?? null);
			return {
				changed,
				publish: !sameSessions(remote.sessions, sessions) || !sameClosed(remote.closed, nextClosed),
				closed: dropped
			};
		}
	};
}

type SharedBoardEvent = { closed: OpenSession[] };

export type SharedSessionBoard = {
	board: SessionBoard;
	/** Fires after this tab or another one changes the list. */
	subscribe(fn: (event: SharedBoardEvent) => void): () => void;
	/** Tell subscribers about a change made through `board` in this tab. */
	changed(event?: Partial<SharedBoardEvent>): void;
};

type SharedRegistry = Map<string, SharedSessionBoard>;

/**
 * One board per storage key per page. The hub and an embedded app import this
 * package once, but a page can still load two module graphs, so the instance
 * lives on `globalThis`. Two boards on one key would each write the list they
 * hold and drop the other's rows.
 */
export function sharedSessionBoard(
	key: string,
	opts: SessionBoardStorage & {
		/** Storage change feed for `key`, from other tabs. */
		watch?: (onRaw: (raw: string | null) => void) => () => void;
	}
): SharedSessionBoard {
	const g = globalThis as unknown as { __sharedSessionBoards__?: SharedRegistry };
	const boards = (g.__sharedSessionBoards__ ??= new Map());
	const existing = boards.get(key);
	if (existing) return existing;
	const board = createSessionBoard(opts);
	const listeners = new Set<(event: SharedBoardEvent) => void>();
	const emit = (event: SharedBoardEvent) => {
		for (const fn of [...listeners]) fn(event);
	};
	opts.watch?.((raw) => {
		const result = board.absorb(raw);
		if (result.publish) board.flush();
		if (result.changed || result.closed.length > 0) emit({ closed: result.closed });
	});
	const shared: SharedSessionBoard = {
		board,
		subscribe(fn) {
			listeners.add(fn);
			return () => listeners.delete(fn);
		},
		changed(event) {
			emit({ closed: event?.closed ?? [] });
		}
	};
	boards.set(key, shared);
	return shared;
}

/** Test hook: forget the page's shared boards. */
export function _resetSharedSessionBoards(): void {
	const g = globalThis as unknown as { __sharedSessionBoards__?: SharedRegistry };
	g.__sharedSessionBoards__ = new Map();
}

