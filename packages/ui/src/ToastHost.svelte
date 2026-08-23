<script lang="ts">
	/**
	 * Renders the active toast stack centered on screen.
	 * Mount once at the app root. Toasts are pushed via the `toast` API
	 * from anywhere in the app.
	 */
	import { getToasts, dismiss, type Toast } from './toast-state.svelte.js';

	const toasts = $derived(getToasts());

	const ICONS: Record<Toast['kind'], string> = {
		info: 'info',
		success: 'check-circle',
		error: 'alert-circle',
		warning: 'alert-triangle'
	};

	// Schedule auto-dismiss for any toast with a positive duration.
	// Runs whenever the toast list changes; each toast's timer fires once.
	const scheduled = new Set<number>();
	$effect(() => {
		for (const t of toasts) {
			if (t.duration > 0 && !scheduled.has(t.id)) {
				scheduled.add(t.id);
				setTimeout(() => {
					dismiss(t.id);
					scheduled.delete(t.id);
				}, t.duration);
			}
		}
	});
</script>

{#snippet toastIcon(name: string)}
	{#if name === 'info'}
		<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>
	{:else if name === 'check-circle'}
		<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="m9 11 3 3L22 4"/></svg>
	{:else if name === 'alert-circle'}
		<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg>
	{:else if name === 'alert-triangle'}
		<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>
	{/if}
{/snippet}

{#if toasts.length > 0}
	<div class="toast-host" data-testid="toast-host" role="region" aria-label="Notifications" aria-live="polite">
		{#each toasts as t (t.id)}
			<div
				class="toast toast-{t.kind}"
				data-testid="toast"
				data-toast-id={t.id}
				data-kind={t.kind}
				role={t.kind === 'error' ? 'alert' : 'status'}
			>
				<span class="toast-icon" aria-hidden="true">
					{@render toastIcon(ICONS[t.kind])}
				</span>
				<span class="toast-message">{t.message}</span>
				<button
					type="button"
					class="toast-close"
					data-testid="toast-close"
					aria-label="Dismiss notification"
					onclick={() => dismiss(t.id)}
				>
					<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
				</button>
			</div>
		{/each}
	</div>
{/if}

<style>
	.toast-host {
		position: fixed;
		top: 50%;
		left: 50%;
		transform: translate(-50%, -50%);
		z-index: 9999;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		align-items: center;
		pointer-events: none;
		max-width: min(440px, calc(100vw - 2rem));
	}

	.toast {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		padding: 0.7rem 0.9rem;
		border-radius: var(--radius-md, 6px);
		background: var(--surface-2, #1e293b);
		border: 1px solid var(--line-hairline, #334155);
		color: var(--text-primary, #f1f5f9);
		font-size: 0.875rem;
		box-shadow: 0 8px 24px rgb(var(--scrim-rgb, 0 0 0) / 0.4);
		pointer-events: auto;
		animation: toast-in 0.18s ease-out;
	}

	@keyframes toast-in {
		from {
			opacity: 0;
			transform: scale(0.96) translateY(-4px);
		}
		to {
			opacity: 1;
			transform: scale(1) translateY(0);
		}
	}

	.toast-icon {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
	}

	.toast-info .toast-icon {
		color: var(--accent, #38bdf8);
	}
	.toast-success .toast-icon {
		color: var(--cat-green, #22c55e);
	}
	.toast-error .toast-icon {
		color: var(--cat-red, #ef4444);
	}
	.toast-warning .toast-icon {
		color: var(--cat-amber, #f59e0b);
	}

	.toast-message {
		flex: 1;
		min-width: 0;
		line-height: 1.4;
	}

	.toast-close {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
		width: 24px;
		height: 24px;
		border: 0;
		background: none;
		color: var(--text-muted, #94a3b8);
		cursor: pointer;
		border-radius: var(--radius-sm, 3px);
		padding: 0;
		transition: color 0.12s ease, background 0.12s ease;
	}
	.toast-close:hover {
		color: var(--text-primary, #f1f5f9);
		background: rgb(var(--overlay-rgb, 255 255 255) / 0.1);
	}
</style>
