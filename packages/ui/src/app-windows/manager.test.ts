import { beforeEach, describe, expect, it } from 'vitest';
import { createLeaf, leafCount, resetLayoutIdsForTests } from '../pane-layout/tree.js';
import {
	canCloseAppWindow,
	clampUnavailableRoles,
	closeAppWindow,
	pickNewRole,
	setAppWindowRole,
	splitAppWindow
} from './manager.js';
import type { AppWindowRoleDef } from './types.js';

const catalog: AppWindowRoleDef<'canvas' | 'scene' | 'layers' | 'git'>[] = [
	{ id: 'canvas', label: 'Canvas', required: true },
	{ id: 'scene', label: 'Scene' },
	{ id: 'layers', label: 'Layers' },
	{ id: 'git', label: 'Git', autoPick: false }
];

type Leaf = { role: 'canvas' | 'scene' | 'layers' | 'git' };

function inherit(_source: Leaf | undefined, role: Leaf['role']): Leaf {
	return { role };
}

beforeEach(() => {
	resetLayoutIdsForTests();
});

describe('app-windows manager', () => {
	it('splits a required role into another of the same role', () => {
		const root = createLeaf('home');
		const windows: Record<string, Leaf> = { home: { role: 'canvas' } };
		expect(pickNewRole(windows, 'canvas', catalog)).toBe('canvas');
		const next = splitAppWindow(root, windows, 'home', 'row', catalog, inherit);
		expect(next).not.toBeNull();
		expect(leafCount(next!.root)).toBe(2);
		expect(next!.windows[next!.newId].role).toBe('canvas');
	});

	it('splits an inspector toward the next unused auto-pick role, never git', () => {
		const root = createLeaf('home');
		const split = splitAppWindow(
			root,
			{ home: { role: 'canvas' } },
			'home',
			'row',
			catalog,
			inherit
		)!;
		const asScene = setAppWindowRole(split.windows, split.newId, 'scene', catalog, inherit)!;
		expect(pickNewRole(asScene, 'scene', catalog)).toBe('layers');
		const again = splitAppWindow(split.root, asScene, split.newId, 'col', catalog, inherit)!;
		expect(again.windows[again.newId].role).toBe('layers');
		expect(pickNewRole(again.windows, 'layers', catalog)).not.toBe('git');
	});

	it('refuses to close the last required leaf or the last window', () => {
		const root = createLeaf('home');
		const windows: Record<string, Leaf> = { home: { role: 'canvas' } };
		expect(canCloseAppWindow(root, windows, 'home', catalog)).toBe(false);
		expect(closeAppWindow(root, windows, 'home', catalog)).toBeNull();
	});

	it('clamps unavailable roles onto the fallback', () => {
		const windows: Record<string, Leaf> = {
			a: { role: 'canvas' },
			b: { role: 'git' }
		};
		const next = clampUnavailableRoles(windows, new Set(['canvas', 'scene']), 'scene', inherit);
		expect(next.b.role).toBe('scene');
		expect(next.a.role).toBe('canvas');
	});
});
