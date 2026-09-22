<script lang="ts">
	/**
	 * Origin storage persistence pill (navigator.storage.persist).
	 * Covers Dexie IDB + OPFS for this origin. Best-effort; denial is not fatal.
	 *
	 * Click opens an explanation. The pane header and the explorer both clip
	 * overflow, so the popup is placed with escapePaneClip — the same fix as
	 * the file menu and the connection (i) tip.
	 */
	import { escapePaneClip } from '@shared-packages/ui';
	import {
		ensurePersistentStorage,
		getPersistenceStatus,
		type PersistenceResult,
		type PersistenceStatus
	} from '../persist.js';
	import type { VfsService } from '../vfs.js';

	interface Props {
		/** When set, re-request updates VFS meta (`storage:persistence`). */
		vfs?: VfsService;
		/**
		 * Poll interval in ms. `0` = check on mount / after request only.
		 * Default 8000.
		 */
		pollMs?: number;
		/** Compact toolbar chip (default true). */
		compact?: boolean;
		/** Show the permission button in the popup when storage is not persistent. */
		showRequest?: boolean;
		class?: string;
	}

	let {
		vfs,
		pollMs = 8000,
		compact = true,
		showRequest = true,
		class: className = ''
	}: Props = $props();

	let status = $state<PersistenceStatus | 'loading'>('loading');
	let usage = $state<number | undefined>(undefined);
	let quota = $state<number | undefined>(undefined);
	let busy = $state(false);
	let lastError = $state('');
	let open = $state(false);
	let wrapEl = $state<HTMLDivElement | undefined>();
	const popupId = `fe-storage-persist-popup-${Math.random().toString(36).slice(2, 8)}`;

	const label = $derived.by(() => {
		switch (status) {
			case 'loading':
				return 'Storage…';
			case 'persistent':
				return compact ? 'Persistent' : 'Storage: persistent';
			case 'best-effort':
				return compact ? 'Best-effort' : 'Storage: best-effort';
			case 'unsupported':
				return compact ? 'No persist API' : 'Storage: unsupported';
			default:
				return 'Storage';
		}
	});

	const heading = $derived.by(() => {
		if (status === 'persistent') return 'Storage is persistent';
		if (status === 'loading') return 'Checking storage';
		return 'Storage is not persistent';
	});

	const explanation = $derived.by(() => {
		if (status === 'persistent') {
			return 'This browser will keep this site’s files. IndexedDB and OPFS are much less likely to be cleared when the disk is full.';
		}
		if (status === 'best-effort') {
			return 'This browser has not agreed to keep this site’s files. Local files can be cleared when the disk is under pressure.';
		}
		if (status === 'unsupported') {
			return 'This browser does not offer persistent storage, so local files may be cleared when the disk is under pressure.';
		}
		return 'Checking whether this browser will keep this site’s files.';
	});

	const usageLine = $derived.by(() => {
		if (usage != null && quota != null && quota > 0) {
			return `${formatBytes(usage)} of ${formatBytes(quota)} used`;
		}
		if (usage != null) return `${formatBytes(usage)} used`;
		return '';
	});

	/** Asking only helps when the browser has the API and has not already granted it. */
	const canRequest = $derived(
		showRequest && status !== 'persistent' && status !== 'loading' && status !== 'unsupported'
	);

	function formatBytes(n: number): string {
		if (!Number.isFinite(n) || n < 0) return '—';
		if (n < 1024) return `${n} B`;
		const units = ['KB', 'MB', 'GB', 'TB'];
		let v = n;
		let i = -1;
		do {
			v /= 1024;
			i += 1;
		} while (v >= 1024 && i < units.length - 1);
		return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
	}

	function applyResult(r: PersistenceResult) {
		status = r.status;
		usage = r.usage;
		quota = r.quota;
	}

	async function readEstimate(): Promise<{ usage?: number; quota?: number }> {
		try {
			if (typeof navigator !== 'undefined' && typeof navigator.storage?.estimate === 'function') {
				const est = await navigator.storage.estimate();
				return { usage: est.usage, quota: est.quota };
			}
		} catch {
			/* ignore */
		}
		return {};
	}

	/** Poll-safe: never calls persist() (avoids re-prompts). */
	async function refresh() {
		try {
			if (vfs) {
				// Ensures first-ready persist request has run; does not re-prompt if denied.
				await vfs.ready();
			}
			const live = await getPersistenceStatus();
			const est = await readEstimate();
			status = live;
			usage = est.usage;
			quota = est.quota;
		} catch (e) {
			lastError = e instanceof Error ? e.message : String(e);
			if (status === 'loading') status = 'best-effort';
		}
	}

	async function onRequest() {
		if (busy) return;
		busy = true;
		lastError = '';
		try {
			if (vfs) {
				const r = await vfs.requestPersistentStorage();
				applyResult(r);
			} else {
				const r = await ensurePersistentStorage();
				applyResult(r);
			}
		} catch (e) {
			lastError = e instanceof Error ? e.message : String(e);
		} finally {
			busy = false;
		}
	}

	function toggleOpen() {
		open = !open;
	}

	$effect(() => {
		void vfs;
		void pollMs;
		let cancelled = false;
		let timer: ReturnType<typeof setInterval> | null = null;

		void (async () => {
			await refresh();
			if (cancelled) return;
			if (pollMs > 0) {
				timer = setInterval(() => {
					if (!cancelled) void refresh();
				}, pollMs);
			}
		})();

		return () => {
			cancelled = true;
			if (timer) clearInterval(timer);
		};
	});

	$effect(() => {
		if (!open) return;
		const onDoc = (e: MouseEvent) => {
			if (wrapEl && e.target instanceof Node && wrapEl.contains(e.target)) return;
			open = false;
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') open = false;
		};
		document.addEventListener('mousedown', onDoc);
		document.addEventListener('keydown', onKey);
		return () => {
			document.removeEventListener('mousedown', onDoc);
			document.removeEventListener('keydown', onKey);
		};
	});
</script>

<div class="fe-persist-wrap {className}" bind:this={wrapEl}>
	<button
		type="button"
		class="fe-persist"
		class:compact
		class:persistent={status === 'persistent'}
		class:best-effort={status === 'best-effort'}
		class:unsupported={status === 'unsupported'}
		class:loading={status === 'loading'}
		class:open
		data-testid="fe-storage-persist"
		data-status={status}
		aria-haspopup="dialog"
		aria-expanded={open}
		aria-controls={open ? popupId : undefined}
		onclick={toggleOpen}
	>
		<span class="fe-persist-dot" aria-hidden="true"></span>
		<span class="fe-persist-label" data-testid="fe-storage-persist-label">{label}</span>
	</button>
	{#if open}
		<div
			class="fe-persist-pop"
			class:persistent={status === 'persistent'}
			class:best-effort={status === 'best-effort'}
			class:unsupported={status === 'unsupported'}
			class:loading={status === 'loading'}
			id={popupId}
			data-testid="fe-storage-persist-popup"
			data-status={status}
			role="dialog"
			aria-label={heading}
			use:escapePaneClip
		>
			<p class="fe-persist-pop-title">{heading}</p>
			<p class="fe-persist-explain" data-testid="fe-storage-persist-explain">{explanation}</p>
			{#if usageLine}
				<p class="fe-persist-usage" data-testid="fe-storage-persist-usage">{usageLine}</p>
			{/if}
			{#if lastError}
				<p class="fe-persist-error" role="alert">{lastError}</p>
			{/if}
			{#if canRequest}
				<button
					type="button"
					class="fe-persist-request"
					data-testid="fe-storage-persist-request"
					disabled={busy}
					onclick={() => void onRequest()}
				>
					{busy ? 'Requesting…' : 'Request permission'}
				</button>
			{/if}
		</div>
	{/if}
</div>

<style>
	.fe-persist-wrap {
		position: relative;
		display: inline-flex;
		flex-shrink: 0;
		max-width: 100%;
	}

	.fe-persist {
		appearance: none;
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font: inherit;
		font-size: 0.78rem;
		line-height: 1.2;
		padding: 3px 8px;
		border-radius: 999px;
		border: 1px solid color-mix(in srgb, currentColor 22%, transparent);
		background: color-mix(in srgb, currentColor 6%, transparent);
		color: inherit;
		max-width: 100%;
		user-select: none;
		cursor: pointer;
	}

	.fe-persist.compact {
		padding: 2px 7px;
		font-size: 0.72rem;
	}

	.fe-persist-dot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		flex-shrink: 0;
		background: var(--text-muted);
	}

	.fe-persist.persistent .fe-persist-dot {
		background: var(--cat-green-soft);
		box-shadow: 0 0 0 2px rgb(var(--cat-green-soft-rgb) / 0.25);
	}
	.fe-persist.best-effort .fe-persist-dot,
	.fe-persist.unsupported .fe-persist-dot {
		background: var(--cat-red-soft);
		box-shadow: 0 0 0 2px rgb(var(--cat-red-soft-rgb) / 0.25);
	}
	.fe-persist.loading .fe-persist-dot {
		background: var(--text-muted);
	}

	.fe-persist.persistent {
		border-color: rgb(var(--cat-green-soft-rgb) / 0.55);
		background: rgb(var(--cat-green-soft-rgb) / 0.16);
		color: var(--cat-green-soft);
	}
	.fe-persist.best-effort,
	.fe-persist.unsupported {
		border-color: rgb(var(--cat-red-soft-rgb) / 0.6);
		background: rgb(var(--cat-red-soft-rgb) / 0.16);
		color: var(--cat-red-soft);
	}

	.fe-persist.open,
	.fe-persist:hover {
		filter: brightness(1.08);
	}

	.fe-persist-label {
		white-space: nowrap;
		opacity: 0.92;
	}

	.fe-persist-pop {
		z-index: 80;
		width: min(18rem, calc(100vw - 24px));
		padding: 0.7rem 0.8rem 0.75rem;
		border-radius: 10px;
		border: 2px solid var(--line-hairline);
		background: var(--surface-2);
		color: var(--text-primary);
		box-shadow: 0 10px 28px rgb(var(--scrim-rgb) / 0.45);
		font-size: 0.8rem;
		line-height: 1.4;
		text-align: left;
	}

	.fe-persist-pop.persistent {
		border-color: var(--cat-green-soft);
	}
	.fe-persist-pop.best-effort,
	.fe-persist-pop.unsupported {
		border-color: var(--cat-red-soft);
	}

	.fe-persist-pop-title {
		margin: 0 0 0.35rem;
		font-weight: 700;
		font-size: 0.84rem;
	}

	.fe-persist-pop.persistent .fe-persist-pop-title {
		color: var(--cat-green-soft);
	}
	.fe-persist-pop.best-effort .fe-persist-pop-title,
	.fe-persist-pop.unsupported .fe-persist-pop-title {
		color: var(--cat-red-soft);
	}

	.fe-persist-explain,
	.fe-persist-usage,
	.fe-persist-error {
		margin: 0;
	}

	.fe-persist-usage {
		margin-top: 0.4rem;
		opacity: 0.75;
		font-size: 0.74rem;
	}

	.fe-persist-error {
		margin-top: 0.4rem;
		color: var(--cat-red-soft);
	}

	.fe-persist-request {
		appearance: none;
		display: inline-flex;
		margin-top: 0.65rem;
		border: 1px solid rgb(var(--cat-red-soft-rgb) / 0.55);
		background: rgb(var(--cat-red-soft-rgb) / 0.14);
		color: var(--cat-red-soft);
		border-radius: 999px;
		padding: 4px 10px;
		font: inherit;
		font-size: 0.75rem;
		font-weight: 650;
		cursor: pointer;
		line-height: 1.35;
	}

	.fe-persist-request:hover:not(:disabled) {
		background: rgb(var(--cat-red-soft-rgb) / 0.24);
	}

	.fe-persist-request:disabled {
		opacity: 0.55;
		cursor: not-allowed;
	}
</style>
