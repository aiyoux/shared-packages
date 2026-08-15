<script lang="ts">
	/** Storage backend kind for the hub connection switcher. */
	export type ConnectionKind = 'local' | 'memory' | 'disk' | 'b2' | 'rclone' | 'monitor';

	export type B2ProfileChip = {
		id: string;
		/** Short button label */
		name: string;
		/** Secondary line / title */
		detail?: string;
	};

	/** Same chip shape as B2; kept as alias for callers wiring rclone/monitor. */
	export type RcloneProfileChip = B2ProfileChip;
	export type MonitorProfileChip = B2ProfileChip;

	interface Props {
		/** Active selection: local | memory | disk | profile id */
		activeId?: string | 'local' | 'memory' | 'disk';
		/**
		 * Which backend is active when `activeId` is a profile id.
		 * Defaults: `local` when activeId is `local`, `memory` when memory,
		 * `disk` when disk, else `b2`.
		 */
		activeKind?: ConnectionKind;
		/** Saved B2 profiles — each becomes a dropdown option */
		profiles?: B2ProfileChip[];
		/** Saved rclone profiles */
		rcloneProfiles?: RcloneProfileChip[];
		/** Saved monitor profiles */
		monitorProfiles?: MonitorProfileChip[];
		/** True while a connect attempt is in flight — disables controls */
		busy?: boolean;
		/**
		 * Feature gate for rclone (`feature:rcloneFiles`).
		 * When false, rclone UI is hidden; local + B2 remain.
		 */
		showRclone?: boolean;
		/** Feature gate for monitor (`feature:monitorFiles`). */
		showMonitor?: boolean;
		/** Show In memory option (tab-ephemeral VFS). Default true. */
		showMemory?: boolean;
		/** Select local, memory, disk, or a profile id (B2 / rclone / monitor) */
		onSelect?: (id: 'local' | 'memory' | 'disk' | string) => void;
		onConfigureB2?: () => void;
		onConfigureRclone?: () => void;
		onConfigureMonitor?: () => void;
		/** Re-pick the native folder when already on disk. */
		onConfigureDisk?: () => void;
	}

	let {
		activeId = 'local',
		activeKind,
		profiles = [],
		rcloneProfiles = [],
		monitorProfiles = [],
		busy = false,
		showRclone = true,
		showMonitor = true,
		showMemory = true,
		onSelect,
		onConfigureB2,
		onConfigureRclone,
		onConfigureMonitor,
		onConfigureDisk
	}: Props = $props();

	let menuOpen = $state(false);
	let settingsOpen = $state(false);
	let rootEl = $state<HTMLDivElement | null>(null);

	/** Resolved kind for active option highlighting (back-compat when activeKind omitted). */
	const kind = $derived<ConnectionKind>(
		activeKind ??
			(activeId === 'local'
				? 'local'
				: activeId === 'memory'
					? 'memory'
					: activeId === 'disk'
						? 'disk'
						: 'b2')
	);

	const activeLabel = $derived.by(() => {
		if (kind === 'local') return 'Browser files';
		if (kind === 'memory') return 'In memory';
		if (kind === 'disk') return 'This computer';
		if (kind === 'b2') {
			const p = profiles.find((x) => x.id === activeId);
			return p ? `B2 · ${p.name}` : 'Backblaze B2';
		}
		if (kind === 'rclone') {
			const p = rcloneProfiles.find((x) => x.id === activeId);
			return p ? `rclone · ${p.name}` : 'rclone';
		}
		if (kind === 'monitor') {
			const p = monitorProfiles.find((x) => x.id === activeId);
			return p ? `Monitor · ${p.name}` : 'Monitor';
		}
		return 'Browser files';
	});

	function select(id: 'local' | 'memory' | 'disk' | string) {
		if (busy) return;
		menuOpen = false;
		settingsOpen = false;
		onSelect?.(id);
	}

	function configure(which: 'b2' | 'rclone' | 'monitor' | 'disk') {
		if (busy) return;
		settingsOpen = false;
		menuOpen = false;
		if (which === 'b2') onConfigureB2?.();
		else if (which === 'rclone') onConfigureRclone?.();
		else if (which === 'monitor') onConfigureMonitor?.();
		else onConfigureDisk?.();
	}

	function toggleMenu() {
		if (busy) return;
		menuOpen = !menuOpen;
		if (menuOpen) settingsOpen = false;
	}

	function toggleSettings() {
		if (busy) return;
		settingsOpen = !settingsOpen;
		if (settingsOpen) menuOpen = false;
	}

	function onDocPointer(e: PointerEvent) {
		if (!rootEl) return;
		if (e.target instanceof Node && rootEl.contains(e.target)) return;
		menuOpen = false;
		settingsOpen = false;
	}

	function onDocKey(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			menuOpen = false;
			settingsOpen = false;
		}
	}

	$effect(() => {
		if (typeof document === 'undefined') return;
		document.addEventListener('pointerdown', onDocPointer);
		document.addEventListener('keydown', onDocKey);
		return () => {
			document.removeEventListener('pointerdown', onDocPointer);
			document.removeEventListener('keydown', onDocKey);
		};
	});
</script>

<div class="conn-switch" bind:this={rootEl} data-testid="connection-switcher">
	<div class="conn-select">
		<button
			type="button"
			class="conn-trigger"
			data-testid="conn-trigger"
			disabled={busy}
			aria-haspopup="listbox"
			aria-expanded={menuOpen}
			aria-label="Storage location"
			onclick={toggleMenu}
		>
			<span class="conn-trigger-label">{activeLabel}</span>
			<span class="conn-caret" aria-hidden="true">▾</span>
		</button>

		<div class="conn-menu" class:open={menuOpen} data-testid="conn-menu" role="listbox">
			<button
				type="button"
				role="option"
				class:active={kind === 'disk'}
				aria-selected={kind === 'disk'}
				data-testid="conn-disk"
				disabled={busy}
				title="Browse a folder on this computer. The browser will ask permission (Chrome / Edge)."
				onclick={() => select('disk')}
			>
				This computer
			</button>
			<button
				type="button"
				role="option"
				class:active={kind === 'local'}
				aria-selected={kind === 'local'}
				data-testid="conn-local"
				disabled={busy}
				onclick={() => select('local')}
			>
				Browser files
			</button>
			{#if showMemory}
				<button
					type="button"
					role="option"
					class:active={kind === 'memory'}
					aria-selected={kind === 'memory'}
					data-testid="conn-memory"
					disabled={busy}
					title="Tab-only storage — cleared when this tab closes."
					onclick={() => select('memory')}
				>
					In memory
				</button>
			{/if}

			{#if profiles.length || (showMonitor && monitorProfiles.length) || (showRclone && rcloneProfiles.length)}
				<div class="conn-sep" role="separator"></div>
			{/if}

			{#each profiles as p (p.id)}
				<button
					type="button"
					role="option"
					class:active={kind === 'b2' && activeId === p.id}
					aria-selected={kind === 'b2' && activeId === p.id}
					data-testid="conn-b2-profile"
					data-profile-id={p.id}
					title={p.detail ? `${p.name} — ${p.detail}` : p.name}
					disabled={busy}
					onclick={() => select(p.id)}
				>
					<span class="chip-name">B2 · {p.name}</span>
					{#if p.detail}
						<span class="chip-detail">{p.detail}</span>
					{/if}
				</button>
			{/each}

			{#if showMonitor}
				{#each monitorProfiles as p (p.id)}
					<button
						type="button"
						role="option"
						class:active={kind === 'monitor' && activeId === p.id}
						aria-selected={kind === 'monitor' && activeId === p.id}
						data-testid="conn-monitor-profile"
						data-profile-id={p.id}
						title={p.detail ? `${p.name} — ${p.detail}` : p.name}
						disabled={busy}
						onclick={() => select(p.id)}
					>
						<span class="chip-name">Monitor · {p.name}</span>
						{#if p.detail}
							<span class="chip-detail">{p.detail}</span>
						{/if}
					</button>
				{/each}
			{/if}

			{#if showRclone}
				{#each rcloneProfiles as p (p.id)}
					<button
						type="button"
						role="option"
						class:active={kind === 'rclone' && activeId === p.id}
						aria-selected={kind === 'rclone' && activeId === p.id}
						data-testid="conn-rclone-profile"
						data-profile-id={p.id}
						title={p.detail ? `${p.name} — ${p.detail}` : p.name}
						disabled={busy}
						onclick={() => select(p.id)}
					>
						<span class="chip-name">rclone · {p.name}</span>
						{#if p.detail}
							<span class="chip-detail">{p.detail}</span>
						{/if}
					</button>
				{/each}
			{/if}
		</div>
	</div>

	<div class="conn-settings-wrap">
	<button
		type="button"
		class="conn-gear"
		data-testid="conn-settings"
		disabled={busy}
		aria-haspopup="true"
		aria-expanded={settingsOpen}
		title="Configure connections"
		aria-label="Configure connections"
		onclick={toggleSettings}
	>
		<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
			<path
				fill="currentColor"
				d="M19.14 12.94c.04-.31.06-.63.06-.94s-.02-.63-.06-.94l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7.03 7.03 0 0 0-1.63-.94l-.36-2.54A.5.5 0 0 0 13.9 2h-3.8a.5.5 0 0 0-.49.42l-.36 2.54c-.59.22-1.14.54-1.63.94l-2.39-.96a.5.5 0 0 0-.6.22L2.71 8.48a.5.5 0 0 0 .12.64l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94L2.83 14.16a.5.5 0 0 0-.12.64l1.92 3.32c.13.22.4.31.64.22l2.39-.96c.49.4 1.04.72 1.63.94l.36 2.54c.05.24.25.42.49.42h3.8c.24 0 .44-.18.49-.42l.36-2.54c.59-.22 1.14-.54 1.63-.94l2.39.96c.24.09.51 0 .64-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.03-1.58ZM12 15.5A3.5 3.5 0 1 1 12 8.5a3.5 3.5 0 0 1 0 7Z"
			/>
		</svg>
	</button>

	<div
		class="conn-settings-panel"
		class:open={settingsOpen}
		data-testid="conn-settings-panel"
		role="menu"
	>
		<p class="settings-title">Connections</p>
		<button
			type="button"
			role="menuitem"
			class="ghost"
			data-testid="conn-disk-config"
			disabled={busy}
			onclick={() => configure('disk')}
		>
			{kind === 'disk' ? 'Change computer folder' : 'Choose computer folder'}
		</button>
		<button
			type="button"
			role="menuitem"
			class="ghost"
			data-testid="conn-b2-config"
			disabled={busy}
			onclick={() => configure('b2')}
		>
			{profiles.length ? 'Manage B2' : 'B2 settings'}
		</button>
		{#if profiles.length === 0}
			<button
				type="button"
				role="menuitem"
				data-testid="conn-b2"
				disabled={busy}
				onclick={() => configure('b2')}
			>
				Add Backblaze B2
			</button>
		{/if}
		{#if showMonitor}
			<button
				type="button"
				role="menuitem"
				class="ghost"
				data-testid="conn-monitor-config"
				disabled={busy}
				onclick={() => configure('monitor')}
			>
				{monitorProfiles.length ? 'Manage monitor' : 'Monitor settings'}
			</button>
			{#if monitorProfiles.length === 0}
				<button
					type="button"
					role="menuitem"
					data-testid="conn-monitor"
					disabled={busy}
					onclick={() => configure('monitor')}
				>
					Add monitor
				</button>
			{/if}
		{/if}
		{#if showRclone}
			<button
				type="button"
				role="menuitem"
				class="ghost"
				data-testid="conn-rclone-config"
				disabled={busy}
				onclick={() => configure('rclone')}
			>
				{rcloneProfiles.length ? 'Manage rclone' : 'rclone settings'}
			</button>
			{#if rcloneProfiles.length === 0}
				<button
					type="button"
					role="menuitem"
					data-testid="conn-rclone"
					disabled={busy}
					onclick={() => configure('rclone')}
				>
					Add rclone
				</button>
			{/if}
		{/if}
	</div>
	</div>
</div>

<style>
	.conn-switch {
		display: contents;
	}
	.conn-select {
		position: relative;
		min-width: 10rem;
		max-width: 16rem;
	}
	.conn-trigger,
	.conn-gear,
	.conn-menu button,
	.conn-settings-panel button {
		padding: 0.35rem 0.7rem;
		border-radius: 8px;
		border: 1px solid var(--border, #334155);
		background: var(--surface, #1e293b);
		color: inherit;
		cursor: pointer;
		font-size: 0.9rem;
		text-align: left;
		line-height: 1.2;
		font-family: inherit;
	}
	.conn-trigger {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		width: 100%;
		min-height: 2rem;
	}
	.conn-trigger-label {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-weight: 600;
	}
	.conn-caret {
		opacity: 0.7;
		font-size: 0.75rem;
	}
	.conn-settings-wrap {
		position: relative;
		margin-left: auto;
		order: 99;
		flex-shrink: 0;
	}
	.conn-gear {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		padding: 0.35rem;
		width: 2rem;
		height: 2rem;
	}
	.conn-trigger:disabled,
	.conn-gear:disabled,
	.conn-menu button:disabled,
	.conn-settings-panel button:disabled {
		opacity: 0.55;
		cursor: wait;
	}
	.conn-menu,
	.conn-settings-panel {
		display: none;
		position: absolute;
		z-index: 30;
		min-width: 14rem;
		max-width: min(22rem, 90vw);
		padding: 0.35rem;
		border-radius: 10px;
		border: 1px solid var(--border, #334155);
		background: var(--bg-card, #1e293b);
		box-shadow: 0 10px 28px rgba(0, 0, 0, 0.35);
	}
	.conn-menu.open,
	.conn-settings-panel.open {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
	}
	.conn-menu {
		top: calc(100% + 4px);
		left: 0;
	}
	.conn-settings-panel {
		top: calc(100% + 4px);
		right: 0;
	}
	.conn-menu button,
	.conn-settings-panel button {
		width: 100%;
		background: transparent;
		border-color: transparent;
	}
	.conn-menu button:hover,
	.conn-settings-panel button:hover {
		background: rgba(255, 255, 255, 0.06);
	}
	.conn-menu button.active {
		outline: 2px solid #38bdf8;
		outline-offset: 0;
	}
	.conn-sep {
		height: 1px;
		margin: 0.25rem 0.35rem;
		background: var(--border, #334155);
	}
	.settings-title {
		margin: 0.15rem 0.45rem 0.25rem;
		font-size: 0.72rem;
		font-weight: 650;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		opacity: 0.65;
	}
	.chip-name {
		display: block;
		font-weight: 600;
	}
	.chip-detail {
		display: block;
		font-size: 0.7rem;
		opacity: 0.75;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
</style>
