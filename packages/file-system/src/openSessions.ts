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

export function joinOrCreate(
	index: OpenSessionIndex,
	input: {
		kind: SessionKind;
		title: string;
		fileId?: string;
		dirty?: boolean;
		remote?: boolean;
		roomLabel?: string | null;
		now?: number;
	}
): { index: OpenSessionIndex; session: OpenSession } {
	const now = input.now ?? Date.now();
	const fileId = input.fileId?.trim() || undefined;
	if (fileId) {
		const existing = index.sessions.find((s) => s.fileId === fileId);
		if (existing) {
			const session: OpenSession = {
				...existing,
				title: input.title || existing.title,
				kind: input.kind,
				dirty: input.dirty ?? existing.dirty,
				remote: input.remote ?? existing.remote,
				...(input.roomLabel !== undefined ? { roomLabel: input.roomLabel || undefined } : {}),
				updatedAt: now
			};
			return {
				session,
				index: {
					connectedId: session.id,
					sessions: index.sessions.map((s) => (s.id === session.id ? session : s))
				}
			};
		}
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
	return { session, index: { connectedId: session.id, sessions: [...index.sessions, session] } };
}

let seq = 0;
function newSessionId(now: number): string {
	seq += 1;
	return `ses-${now.toString(36)}-${seq.toString(36)}`;
}
