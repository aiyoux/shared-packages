<script lang="ts">
	/** Test entry for the snippet-gated OCR settings tab of the dialog. */
	import RemoteConnectionsDialog from '../src/ui/RemoteConnectionsDialog.svelte';
	let { onClose }: { onClose: () => void } = $props();
</script>

<RemoteConnectionsDialog {onClose}>
	{#snippet ocr()}
		<div data-testid="ocr-settings-tab-content">OCR tab body</div>
	{/snippet}
</RemoteConnectionsDialog>