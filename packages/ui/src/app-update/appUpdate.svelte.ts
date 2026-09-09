/**
 * Origin-wide app update watcher. Detects a new service worker (installing or
 * waiting) but never reloads until the user confirms — Refresh skipWaiting's.
 */
import {
	APPLYING_UPDATE_KEY,
	shouldOfferUpdate,
	type AppUpdateStatus
} from './appUpdate.ts';

const CHECK_MS = 30_000;
const isDev = typeof import.meta !== 'undefined' && !!import.meta.env?.DEV;

export class AppUpdateStore {
	status = $state<AppUpdateStatus>('current');
	private started = false;
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

		void this.check();
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
		const worker = await this.targetWorker();
		if (worker) {
			worker.postMessage({ type: 'SKIP_WAITING' });
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

	private async check(): Promise<void> {
		if (this.status === 'applying') return;
		const registration = await this.registration();
		await registration?.update().catch(() => {});
		if (
			shouldOfferUpdate({
				hasWaitingWorker: !!registration?.waiting,
				hasInstallingWorker: !!registration?.installing
			})
		) {
			this.status = 'available';
		}
	}

	private async registration(): Promise<ServiceWorkerRegistration | undefined> {
		if (!('serviceWorker' in navigator)) return undefined;
		return navigator.serviceWorker.getRegistration();
	}

	/** Waiting first; installing is enough — skipWaiting during install activates on finish. */
	private async targetWorker(): Promise<ServiceWorker | null> {
		const registration = await this.registration();
		if (!registration) return null;
		if (registration.waiting) return registration.waiting;
		if (registration.installing) return registration.installing;
		await registration.update().catch(() => {});
		return registration.waiting ?? registration.installing ?? null;
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
