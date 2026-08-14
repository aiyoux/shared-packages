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
		/** Saved B2 profiles — each becomes a join button */
		profiles?: B2ProfileChip[];
		/** Saved rclone profiles — each becomes a join button */
		rcloneProfiles?: RcloneProfileChip[];
		/** Saved monitor profiles */
		monitorProfiles?: MonitorProfileChip[];
		/** True while a connect attempt is in flight — disables all chips */
		busy?: boolean;
		/**
		 * Feature gate for rclone chips (`feature:rcloneFiles`).
		 * When false, rclone UI is hidden; local + B2 remain.
		 */
		showRclone?: boolean;
		/** Feature gate for monitor chips (`feature:monitorFiles`). */
		showMonitor?: boolean;
		/** Show In memory chip (tab-ephemeral VFS). Default true. */
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

	/** Resolved kind for active chip highlighting (back-compat when activeKind omitted). */
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

	function select(id: 'local' | 'memory' | 'disk' | string) {
		if (busy) return;
		onSelect?.(id);
	}
</script>

<div class="conn-switch" data-testid="connection-switcher" role="group" aria-label="Storage connection">
	<button
		type="button"
		class:active={kind === 'local'}
		data-testid="conn-local"
		disabled={busy}
		onclick={() => select('local')}
	>
		This browser
	</button>

	{#if showMemory}
		<button
			type="button"
			class:active={kind === 'memory'}
			data-testid="conn-memory"
			disabled={busy}
			title="Tab-only storage — cleared when this tab closes. Use Dual pane + Copy across to promote into This browser."
			onclick={() => select('memory')}
		>
			In memory
		</button>
	{/if}

	<button
		type="button"
		class:active={kind === 'disk'}
		data-testid="conn-disk"
		disabled={busy}
		title="Browse a folder on this computer. The browser will ask permission (Chrome / Edge)."
		onclick={() => select('disk')}
	>
		This computer
	</button>
	<button
		type="button"
		class="ghost"
		data-testid="conn-disk-config"
		disabled={busy}
		onclick={(e) => {
			e.preventDefault();
			e.stopPropagation();
			if (busy) return;
			onConfigureDisk?.();
		}}
	>
		{kind === 'disk' ? 'Change folder' : 'Choose folder'}
	</button>

	{#each profiles as p (p.id)}
		<button
			type="button"
			class:active={kind === 'b2' && activeId === p.id}
			data-testid="conn-b2-profile"
			data-profile-id={p.id}
			title={p.detail ? `${p.name} — ${p.detail}` : p.name}
			disabled={busy}
			onclick={() => select(p.id)}
		>
			<span class="chip-name">{p.name}</span>
			{#if p.detail}
				<span class="chip-detail">{p.detail}</span>
			{/if}
		</button>
	{/each}

	{#if profiles.length === 0}
		<!-- No saved B2 profiles yet — one control to open settings / prompt connect -->
		<button
			type="button"
			class:active={kind === 'b2'}
			data-testid="conn-b2"
			disabled={busy}
			onclick={() => {
				if (busy) return;
				onConfigureB2?.();
			}}
		>
			Backblaze B2
		</button>
	{/if}

	<button
		type="button"
		class="ghost"
		data-testid="conn-b2-config"
		disabled={busy}
		onclick={(e) => {
			e.preventDefault();
			e.stopPropagation();
			if (busy) return;
			onConfigureB2?.();
		}}
	>
		{profiles.length ? 'Manage B2' : 'B2 settings'}
	</button>

	{#if showRclone}
		{#each rcloneProfiles as p (p.id)}
			<button
				type="button"
				class:active={kind === 'rclone' && activeId === p.id}
				data-testid="conn-rclone-profile"
				data-profile-id={p.id}
				title={p.detail ? `${p.name} — ${p.detail}` : p.name}
				disabled={busy}
				onclick={() => select(p.id)}
			>
				<span class="chip-name">{p.name}</span>
				{#if p.detail}
					<span class="chip-detail">{p.detail}</span>
				{/if}
			</button>
		{/each}

		{#if rcloneProfiles.length === 0}
			<button
				type="button"
				class:active={kind === 'rclone'}
				data-testid="conn-rclone"
				disabled={busy}
				onclick={() => {
					if (busy) return;
					onConfigureRclone?.();
				}}
			>
				rclone
			</button>
		{/if}

		<button
			type="button"
			class="ghost"
			data-testid="conn-rclone-config"
			disabled={busy}
			onclick={(e) => {
				e.preventDefault();
				e.stopPropagation();
				if (busy) return;
				onConfigureRclone?.();
			}}
		>
			{rcloneProfiles.length ? 'Manage rclone' : 'rclone settings'}
		</button>
	{/if}

	{#if showMonitor}
		{#each monitorProfiles as p (p.id)}
			<button
				type="button"
				class:active={kind === 'monitor' && activeId === p.id}
				data-testid="conn-monitor-profile"
				data-profile-id={p.id}
				title={p.detail ? `${p.name} — ${p.detail}` : p.name}
				disabled={busy}
				onclick={() => select(p.id)}
			>
				<span class="chip-name">{p.name}</span>
				{#if p.detail}
					<span class="chip-detail">{p.detail}</span>
				{/if}
			</button>
		{/each}

		{#if monitorProfiles.length === 0}
			<button
				type="button"
				class:active={kind === 'monitor'}
				data-testid="conn-monitor"
				disabled={busy}
				onclick={() => {
					if (busy) return;
					onConfigureMonitor?.();
				}}
			>
				monitor
			</button>
		{/if}

		<button
			type="button"
			class="ghost"
			data-testid="conn-monitor-config"
			disabled={busy}
			onclick={(e) => {
				e.preventDefault();
				e.stopPropagation();
				if (busy) return;
				onConfigureMonitor?.();
			}}
		>
			{monitorProfiles.length ? 'Manage monitor' : 'monitor settings'}
		</button>
	{/if}
</div>

<style>
	.conn-switch {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
		align-items: center;
	}
	button {
		padding: 0.35rem 0.7rem;
		border-radius: 8px;
		border: 1px solid var(--border, #334155);
		background: var(--surface, #1e293b);
		color: inherit;
		cursor: pointer;
		font-size: 0.9rem;
		text-align: left;
		line-height: 1.2;
	}
	button:disabled {
		opacity: 0.55;
		cursor: wait;
	}
	button.active {
		outline: 2px solid #38bdf8;
		outline-offset: 1px;
	}
	button.ghost {
		background: transparent;
		opacity: 0.85;
		font-size: 0.8rem;
	}
	.chip-name {
		display: block;
		font-weight: 600;
	}
	.chip-detail {
		display: block;
		font-size: 0.7rem;
		opacity: 0.75;
		max-width: 12rem;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
</style>
