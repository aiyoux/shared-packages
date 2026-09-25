/**
 * An open document. A tab connects to a session. A session with no tab
 * connected is still that session. One file has one session.
 */

export type SessionKind = 'image' | 'svg' | 'pdf' | 'sketch' | 'document' | 'remote';

export type OpenSession = {
	id: string;
	kind: SessionKind;
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
		title: string;
		fileId?: string;
		/** The session this caller is already connected to, if any. */
		sessionId?: string;
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
				connectedId: session.id,
				sessions: index.sessions.map((s) => (s.id === session.id ? session : s))
			}
		};
	}
	const session: OpenSession = {
		id: newSessionId(now),
		kind: input.kind,
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
		index: { connectedId: session.id, sessions: [...index.sessions, session] }
	};
}

let seq = 0;
function newSessionId(now: number): string {
	seq += 1;
	return `ses-${now.toString(36)}-${seq.toString(36)}`;
}
