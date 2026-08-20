<script lang="ts">
	import type { ExplorerCapabilities } from '../ui/explorerDriver.js';
	import type { CopyAcrossPath } from '../ui/copyAcross.js';

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
		/** Active driver caps — tooltip lists these for the current connection. */
		capabilities?: ExplorerCapabilities;
		/**
		 * Live copy-across route for the current dual-pane pair.
		 * Shown in the (i) tooltip so the in-app config is explicit.
		 */
		copyOut?: CopyAcrossPath | null;
		copyIn?: CopyAcrossPath | null;
		copyOtherLabel?: string;
		/** Dual pane is off — copy-across is idle. */
		copyIdleNote?: string | null;
		/** Select local, memory, disk, or a profile id (B2 / rclone / monitor) */
		onSelect?: (id: 'local' | 'memory' | 'disk' | string) => void;
		onConfigureB2?: () => void;
		onConfigureRclone?: () => void;
		onConfigureMonitor?: () => void;
		/** Re-pick the native folder when already on disk. */
		onConfigureDisk?: () => void;
		/**
		 * `full` (default): backend dropdown + settings gear.
		 * `settings`: gear + panel only — used for a single module-level host.
		 */
		variant?: 'full' | 'settings';
		/** Hide the gear in `full` variant (host already owns settings). Default true. */
		showSettings?: boolean;
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
		capabilities,
		copyOut = null,
		copyIn = null,
		copyOtherLabel = '',
		copyIdleNote = null,
		onSelect,
		onConfigureB2,
		onConfigureRclone,
		onConfigureMonitor,
		onConfigureDisk,
		variant = 'full',
		showSettings = true
	}: Props = $props();

	const settingsOnly = $derived(variant === 'settings');
	const renderSettings = $derived(settingsOnly || showSettings);

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

	const kindNote = $derived(
		kind === 'memory'
			? 'This tab only — cleared when the tab closes.'
			: kind === 'disk'
				? 'Folder on this computer (browser permission).'
				: kind === 'b2'
					? 'Remote Backblaze B2. Keys stay in this browser.'
					: kind === 'monitor'
						? 'Live folder via monitor (same connection can server-copy).'
						: kind === 'rclone'
							? 'Remote folder via rclone.'
							: 'Saved in this browser (Dexie + OPFS).'
	);

	const fallbackCaps: Record<ConnectionKind, ExplorerCapabilities> = {
		local: {
			supportsTrash: true,
			supportsSoftDelete: true,
			supportsRename: true,
			supportsMove: true,
			supportsCopy: true,
			supportsMkdir: true,
			supportsUpload: false,
			supportsDownload: false,
			supportsSiblingOrder: true
		},
		memory: {
			supportsTrash: false,
			supportsSoftDelete: false,
			supportsRename: true,
			supportsMove: false,
			supportsCopy: false,
			supportsMkdir: false,
			supportsUpload: false,
			supportsDownload: true,
			supportsSiblingOrder: false,
			supportsDragOut: true
		},
		disk: {
			supportsTrash: false,
			supportsSoftDelete: false,
			supportsRename: true,
			supportsMove: true,
			supportsCopy: true,
			supportsMkdir: true,
			supportsUpload: true,
			supportsDownload: true,
			supportsSiblingOrder: false,
			supportsDragOut: true
		},
		b2: {
			supportsTrash: false,
			supportsSoftDelete: false,
			supportsRename: true,
			supportsMove: true,
			supportsCopy: true,
			supportsMkdir: true,
			supportsUpload: true,
			supportsDownload: true,
			supportsSiblingOrder: false
		},
		rclone: {
			supportsTrash: false,
			supportsSoftDelete: false,
			supportsRename: true,
			supportsMove: true,
			supportsCopy: true,
			supportsMkdir: true,
			supportsUpload: true,
			supportsDownload: true,
			supportsSiblingOrder: false
		},
		monitor: {
			supportsTrash: false,
			supportsSoftDelete: false,
			supportsRename: false,
			supportsMove: false,
			supportsCopy: true,
			supportsMkdir: false,
			supportsUpload: true,
			supportsDownload: true,
			supportsSiblingOrder: false,
			supportsDragOut: true
		}
	};

	const capRows = $derived.by(() => {
		const c = capabilities ?? fallbackCaps[kind];
		const rows: { label: string; on: boolean }[] = [
			{ label: 'Trash', on: !!c?.supportsTrash },
			{ label: 'Soft delete', on: !!c?.supportsSoftDelete },
			{ label: 'Rename', on: !!c?.supportsRename },
			{ label: 'Move', on: !!c?.supportsMove },
			{ label: 'Copy', on: !!c?.supportsCopy },
			{ label: 'New folders', on: !!c?.supportsMkdir },
			{ label: 'Select file / drop from PC', on: !!c?.supportsUpload },
			{ label: 'Download', on: !!c?.supportsDownload },
			{ label: 'Drag to reorder', on: !!c?.supportsSiblingOrder },
			{ label: 'Drag files out', on: !!c?.supportsDragOut }
		];
		if (!c) {
			/* No driver yet — still show the list as unavailable rather than empty. */
		}
		return rows;
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

<div
	class="conn-switch"
	class:settings-only={settingsOnly}
	bind:this={rootEl}
	data-testid={settingsOnly ? 'connection-settings' : 'connection-switcher'}
>
	{#if !settingsOnly}
	<div class="conn-select">
		<div class="conn-select-row">
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
		<div class="conn-info-wrap">
			<button
				type="button"
				class="conn-info"
				data-testid="conn-caps-info"
				aria-label={`Features for ${activeLabel}`}
				aria-describedby="conn-caps-tip"
			>
				i
			</button>
			<div class="conn-caps-tip" id="conn-caps-tip" data-testid="conn-caps-tooltip" role="tooltip">
				<p class="caps-title">{activeLabel}</p>
				<p class="caps-note">{kindNote}</p>
				<ul class="caps-list">
					{#each capRows as row (row.label)}
						<li class:on={row.on} data-on={row.on ? '1' : '0'}>
							<span class="caps-mark" aria-hidden="true">{row.on ? '✓' : '–'}</span>
							{row.label}
							<span class="visually-hidden">{row.on ? 'enabled' : 'disabled'}</span>
						</li>
					{/each}
				</ul>
				<div class="copy-path" data-testid="conn-copy-path">
					<p class="caps-title copy-path-title">Copy path</p>
					{#if copyIdleNote}
						<p class="copy-path-summary">{copyIdleNote}</p>
					{:else}
						{#if copyOut}
							<p class="copy-path-dir">To {copyOtherLabel || 'the other pane'}</p>
							<p class="copy-path-summary" data-copy-kind={copyOut.kind}>{copyOut.summary}</p>
							<p class="copy-path-detail">{copyOut.detail}</p>
						{/if}
						{#if copyIn}
							<p class="copy-path-dir">From {copyOtherLabel || 'the other pane'}</p>
							<p class="copy-path-summary" data-copy-kind={copyIn.kind}>{copyIn.summary}</p>
							<p class="copy-path-detail">{copyIn.detail}</p>
						{/if}
					{/if}
					<p class="copy-path-detail">Folder copy only works between local panes.</p>
				</div>
			</div>
		</div>
		</div>

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
	{/if}

	{#if renderSettings}
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
	{/if}
</div>

<style>
	.conn-switch {
		display: contents;
	}
	.conn-switch.settings-only {
		display: block;
	}
	.conn-select {
		position: relative;
		min-width: 10rem;
		max-width: 18rem;
	}
	.conn-select-row {
		display: flex;
		align-items: center;
		gap: 0.3rem;
	}
	.conn-info-wrap {
		position: relative;
		flex-shrink: 0;
	}
	.conn-info {
		width: 1.45rem;
		height: 1.45rem;
		padding: 0;
		border-radius: 999px;
		border: 1px solid var(--line-hairline);
		background: var(--surface-2);
		color: inherit;
		font: inherit;
		font-size: 0.72rem;
		font-weight: 750;
		font-style: italic;
		line-height: 1;
		cursor: help;
	}
	.conn-caps-tip {
		display: none;
		position: absolute;
		z-index: 40;
		top: calc(100% + 6px);
		left: 0;
		width: 18.5rem;
		padding: 0.55rem 0.65rem 0.5rem;
		border-radius: 0;
		border: 1px solid var(--line-hairline);
		background: var(--surface-2);
		color: var(--text-primary);
		box-shadow: 0 10px 28px rgb(var(--scrim-rgb) / 0.45);
		font-size: 0.78rem;
		line-height: 1.35;
	}
	.conn-info-wrap:hover .conn-caps-tip,
	.conn-info-wrap:focus-within .conn-caps-tip {
		display: block;
	}
	.caps-title {
		margin: 0 0 0.15rem;
		font-weight: 700;
		font-size: 0.82rem;
	}
	.caps-note {
		margin: 0 0 0.45rem;
		opacity: 0.75;
		font-size: 0.72rem;
	}
	.caps-list {
		margin: 0;
		padding: 0;
		list-style: none;
		display: grid;
		gap: 0.12rem;
	}
	.caps-list li {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		opacity: 0.45;
	}
	.caps-list li.on {
		opacity: 1;
	}
	.copy-path {
		margin-top: 0.55rem;
		padding-top: 0.45rem;
		border-top: 1px solid var(--line-hairline);
	}
	.copy-path-title {
		margin-bottom: 0.3rem;
	}
	.copy-path-dir {
		margin: 0.35rem 0 0.1rem;
		font-weight: 650;
		font-size: 0.72rem;
		text-transform: uppercase;
		letter-spacing: 0.03em;
		opacity: 0.7;
	}
	.copy-path-summary {
		margin: 0;
		font-weight: 600;
	}
	.copy-path-detail {
		margin: 0.15rem 0 0;
		opacity: 0.75;
		font-size: 0.72rem;
	}
	.caps-mark {
		width: 0.85rem;
		text-align: center;
		color: var(--accent);
		font-weight: 700;
	}
	.caps-list li:not(.on) .caps-mark {
		color: var(--text-muted);
	}
	.visually-hidden {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip: rect(0 0 0 0);
	}
	.conn-trigger,
	.conn-gear,
	.conn-menu button,
	.conn-settings-panel button {
		padding: 0.35rem 0.7rem;
		border-radius: var(--radius-md);
		border: 1px solid var(--line-hairline);
		background: var(--surface-2);
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
		order: 99;
		flex-shrink: 0;
		margin-left: auto;
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
		z-index: 40;
		min-width: 14rem;
		max-width: min(22rem, 90vw);
		padding: 0.35rem;
		border-radius: 0;
		border: 1px solid var(--line-hairline);
		background: var(--surface-2);
		color: var(--text-primary);
		box-shadow: 0 10px 28px rgb(var(--scrim-rgb) / 0.45);
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
		background: rgb(var(--overlay-rgb) / 0.06);
	}
	.conn-menu button.active {
		outline: 2px solid var(--accent);
		outline-offset: 0;
		background: rgb(var(--accent-rgb) / 0.08);
	}
	.conn-sep {
		height: 1px;
		margin: 0.25rem 0.35rem;
		background: var(--line-hairline);
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
