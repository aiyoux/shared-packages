<script lang="ts">
	/**
	 * The one mark every document app shows while its document holds edits
	 * its file does not: an accent dot, "Unsaved changes" on hover. On a Save
	 * button it sits at the corner (`corner`); beside a title, in the line.
	 */
	let {
		corner = false,
		testid = undefined
	}: {
		corner?: boolean;
		testid?: string;
	} = $props();
</script>

<span class="unsaved-mark" class:corner title="Unsaved changes" data-testid={testid}
	><span class="unsaved-text">Unsaved</span></span
>

<style>
	.unsaved-mark {
		display: inline-block;
		flex-shrink: 0;
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--accent, #38bdf8);
		vertical-align: middle;
	}
	/* Read out, and found by text, without taking room. */
	.unsaved-text {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip: rect(0 0 0 0);
		white-space: nowrap;
	}
	.unsaved-mark.corner {
		position: absolute;
		top: -2px;
		right: -2px;
	}
</style>
