/** Pure update-offer policy. A new build never auto-reloads — the header banner does. */

export type AppUpdateStatus = 'current' | 'available' | 'applying';

export const APPLYING_UPDATE_KEY = 'scratch-pad-applying-update';

export function shouldOfferUpdate(opts: {
	hasWaitingWorker: boolean;
	/** New SW is still precaching. Refresh must skipWaiting it, not reload. */
	hasInstallingWorker?: boolean;
	/**
	 * Ignored for the banner. `version.json` moving while the old SW still
	 * controls only proves a deploy exists — a reload is still served from the
	 * previous cache. Offer once a worker is installing/waiting so Refresh
	 * can skipWaiting.
	 */
	versionChanged?: boolean;
}): boolean {
	return opts.hasWaitingWorker || !!opts.hasInstallingWorker;
}

/** After the user confirms: activate the new worker (waiting or still installing). */
export function applyUpdatePlan(opts: {
	hasWaitingWorker: boolean;
	hasInstallingWorker?: boolean;
}): 'skip-waiting' | 'reload' {
	return opts.hasWaitingWorker || !!opts.hasInstallingWorker ? 'skip-waiting' : 'reload';
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
