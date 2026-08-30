<script lang="ts">
	import { appClipboard } from './clipboardStore.svelte.js';
	import type { ClipboardItem } from './types.js';

	let { onClose }: { onClose?: () => void } = $props();

	let copiedId = $state<string | null>(null);

	function formatTime(ts: number): string {
		const diff = Date.now() - ts;
		if (diff < 30_000) return 'Just now';
		if (diff < 60_000) return '1m ago';
		const mins = Math.floor(diff / 60_000);
		if (mins < 60) return `${mins}m ago`;
		const hours = Math.floor(mins / 60);
		if (hours < 24) return `${hours}h ago`;
		return new Date(ts).toLocaleDateString();
	}

	function typeBadge(type: string): { label: string; kind: string } {
		if (type.includes('sketcher')) return { label: 'Sketcher', kind: 'sketcher' };
		if (type.includes('text') || type === 'text/plain') return { label: 'Text', kind: 'text' };
		if (type.includes('image')) return { label: 'Image', kind: 'image' };
		if (type.includes('json')) return { label: 'JSON', kind: 'json' };
		return { label: type.split('/').pop() || type, kind: 'custom' };
	}

	async function handleCopySystem(item: ClipboardItem) {
		const ok = await appClipboard.copyToSystem(item);
		if (ok) {
			copiedId = item.id;
			setTimeout(() => {
				if (copiedId === item.id) copiedId = null;
			}, 1500);
		}
	}
</script>

<div class="cb-popup" data-testid="clipboard-popup">
	<header class="cb-header">
		<div class="cb-title-row">
			<span class="cb-title">App Clipboard</span>
			<span class="cb-count" data-testid="clipboard-count">{appClipboard.items.length}</span>
		</div>
		<div class="cb-header-actions">
			{#if appClipboard.items.length > 0}
				<button
					type="button"
					class="cb-clear-btn"
					data-testid="clipboard-clear"
					onclick={() => appClipboard.clear()}
					title="Clear clipboard history"
				>
					Clear
				</button>
			{/if}
			{#if onClose}
				<button
					type="button"
					class="cb-close-btn"
					data-testid="clipboard-close"
					onclick={onClose}
					title="Close"
					aria-label="Close clipboard"
				>
					<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
				</button>
			{/if}
		</div>
	</header>

	<div class="cb-sync-banner">
		<label class="cb-sync-label">
			<input
				type="checkbox"
				class="cb-sync-check"
				data-testid="clipboard-sync-toggle"
				checked={appClipboard.syncWithSystem}
				onchange={(e) => appClipboard.setSyncWithSystem((e.currentTarget as HTMLInputElement).checked)}
			/>
			<span class="cb-sync-text">Sync with system clipboard</span>
		</label>
		{#if appClipboard.syncWithSystem}
			<button
				type="button"
				class="cb-refresh-btn"
				data-testid="clipboard-system-refresh"
				disabled={appClipboard.isReadingSystem}
				onclick={() => void appClipboard.readFromSystem()}
				title="Read latest from system clipboard"
			>
				{appClipboard.isReadingSystem ? 'Reading…' : 'Read system'}
			</button>
		{/if}
	</div>

	{#if appClipboard.systemReadError}
		<div class="cb-error" role="alert">
			{appClipboard.systemReadError}
		</div>
	{/if}

	<div class="cb-body">
		{#if appClipboard.items.length === 0}
			<div class="cb-empty" data-testid="clipboard-empty">
				<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="cb-empty-icon"><rect width="8" height="4" x="8" y="2" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/></svg>
				<p class="cb-empty-title">Clipboard is empty</p>
				<p class="cb-empty-hint">Copy elements using Select in Sketcher or text across tools to see them here.</p>
			</div>
		{:else}
			<ul class="cb-list" data-testid="clipboard-list">
				{#each appClipboard.items as item (item.id)}
					{@const badge = typeBadge(item.type)}
					<li class="cb-item" data-testid="clipboard-item" data-item-type={item.type}>
						<div class="cb-item-header">
							<span class="cb-badge {badge.kind}">{badge.label}</span>
							<span class="cb-item-label">{item.label}</span>
							<span class="cb-item-time">{formatTime(item.createdAt)}</span>
						</div>

						{#if item.textPreview}
							<div class="cb-item-preview">
								{item.textPreview}
							</div>
						{/if}

						<div class="cb-item-actions">
							<button
								type="button"
								class="cb-item-btn"
								data-testid="clipboard-item-copy"
								onclick={() => void handleCopySystem(item)}
							>
								{#if copiedId === item.id}
									<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
									Copied
								{:else}
									<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>
									Copy to OS
								{/if}
							</button>
							<button
								type="button"
								class="cb-item-btn cb-delete"
								data-testid="clipboard-item-delete"
								onclick={() => appClipboard.removeItem(item.id)}
								title="Delete item"
								aria-label="Delete item from clipboard"
							>
								<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
							</button>
						</div>
					</li>
				{/each}
			</ul>
		{/if}
	</div>
</div>

<style>
	.cb-popup {
		box-sizing: border-box;
		display: flex;
		flex-direction: column;
		width: 320px;
		max-width: calc(100vw - 24px);
		max-height: 480px;
		background: var(--surface-1, #181c24);
		border: 1px solid var(--line-strong, #334155);
		border-radius: 8px;
		box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
		color: var(--text-primary, #f1f5f9);
		font-family: inherit;
		overflow: hidden;
		user-select: none;
	}

	.cb-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 10px 12px;
		background: var(--surface-2, #1e293b);
		border-bottom: 1px solid var(--line-hairline, rgba(255, 255, 255, 0.08));
	}

	.cb-title-row {
		display: flex;
		align-items: center;
		gap: 6px;
	}

	.cb-title {
		font-size: 12px;
		font-weight: 600;
		letter-spacing: -0.01em;
	}

	.cb-count {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		padding: 1px 6px;
		border-radius: 10px;
		background: var(--surface-3, #334155);
		color: var(--text-muted, #94a3b8);
		font-size: 10px;
		font-weight: 600;
	}

	.cb-header-actions {
		display: flex;
		align-items: center;
		gap: 6px;
	}

	.cb-clear-btn {
		background: transparent;
		border: 1px solid var(--line-hairline, rgba(255, 255, 255, 0.1));
		border-radius: 4px;
		color: var(--text-muted, #94a3b8);
		font-size: 11px;
		padding: 2px 8px;
		cursor: pointer;
		transition: all 0.15s ease;
	}

	.cb-clear-btn:hover {
		background: rgba(255, 255, 255, 0.08);
		color: var(--text-primary, #fff);
	}

	.cb-close-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 22px;
		height: 22px;
		border: none;
		border-radius: 4px;
		background: transparent;
		color: var(--text-muted, #94a3b8);
		cursor: pointer;
		padding: 0;
	}

	.cb-close-btn:hover {
		background: rgba(255, 255, 255, 0.08);
		color: var(--text-primary, #fff);
	}

	.cb-sync-banner {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 8px 12px;
		background: color-mix(in srgb, var(--accent, #38bdf8) 6%, transparent);
		border-bottom: 1px solid var(--line-hairline, rgba(255, 255, 255, 0.08));
		font-size: 11px;
	}

	.cb-sync-label {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		cursor: pointer;
		color: var(--text-secondary, #cbd5e1);
	}

	.cb-sync-check {
		cursor: pointer;
		accent-color: var(--accent, #38bdf8);
	}

	.cb-refresh-btn {
		background: transparent;
		border: 1px solid color-mix(in srgb, var(--accent, #38bdf8) 30%, transparent);
		border-radius: 4px;
		color: var(--accent, #38bdf8);
		font-size: 10px;
		padding: 2px 6px;
		cursor: pointer;
	}

	.cb-refresh-btn:hover:not(:disabled) {
		background: color-mix(in srgb, var(--accent, #38bdf8) 15%, transparent);
	}

	.cb-refresh-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.cb-error {
		padding: 6px 12px;
		background: rgba(239, 68, 68, 0.15);
		color: #f87171;
		font-size: 11px;
		border-bottom: 1px solid rgba(239, 68, 68, 0.25);
	}

	.cb-body {
		flex: 1 1 auto;
		overflow-y: auto;
		padding: 8px;
		max-height: 360px;
	}

	.cb-empty {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		padding: 32px 16px;
		text-align: center;
		color: var(--text-muted, #64748b);
	}

	.cb-empty-icon {
		margin-bottom: 8px;
		opacity: 0.5;
	}

	.cb-empty-title {
		font-size: 12px;
		font-weight: 600;
		color: var(--text-secondary, #94a3b8);
		margin: 0 0 4px;
	}

	.cb-empty-hint {
		font-size: 11px;
		line-height: 1.4;
		margin: 0;
	}

	.cb-list {
		list-style: none;
		padding: 0;
		margin: 0;
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.cb-item {
		display: flex;
		flex-direction: column;
		gap: 4px;
		padding: 8px 10px;
		background: var(--surface-2, #1e293b);
		border: 1px solid var(--line-hairline, rgba(255, 255, 255, 0.05));
		border-radius: 6px;
		transition: border-color 0.15s ease;
	}

	.cb-item:hover {
		border-color: color-mix(in srgb, var(--accent, #38bdf8) 40%, transparent);
	}

	.cb-item-header {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 11px;
	}

	.cb-badge {
		font-size: 9px;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		padding: 1px 5px;
		border-radius: 3px;
		background: var(--surface-3, #334155);
		color: var(--text-secondary, #cbd5e1);
	}

	.cb-badge.sketcher {
		background: rgba(168, 85, 247, 0.2);
		color: #c084fc;
		border: 1px solid rgba(168, 85, 247, 0.3);
	}

	.cb-badge.text {
		background: rgba(56, 189, 248, 0.2);
		color: #38bdf8;
		border: 1px solid rgba(56, 189, 248, 0.3);
	}

	.cb-badge.image {
		background: rgba(34, 197, 94, 0.2);
		color: #4ade80;
		border: 1px solid rgba(34, 197, 94, 0.3);
	}

	.cb-item-label {
		font-weight: 500;
		color: var(--text-primary, #f1f5f9);
		flex: 1 1 auto;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.cb-item-time {
		font-size: 10px;
		color: var(--text-muted, #64748b);
		flex-shrink: 0;
	}

	.cb-item-preview {
		font-size: 10px;
		font-family: var(--font-mono, monospace);
		color: var(--text-muted, #94a3b8);
		background: rgba(0, 0, 0, 0.25);
		padding: 4px 6px;
		border-radius: 4px;
		max-height: 48px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: pre-wrap;
		word-break: break-word;
	}

	.cb-item-actions {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: 6px;
		margin-top: 2px;
	}

	.cb-item-btn {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		font-size: 10px;
		padding: 2px 6px;
		border-radius: 3px;
		background: var(--surface-3, #334155);
		border: 1px solid transparent;
		color: var(--text-secondary, #cbd5e1);
		cursor: pointer;
		transition: all 0.15s ease;
	}

	.cb-item-btn:hover {
		background: var(--surface-hover, #475569);
		color: var(--text-primary, #fff);
	}

	.cb-item-btn.cb-delete:hover {
		background: rgba(239, 68, 68, 0.2);
		color: #f87171;
	}
</style>
