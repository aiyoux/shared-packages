<script lang="ts">
	/**
	 * Segmented group. Callers render the buttons so testids and icons stay
	 * at the call site; appearance lives in segmented.css.
	 *
	 * Selected state: `aria-selected="true"` and/or class `selected`.
	 */
	import '../segmented.css';

	let {
		label,
		role = 'group',
		class: className = '',
		children,
		...rest
	}: {
		label: string;
		role?: string;
		class?: string;
		children?: import('svelte').Snippet;
		[key: string]: unknown;
	} = $props();
</script>

<div class="ds-seg {className}" {role} aria-label={label} {...rest}>
	{@render children?.()}
</div>
