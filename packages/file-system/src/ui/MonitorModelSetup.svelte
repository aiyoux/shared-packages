<script lang="ts">
	import { mediaModelConfigExample, monitorModelSetup, monitorRuntimeExample } from '../ai/monitorModelSetup.js';
	let { task, location = 'native' }: { task: string; location?: 'native' | 'api' } = $props();
	const guide = $derived(monitorModelSetup(task));
	const runtime = $derived(monitorRuntimeExample(task));
	const mediaConfig = $derived(mediaModelConfigExample(task));
</script>

{#if guide}
	<div class="setup" data-testid="monitor-setup-{location}-{task}">
		{#if location === 'native'}
			<p><strong>Set up {guide.title.toLowerCase()} on Monitor</strong></p>
			<ol>{#each guide.steps as step}<li>{step}</li>{/each}</ol>
			{#if runtime && guide.modelExample}
				<p>Example paths only — replace them with files on the computer running Monitor, not this browser:</p>
				<dl><dt>Runtime binary</dt><dd><code>{runtime}</code></dd><dt>Model file</dt><dd><code>{guide.modelExample}</code></dd></dl>
			{/if}
			<p>{#each guide.links as link}<a href={link.url} target="_blank" rel="noopener noreferrer">{link.label}</a>{' '}{/each}</p>
		{:else if task === 'chat'}
			<p>Choose Add API connection, enter an OpenAI-compatible API base URL and key, then Save API connection. Refresh to list the provider’s chat models. The key stays on Monitor.</p>
		{:else if mediaConfig}
			<p><strong>Configure an API {guide.title.toLowerCase()} model</strong></p>
			<ol>
				<li>Add an API connection below. Copy its profile ID from the saved connection.</li>
				<li>On the computer running Monitor, add the example below to <code>monitor.toml</code>. Replace the profile, model{task === 'text-to-speech' ? ' and voice' : ''} IDs with those supplied by your API. It must support the corresponding OpenAI-compatible media endpoint.</li>
				<li>Restart Monitor, then Refresh and choose the model in its app or in Default models for apps.</li>
			</ol>
			<pre>{mediaConfig}</pre>
			<p>Media model editing is not yet available here. This setup is manual on Monitor; API keys belong in the API connection, not in this example.</p>
		{/if}
	</div>
{/if}

<style>
	.setup { font-size: 0.78rem; color: var(--text-muted); line-height: 1.5; margin: 0.5rem 0; }
	p { margin: 0.4rem 0; }
	ol { margin: 0.4rem 0; padding-left: 1.4rem; }
	li { margin: 0.35rem 0; }
	dl { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 0.25rem 0.6rem; }
	dd { margin: 0; overflow-wrap: anywhere; }
	pre { padding: 0.6rem; background: var(--surface-1); border: 1px solid var(--line-hairline); white-space: pre-wrap; overflow-wrap: anywhere; }
	a { color: var(--text-primary); display: inline-block; margin-right: 0.6rem; }
</style>
