/** Pure update-offer policy. A new build never auto-reloads — the header banner does. */

export type AppUpdateStatus = 'current' | 'available' | 'applying';

export const APPLYING_UPDATE_KEY = 'scratch-pad-applying-update';

export function shouldOfferUpdate(opts: {
	hasWaitingWorker: boolean;
	versionChanged: boolean;
}): boolean {
	return opts.hasWaitingWorker || opts.versionChanged;
}

/** After the user confirms: activate a waiting worker, otherwise just reload. */
export function applyUpdatePlan(opts: { hasWaitingWorker: boolean }): 'skip-waiting' | 'reload' {
	return opts.hasWaitingWorker ? 'skip-waiting' : 'reload';
}

type QueryRoot = {
	querySelector: (selectors: string) => HTMLElement | null;
};

/**
 * Primary window header for the update chip, in priority order:
 * focused pane chrome, hub topbar, any `data-app-update-slot`, then `<header>`.
 */
export function findUpdateBannerHost(root: QueryRoot): HTMLElement | null {
	const focusedPane = root.querySelector(
		'[data-pl-focused="true"] [data-app-update-slot]'
	);
	if (focusedPane) return focusedPane;
	const hub = root.querySelector('[data-testid="hub-topbar-actions"] [data-app-update-slot]');
	if (hub) return hub;
	const slot = root.querySelector('[data-app-update-slot]');
	if (slot) return slot;
	const pane = root.querySelector('[data-testid="pl-chrome"] [data-app-update-slot]');
	if (pane) return pane;
	return root.querySelector('[data-testid="hub-topbar-actions"]');
}

export function parseVersionPayload(body: unknown): string | null {
	if (!body || typeof body !== 'object') return null;
	const version = (body as { version?: unknown }).version;
	return typeof version === 'string' && version.length > 0 ? version : null;
}
