<script module lang="ts">
  const anchorDateFormatter = new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric'
  });
</script>

<script lang="ts">
  import type { Item } from '../types.ts';
  import { DatePicker, Checkbox, type DatePickerValue } from '@modular-app/ui';

  let {
    title = 'Apply a template',
    description = "Clones the template's items onto real calendar dates anchored at a date you pick next. The template itself is not modified.",
    emptyMessage = 'No planning templates available.',
    templates = [],
    selectedTemplateId = $bindable<string | null>(null),
    step = $bindable<'select' | 'configure'>('select'),
    anchorValue = $bindable<DatePickerValue>(),
    anchorDate,
    showPreview = $bindable<boolean>(false),
    previewLabel = 'Show preview on calendar',
    previewActiveLabel = 'Show preview on calendar',
    previewButtonMode = false,
    onCancel,
    onApply
  }: {
    title?: string;
    description?: string;
    emptyMessage?: string;
    templates: Item[];
    selectedTemplateId: string | null;
    step: 'select' | 'configure';
    anchorValue: DatePickerValue;
    anchorDate: Date;
    showPreview: boolean;
    previewLabel?: string;
    previewActiveLabel?: string;
    previewButtonMode?: boolean;
    onCancel: () => void;
    onApply: () => void | Promise<void>;
  } = $props();

  const selectedTemplate = $derived<Item | null>(
    selectedTemplateId
      ? (templates.find((t) => String(t.id) === selectedTemplateId) ?? null)
      : null
  );

  let showAnchorPicker = $state(false);
  let applyPending = $state(false);

  $effect(() => {
    if (step !== 'configure') {
      showAnchorPicker = false;
    }
  });

  async function handleApply() {
    if (!selectedTemplateId || applyPending) return;
    applyPending = true;
    try {
      await onApply();
    } finally {
      applyPending = false;
    }
  }
</script>

<div class="rounded-[var(--radius-lg)] border bg-[var(--color-background)] p-4 shadow-lg space-y-4 w-[22rem]">
  {#if step === 'select'}
    <div class="flex items-center justify-between">
      <div class="text-sm font-semibold">{title}</div>
      <button
        type="button"
        class="text-xs text-muted-foreground hover:text-foreground transition-colors"
        onclick={onCancel}
      >
        Cancel
      </button>
    </div>
    <div class="text-xs text-muted-foreground">
      {description}
    </div>
    {#if templates.length === 0}
      <div class="rounded-lg border bg-muted/20 px-3 py-4 text-center text-sm text-muted-foreground">
        {emptyMessage}
      </div>
    {:else}
      <div class="max-h-64 overflow-y-auto rounded-lg border divide-y">
        {#each templates as template (template.id)}
          <button
            type="button"
            class="w-full text-left px-3 py-2 text-sm hover:bg-muted/40 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]"
            onclick={() => {
              selectedTemplateId = String(template.id);
              step = 'configure';
            }}
          >
            <div class="font-medium truncate">{template.text || template.id}</div>
          </button>
        {/each}
      </div>
    {/if}
  {:else}
    <div class="flex items-center gap-2">
      <button
        type="button"
        class="p-1 rounded hover:bg-muted text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]"
        onclick={() => {
          showPreview = false;
          step = 'select';
        }}
        aria-label="Back"
        title="Back"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>
      </button>
      <div class="min-w-0 flex-1">
        <div class="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Template</div>
        <div class="text-sm font-semibold truncate">
          {selectedTemplate?.text || selectedTemplate?.id || '—'}
        </div>
      </div>
      <button
        type="button"
        class="text-xs text-muted-foreground hover:text-foreground transition-colors"
        onclick={onCancel}
      >
        Cancel
      </button>
    </div>

    <div class="space-y-2">
      <div class="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
        Anchor date
      </div>
      <div class="rounded-lg border bg-muted/20 px-3 py-3">
        <div class="flex items-center justify-between gap-3">
          <div class="min-w-0">
            <div class="text-sm font-medium">
              {anchorDateFormatter.format(anchorDate)}
            </div>
            <div class="text-xs text-muted-foreground">
              Relative offsets in the template will resolve against this date.
            </div>
          </div>
          <Checkbox
            checked={showAnchorPicker}
            onchange={(checked) => showAnchorPicker = checked}
          >
            Pick date to anchor by
          </Checkbox>
        </div>
      </div>
      {#if showAnchorPicker}
        <DatePicker
          bind:value={anchorValue}
          anchorYear={anchorDate.getFullYear()}
          side="start"
          exactOnly={true}
          showYearInput={false}
        />
      {/if}
    </div>

    {#if previewButtonMode}
      <button
        type="button"
        class="w-full rounded-lg border border-muted-foreground/30 bg-muted/20 px-3 py-2 text-sm text-left hover:bg-muted/30 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]"
        onclick={() => {
          showPreview = true;
        }}
        disabled={showPreview}
      >
        {showPreview ? previewActiveLabel : previewLabel}
      </button>
    {:else}
      <div class="rounded-lg border bg-muted/20 px-3 py-3">
        <Checkbox bind:checked={showPreview}>
          {previewLabel}
        </Checkbox>
      </div>
    {/if}

    <button
      type="button"
      class="w-full rounded-lg border border-primary/50 bg-primary/10 text-primary px-3 py-2 text-sm font-semibold hover:bg-primary/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      onclick={() => void handleApply()}
      disabled={!selectedTemplateId || applyPending}
    >
      {applyPending ? 'Applying...' : 'Apply template'}
    </button>
  {/if}
</div>
