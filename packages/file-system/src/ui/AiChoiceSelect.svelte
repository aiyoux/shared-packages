<script lang="ts">
	/**
	 * The one model picker over `listAiChoices`: grouped by where a model runs
	 * (this browser, then each saved monitor), each option naming that place
	 * so the closed select still says it. Unreachable monitors stay listed with
	 * their reason. Nothing is preselected for the user: an empty value shows
	 * the placeholder until they choose.
	 */
	import type { AiChoice, AiMonitorStatus } from '../ai/choices.js';

	let {
		choices,
		monitors = [],
		value,
		onSelect,
		blocked,
		detail,
		disabled = false,
		placeholder = 'Choose a model',
		ariaLabel = 'Model',
		testid,
		class: className = ''
	}: {
		choices: readonly AiChoice[];
		/** Saved monitors, so unreachable ones are named rather than missing. */
		monitors?: readonly AiMonitorStatus[];
		/** The selected choice's key, or '' for none. */
		value: string;
		onSelect: (choice: AiChoice) => void;
		/** Why a choice cannot serve this use (e.g. text-only for an image). */
		blocked?: (choice: AiChoice) => string | null;
		/** Extra facts after the label (size on disk, last run). */
		detail?: (choice: AiChoice) => string;
		disabled?: boolean;
		placeholder?: string;
		ariaLabel?: string;
		testid?: string;
		class?: string;
	} = $props();

	const groups = $derived.by(() => {
		const byWhere = new Map<string, AiChoice[]>();
		for (const choice of choices) {
			const id = choice.monitor?.profileId ?? 'browser';
			byWhere.set(id, [...(byWhere.get(id) ?? []), choice]);
		}
		return [...byWhere.entries()].map(([id, rows]) => ({ id, where: rows[0]!.where, rows }));
	});
	const current = $derived(choices.some((choice) => choice.key === value) ? value : '');
	const silent = $derived(monitors.filter((monitor) => monitor.error && !groups.some((group) => group.id === monitor.profileId)));

	function note(choice: AiChoice): string {
		const reason = blocked?.(choice) ?? (choice.offer.available ? null : choice.offer.reason ?? 'unavailable');
		return `${detail?.(choice) ?? ''}${reason ? ` · ${reason}` : ''}`;
	}
</script>

<select
	class={className}
	data-testid={testid}
	aria-label={ariaLabel}
	{disabled}
	value={current}
	onchange={(event) => {
		const choice = choices.find((row) => row.key === event.currentTarget.value);
		if (choice) onSelect(choice);
	}}
>
	{#if !current}<option value="" disabled>{placeholder}</option>{/if}
	{#each groups as group (group.id)}
		<optgroup label={group.where}>
			{#each group.rows as choice (choice.key)}
				<option value={choice.key} disabled={!choice.offer.available || !!blocked?.(choice)}>{choice.label}{note(choice)}</option>
			{/each}
		</optgroup>
	{/each}
	{#each silent as monitor (monitor.profileId)}
		<optgroup label={monitor.name}><option value={`unreachable:${monitor.profileId}`} disabled>{monitor.error}</option></optgroup>
	{/each}
</select>
