<script lang="ts">
	import { audioChunkingError } from './audioChunking.js';

	let {
		chunkSeconds = $bindable(),
		overlapSeconds = $bindable(),
		disabled = false
	}: {
		chunkSeconds: number | undefined;
		overlapSeconds: number | undefined;
		disabled?: boolean;
	} = $props();
	const error = $derived(audioChunkingError(chunkSeconds, overlapSeconds));
</script>

<fieldset {disabled}>
	<legend>Chunk processing</legend>
	<div class="fields">
		<label>
			Chunk duration (seconds)
			<input type="number" min="1" max="60" step="any" bind:value={chunkSeconds} />
		</label>
		<label>
			Overlap (seconds)
			<input type="number" min="0" max={Math.min(5, (chunkSeconds ?? 5) / 2)} step="any" bind:value={overlapSeconds} />
		</label>
	</div>
	<p>Shorter chunks use less memory. Overlap blends the joins between chunks.</p>
	{#if error}<p role="alert">{error}</p>{/if}
</fieldset>

<style>
	fieldset { border: 0; padding: 0; margin: 0; min-width: 0; }
	legend { font-size: 0.82rem; font-weight: 600; padding: 0; margin-bottom: 8px; }
	.fields { display: flex; gap: 12px; flex-wrap: wrap; }
	label { display: flex; flex-direction: column; gap: 4px; font-size: 0.82rem; }
	input { width: 8rem; background: var(--surface-2); color: var(--text-primary); border: 1px solid var(--border); border-radius: 6px; padding: 5px 8px; }
	p { margin: 8px 0 0; font-size: 0.8rem; color: var(--text-secondary); }
	p[role='alert'] { color: var(--danger, var(--text-primary)); }
</style>
