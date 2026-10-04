<script lang="ts">
	import Dialog from '../../ui/src/Dialog.svelte';
	import Popover from '../../ui/src/Popover.svelte';
	import FileExplorerDialog from '../src/ui/FileExplorerDialog.svelte';
	import FeConfirmDialog from '../src/ui/FeConfirmDialog.svelte';
	let { picker = false }: { picker?: boolean } = $props();
	let parentOpen = $state(true);
	let popupOpen = $state(false);
	let nestedOpen = $state(false);
	let confirmOpen = $state(false);
	let editing = $state(true);
</script>

{#if picker}
	{#if parentOpen}
		<FileExplorerDialog mode="open" accept={['image']} onClose={() => (parentOpen = false)} />
	{/if}
	<button data-testid="confirm-trigger" onclick={() => (confirmOpen = true)}>Overwrite</button>
{:else}
	<Dialog open={parentOpen} title="Parent" onClose={() => (parentOpen = false)}>
		{#if editing}
			<input data-testid="inline-edit" onkeydown={(event) => {
				if (event.key === 'Escape') {
					event.preventDefault();
					editing = false;
				}
			}} />
		{/if}
		<Popover bind:open={popupOpen} contentClass="first-popup">
			{#snippet trigger({ ref })}
				<button use:ref data-testid="popup-trigger" onclick={() => (popupOpen = !popupOpen)}>Menu</button>
			{/snippet}
			{#snippet content()}
				<Popover bind:open={nestedOpen} contentClass="nested-popup">
					{#snippet trigger({ ref })}
						<button use:ref data-testid="nested-trigger" onclick={() => (nestedOpen = !nestedOpen)}>Submenu</button>
					{/snippet}
					{#snippet content()}
						<button data-testid="nested-action">Nested action</button>
					{/snippet}
				</Popover>
			{/snippet}
		</Popover>
	</Dialog>
{/if}
{#if confirmOpen}
	<FeConfirmDialog copy={{ title: 'Overwrite?', body: 'Replace this file?', confirmLabel: 'Replace' }} onConfirm={() => (confirmOpen = false)} onCancel={() => (confirmOpen = false)} />
{/if}
