/**
 * Origin-wide app update watcher. Detects a new build (waiting service worker
 * or `/_app/version.json`) but never reloads until the user confirms.
 */
import {
	APPLYING_UPDATE_KEY,
	applyUpdatePlan,
	parseVersionPayload,
	shouldOfferUpdate,
	type AppUpdateStatus
} from './appUpdate.ts';

const CHECK_MS = 30_000;
const isDev = typeof import.meta !== 'undefined' && !!import.meta.env?.DEV;

export class AppUpdateStore {
	status = $state<AppUpdateStatus>('current');
	private started = false;
	private baseline: string | null = null;
	private timer: ReturnType<typeof setInterval> | null = null;
	private unsub: Array<() => void> = [];

	start(): () => void {
		if (typeof window === 'undefined') return () => {};
		this.installTestHook();
		// Vite HMR rewrites version.json constantly — don't nag in `vite dev`.
		if (isDev) return () => {};
		if (this.started) return () => this.stop();
		this.started = true;

		const onControllerChange = () => {
			if (!this.isApplying()) return;
			location.reload();
		};
		if (navigator.serviceWorker?.controller) {
			navigator.serviceWorker.addEventListener('controllerchange', onControllerChange);
			this.unsub.push(() =>
				navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange)
			);
		}

		const onVisible = () => {
			if (document.visibilityState === 'visible') void this.check();
		};
		document.addEventListener('visibilitychange', onVisible);
		window.addEventListener('focus', onVisible);
		this.unsub.push(() => document.removeEventListener('visibilitychange', onVisible));
		this.unsub.push(() => window.removeEventListener('focus', onVisible));

		void this.check({ recordBaseline: true });
		this.timer = setInterval(() => void this.check(), CHECK_MS);

		this.installTestHook();
		return () => this.stop();
	}

	stop(): void {
		if (this.timer != null) {
			clearInterval(this.timer);
			this.timer = null;
		}
		for (const fn of this.unsub) fn();
		this.unsub = [];
		this.started = false;
	}

	/** Test-only: show the banner without a real deploy. */
	offer(): void {
		this.status = 'available';
	}

	async apply(): Promise<void> {
		if (this.status === 'current') return;
		this.status = 'applying';
		this.markApplying();
		const waiting = await this.waitingWorker();
		const plan = applyUpdatePlan({ hasWaitingWorker: !!waiting });
		if (plan === 'skip-waiting' && waiting) {
			waiting.postMessage({ type: 'SKIP_WAITING' });
			return;
		}
		location.reload();
	}

	private isApplying(): boolean {
		if (this.status === 'applying') return true;
		try {
			return sessionStorage.getItem(APPLYING_UPDATE_KEY) === '1';
		} catch {
			return false;
		}
	}

	private markApplying(): void {
		try {
			sessionStorage.setItem(APPLYING_UPDATE_KEY, '1');
		} catch {
			/* private mode */
		}
	}

	private async check(opts?: { recordBaseline?: boolean }): Promise<void> {
		if (this.status === 'applying') return;
		const version = await this.readVersion();
		if (opts?.recordBaseline) this.baseline = version;
		const registration = await this.registration();
		await registration?.update().catch(() => {});
		const waiting = !!registration?.waiting;
		const versionChanged = !!this.baseline && !!version && version !== this.baseline;
		if (shouldOfferUpdate({ hasWaitingWorker: waiting, versionChanged })) {
			this.status = 'available';
		}
	}

	private async readVersion(): Promise<string | null> {
		try {
			const res = await fetch('/_app/version.json', { cache: 'no-store' });
			if (!res.ok) return null;
			return parseVersionPayload(await res.json());
		} catch {
			return null;
		}
	}

	private async registration(): Promise<ServiceWorkerRegistration | undefined> {
		if (!('serviceWorker' in navigator)) return undefined;
		return navigator.serviceWorker.getRegistration();
	}

	private async waitingWorker(): Promise<ServiceWorker | null> {
		const registration = await this.registration();
		return registration?.waiting ?? null;
	}

	private installTestHook(): void {
		const w = window as unknown as {
			__APP_UPDATE_TEST__?: { offer: () => void; apply: () => Promise<void> };
		};
		w.__APP_UPDATE_TEST__ = {
			offer: () => this.offer(),
			apply: () => this.apply()
		};
	}
}

export const appUpdate = new AppUpdateStore();

export function startAppUpdateWatcher(): () => void {
	return appUpdate.start();
}
