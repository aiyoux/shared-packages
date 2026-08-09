<script lang="ts">
	export type ConnectionKind = 'local' | 'b2';

	export type B2ProfileChip = {
		id: string;
		/** Short button label */
		name: string;
		/** Secondary line / title */
		detail?: string;
	};

	interface Props {
		/** Active selection: local browser or a specific B2 profile id */
		activeId?: string | 'local';
		/** Saved B2 profiles — each becomes a join button */
		profiles?: B2ProfileChip[];
		/** True while a B2 connect attempt is in flight */
		busy?: boolean;
		/** Select local or a profile id */
		onSelect?: (id: 'local' | string) => void;
		onConfigureB2?: () => void;
	}

	let {
		activeId = 'local',
		profiles = [],
		busy = false,
		onSelect,
		onConfigureB2
	}: Props = $props();

	function select(id: 'local' | string) {
		if (busy) return;
		onSelect?.(id);
	}
</script>

<div class="conn-switch" data-testid="connection-switcher" role="group" aria-label="Storage connection">
	<button
		type="button"
		class:active={activeId === 'local'}
		data-testid="conn-local"
		disabled={busy}
		onclick={() => select('local')}
	>
		This browser
	</button>

	{#each profiles as p (p.id)}
		<button
			type="button"
			class:active={activeId === p.id}
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
		<!-- No saved profiles yet — one control to open settings / prompt connect -->
		<button
			type="button"
			class:active={activeId !== 'local'}
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
			onConfigureB2?.();
		}}
	>
		{profiles.length ? 'Manage B2' : 'B2 settings'}
	</button>
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
