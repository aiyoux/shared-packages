import { describe, expect, it } from 'vitest';
import {
	applyUpdatePlan,
	findUpdateBannerHost,
	parseVersionPayload,
	shouldOfferUpdate
} from './appUpdate.ts';

describe('shouldOfferUpdate', () => {
	it('is silent when nothing changed', () => {
		expect(shouldOfferUpdate({ hasWaitingWorker: false, versionChanged: false })).toBe(false);
	});

	it('offers when a worker is waiting or still installing', () => {
		expect(shouldOfferUpdate({ hasWaitingWorker: true })).toBe(true);
		expect(shouldOfferUpdate({ hasWaitingWorker: false, hasInstallingWorker: true })).toBe(true);
	});

	it('does not offer on version.json alone — a reload would still hit the old cache', () => {
		expect(shouldOfferUpdate({ hasWaitingWorker: false, versionChanged: true })).toBe(false);
	});
});

describe('applyUpdatePlan', () => {
	it('activates a waiting or installing worker instead of reloading blindly', () => {
		expect(applyUpdatePlan({ hasWaitingWorker: true })).toBe('skip-waiting');
		expect(applyUpdatePlan({ hasWaitingWorker: false, hasInstallingWorker: true })).toBe(
			'skip-waiting'
		);
		expect(applyUpdatePlan({ hasWaitingWorker: false })).toBe('reload');
	});
});

describe('parseVersionPayload', () => {
	it('reads SvelteKit version.json', () => {
		expect(parseVersionPayload({ version: 'abc' })).toBe('abc');
		expect(parseVersionPayload({})).toBeNull();
		expect(parseVersionPayload(null)).toBeNull();
	});
});

describe('findUpdateBannerHost', () => {
	it('prefers the focused pane slot over the hub topbar', () => {
		const pane = { id: 'pane' } as unknown as HTMLElement;
		const hub = { id: 'hub' } as unknown as HTMLElement;
		const root = {
			querySelector(sel: string) {
				if (sel === '[data-pl-focused="true"] [data-app-update-slot]') return pane;
				if (sel === '[data-testid="hub-topbar-actions"] [data-app-update-slot]') return hub;
				return null;
			}
		};
		expect(findUpdateBannerHost(root)).toBe(pane);
	});

	it('falls back to hub topbar actions', () => {
		const actions = { id: 'actions' } as unknown as HTMLElement;
		const root = {
			querySelector(sel: string) {
				if (sel === '[data-testid="hub-topbar-actions"]') return actions;
				return null;
			}
		};
		expect(findUpdateBannerHost(root)).toBe(actions);
	});
});
