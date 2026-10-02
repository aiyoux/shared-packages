<script lang="ts">
  import { onMount } from 'svelte';
  import '@shared-packages/design-system/button.css';
  import { browserModelStore, deviceModelFiles, matchModelFiles, type ModelDef, type ModelStatus, type ModelFileMatch, type ModelSourceFile } from '@shared-packages/model-store';
  import { startOp, type OpHandle } from '../services/ops.js';
  import { getSharedVfs } from '../vfs.js';
  import { createLocalExplorerDriver } from './localExplorerDriver.js';
  import FeFolderPickerDialog from './FeFolderPickerDialog.svelte';

  let { def, onChanged }: { def: ModelDef; onChanged?: () => void } = $props();
  let status = $state<ModelStatus | null>(null);
  let error = $state('');
  let busy = $state(false);
  let preview = $state<ModelFileMatch[] | null>(null);
  let sourceLabel = $state('This device');
  let singlePath = $state<string | null>(null);
  let fileInput = $state<HTMLInputElement>();
  let folderInput = $state<HTMLInputElement>();
  let singleInput = $state<HTMLInputElement>();
  let supportsFolder = $state(false);
  let chooseBrowserFolder = $state(false);
  let driver = $state<ReturnType<typeof createLocalExplorerDriver> | null>(null);
  let controller = $state<AbortController | null>(null);
  let progress = $state('');
  let refreshGeneration = 0;
  async function refresh() {
    const generation = ++refreshGeneration;
    try {
      const next = await browserModelStore.status(def);
      if (generation === refreshGeneration) status = next;
    } catch (e) { if (generation === refreshGeneration) error = message(e); }
  }
  const message = (e: unknown) => e instanceof Error ? e.message : String(e);
  $effect(() => { def; void refresh(); });
  onMount(() => {
    supportsFolder = 'webkitdirectory' in document.createElement('input');
    const off = browserModelStore.subscribe(() => { void refresh(); onChanged?.(); });
    return () => { off(); controller?.abort(new DOMException('Model card closed', 'AbortError')); };
  });
  function picked(input: HTMLInputElement, path?: string | null) {
    const files = Array.from(input.files ?? []); input.value = '';
    if (!files.length) return;
    const sources = deviceModelFiles(files);
    if (path) { sources[0]!.path = path; }
    preview = matchModelFiles(path ? { ...def, files: def.files.filter(file => file.path === path) } : def, sources);
    sourceLabel = 'This device'; error = '';
  }
  async function browserFolder() {
    error = '';
    try { driver = createLocalExplorerDriver(getSharedVfs()); await driver.ready(); chooseBrowserFolder = true; }
    catch (e) { error = message(e); }
  }
  async function previewFolder(folder: { id: string | null; name: string }) {
    chooseBrowserFolder = false; busy = true; error = '';
    try {
      const activeDriver = driver!;
      // Traverse only required directories, rather than unrelated files in a large source tree.
      const listing = new Map<string | null, Awaited<ReturnType<typeof activeDriver.list>>>();
      const files: ModelSourceFile[] = [];
      for (const required of def.files) {
        let parent = folder.id;
        const parts = required.path.split('/');
        for (let index = 0; index < parts.length; index++) {
          let result = listing.get(parent);
          if (!result) { result = await activeDriver.list({ parentId: parent }); listing.set(parent, result); }
          if (result.truncated) throw new Error('This folder has too many entries to match safely. Choose a smaller model folder.');
          const entry = result.entries.find(item => item.name === parts[index] && item.kind === (index === parts.length - 1 ? 'file' : 'folder'));
          if (!entry) break;
          if (entry.kind === 'folder') parent = entry.id;
          else files.push({ path: required.path, bytes: entry.size ?? -1,
            async open(signal) { signal.throwIfAborted(); const blob = await activeDriver.download!(entry.id, { signal }); signal.throwIfAborted(); return blob.stream(); } });
        }
      }
      preview = matchModelFiles(def, files); sourceLabel = `Browser files · ${folder.name}`;
    } catch (e) { error = message(e); } finally { busy = false; }
  }
  async function loadPreview() {
    const matches = preview?.filter(row => row.state === 'found' && row.source) ?? [];
    if (!matches.length || busy) return;
    const model = def; const source = sourceLabel;
    busy = true; error = ''; controller = new AbortController();
    let op: OpHandle | undefined;
    try {
      op = await startOp({ kind: 'model-load', app: 'ai-models', title: `Load ${model.label}`, signal: controller.signal,
        where: { executor: 'this-browser', from: { kind: 'browser', label: source }, to: { kind: 'browser', label: 'Browser model store' }, route: 'direct' },
        landing: { kind: 'browser-model', modelId: model.id } });
      const total = matches.reduce((sum, row) => sum + row.source!.bytes, 0);
      let done = 0;
      for (const row of matches) {
        op.signal.throwIfAborted();
        const stream = await row.source!.open(op.signal);
        await browserModelStore.write(model.id, row.file.path, stream, {
          expectedBytes: row.file.bytes, expectedBlake3: row.file.blake3, source, signal: op.signal,
          onProgress(bytes) { progress = `${row.file.path}: ${bytes.toLocaleString()} bytes`; op!.progress({ done: done + bytes, total: total > 0 ? total : undefined, note: row.file.path }); }
        });
        done += row.source!.bytes;
      }
      await op.done({ kind: 'browser-model', modelId: model.id }); preview = null;
    } catch (e) { error = message(e); if (op) await op.fail(e); }
    finally { controller = null; busy = false; progress = ''; await refresh(); onChanged?.(); }
  }
  async function clear(path: string) {
    busy = true; error = '';
    try { await browserModelStore.clear(def.id, path); }
    catch (e) { error = message(e); }
    finally { busy = false; await refresh(); onChanged?.(); }
  }
</script>

<div class="model-files-card" data-testid="model-files-{def.id}">
  <p>{def.builtIn ?? (status?.ready ? 'Ready' : `${status?.present ?? 0} of ${def.files.length} files`)}</p>
  {#if !def.builtIn}
    <ul>
      {#each def.files as file (file.path)}
        {@const installed = status?.files.find(row => row.path === file.path)}
        <li>
          <span><code>{file.path}</code>{file.bytes != null ? ` · ${file.bytes.toLocaleString()} bytes` : ''} · {installed?.state ?? 'missing'}</span>
          {#if file.url}<a href={file.url} target="_blank" rel="noopener noreferrer">Source file</a>{/if}
          <button class="ds-btn ds-btn--sm ds-btn--secondary" disabled={busy} onclick={() => { singlePath = file.path; singleInput?.click(); }}>{installed?.actual ? 'Replace' : 'Add file'}</button>
          {#if installed?.actual}<button class="ds-btn ds-btn--sm ds-btn--ghost" disabled={busy} onclick={() => void clear(file.path)}>Clear</button>{/if}
        </li>
      {/each}
    </ul>
    <div class="actions">
      <span>Load from:</span>
      <button class="ds-btn ds-btn--sm ds-btn--secondary" disabled={busy} onclick={() => fileInput?.click()}>This device · files</button>
      {#if supportsFolder}<button class="ds-btn ds-btn--sm ds-btn--secondary" disabled={busy} onclick={() => folderInput?.click()}>This device · folder</button>{/if}
      <button class="ds-btn ds-btn--sm ds-btn--secondary" disabled={busy} onclick={() => void browserFolder()}>Browser files</button>
      {#if busy}<button class="ds-btn ds-btn--sm ds-btn--ghost" onclick={() => controller?.abort(new DOMException('Cancelled', 'AbortError'))} disabled={!controller}>Cancel</button>{/if}
    </div>
    <input hidden type="file" multiple bind:this={fileInput} onchange={() => picked(fileInput!)} />
    <input hidden type="file" multiple webkitdirectory bind:this={folderInput} onchange={() => picked(folderInput!)} />
    <input hidden type="file" bind:this={singleInput} onchange={() => picked(singleInput!, singlePath)} />
  {/if}
  {#if preview}
    <div class="preview">
      <p>Preview · {sourceLabel}</p>
      <ul>{#each preview as row (row.file.path)}<li><code>{row.file.path}</code> · {row.state}</li>{/each}</ul>
      <p>Only matched files are loaded. Their sizes and available expected hashes are checked before replacing installed files.</p>
      <button class="ds-btn ds-btn--sm" disabled={busy || !preview.some(row => row.state === 'found')} onclick={() => void loadPreview()}>Load matched files</button>
      <button class="ds-btn ds-btn--sm ds-btn--ghost" disabled={busy} onclick={() => preview = null}>Discard preview</button>
    </div>
  {/if}
  {#if progress}<p role="status">{progress}</p>{/if}
  {#if error}<p class="error" role="alert">{error}</p>{/if}
</div>
{#if chooseBrowserFolder && driver}
  <FeFolderPickerDialog {driver} title="Choose {def.label} model folder" confirmLabel="Preview files" onSelect={previewFolder} onCancel={() => chooseBrowserFolder = false} />
{/if}
<style>
  .model-files-card { width: 100%; font-size: 0.85rem; }
  ul { padding-left: 1.2rem; }
  li, .actions { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; margin: 0.4rem 0; }
  code { overflow-wrap: anywhere; }
  .preview { border: 1px solid var(--ds-border); border-radius: 6px; padding: 0.5rem; }
  .error { color: var(--ds-danger, #b91c1c); }
</style>
