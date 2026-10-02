<script lang="ts">
  import { onMount } from 'svelte';
  import '@shared-packages/design-system/button.css';
  import { browserModelStore, deviceModelFiles, matchModelFiles, skipStored, type ModelDef, type ModelStatus, type ModelFileMatch } from '@shared-packages/model-store';
  import { startOp, type OpHandle } from '../services/ops.js';
  import { getSharedVfs } from '../vfs.js';
  import type { ExplorerDriver } from './explorerDriver.js';
  import { createLocalExplorerDriver } from './localExplorerDriver.js';
  import FeFolderPickerDialog from './FeFolderPickerDialog.svelte';
  import {
    b2FolderSources, folderModelFiles, monitorFolderSources, onlineModelFiles, onlineSources,
    type ModelFolderSource, type ModelOnlineSource
  } from '../ai/modelSources.js';

  /** `onStatus` reports each store read, so an app can gate its engine on `ready`. */
  let { def, onChanged, onStatus }: { def: ModelDef; onChanged?: () => void; onStatus?: (status: ModelStatus) => void } = $props();
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
  /** The connection whose folder picker is open, and its driver. */
  let picking = $state<{ label: string; driver: ExplorerDriver; release: () => void } | null>(null);
  let folderSources = $state<ModelFolderSource[]>([]);
  let online = $state<ModelOnlineSource[]>([]);
  let onlinePick = $state('');
  let controller = $state<AbortController | null>(null);
  /** Releases the connection a folder preview reads from, once its load ends or it is discarded. */
  let held: (() => void) | null = null;
  let progress = $state('');
  let refreshGeneration = 0;
  async function refresh() {
    const generation = ++refreshGeneration;
    try {
      const next = await browserModelStore.status(def);
      if (generation === refreshGeneration) { status = next; onStatus?.(next); }
    } catch (e) { if (generation === refreshGeneration) error = message(e); }
  }
  const message = (e: unknown) => e instanceof Error ? e.message : String(e);
  $effect(() => { def; void refresh(); });
  onMount(() => {
    supportsFolder = 'webkitdirectory' in document.createElement('input');
    const off = browserModelStore.subscribe(() => { void refresh(); onChanged?.(); });
    const sources = new AbortController();
    // Monitors come from the saved profiles; B2 rows and fetch capabilities
    // need each monitor to answer, so they join as they arrive.
    void monitorFolderSources().then((rows) => { if (!sources.signal.aborted) folderSources = [...rows, ...folderSources]; }).catch(() => {});
    void b2FolderSources().then((rows) => { if (!sources.signal.aborted) folderSources = [...folderSources, ...rows]; }).catch(() => {});
    void onlineSources().then((rows) => { if (!sources.signal.aborted) online = rows; }).catch(() => {});
    return () => {
      off(); sources.abort();
      controller?.abort(new DOMException('Model card closed', 'AbortError'));
      picking?.release(); held?.(); held = null;
    };
  });
  /** Only previewed, matching, not-yet-stored files load; Replace is per file. */
  function showPreview(rows: ModelFileMatch[], label: string, release: (() => void) | null = null) {
    held?.(); held = release;
    preview = status ? skipStored(rows, status) : rows; sourceLabel = label; error = '';
  }
  function discardPreview() { preview = null; held?.(); held = null; }
  function picked(input: HTMLInputElement, path?: string | null) {
    const files = Array.from(input.files ?? []); input.value = '';
    if (!files.length) return;
    const sources = deviceModelFiles(files);
    if (path) { sources[0]!.path = path; }
    // A single-file pick is an explicit Add or Replace, so it is never skipped.
    const rows = matchModelFiles(path ? { ...def, files: def.files.filter(file => file.path === path) } : def, sources);
    if (path) { held?.(); held = null; preview = rows; sourceLabel = 'This device'; error = ''; }
    else showPreview(rows, 'This device');
  }
  async function chooseFolder(label: string, acquire: () => Promise<ExplorerDriver>, release: () => void) {
    error = ''; busy = true;
    try { const driver = await acquire(); await driver.ready(); picking?.release(); picking = { label, driver, release }; }
    catch (e) { release(); error = message(e); }
    finally { busy = false; }
  }
  function browserFolder() {
    void chooseFolder('Browser files', async () => createLocalExplorerDriver(getSharedVfs()), () => {});
  }
  function closePicker() { picking?.release(); picking = null; }
  async function previewFolder(folder: { id: string | null; name: string }) {
    const source = picking; if (!source) return;
    picking = null; busy = true; error = '';
    try { showPreview(await folderModelFiles(def, source.driver, folder.id), `${source.label} · ${folder.name}`, source.release); }
    catch (e) { error = message(e); source.release(); } finally { busy = false; }
  }
  function previewOnline(id: string) {
    onlinePick = '';
    const source = online.find(row => row.id === id); if (!source) return;
    showPreview(onlineModelFiles(def, source), `Online via ${source.label}`);
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
      const total = matches.reduce((sum, row) => sum + Math.max(0, row.source!.bytes), 0);
      let done = 0;
      for (const row of matches) {
        op.signal.throwIfAborted();
        const stream = await row.source!.open(op.signal);
        await browserModelStore.write(model.id, row.file.path, stream, {
          expectedBytes: row.file.bytes, expectedBlake3: row.file.blake3, source, signal: op.signal,
          onProgress(bytes) { progress = `${row.file.path}: ${bytes.toLocaleString()} bytes`; op!.progress({ done: done + bytes, total: total > 0 ? total : undefined, note: row.file.path }); }
        });
        done += Math.max(0, row.source!.bytes);
      }
      await op.done({ kind: 'browser-model', modelId: model.id }); discardPreview();
    } catch (e) { error = message(e); if (op) await op.fail(e); }
    finally { controller = null; busy = false; progress = ''; await refresh(); onChanged?.(); }
  }
  async function clear(path: string) {
    busy = true; error = '';
    try { await browserModelStore.clear(def.id, path); }
    catch (e) { error = message(e); }
    finally { busy = false; await refresh(); onChanged?.(); }
  }
  const stateLabel: Record<ModelFileMatch['state'], string> = {
    found: 'will load', missing: 'not in this source', ambiguous: 'more than one match', 'size-mismatch': 'wrong size',
    present: 'already stored', 'not-fetchable': 'not fetchable through this monitor'
  };
  const hasMonitor = $derived(folderSources.some(source => source.id.startsWith('monitor:')));
</script>

<div class="model-files-card" data-testid="model-files-{def.id}">
  <p>{def.builtIn ?? (status?.ready ? 'Ready' : `${status?.present ?? 0} of ${def.files.length} files`)}</p>
  {#if !def.builtIn}
    <ul>
      {#each def.files as file (file.path)}
        {@const installed = status?.files.find(row => row.path === file.path)}
        <li>
          <span><code>{file.path}</code>{file.bytes != null ? ` · ${file.bytes.toLocaleString()} bytes` : ''} · {installed?.state ?? 'missing'}{file.optional ? ' · optional' : ''}</span>
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
      <button class="ds-btn ds-btn--sm ds-btn--secondary" disabled={busy} onclick={browserFolder}>Browser files</button>
      {#each folderSources as source (source.id)}
        <button class="ds-btn ds-btn--sm ds-btn--secondary" disabled={busy} data-testid="model-source-{source.id}"
          onclick={() => void chooseFolder(source.label, source.acquire, source.release)}>{source.label} · folder</button>
      {/each}
      {#if online.length}
        <select aria-label="Load {def.label} online through a monitor" data-testid="model-source-online" disabled={busy}
          value={onlinePick} onchange={(event) => previewOnline(event.currentTarget.value)}>
          <option value="" disabled>Online via…</option>
          {#each online as source (source.id)}<option value={source.id}>{source.label}</option>{/each}
        </select>
      {/if}
      {#if busy}<button class="ds-btn ds-btn--sm ds-btn--ghost" onclick={() => controller?.abort(new DOMException('Cancelled', 'AbortError'))} disabled={!controller}>Cancel</button>{/if}
    </div>
    {#if !hasMonitor}
      <p class="hint" data-testid="model-sources-hint">Connect to another device or add a monitor to fetch them automatically.</p>
    {/if}
    <input hidden type="file" multiple bind:this={fileInput} onchange={() => picked(fileInput!)} />
    <input hidden type="file" multiple webkitdirectory bind:this={folderInput} onchange={() => picked(folderInput!)} />
    <input hidden type="file" bind:this={singleInput} onchange={() => picked(singleInput!, singlePath)} />
  {/if}
  {#if preview}
    <div class="preview" data-testid="model-files-preview">
      <p>Preview · {sourceLabel}</p>
      <ul>{#each preview as row (row.file.path)}<li><code>{row.file.path}</code> · {stateLabel[row.state]}</li>{/each}</ul>
      <p>Only files marked “will load” are loaded. Their sizes and expected hashes are checked before anything replaces an installed file.</p>
      <button class="ds-btn ds-btn--sm" disabled={busy || !preview.some(row => row.state === 'found')} onclick={() => void loadPreview()}>Load matched files</button>
      <button class="ds-btn ds-btn--sm ds-btn--ghost" disabled={busy} onclick={discardPreview}>Discard preview</button>
    </div>
  {/if}
  {#if progress}<p role="status">{progress}</p>{/if}
  {#if error}<p class="error" role="alert">{error}</p>{/if}
</div>
{#if picking}
  <FeFolderPickerDialog driver={picking.driver} title="Choose {def.label} model folder on {picking.label}" confirmLabel="Preview files" onSelect={previewFolder} onCancel={closePicker} />
{/if}
<style>
  .model-files-card { width: 100%; font-size: 0.85rem; }
  ul { padding-left: 1.2rem; }
  li, .actions { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; margin: 0.4rem 0; }
  code { overflow-wrap: anywhere; }
  .preview { border: 1px solid var(--ds-border); border-radius: 6px; padding: 0.5rem; }
  .hint { color: var(--ds-text-muted, inherit); }
  .error { color: var(--ds-danger, #b91c1c); }
</style>
