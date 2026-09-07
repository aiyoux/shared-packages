<script lang="ts">
	let {
		x,
		y,
		label = 'Unsupported file',
		testId = 'drop-reject-hint'
	}: {
		x: number;
		y: number;
		label?: string;
		testId?: string;
	} = $props();
</script>

<div
	class="drop-reject-hint"
	style="left:{x + 14}px;top:{y + 14}px"
	data-testid={testId}
	role="status"
>
	{label}
</div>

<style>
	.drop-reject-hint {
		position: fixed;
		z-index: 200;
		pointer-events: none;
		padding: 4px 8px;
		border-radius: var(--radius-sm, 4px);
		background: var(--surface-2, #0c111c);
		border: 1px solid var(--line-strong, #3d4f63);
		color: var(--text-primary, #e8eef4);
		font-size: 0.75rem;
		font-weight: 600;
		white-space: nowrap;
		box-shadow: 0 4px 16px rgb(0 0 0 / 0.35);
	}
</style>
