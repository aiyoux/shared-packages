<script lang="ts">
	/**
	 * Pollable origin storage persistence badge (navigator.storage.persist).
	 * Covers Dexie IDB + OPFS for this origin. Best-effort; denial is not fatal.
	 */
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
		/** Show request button when status is not persistent (default true). */
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

	const title = $derived.by(() => {
		const parts: string[] = [];
		if (status === 'persistent') {
			parts.push(
				'This origin has persistent storage. IndexedDB and OPFS are less likely to be evicted under disk pressure.'
			);
		} else if (status === 'best-effort') {
			parts.push(
				'Browser denied or has not granted persistent storage. Local files may be cleared under storage pressure.'
			);
		} else if (status === 'unsupported') {
			parts.push('navigator.storage.persist is not available in this environment.');
		} else {
			parts.push('Checking storage persistence…');
		}
		if (usage != null && quota != null && quota > 0) {
			parts.push(`Usage ${formatBytes(usage)} / ${formatBytes(quota)}.`);
		} else if (usage != null) {
			parts.push(`Usage ${formatBytes(usage)}.`);
		}
		if (lastError) parts.push(lastError);
		return parts.join(' ');
	});

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
</script>

<div
	class="fe-persist {className}"
	class:compact
	class:persistent={status === 'persistent'}
	class:best-effort={status === 'best-effort'}
	class:unsupported={status === 'unsupported'}
	class:loading={status === 'loading'}
	data-testid="fe-storage-persist"
	data-status={status}
	title={title}
	role="status"
	aria-live="polite"
>
	<span class="fe-persist-dot" aria-hidden="true"></span>
	<span class="fe-persist-label" data-testid="fe-storage-persist-label">{label}</span>
	{#if usage != null && quota != null && !compact}
		<span class="fe-persist-usage" data-testid="fe-storage-persist-usage">
			{formatBytes(usage)} / {formatBytes(quota)}
		</span>
	{/if}
	{#if showRequest && status !== 'persistent' && status !== 'loading' && status !== 'unsupported'}
		<button
			type="button"
			class="fe-persist-request"
			data-testid="fe-storage-persist-request"
			disabled={busy}
			title="Ask the browser to keep this site's data (IndexedDB + OPFS)"
			onclick={() => void onRequest()}
		>
			{busy ? 'Requesting…' : 'Keep data'}
		</button>
	{/if}
</div>

<style>
	.fe-persist {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-size: 0.78rem;
		line-height: 1.2;
		padding: 3px 8px;
		border-radius: 999px;
		border: 1px solid color-mix(in srgb, currentColor 22%, transparent);
		background: color-mix(in srgb, currentColor 6%, transparent);
		color: inherit;
		max-width: 100%;
		user-select: none;
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
		background: #94a3b8;
	}

	.fe-persist.persistent .fe-persist-dot {
		background: #4ade80;
		box-shadow: 0 0 0 2px color-mix(in srgb, #4ade80 25%, transparent);
	}
	.fe-persist.best-effort .fe-persist-dot {
		background: #fbbf24;
	}
	.fe-persist.unsupported .fe-persist-dot,
	.fe-persist.loading .fe-persist-dot {
		background: #64748b;
	}

	.fe-persist.persistent {
		border-color: color-mix(in srgb, #4ade80 40%, transparent);
	}
	.fe-persist.best-effort {
		border-color: color-mix(in srgb, #fbbf24 45%, transparent);
	}

	.fe-persist-label {
		white-space: nowrap;
		opacity: 0.92;
	}

	.fe-persist-usage {
		opacity: 0.7;
		white-space: nowrap;
	}

	.fe-persist-request {
		appearance: none;
		border: 1px solid color-mix(in srgb, currentColor 28%, transparent);
		background: color-mix(in srgb, currentColor 10%, transparent);
		color: inherit;
		border-radius: 999px;
		padding: 1px 7px;
		font-size: inherit;
		cursor: pointer;
		line-height: 1.35;
	}

	.fe-persist-request:hover:not(:disabled) {
		background: color-mix(in srgb, currentColor 16%, transparent);
	}

	.fe-persist-request:disabled {
		opacity: 0.55;
		cursor: not-allowed;
	}
</style>
