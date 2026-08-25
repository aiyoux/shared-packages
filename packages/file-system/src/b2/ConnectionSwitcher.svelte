<script lang="ts">
	import type { ExplorerCapabilities } from '../ui/explorerDriver.js';
	import type { CopyAcrossPath } from '../ui/copyAcross.js';
	import { capabilityRows, connectionKindNote } from '../ui/connectionInfo.js';
	import FeIcon from '../ui/FeIcon.svelte';

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
		/** Gear opens the combined B2 / rclone / monitor connections popup. */
		onConfigure?: () => void;
		/**
		 * `full` (default): backend dropdown + settings gear.
		 * `settings`: gear only — used for a single module-level host.
		 */
		variant?: 'full' | 'settings';
		/** Hide the gear in `full` variant (host already owns settings). Default true. */
		showSettings?: boolean;
		/** Square chip flush to a parent corner stack. */
		flush?: boolean;
		/**
		 * Per-switcher (i) tooltip. Hub Files hides this and uses the combined
		 * pair-info icon next to Single/Dual instead.
		 */
		showInfo?: boolean;
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
		onConfigure,
		variant = 'full',
		showSettings = true,
		flush = false,
		showInfo = true
	}: Props = $props();

	const settingsOnly = $derived(variant === 'settings');
	const renderSettings = $derived(settingsOnly || showSettings);

	let menuOpen = $state(false);
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

	const kindNote = $derived(connectionKindNote(kind));

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

	const capRows = $derived(capabilityRows(capabilities ?? fallbackCaps[kind]));

	function select(id: 'local' | 'memory' | 'disk' | string) {
		if (busy) return;
		menuOpen = false;
		onSelect?.(id);
	}

	function toggleMenu() {
		if (busy) return;
		menuOpen = !menuOpen;
	}

	function onDocPointer(e: PointerEvent) {
		if (!rootEl) return;
		if (e.target instanceof Node && rootEl.contains(e.target)) return;
		menuOpen = false;
	}

	function onDocKey(e: KeyboardEvent) {
		if (e.key === 'Escape') menuOpen = false;
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
	class:flush
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
			<span class="conn-caret"><FeIcon name="chevron-down" size={14} /></span>
		</button>
		{#if showInfo}
		<div class="conn-info-wrap">
			<button
				type="button"
				class="conn-info"
				data-testid="conn-caps-info"
				aria-label={`Features for ${activeLabel}`}
				aria-describedby="conn-caps-tip"
			>
				<FeIcon name="info" size={12} />
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
					<p class="copy-path-detail">
						Folder copy walks the tree and copies each item. The destination must support new
						folders (not In memory).
					</p>
				</div>
			</div>
		</div>
		{/if}
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
		aria-haspopup="dialog"
		title="Configure connections"
		aria-label="Configure connections"
		onclick={() => {
			if (busy) return;
			onConfigure?.();
		}}
	>
		<FeIcon name="settings" size={15} />
	</button>
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
	.conn-switch.flush {
		display: block;
	}
	.conn-switch.flush .conn-settings-wrap {
		margin-left: 0;
	}
	.conn-switch.flush .conn-gear {
		width: var(--control-h, 2rem);
		height: var(--control-h, 2rem);
		padding: 0;
		border: 1px solid var(--line-strong);
		border-top: 0;
		border-right: 0;
		background: var(--surface-ground);
		color: var(--text-secondary);
	}
	.conn-switch.flush .conn-gear:hover:not(:disabled) {
		border-color: var(--accent);
		color: var(--accent);
		background: var(--accent-glow);
	}
	.conn-select {
		position: relative;
		min-width: 0;
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
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.45rem;
		height: 1.45rem;
		padding: 0;
		border: 0;
		background: transparent;
		color: var(--text-secondary);
		cursor: help;
		transition: background var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease);
	}
	.conn-info:hover {
		background: rgb(var(--overlay-rgb) / 0.06);
		color: var(--text-primary);
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
	.conn-menu button {
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
		gap: 0.35rem;
		width: auto;
		max-width: 100%;
		min-height: var(--control-h-sm, 1.75rem);
		padding: 0.15rem 0.35rem;
		border: 0;
		border-radius: var(--radius-md);
		background: transparent;
		color: inherit;
		cursor: pointer;
		font-size: 0.85rem;
		text-align: left;
		line-height: 1.2;
		font-family: inherit;
	}
	.conn-trigger:hover:not(:disabled) {
		background: rgb(var(--overlay-rgb) / 0.06);
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
		display: inline-flex;
		opacity: 0.7;
		color: var(--text-muted);
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
		border: 0;
		background: transparent;
		color: var(--text-secondary);
		cursor: pointer;
		transition: background var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease);
	}
	.conn-gear:hover:not(:disabled) {
		background: rgb(var(--overlay-rgb) / 0.06);
		color: var(--text-primary);
	}
	.conn-trigger:disabled,
	.conn-gear:disabled,
	.conn-menu button:disabled {
		opacity: 0.55;
		cursor: wait;
	}
	.conn-menu {
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
		top: calc(100% + 4px);
		left: 0;
	}
	.conn-menu.open {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
	}
	.conn-menu button {
		width: 100%;
		background: transparent;
		border-color: transparent;
		border-radius: var(--radius-sm, 3px);
		transition: background var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease);
	}
	.conn-menu button:hover:not(:disabled) {
		background: rgb(var(--overlay-rgb) / 0.12);
		color: var(--text-primary);
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
