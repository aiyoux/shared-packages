<script lang="ts">
	import { Button } from '@shared-packages/design-system';

	/** Same vocabulary as animation clips: clone / live / snapshot / git-pin. */
	export type VfsBindMode = 'clone' | 'live' | 'snapshot' | 'gitPin';

	export type BindPromptIds = {
		prompt: string;
		bindClone: string;
		bindLive: string;
		bindSnapshot: string;
		bindGitpin?: string;
		gitSnapshot?: string;
	};

	export type BindPromptPending = {
		label: string;
		git?: boolean;
		cloneOnly?: boolean;
		liveDisabled?: boolean;
		liveTitle?: string;
	};

	let {
		ids,
		pending,
		gitKeepSnapshot = $bindable(true),
		placement = 'anchored',
		hugBottom = false,
		clientX = 0,
		clientY = 0,
		ariaLabel = 'Bind clip',
		onConfirm,
		onCancel
	}: {
		ids: BindPromptIds;
		pending: BindPromptPending;
		gitKeepSnapshot?: boolean;
		placement?: 'anchored' | 'pointer';
		hugBottom?: boolean;
		clientX?: number;
		clientY?: number;
		ariaLabel?: string;
		onConfirm: (mode: VfsBindMode) => void;
		onCancel: () => void;
	} = $props();

	const pointerStyle = $derived(
		placement === 'pointer'
			? `left:${Math.max(8, clientX + 12)}px;top:${Math.max(8, clientY + 12)}px;`
			: undefined
	);
</script>

<div
	class="prompt"
	class:pointer={placement === 'pointer'}
	class:hug-bottom={hugBottom}
	style={pointerStyle}
	data-testid={ids.prompt}
	role="dialog"
	aria-label={ariaLabel}
>
	<p class="hint">Bind {pending.label}</p>
	<div class="prompt-actions">
		<Button size="sm" data-testid={ids.bindClone} onclick={() => onConfirm('clone')}>Clone</Button>
		{#if !pending.cloneOnly}
			<Button
				size="sm"
				data-testid={ids.bindLive}
				disabled={pending.liveDisabled}
				title={pending.liveTitle ?? 'Live'}
				onclick={() => onConfirm('live')}
			>
				Live
			</Button>
			<Button size="sm" data-testid={ids.bindSnapshot} onclick={() => onConfirm('snapshot')}>
				Snapshot
			</Button>
		{/if}
		{#if pending.git && !pending.cloneOnly && ids.bindGitpin}
			<Button size="sm" data-testid={ids.bindGitpin} onclick={() => onConfirm('gitPin')}>
				Git pin
			</Button>
			{#if ids.gitSnapshot}
				<label class="check">
					<input
						type="checkbox"
						checked={gitKeepSnapshot}
						data-testid={ids.gitSnapshot}
						onchange={(e) => (gitKeepSnapshot = (e.currentTarget as HTMLInputElement).checked)}
					/>
					Keep snapshot of this commit
				</label>
			{/if}
		{/if}
		<Button size="sm" variant="ghost" onclick={onCancel}>Cancel</Button>
	</div>
	{#if pending.cloneOnly}
		<p class="hint">Cross-backend drop is clone only — no live, snapshot, or git pin.</p>
	{/if}
	{#if pending.liveDisabled}
		<p class="hint">Save the sketch to enable Live, Snapshot, and Git pin.</p>
	{/if}
</div>

<style>
	.prompt {
		position: absolute;
		left: 12px;
		bottom: 56px;
		z-index: 80;
		padding: var(--space-2, 8px);
		background: rgb(var(--surface-rgb, 20 20 20));
		border: 1px solid rgb(var(--border-rgb, 80 80 80));
		max-width: min(420px, calc(100% - 24px));
	}
	.prompt.pointer {
		position: fixed;
		bottom: auto;
		max-width: min(360px, calc(100vw - 24px));
		pointer-events: auto;
	}
	.prompt.hug-bottom {
		bottom: 12px;
	}
	.prompt-actions {
		display: flex;
		gap: var(--space-2, 8px);
		flex-wrap: wrap;
		align-items: center;
	}
	.check {
		display: flex;
		gap: var(--space-1, 4px);
		align-items: center;
		font-size: 12px;
	}
	.hint {
		margin: 0;
		padding: var(--space-2, 8px);
		opacity: 0.7;
		font-size: 12px;
	}
</style>
