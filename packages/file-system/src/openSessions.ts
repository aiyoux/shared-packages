/**
 * An open document. A tab connects to a session. A session with no tab
 * connected is still that session. One file has one session.
 */

export type SessionKind =
	| 'image'
	| 'svg'
	| 'pdf'
	| 'sketch'
	| 'document'
	| 'remote'
	| 'diagram'
	| 'nodes'
	| 'animation'
	| 'data'
	| 'text'
	| 'video';

/** Which app paints this session. Absent on rows written before the shared list. */
export type SessionApp =
	| 'creative'
	| 'diagrams'
	| 'nodes'
	| 'animations'
	| 'data'
	| 'text'
	| 'video';

export type OpenSession = {
	id: string;
	kind: SessionKind;
	app?: SessionApp;
	title: string;
	fileId?: string;
	dirty: boolean;
	remote: boolean;
	/** Checked-out project room, when this file lives in a project. A label, not a switch. */
	roomLabel?: string;
	updatedAt: number;
};

export type OpenSessionIndex = {
	sessions: OpenSession[];
	connectedId?: string;
};

export function emptySessionIndex(): OpenSessionIndex {
	return { sessions: [] };
}

/**
 * Find this document's session, or open one.
 *
 * A saved file joins the session that already names it. An unsaved document
 * has no file id to join by, so the caller passes the session it is already
 * on as `sessionId`: without it every call would open another session, and
 * callers run on every title or dirty change. That session is joined only
 * while it names no other file, so it also adopts the file id on first save.
 *
 * `changed` is false when nothing but the clock would move. The index is then
 * returned as given, so a caller can skip the write — and a reactive caller
 * does not re-run on its own no-op.
 */
export function joinOrCreate(
	index: OpenSessionIndex,
	input: {
		kind: SessionKind;
		app?: SessionApp;
		title: string;
		fileId?: string;
		/** The session this caller is already connected to, if any. */
		sessionId?: string;
		/** Id to use when this call creates a session. An existing id is left as it is. */
		id?: string;
		/** When false, this tab's connected session stays where it was. */
		connect?: boolean;
		dirty?: boolean;
		remote?: boolean;
		roomLabel?: string | null;
		now?: number;
	}
): { index: OpenSessionIndex; session: OpenSession; changed: boolean } {
	const now = input.now ?? Date.now();
	const fileId = input.fileId?.trim() || undefined;
	const byFile = fileId ? index.sessions.find((s) => s.fileId === fileId) : undefined;
	const byId = input.sessionId ? index.sessions.find((s) => s.id === input.sessionId) : undefined;
	const existing = byFile ?? (byId && (byId.fileId === undefined || byId.fileId === fileId) ? byId : undefined);
	if (existing) {
		const next: OpenSession = {
			...existing,
			title: input.title || existing.title,
			kind: input.kind,
			...(input.app ? { app: input.app } : {}),
			...(fileId ? { fileId } : {}),
			dirty: input.dirty ?? existing.dirty,
			remote: input.remote ?? existing.remote
		};
		if (input.roomLabel !== undefined) {
			if (input.roomLabel) next.roomLabel = input.roomLabel;
			else delete next.roomLabel;
		}
		const changed =
			index.connectedId !== existing.id ||
			next.title !== existing.title ||
			next.kind !== existing.kind ||
			next.app !== existing.app ||
			next.fileId !== existing.fileId ||
			next.dirty !== existing.dirty ||
			next.remote !== existing.remote ||
			next.roomLabel !== existing.roomLabel;
		if (!changed) return { index, session: existing, changed: false };
		const session: OpenSession = { ...next, updatedAt: now };
		return {
			session,
			changed: true,
			index: {
				connectedId: input.connect === false ? index.connectedId : session.id,
				sessions: index.sessions.map((s) => (s.id === session.id ? session : s))
			}
		};
	}
	const requestedId =
		input.id && !index.sessions.some((session) => session.id === input.id) ? input.id : undefined;
	const session: OpenSession = {
		id: requestedId ?? newSessionId(now),
		kind: input.kind,
		...(input.app ? { app: input.app } : {}),
		title: input.title || 'Untitled',
		...(fileId ? { fileId } : {}),
		dirty: input.dirty ?? false,
		remote: input.remote ?? false,
		...(input.roomLabel ? { roomLabel: input.roomLabel } : {}),
		updatedAt: now
	};
	return {
		session,
		changed: true,
		index: {
			connectedId: input.connect === false ? index.connectedId : session.id,
			sessions: [...index.sessions, session]
		}
	};
}

let seq = 0;
function newSessionId(now: number): string {
	seq += 1;
	return `ses-${now.toString(36)}-${seq.toString(36)}`;
}

/** A saved file is one session. An unsaved document is keyed by its own id. */
export function sessionMergeKey(session: OpenSession): string {
	return session.fileId ? `file:${session.fileId}` : `id:${session.id}`;
}

/**
 * Union two tabs' session lists.
 *
 * The later `updatedAt` supplies the fields. The id is the lesser of the two,
 * so both tabs converge on one id for a file instead of each keeping its own
 * and rewriting the list forever.
 */
export function mergeSessions(local: readonly OpenSession[], remote: readonly OpenSession[]): OpenSession[] {
	const map = new Map<string, OpenSession>();
	const put = (session: OpenSession) => {
		const key = sessionMergeKey(session);
		const prev = map.get(key);
		if (!prev) {
			map.set(key, session);
			return;
		}
		const newer = session.updatedAt >= prev.updatedAt ? session : prev;
		const id = prev.id < session.id ? prev.id : session.id;
		map.set(key, { ...newer, id, updatedAt: Math.max(prev.updatedAt, session.updatedAt) });
	};
	for (const session of local) put(session);
	for (const session of remote) put(session);
	return [...map.values()];
}

/** Point a tab's connected id at the merged session for the same document. */
export function retargetConnected(
	connectedId: string | undefined,
	before: readonly OpenSession[],
	after: readonly OpenSession[]
): string | undefined {
	if (!connectedId) return undefined;
	if (after.some((session) => session.id === connectedId)) return connectedId;
	const old = before.find((session) => session.id === connectedId);
	if (!old) return undefined;
	const key = sessionMergeKey(old);
	return after.find((session) => sessionMergeKey(session) === key)?.id;
}

/**
 * What a tab does when another tab writes the file.
 *
 * A replicated document (both tabs already share the bytes) drops Unsaved.
 * A tab that has not edited reloads the file. A tab with its own edits keeps
 * them.
 */
export type ForeignSaveAction = 'clear-dirty' | 'reload' | 'keep';

export function foreignSaveAction(opts: { replicated: boolean; uiDirty: boolean }): ForeignSaveAction {
	if (opts.replicated) return 'clear-dirty';
	if (!opts.uiDirty) return 'reload';
	return 'keep';
}
