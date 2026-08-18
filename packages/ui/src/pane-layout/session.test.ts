import { describe, it, expect, beforeEach } from 'vitest';
import { createLeaf, resetLayoutIdsForTests, splitLeaf, syncLayoutIdSeq, newLayoutId } from './tree.ts';
import {
	applySessionId,
	createPaneSessionStore,
	createSessionId,
	isWorkspacePath,
	parseLayoutNode,
	parsePaneSessionSnapshot,
	readSessionId,
	type StorageLike
} from './session.ts';

function memoryStorage(): StorageLike {
	const map = new Map<string, string>();
	return {
		getItem: (k) => (map.has(k) ? map.get(k)! : null),
		setItem: (k, v) => {
			map.set(k, v);
		},
		removeItem: (k) => {
			map.delete(k);
		}
	};
}

describe('pane session helpers', () => {
	beforeEach(() => {
		resetLayoutIdsForTests();
	});

	it('creates unique URL-safe session ids', () => {
		const a = createSessionId();
		const b = createSessionId();
		expect(a).toMatch(/^[0-9a-z]{12}$/);
		expect(b).toMatch(/^[0-9a-z]{12}$/);
		expect(a).not.toBe(b);
	});

	it('reads and writes the session query param without dropping siblings', () => {
		expect(readSessionId('')).toBeNull();
		expect(readSessionId('foo=1')).toBeNull();
		expect(readSessionId('s=abc')).toBe('abc');
		expect(readSessionId('?s=abc&x=1')).toBe('abc');
		expect(applySessionId('/tools', 'abc')).toBe('/tools?s=abc');
		expect(applySessionId('/tools?x=1#top', 'abc')).toBe('/tools?x=1&s=abc#top');
		expect(applySessionId('/tools?s=old', 'new')).toBe('/tools?s=new');
	});

	it('treats only the tools index as the workspace path', () => {
		expect(isWorkspacePath('/tools')).toBe(true);
		expect(isWorkspacePath('/tools/')).toBe(true);
		expect(isWorkspacePath('/tools/files')).toBe(false);
		expect(isWorkspacePath('/cm')).toBe(false);
	});

	it('round-trips a split layout and rejects junk', () => {
		const split = splitLeaf(createLeaf('home'), 'home', 'row')!;
		const parsed = parseLayoutNode(JSON.parse(JSON.stringify(split.root)));
		expect(parsed).toEqual(split.root);
		expect(parseLayoutNode(null)).toBeNull();
		expect(parseLayoutNode({ kind: 'leaf' })).toBeNull();
		expect(parseLayoutNode({ kind: 'split', id: 'x', direction: 'row', first: { kind: 'leaf', id: 'a' } })).toBeNull();
	});

	it('persists a snapshot to session storage and restores it', () => {
		const session = memoryStorage();
		const local = memoryStorage();
		const store = createPaneSessionStore({ storages: [session, local] });
		const root = createLeaf('home');
		store.save({
			version: 1,
			id: 'tab1',
			root,
			focusedId: 'home',
			views: { home: { kind: 'home' } },
			updatedAt: 42
		});
		expect(store.load('tab1')).toEqual({
			version: 1,
			id: 'tab1',
			root,
			focusedId: 'home',
			views: { home: { kind: 'home' } },
			updatedAt: 42
		});
		expect(session.getItem('sp:pane-session:tab1')).toContain('"tab1"');
		expect(local.getItem('sp:pane-session:tab1')).toContain('"tab1"');
	});

	it('falls back to the next storage when the first slot is empty', () => {
		const session = memoryStorage();
		const local = memoryStorage();
		const writer = createPaneSessionStore({ storages: [local] });
		writer.save({
			version: 1,
			id: 'copied',
			root: createLeaf('home'),
			focusedId: 'home',
			views: {},
			updatedAt: 1
		});
		const reader = createPaneSessionStore({ storages: [session, local] });
		expect(reader.load('copied')?.id).toBe('copied');
	});

	it('rejects a snapshot whose id does not match the requested key', () => {
		const storage = memoryStorage();
		storage.setItem(
			'sp:pane-session:want',
			JSON.stringify({
				version: 1,
				id: 'other',
				root: { kind: 'leaf', id: 'home' },
				focusedId: 'home',
				views: {},
				updatedAt: 1
			})
		);
		expect(createPaneSessionStore({ storages: [storage] }).load('want')).toBeNull();
	});

	it('drops views the parseView callback rejects', () => {
		const parsed = parsePaneSessionSnapshot(
			{
				version: 1,
				id: 's',
				root: { kind: 'leaf', id: 'home' },
				focusedId: 'home',
				views: { home: { kind: 'home' }, junk: { kind: 'nope' } },
				updatedAt: 1
			},
			(value) => {
				const kind = (value as { kind?: string } | null)?.kind;
				return kind === 'home' ? { kind: 'home' } : null;
			}
		);
		expect(parsed?.views).toEqual({ home: { kind: 'home' } });
	});
});

describe('syncLayoutIdSeq', () => {
	beforeEach(() => {
		resetLayoutIdsForTests();
	});

	it('advances the id counter past restored ids so new leaves do not collide', () => {
		const root = parseLayoutNode({
			kind: 'split',
			id: 'split-4',
			direction: 'row',
			ratio: 0.5,
			first: { kind: 'leaf', id: 'leaf-2' },
			second: { kind: 'leaf', id: 'leaf-3' }
		});
		expect(root).not.toBeNull();
		syncLayoutIdSeq(root!);
		expect(newLayoutId('leaf')).toBe('leaf-5');
	});
});
