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
    b2FolderSources, connectModelDevice, folderModelFiles, linkedDeviceFiles, modelDeviceSources, monitorFolderSources, onDeviceSourcesChange,
    onlineModelFiles, onlineSources, type ModelDeviceSource, type ModelFolderSource, type ModelOnlineSource
  } from '../ai/modelSources.js';

  /** `onStatus` reports each store read, so an app can gate its engine on `ready`.
   * `showCount` is the standalone card's downloaded pill; the settings row hides it. */
  let { def, onChanged, onStatus, showCount = true }: { def: ModelDef; onChanged?: () => void; onStatus?: (status: ModelStatus) => void; showCount?: boolean } = $props();
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
  let folderOpen = $state(false);
  let folderSourceId = $state('browser-files');
  let onlineOpen = $state(false);
  let peerOpen = $state(false);
  let folderGeneration = 0;
  const BROWSER_SOURCE = 'browser-files';
  let folderSources = $state<ModelFolderSource[]>([]);
  let online = $state<ModelOnlineSource[]>([]);
  let devices = $state<ModelDeviceSource[]>([]);
  /** Set while the preview is a linked device's offer: it sends the files, the card does not open them. */
  let previewDevice = $state<ModelDeviceSource | null>(null);
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
    devices = modelDeviceSources();
    const offDevices = onDeviceSourcesChange(() => { devices = modelDeviceSources(); });
    sources.signal.addEventListener('abort', offDevices, { once: true });
    return () => {
      off(); sources.abort();
      controller?.abort(new DOMException('Model card closed', 'AbortError'));
      picking?.release(); held?.(); held = null;
    };
  });
  /** Only previewed, matching, not-yet-stored files load; Replace is per file. */
  function showPreview(rows: ModelFileMatch[], label: string, release: (() => void) | null = null, device: ModelDeviceSource | null = null) {
    held?.(); held = release; previewDevice = device;
    preview = status ? skipStored(rows, status) : rows; sourceLabel = label; error = '';
  }
  function discardPreview() { preview = null; previewDevice = null; held?.(); held = null; }
  function picked(input: HTMLInputElement, path?: string | null) {
    const files = Array.from(input.files ?? []); input.value = '';
    if (!files.length) return;
    const sources = deviceModelFiles(files);
    if (path) { sources[0]!.path = path; }
    // A single-file pick is an explicit Add or Replace, so it is never skipped.
    const rows = matchModelFiles(path ? { ...def, files: def.files.filter(file => file.path === path) } : def, sources);
    if (path) { held?.(); held = null; previewDevice = null; preview = rows; sourceLabel = 'This device'; error = ''; }
    else showPreview(rows, 'This device');
  }
  const folderChoices = $derived([
    { id: BROWSER_SOURCE, label: 'Browser files' },
    ...folderSources.map((source) => ({ id: source.id, label: source.label }))
  ]);
  async function acquireFolder(id: string): Promise<{ label: string; driver: ExplorerDriver; release: () => void }> {
    if (id === BROWSER_SOURCE) {
      const driver = createLocalExplorerDriver(getSharedVfs());
      await driver.ready();
      return { label: 'Browser files', driver, release: () => {} };
    }
    const source = folderSources.find((row) => row.id === id);
    if (!source) throw new Error('That folder source is no longer available.');
    const driver = await source.acquire();
    await driver.ready();
    return { label: source.label, driver, release: source.release };
  }
  async function openFolderPicker() {
    onlineOpen = false; peerOpen = false; error = '';
    const generation = ++folderGeneration;
    busy = true;
    try {
      const next = await acquireFolder(BROWSER_SOURCE);
      if (generation !== folderGeneration) { next.release(); return; }
      picking?.release();
      picking = next;
      folderSourceId = BROWSER_SOURCE;
      folderOpen = true;
    } catch (e) { error = message(e); }
    finally { if (generation === folderGeneration) busy = false; }
  }
  async function onFolderSource(id: string) {
    if (id === folderSourceId || busy) return;
    const generation = ++folderGeneration;
    const previous = picking;
    busy = true; error = '';
    try {
      const next = await acquireFolder(id);
      if (generation !== folderGeneration) { next.release(); return; }
      previous?.release();
      picking = next;
      folderSourceId = id;
    } catch (e) {
      error = message(e);
    } finally { if (generation === folderGeneration) busy = false; }
  }
  function closePicker() { folderOpen = false; folderGeneration += 1; picking?.release(); picking = null; }
  async function previewFolder(folder: { id: string | null; name: string }) {
    const source = picking; if (!source) return;
    folderGeneration += 1;
    folderOpen = false; picking = null; busy = true; error = '';
    try { showPreview(await folderModelFiles(def, source.driver, folder.id), `${source.label} · ${folder.name}`, source.release); }
    catch (e) { error = message(e); source.release(); } finally { busy = false; }
  }
  function loadFromDevice() {
    if (supportsFolder) folderInput?.click();
    else fileInput?.click();
  }
  function startOnline() {
    peerOpen = false;
    if (online.length === 1) { onlineOpen = false; previewOnline(online[0]!.id); return; }
    onlineOpen = !onlineOpen;
  }
  function startPeer() {
    onlineOpen = false;
    if (!devices.length) {
      peerOpen = false;
      if (!connectModelDevice()) error = 'Pair another device from Connections.';
      return;
    }
    peerOpen = !peerOpen;
  }
  function connectAnother() {
    peerOpen = false;
    if (!connectModelDevice()) error = 'Pair another device from Connections.';
  }
  function previewOnline(id: string) {
    onlineOpen = false;
    const source = online.find(row => row.id === id); if (!source) return;
    showPreview(onlineModelFiles(def, source), `Online via ${source.label}`);
  }
  /** Ask a linked device what it holds of this model; its user is asked only when the copy starts. */
  async function previewDeviceOffer(device: ModelDeviceSource) {
    busy = true; error = ''; controller = new AbortController();
    progress = `Asking ${device.label}…`;
    try { showPreview(linkedDeviceFiles(def, await device.offered(def, controller.signal)), `Copy from ${device.label}`, null, device); }
    catch (e) { error = message(e); } finally { controller = null; busy = false; progress = ''; }
  }
  async function loadPreview() {
    if (previewDevice) return copyFromDevice(previewDevice);
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
  async function copyFromDevice(device: ModelDeviceSource) {
    const rows = preview?.filter(row => row.state === 'found') ?? [];
    if (!rows.length || busy) return;
    const model = def; const source = sourceLabel;
    busy = true; error = ''; controller = new AbortController();
    let op: OpHandle | undefined;
    try {
      op = await startOp({ kind: 'model-load', app: 'ai-models', title: `Copy ${model.label} from ${device.label}`, signal: controller.signal,
        where: { executor: 'this-browser', from: { kind: 'browser', label: source }, to: { kind: 'browser', label: 'Browser model store' }, route: 'direct' },
        landing: { kind: 'browser-model', modelId: model.id } });
      const total = rows.reduce((sum, row) => sum + (row.file.bytes ?? 0), 0);
      const landed = new Map<string, number>();
      progress = `Waiting for ${device.label} to allow the copy…`;
      await device.copy(model, rows.map(row => row.file.path), { signal: op.signal, onProgress(path, bytes) {
        landed.set(path, bytes);
        const done = [...landed.values()].reduce((sum, n) => sum + n, 0);
        progress = `${path}: ${bytes.toLocaleString()} bytes`;
        op!.progress({ done, total: total > 0 ? total : undefined, note: path });
      } });
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
    'hash-mismatch': 'a different version', present: 'already stored', 'not-fetchable': 'not fetchable through this monitor'
  };
  const hasMonitor = $derived(folderSources.some(source => source.id.startsWith('monitor:')));
</script>

<div class="model-files-card" data-testid="model-files-{def.id}">
  {#if showCount && !def.builtIn}
    <p class="count" data-testid="model-files-count">{status?.present ?? 0}/{status?.total ?? def.files.length}</p>
  {/if}
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
      <button class="ds-btn ds-btn--sm" data-testid="model-source-online" disabled={busy || !online.length}
        title={online.length ? 'Load the model files online through a monitor' : 'Add a monitor to load files online'}
        onclick={startOnline}>Online</button>
      {#if onlineOpen}
        <ul class="menu" data-testid="model-online-menu">
          {#each online as source (source.id)}
            <li><button type="button" disabled={busy} onclick={() => previewOnline(source.id)}>{source.label}</button></li>
          {/each}
        </ul>
      {/if}
      <button class="ds-btn ds-btn--sm ds-btn--secondary" disabled={busy} onclick={loadFromDevice}>This device</button>
      <button class="ds-btn ds-btn--sm ds-btn--secondary" data-testid="model-source-folder" disabled={busy} onclick={() => void openFolderPicker()}>Choose folder</button>
      <button class="ds-btn ds-btn--sm ds-btn--secondary" data-testid="model-source-peer" disabled={busy} onclick={startPeer}>Another device</button>
      {#if peerOpen}
        <ul class="menu" data-testid="model-peer-menu">
          {#each devices as device (device.id)}
            <li><button type="button" data-testid="model-source-device-{device.id}" disabled={busy} onclick={() => { peerOpen = false; void previewDeviceOffer(device); }}>Copy from {device.label}</button></li>
          {/each}
          <li><button type="button" disabled={busy} onclick={connectAnother}>Connect another device</button></li>
        </ul>
      {/if}
      {#if busy}<button class="ds-btn ds-btn--sm ds-btn--ghost" onclick={() => controller?.abort(new DOMException('Cancelled', 'AbortError'))} disabled={!controller}>Cancel</button>{/if}
    </div>
    {#if !hasMonitor && !devices.length}
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
      <p>Only files marked “will load” are loaded. Their sizes and expected hashes are checked before anything replaces an installed file.{previewDevice ? ` ${previewDevice.label} asks its user to allow the copy.` : ''}</p>
      <button class="ds-btn ds-btn--sm" disabled={busy || !preview.some(row => row.state === 'found')} onclick={() => void loadPreview()}>Load matched files</button>
      <button class="ds-btn ds-btn--sm ds-btn--ghost" disabled={busy} onclick={discardPreview}>Discard preview</button>
    </div>
  {/if}
  {#if progress}<p role="status">{progress}</p>{/if}
  {#if error}<p class="error" role="alert">{error}</p>{/if}
</div>
{#if folderOpen && picking}
  <FeFolderPickerDialog driver={picking.driver} sources={folderChoices} sourceId={folderSourceId} onSourceChange={(id) => void onFolderSource(id)} title="Choose a folder for {def.label}" confirmLabel="Preview files" onSelect={previewFolder} onCancel={closePicker} />
{/if}
<style>
  .model-files-card { width: 100%; font-size: 0.85rem; }
  ul { padding-left: 1.2rem; }
  li, .actions { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; margin: 0.4rem 0; }
  .menu { list-style: none; display: flex; flex-direction: column; gap: 0.2rem; padding: 0; margin: 0; flex-basis: 100%; }
  .menu button { font: inherit; font-size: 0.8rem; text-align: left; background: transparent; border: none; color: inherit; cursor: pointer; padding: 0.15rem 0; }
  code { overflow-wrap: anywhere; }
  .count {
    display: inline-flex;
    margin: 0;
    font-size: 0.72rem;
    line-height: 1.5;
    padding: 0 0.4rem;
    border-radius: 999px;
    border: 1px solid var(--line-hairline, currentColor);
    color: var(--text-muted, inherit);
  }
  .preview { padding: 0.25rem 0; }
  .hint { color: var(--ds-text-muted, inherit); }
  .error { color: var(--ds-danger, #b91c1c); }
</style>
