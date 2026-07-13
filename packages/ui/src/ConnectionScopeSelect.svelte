<script lang="ts">
  // Grouped multi-runtime scope selector. Mirrors Select.svelte's Popover-based
  // shape (keyboard nav, highlighted row, Check icon) but renders one section
  // per connection (color dot + label header) with that connection's calendar
  // scopes underneath, plus an "All scopes" row per group. `value` is an array
  // of composite tokens (`buildScopeSelectionToken`) so the same component backs
  // both the multi-select calendar header (multiple=true) and the single-target
  // quick-add / DayEventsModal pickers (multiple=false, length-1 array). See
  // [[m7-aggregated-calendar]] and [[shared-packages-yalc-canonical-only]].
  import { Check, ChevronDown } from '@lucide/svelte';
  import Popover from './Popover.svelte';
  import { cn } from './utils.ts';
  import {
    ALL_SCOPES_SENTINEL,
    buildScopeSelectionToken,
    type ConnectionScopeSelectGroup
  } from './connection-scope-select.ts';

  let {
    value = $bindable<string[]>([]),
    groups = [],
    multiple = false,
    placeholder = 'Select scope',
    ariaLabel,
    disabled = false,
    class: className = '',
    contentClass = '',
    onValueChange
  }: {
    value?: string[];
    groups?: ConnectionScopeSelectGroup[];
    multiple?: boolean;
    placeholder?: string;
    ariaLabel?: string;
    disabled?: boolean;
    class?: string;
    contentClass?: string;
    onValueChange?: (value: string[]) => void;
  } = $props();

  let open = $state(false);
  // Highlight is tracked by token (not flat-index) so it stays correct across
  // the header/option mixed render list without index arithmetic.
  let highlightedToken = $state<string | null>(null);

  // Single flat render list: a header row per group, then that group's
  // "All scopes" row + one row per scope. Headers are non-interactive markers
  // (keyboard nav skips them); option rows carry the composite token.
  type FlatItem =
    | { kind: 'header'; group: ConnectionScopeSelectGroup }
    | { kind: 'option'; token: string; label: string; hint: string; runtimeKey: string };

  const flatItems = $derived<FlatItem[]>(
    groups.flatMap((group): FlatItem[] => [
      { kind: 'header', group },
      {
        kind: 'option',
        token: buildScopeSelectionToken(group.runtimeKey, ALL_SCOPES_SENTINEL),
        label: 'All scopes',
        hint: group.connectionLabel,
        runtimeKey: group.runtimeKey
      },
      ...group.scopes.map(
        (scope): FlatItem => ({
          kind: 'option',
          token: buildScopeSelectionToken(group.runtimeKey, scope.id),
          label: scope.text,
          hint: group.connectionLabel,
          runtimeKey: group.runtimeKey
        })
      )
    ])
  );

  const optionItems = $derived(flatItems.filter((item): item is Extract<FlatItem, { kind: 'option' }> => item.kind === 'option'));
  const selectedSet = $derived(new Set(value));

  function labelForToken(token: string): string | null {
    const opt = optionItems.find((o) => o.token === token);
    if (!opt) return null;
    return opt.label === 'All scopes' ? `All scopes · ${opt.hint}` : opt.label;
  }

  const triggerLabel = $derived.by(() => {
    if (value.length === 0) return placeholder;
    if (multiple) {
      if (value.length === 1) return labelForToken(value[0]) ?? `${value.length} scopes`;
      return `${value.length} scopes`;
    }
    return labelForToken(value[0]) ?? placeholder;
  });

  function syncHighlight() {
    highlightedToken = value.length > 0 ? value[0] : null;
    if (highlightedToken === null && optionItems.length > 0) {
      highlightedToken = optionItems[0].token;
    }
  }

  function commit(next: string[]) {
    value = next;
    onValueChange?.(next);
  }

  function selectOption(token: string) {
    if (multiple) {
      const next = value.includes(token)
        ? value.filter((t) => t !== token)
        : [...value, token];
      commit(next);
      // Keep the popover open in multi mode so the user can toggle several.
    } else {
      commit([token]);
      open = false;
    }
  }

  function moveHighlight(direction: 1 | -1) {
    if (optionItems.length === 0) return;
    const currentIndex = highlightedToken
      ? optionItems.findIndex((o) => o.token === highlightedToken)
      : -1;
    if (currentIndex < 0) {
      highlightedToken = direction === 1 ? optionItems[0].token : optionItems[optionItems.length - 1].token;
      return;
    }
    const next = (currentIndex + direction + optionItems.length) % optionItems.length;
    highlightedToken = optionItems[next].token;
  }

  function handleKeyDown(event: KeyboardEvent) {
    if (disabled) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (!open) {
        open = true;
        syncHighlight();
      } else {
        moveHighlight(1);
      }
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) {
        open = true;
        syncHighlight();
      } else {
        moveHighlight(-1);
      }
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (!open) {
        open = true;
        syncHighlight();
        return;
      }
      if (highlightedToken) selectOption(highlightedToken);
    }
  }

  $effect(() => {
    if (!open) return;
    syncHighlight();
  });
</script>

<Popover
  bind:open
  placement="bottom-start"
  contentClass={cn(
    'min-w-[16rem] rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-panel)] p-1 shadow-[0_24px_60px_-28px_rgba(0,0,0,0.65)]',
    contentClass
  )}
>
  {#snippet trigger({ ref })}
    <button
      use:ref
      type="button"
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-label={ariaLabel}
      disabled={disabled}
      class={cn(
        'inline-flex h-11 w-full appearance-none items-center justify-between gap-3 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-input)] px-3 py-2 text-left text-[var(--text-sm)] text-[var(--color-foreground)] shadow-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)] disabled:cursor-not-allowed disabled:opacity-50',
        className
      )}
      onclick={() => {
        open = !open;
      }}
      onkeydown={handleKeyDown}
    >
      <span class={cn('truncate', value.length === 0 && 'text-[var(--color-muted-foreground)]')}>
        {triggerLabel}
      </span>
      <ChevronDown
        class={cn('size-4 shrink-0 text-[var(--color-muted-foreground)] transition-transform', open && 'rotate-180')}
      />
    </button>
  {/snippet}

  {#snippet content()}
    <div
      role="listbox"
      aria-label={ariaLabel}
      aria-multiselectable={multiple || undefined}
      class="max-h-80 overflow-auto py-1"
      onkeydown={handleKeyDown}
      tabindex="-1"
    >
      {#if flatItems.length === 0}
        <div class="px-3 py-4 text-center text-[var(--text-sm)] text-[var(--color-muted-foreground)]">
          No connections
        </div>
      {/if}
      {#each flatItems as item (item.kind === 'header' ? `h:${item.group.runtimeKey}` : `o:${item.token}`)}
        {#if item.kind === 'header'}
          <div class="flex items-center gap-2 px-3 pb-1 pt-2">
            <span
              class="size-2.5 shrink-0 rounded-full"
              style="background-color: {item.group.color}"
              aria-hidden="true"
            ></span>
            <span
              class={cn(
                'truncate text-[var(--text-xsm)] font-semibold uppercase tracking-wide text-[var(--color-muted-foreground)]',
                item.group.scopes.length === 0 && 'italic opacity-70'
              )}
            >
              {item.group.connectionLabel}{#if item.group.scopes.length === 0} · loading…{/if}
            </span>
          </div>
        {:else}
          {@const highlighted = highlightedToken === item.token}
          {@const checked = selectedSet.has(item.token)}
          <button
            type="button"
            role="option"
            aria-selected={checked}
            class={cn(
              'flex w-full appearance-none items-center justify-between gap-3 rounded-[var(--radius-md)] px-3 py-1.5 text-left text-[var(--text-sm)] transition',
              highlighted || checked
                ? 'bg-[var(--color-primary)]/10 text-[var(--color-foreground)]'
                : 'hover:bg-[var(--color-muted)]'
            )}
            onclick={() => selectOption(item.token)}
            onmouseenter={() => {
              highlightedToken = item.token;
            }}
          >
            <span class="grid gap-0.5">
              <span class={cn('font-medium', item.label === 'All scopes' && 'text-[var(--color-muted-foreground)]')}>
                {item.label}
              </span>
              {#if multiple && item.label !== 'All scopes'}
                <span class="text-[var(--text-xsm)] text-[var(--color-muted-foreground)]">{item.hint}</span>
              {/if}
            </span>
            {#if checked}
              <Check class="mt-0.5 size-4 shrink-0 text-[var(--color-primary)]" />
            {/if}
          </button>
        {/if}
      {/each}
    </div>
  {/snippet}
</Popover>