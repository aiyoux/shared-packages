<script lang="ts">
	import FileExplorer from '../src/ui/FileExplorer.svelte';
	import type { VfsService } from '../src/index.ts';

	let { vfs }: { vfs: VfsService } = $props();
</script>

<FileExplorer mode="manage" {vfs} variant="panel">
	{#snippet toolbarExtra({ variant }: { variant: 'icon' | 'label' })}
		{#if variant === 'label'}
			<button type="button" data-testid="fe-file-preview-copy-across">Copy across</button>
		{:else}
			<button type="button" data-testid="fe-copy-across-stub">Copy across</button>
		{/if}
	{/snippet}
</FileExplorer>
