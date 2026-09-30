/**
 * One session list for every app in the workspace, and which window shows
 * which session.
 *
 * A session is one open document. A window is a pane (or a full-page mount)
 * that points at a session. Closing a window drops the pointer and leaves the
 * session on the list. Closing the session removes the row for every tab and
 * tells every window showing it.
 *
 * The list is shared by the tabs of this origin. Window pointers belong to one
 * tab (sessionStorage), so another tab cannot move this tab's windows.
 *
 * A session another device shares with this one is on the list too, with an
 * `origin`: windows point at it and the Sessions menu lists it like any other.
 * It lives only in the tab that holds the link to that device, so it is never
 * stored or sent to other tabs, and it goes when the link or the share ends.
 *
 * State lives on `globalThis`: a page can load this package in two module
 * graphs (hub layout and an embedded app), and both must see one list.
 */
import { persistKv, persistReady } from '@shared-packages/ui/persistKv';
import { subscribeStorageKey } from '@shared-packages/ui/subscribeStorageKey';
import type { OpenSession, SessionApp, SessionKind, SessionOrigin } from './openSessions.js';
import {
	sharedSessionBoard,
	type SessionBoardStorage,
	type SharedSessionBoard
} from './sessionBoard.js';

export const WORKSPACE_SESSIONS_KEY = 'workspace:sessions';
const WINDOW_KEY = 'workspace:session-windows';

export type WorkspaceSession = OpenSession;

export type WorkspaceStorage = SessionBoardStorage & {
	watch?: (onRaw: (raw: string | null) => void) => () => void;
	/**
	 * Resolves once `load` returns what is stored. Until then the board holds
	 * writes in memory: the store keeps whatever was written first, so an
	 * early write of a half-known list would replace the stored one.
	 */
	ready?: () => Promise<void>;
	readWindows(): Record<string, string>;
	writeWindows(windows: Record<string, string>): void;
};

export type SessionClosedEvent = {
	session: WorkspaceSession;
	/** Windows in this tab that were showing it. Their pointers are already gone. */
	windowIds: string[];
	/** True when this tab closed it; false when another tab did. */
	local: boolean;
};

type Bag = {
	storage: WorkspaceStorage | null;
	shared: SharedSessionBoard | null;
	boardKey: string;
	requests: Map<string, WorkspaceSession>;
	/** Sessions other devices share with this tab, by row id. */
	joined: Map<string, WorkspaceSession>;
	changeListeners: Set<() => void>;
	closeListeners: Set<(event: SessionClosedEvent) => void>;
	showListeners: Set<(windowId: string, session: WorkspaceSession) => void>;
	unwatch: (() => void) | null;
	ready: Promise<void> | null;
	hydrated: boolean;
	heldWrite: boolean;
};

function bag(): Bag {
	const g = globalThis as unknown as { __workspaceSessions__?: Bag };
	return (g.__workspaceSessions__ ??= {
		storage: null,
		shared: null,
		boardKey: WORKSPACE_SESSIONS_KEY,
		requests: new Map(),
		joined: new Map(),
		changeListeners: new Set(),
		closeListeners: new Set(),
		showListeners: new Set(),
		unwatch: null,
		ready: null,
		hydrated: false,
		heldWrite: false
	});
}

function browserStorage(): WorkspaceStorage {
	const tabKey = `${WORKSPACE_SESSIONS_KEY}:tab`;
	return {
		load: () => persistKv.getItem(WORKSPACE_SESSIONS_KEY),
		save: (json) => persistKv.setItem(WORKSPACE_SESSIONS_KEY, json),
		ready: () => persistReady(),
		tabGet: () => {
			try {
				return sessionStorage.getItem(tabKey);
			} catch {
				return null;
			}
		},
		tabSet: (id) => {
			try {
				if (id) sessionStorage.setItem(tabKey, id);
				else sessionStorage.removeItem(tabKey);
			} catch {
				/* private mode */
			}
		},
		watch:
			typeof window === 'undefined'
				? undefined
				: (onRaw) => subscribeStorageKey(WORKSPACE_SESSIONS_KEY, onRaw),
		readWindows: () => {
			try {
				const raw = sessionStorage.getItem(WINDOW_KEY);
				if (!raw) return {};
				const parsed = JSON.parse(raw) as unknown;
				if (!parsed || typeof parsed !== 'object') return {};
				return parsed as Record<string, string>;
			} catch {
				return {};
			}
		},
		writeWindows: (windows) => {
			try {
				sessionStorage.setItem(WINDOW_KEY, JSON.stringify(windows));
			} catch {
				/* private mode */
			}
		}
	};
}

function storage(): WorkspaceStorage {
	const b = bag();
	return (b.storage ??= browserStorage());
}

function emitChange(): void {
	for (const fn of [...bag().changeListeners]) fn();
}

function emitClosed(session: WorkspaceSession, local: boolean): void {
	const windows = storage().readWindows();
	const windowIds = Object.keys(windows).filter((id) => windows[id] === session.id);
	if (windowIds.length > 0) {
		for (const id of windowIds) delete windows[id];
		storage().writeWindows(windows);
	}
	for (const id of [...bag().requests.keys()]) {
		if (bag().requests.get(id)?.id === session.id) bag().requests.delete(id);
	}
	const event: SessionClosedEvent = { session, windowIds, local };
	for (const fn of [...bag().closeListeners]) fn(event);
}

function shared(): SharedSessionBoard {
	const b = bag();
	if (b.shared) return b.shared;
	const s = storage();
	b.hydrated = !s.ready;
	const gated: SessionBoardStorage = {
		load: s.load,
		tabGet: s.tabGet,
		tabSet: s.tabSet,
		save: (json) => {
			if (b.hydrated) s.save(json);
			else b.heldWrite = true;
		}
	};
	// A key per storage keeps a test's board apart from the page's.
	b.shared = sharedSessionBoard(b.boardKey, { ...gated, watch: s.watch });
	const board = b.shared;
	if (s.ready) {
		b.ready = s.ready().then(() => {
			b.hydrated = true;
			const result = board.board.absorb(s.load());
			if (result.publish || b.heldWrite) board.board.flush();
			b.heldWrite = false;
			for (const session of result.closed) emitClosed(session, false);
			emitChange();
		});
	} else {
		b.ready = Promise.resolve();
	}
	b.unwatch = b.shared.subscribe((event) => {
		for (const session of event.closed) emitClosed(session, false);
		emitChange();
	});
	return b.shared;
}

/** Resolves once the list reflects what is stored. Read it before restoring a window. */
export function workspaceSessionsReady(): Promise<void> {
	shared();
	return bag().ready ?? Promise.resolve();
}

/**
 * The collab room of a session: its file once it has one, the session itself
 * before. Every tab and pane showing the session meets there; on the first
 * save, whoever is in the session's room moves to the file's.
 */
export function sessionRoom(session: { id: string; fileId?: string }): string {
	return session.fileId || `session:${session.id}`;
}

export function listWorkspaceSessions(): WorkspaceSession[] {
	const stored = shared().board.current().sessions;
	const joined = bag().joined;
	return joined.size === 0 ? stored : [...stored, ...joined.values()];
}

/** This device's own sessions: what it can share with another device. */
export function ownWorkspaceSessions(): WorkspaceSession[] {
	return shared().board.current().sessions;
}

/** The row id a shared session gets on this device. */
export function joinedSessionId(origin: Pick<SessionOrigin, 'peerId' | 'sessionId'>): string {
	return `join:${origin.peerId}:${origin.sessionId}`;
}

/**
 * A session another device shares with this tab. Adding it again updates it
 * (a new title, a changed write grant) and keeps the windows showing it.
 */
export function addJoinedSession(input: {
	app: SessionApp;
	kind: SessionKind;
	title: string;
	dirty?: boolean;
	origin: SessionOrigin;
}): WorkspaceSession {
	shared();
	const id = joinedSessionId(input.origin);
	const before = bag().joined.get(id);
	const row: WorkspaceSession = {
		id,
		app: input.app,
		kind: input.kind,
		title: input.title || before?.title || 'Untitled',
		dirty: input.dirty ?? before?.dirty ?? false,
		origin: { ...input.origin },
		updatedAt: before?.updatedAt ?? Date.now()
	};
	if (
		before &&
		before.title === row.title &&
		before.dirty === row.dirty &&
		before.app === row.app &&
		before.origin?.write === row.origin?.write &&
		before.origin?.device === row.origin?.device
	) {
		return before;
	}
	bag().joined.set(id, row);
	emitChange();
	return row;
}

/**
 * The share ended (this device left, the other device stopped sharing, or the
 * link went). Windows showing it hear `onWorkspaceSessionClosed` with the row,
 * whose `origin` tells them to keep what they hold as their own copy.
 */
export function endJoinedSession(id: string): WorkspaceSession | undefined {
	const row = bag().joined.get(id);
	if (!row) return undefined;
	bag().joined.delete(id);
	emitClosed(row, true);
	emitChange();
	return row;
}

export function findWorkspaceSession(id: string | null | undefined): WorkspaceSession | undefined {
	if (!id) return undefined;
	return listWorkspaceSessions().find((row) => row.id === id);
}

/** Every change to the list or to this tab's window pointers. */
export function onWorkspaceSessions(fn: () => void): () => void {
	shared();
	bag().changeListeners.add(fn);
	return () => bag().changeListeners.delete(fn);
}

/** A session was closed here or in another tab. */
export function onWorkspaceSessionClosed(fn: (event: SessionClosedEvent) => void): () => void {
	shared();
	bag().closeListeners.add(fn);
	return () => bag().closeListeners.delete(fn);
}

/**
 * Record a session. A saved file joins its row. An unsaved document passes the
 * row it already has as `sessionId`; that row adopts `fileId` on first save.
 */
export function noteWorkspaceSession(input: {
	sessionId?: string;
	app: SessionApp;
	kind: SessionKind;
	title: string;
	fileId?: string;
	dirty?: boolean;
	roomLabel?: string | null;
}): WorkspaceSession {
	const board = shared().board;
	const { sessionId, ...rest } = input;
	const before = board.current().sessions;
	const row = board.note({ ...rest, sessionId, connect: false });
	if (board.current().sessions !== before) emitChange();
	return row;
}

/** Close a session for every tab. Windows showing it hear `onWorkspaceSessionClosed`. */
export function closeWorkspaceSession(id: string): WorkspaceSession | undefined {
	if (bag().joined.has(id)) return endJoinedSession(id);
	const row = shared().board.forget(id);
	if (!row) return undefined;
	emitClosed(row, true);
	emitChange();
	return row;
}

export function attachWindow(windowId: string, sessionId: string): void {
	if (!windowId || !sessionId) return;
	const windows = storage().readWindows();
	if (windows[windowId] === sessionId) return;
	windows[windowId] = sessionId;
	storage().writeWindows(windows);
	emitChange();
}

export function detachWindow(windowId: string): void {
	if (!windowId) return;
	const windows = storage().readWindows();
	if (!(windowId in windows)) return;
	delete windows[windowId];
	storage().writeWindows(windows);
	emitChange();
}

export function sessionIdForWindow(windowId: string): string | undefined {
	if (!windowId) return undefined;
	return storage().readWindows()[windowId];
}

export function windowPointers(): Record<string, string> {
	return { ...storage().readWindows() };
}

/** Windows in this tab showing a session. */
export function windowsShowing(sessionId: string): string[] {
	const windows = storage().readWindows();
	return Object.keys(windows).filter((id) => windows[id] === sessionId);
}

/**
 * Ask a window to show a session. The app in that window attaches its pointer
 * once it actually shows it, so a window that refuses keeps its own.
 */
export function requestWindowSession(windowId: string, session: WorkspaceSession): void {
	if (!windowId) return;
	bag().requests.set(windowId, session);
	for (const fn of [...bag().showListeners]) fn(windowId, session);
}

/** A mounted app hears requests for its window and app. */
export function watchWindowSession(
	windowId: string,
	app: SessionApp,
	onShow: (session: WorkspaceSession) => void
): () => void {
	if (!windowId) return () => {};
	const fn = (target: string, session: WorkspaceSession) => {
		if (target !== windowId || session.app !== app) return;
		bag().requests.delete(windowId);
		onShow(session);
	};
	bag().showListeners.add(fn);
	return () => bag().showListeners.delete(fn);
}

/** The request waiting for a window, without taking it. */
export function peekWindowRequest(windowId: string): WorkspaceSession | null {
	return bag().requests.get(windowId) ?? null;
}

/**
 * What a window shows when it mounts: an explicit request first, then the
 * pointer this tab stored for it (a refresh), then — only when `recent` is
 * set, for a standalone build's pane-less mount — the most recent session of
 * this app that no other window here is showing. Hub windows start empty.
 */
export function bootWindowSession(
	windowId: string,
	app: SessionApp,
	opts: { recent?: boolean } = {}
): WorkspaceSession | null {
	const b = bag();
	const requested = b.requests.get(windowId);
	if (requested?.app === app) {
		b.requests.delete(windowId);
		return requested;
	}
	const pointed = findWorkspaceSession(sessionIdForWindow(windowId));
	if (pointed?.app === app) return pointed;
	if (!opts.recent) return null;
	const shown = new Set(Object.values(storage().readWindows()));
	return (
		// Newest first; on a tie, the row added later.
		[...ownWorkspaceSessions()]
			.reverse()
			.filter((row) => row.app === app && !shown.has(row.id))
			.sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null
	);
}

/** Test hook: a fresh list over the given storage. */
export function _resetWorkspaceSessionsForTest(next?: WorkspaceStorage): void {
	const b = bag();
	b.unwatch?.();
	b.unwatch = null;
	b.shared = null;
	b.ready = null;
	b.hydrated = false;
	b.heldWrite = false;
	b.storage = next ?? null;
	b.boardKey = `${WORKSPACE_SESSIONS_KEY}:test:${Math.random().toString(36).slice(2)}`;
	b.requests.clear();
	b.joined.clear();
	b.changeListeners.clear();
	b.closeListeners.clear();
	b.showListeners.clear();
}
