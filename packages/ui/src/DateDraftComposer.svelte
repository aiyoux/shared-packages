<script lang="ts">
  import type { DateInformation, ResolveContext } from './date';
  import DateAnchorEditor from './DateAnchorEditor.svelte';
  import Button from './Button.svelte';
  import type { Snippet } from 'svelte';

  type ComposerMode = 'simple' | 'advanced';

  let {
    initialTitle = '',
    initialValue,
    now,
    resolveContext,
    allowedAnchors,
    initialMode: _initialMode = 'simple',
    heading = 'New date item',
    description = '',
    titlePlaceholder = 'What needs to happen?',
    targetPrefixLabel = null,
    targetLabel = null,
    submitLabel = 'Save',
    cancelLabel = 'Cancel',
    titleErrorMessage = 'Give this item a title before saving it.',
    showTitleField = true,
    useAnchorOffsetEditor = false,
    anchorOffsetLabel = 'plan start',
    allowNoDate = false,
    onCancel,
    onSubmit,
    onOpenRecordSettings = null,
    recordSettingsLabel = 'Open record settings',
    hideHeader = false,
    class: className = '',
    children
  }: {
    initialTitle?: string;
    /**
     * Initial date draft. Pass `null` together with `allowNoDate` to open the
     * composer in the “No date assigned” bucket — saving from that state emits
     * `{ draft: null }` so the host can remove / skip the date additional.
     */
    initialValue: DateInformation | null;
    now: Date;
    resolveContext?: ResolveContext;
    allowedAnchors?: Array<'nw' | 'up' | 'pr'>;
    initialMode?: ComposerMode;
    heading?: string;
    description?: string;
    titlePlaceholder?: string;
    targetPrefixLabel?: string | null;
    targetLabel?: string | null;
    submitLabel?: string;
    cancelLabel?: string;
    titleErrorMessage?: string;
    /** When false, the title input is hidden and the title is not required. */
    showTitleField?: boolean;
    useAnchorOffsetEditor?: boolean;
    anchorOffsetLabel?: string;
    /** See DateAnchorEditor.allowNoDate — exposes the third bucket option. */
    allowNoDate?: boolean;
    onCancel: () => void;
    /**
     * When true, skip rendering the composer's built-in header (heading,
     * description, context/target chips, record-settings gear, close button).
     * Useful when embedding the composer inside a host that provides its own
     * header chrome.
     */
    hideHeader?: boolean;
    onSubmit: (payload: { title: string; draft: DateInformation | null }) => void;
    /**
     * Optional shortcut to the underlying record's full settings page.
     * When provided, a small gear button appears in the header so the
     * composer itself stays focused on planner scheduling while users can
     * still jump to the record's general settings without closing out.
     */
    onOpenRecordSettings?: (() => void) | null;
    recordSettingsLabel?: string;
    class?: string;
    children?: Snippet;
  } = $props();

  let title = $state('');
  let titleError = $state('');
  let titleInputRef = $state<HTMLInputElement | null>(null);
  let dateEditorRef = $state<{ commitFromHost: () => void } | null>(null);
  let summary = $state<string | null>(null);
  let currentDraft = $state<DateInformation | null>(null);

  // Track if there are actual changes to save
  const hasChanges = $derived.by(() => {
    // Title changed (when title field is shown)
    if (showTitleField && title.trim() !== initialTitle.trim()) return true;
    // New item with no initial value - show if we have a valid draft
    if (!initialValue && currentDraft) return true;
    // Draft exists vs initial null
    if (currentDraft && !initialValue) return true;
    // Draft null vs initial exists
    if (!currentDraft && initialValue) return true;
    // Both exist - compare them
    if (currentDraft && initialValue) {
      return !draftsEqual(currentDraft, initialValue);
    }
    return false;
  });

  function draftsEqual(a: DateInformation, b: DateInformation): boolean {
    // Compare key fields - using JSON for deep equality check
    // This is a simple approach; for production might want more robust comparison
    const aJson = JSON.stringify(a);
    const bJson = JSON.stringify(b);
    return aJson === bJson;
  }

  $effect(() => {
    if (!title && initialTitle) {
      title = initialTitle;
    }
  });

  $effect(() => {
    titleInputRef?.focus();
  });

  function submit(draft: DateInformation | null) {
    const nextTitle = title.trim();
    if (showTitleField && !nextTitle) {
      titleError = titleErrorMessage;
      return;
    }

    titleError = '';
    onSubmit({
      title: nextTitle,
      draft
    });
  }

  function submitFromFooter() {
    dateEditorRef?.commitFromHost();
  }

  function handleDraftChange(draft: DateInformation) {
    currentDraft = draft;
  }
</script>

<div class="flex flex-col h-full overflow-hidden {className}">
  <!-- Header -->
  {#if !hideHeader}
  <div class="flex flex-col border-b shrink-0 bg-muted/20">
    <div class="flex items-start justify-between gap-4">
      <div class="flex min-w-0 flex-1 flex-col gap-1 px-4 py-4">
        <h3 class="font-semibold text-xl leading-tight">{heading}</h3>
        {#if description}
          <div class="text-sm text-muted-foreground">{description}</div>
        {/if}
      </div>
      <div class="flex items-center gap-2 px-4 py-4">
        {#if onOpenRecordSettings}
          <button
            type="button"
            class="p-1.5 rounded-full hover:bg-muted text-muted-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]"
            onclick={() => onOpenRecordSettings?.()}
            aria-label={recordSettingsLabel}
            title={recordSettingsLabel}
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c0 .66.39 1.26 1 1.51.16.07.33.11.51.11H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
        {/if}
        <button
          type="button"
          class="p-1.5 rounded-full hover:bg-muted text-muted-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]"
          onclick={onCancel}
          aria-label="Close"
          title="Close"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
        </button>
      </div>
    </div>
    {#if targetPrefixLabel || targetLabel || summary}
      <div class="border-t border-[var(--color-border)]/70 px-4 py-3">
        <div class="flex flex-col gap-2">
          {#if targetPrefixLabel || targetLabel}
            <div class="flex flex-wrap items-center gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
              {#if targetPrefixLabel}
                <span>{targetPrefixLabel}</span>
              {/if}
              {#if targetLabel}
                <span class="inline-flex w-fit items-center rounded-full border border-border/60 bg-panel/60 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-foreground">
                  {targetLabel}
                </span>
              {/if}
            </div>
          {/if}
          {#if summary}
            <div class="text-sm text-muted-foreground">{summary}</div>
          {/if}
        </div>
      </div>
    {/if}
  </div>
  {/if}

  <!-- Body -->
  <div class="min-h-0 flex-1 overflow-hidden">
    <div class="h-full overflow-y-auto p-4 space-y-6">
    {#if children}
      {@render children()}
    {/if}
    {#if showTitleField}
      <label class="space-y-1 block">
        <input
          bind:this={titleInputRef}
          bind:value={title}
          class="w-full bg-muted/30 border-b-2 border-transparent focus:border-primary px-3 py-2.5 rounded-t-md outline-none text-lg font-medium transition-all"
          placeholder={titlePlaceholder}
        />
        {#if titleError}
          <div class="text-sm text-red-500 mt-1">{titleError}</div>
        {/if}
      </label>
    {/if}
    <DateAnchorEditor
      bind:this={dateEditorRef}
      value={initialValue}
      mode="simple"
      now={now}
      {resolveContext}
      {allowedAnchors}
      hideActions
      {useAnchorOffsetEditor}
      {anchorOffsetLabel}
      {allowNoDate}
      onSummaryChange={(next) => { summary = next; }}
      onDraftChange={handleDraftChange}
      onSave={submit}
      onCancel={onCancel}
    />
    </div>
  </div>

  {#if hasChanges}
    <div class="shrink-0 border-t border-[var(--color-border)] bg-[color-mix(in_srgb,var(--color-panel),var(--color-background)_10%)] px-4 py-3 shadow-[0_-12px_24px_-18px_rgba(0,0,0,0.7)] supports-[backdrop-filter]:bg-[color-mix(in_srgb,var(--color-panel),transparent_6%)] supports-[backdrop-filter]:backdrop-blur">
      <div class="flex justify-end gap-3">
        <Button variant="ghost" onclick={onCancel}>{cancelLabel}</Button>
        <Button variant="secondary" onclick={submitFromFooter}>{submitLabel}</Button>
      </div>
    </div>
  {/if}
</div>
