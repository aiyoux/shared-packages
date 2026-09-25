/**
 * The open-document list is one record for every tab. Which document this
 * tab is showing is not part of that record — a second tab must not steal it.
 */
import {
	emptySessionIndex,
	joinOrCreate,
	mergeSessions,
	retargetConnected,
	type OpenSession,
	type OpenSessionIndex
} from './openSessions.js';

export type SessionBoard = {
	current(): OpenSessionIndex;
	remember(input: Parameters<typeof joinOrCreate>[1]): OpenSession;
	connect(id: string): void;
	forgetFile(fileId: string): void;
	/** Write the list this tab holds. Used after a merge the other tab has not seen. */
	flush(): void;
	/** Apply a list another tab just wrote. `publish` means this tab still holds sessions the write lacked. */
	absorb(raw: string | null): { changed: boolean; publish: boolean };
};

function parseSessions(raw: string | null): { sessions: OpenSession[]; legacyConnectedId?: string } {
	if (!raw) return { sessions: [] };
	try {
		const parsed = JSON.parse(raw) as OpenSessionIndex;
		if (!parsed || !Array.isArray(parsed.sessions)) return { sessions: [] };
		return { sessions: parsed.sessions, legacyConnectedId: parsed.connectedId };
	} catch {
		return { sessions: [] };
	}
}

function sameSessions(a: readonly OpenSession[], b: readonly OpenSession[]): boolean {
	if (a.length !== b.length) return false;
	const times = new Map(b.map((session) => [session.id, session.updatedAt]));
	return a.every((session) => times.get(session.id) === session.updatedAt);
}

export function createSessionBoard(opts: {
	load(): string | null;
	save(json: string): void;
	tabGet(): string | null;
	tabSet(id: string | null): void;
}): SessionBoard {
	const parsed = parseSessions(opts.load());
	let connectedId = opts.tabGet() ?? parsed.legacyConnectedId;
	if (!opts.tabGet() && parsed.legacyConnectedId) opts.tabSet(parsed.legacyConnectedId);
	let index: OpenSessionIndex = { sessions: parsed.sessions, connectedId };

	function persist() {
		opts.tabSet(index.connectedId ?? null);
		opts.save(JSON.stringify({ sessions: index.sessions }));
	}

	return {
		current: () => index,
		remember(input) {
			const next = joinOrCreate(index, { ...input, sessionId: index.connectedId });
			if (!next.changed) return next.session;
			index = next.index;
			persist();
			return next.session;
		},
		connect(id) {
			if (!index.sessions.some((session) => session.id === id) || index.connectedId === id) return;
			index = { ...index, connectedId: id };
			persist();
		},
		forgetFile(fileId) {
			const sessions = index.sessions.filter((session) => session.fileId !== fileId);
			if (sessions.length === index.sessions.length) return;
			const dropped = index.sessions.find((session) => session.fileId === fileId);
			const connectedId = index.connectedId === dropped?.id ? undefined : index.connectedId;
			index = { sessions, connectedId };
			persist();
		},
		flush() {
			persist();
		},
		absorb(raw) {
			const remote = parseSessions(raw).sessions;
			const before = index.sessions;
			const sessions = mergeSessions(before, remote);
			const connectedId = retargetConnected(index.connectedId, before, sessions);
			const changed = !sameSessions(before, sessions) || connectedId !== index.connectedId;
			index = { sessions, connectedId };
			if (changed) opts.tabSet(connectedId ?? null);
			return { changed, publish: !sameSessions(remote, sessions) };
		}
	};
}
