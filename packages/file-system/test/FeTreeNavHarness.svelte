<!-- Test harness: owns activeId like FileExplorer does, so navigation updates
	flow through props on the live instance (testing-library rerender remounts
	and would wipe the tree's internal expanded state). -->
<script lang="ts">
	import FeTreeView from '../src/ui/FeTreeView.svelte';
	import type { ExplorerDriver, ExplorerEntryId } from '../src/ui/explorerDriver.js';

	let { driver }: { driver: ExplorerDriver } = $props();
	let activeId = $state<ExplorerEntryId | null>(null);
</script>

<FeTreeView
	{driver}
	{activeId}
	onNavigate={(id) => {
		activeId = id;
	}}
/>
