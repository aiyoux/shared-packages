<script lang="ts">
  import { X } from '@lucide/svelte';
  import { MINUTE_MS } from '@modular-app/ui/date';
  import OperationStatusBadge from './OperationStatusBadge.svelte';
  import { dismissOperation, type OperationRecord } from './operation-feed.svelte.js';
  import { cn } from '@modular-app/ui';

  type Variant = 'panel' | 'inline' | 'strip';

  let {
    operations = [],
    variant = 'panel',
    emptyMessage = 'No operations for this filter.',
    showScope = false,
    hideWhenEmpty = false,
    class: className = ''
  }: {
    operations?: OperationRecord[];
    variant?: Variant;
    emptyMessage?: string;
    showScope?: boolean;
    hideWhenEmpty?: boolean;
    class?: string;
  } = $props();

  function formatRelativeTime(timestamp: number): string {
    const deltaMs = Date.now() - timestamp;
    const deltaMinutes = Math.floor(deltaMs / MINUTE_MS);
    if (deltaMinutes <= 0) return 'just now';
    if (deltaMinutes < 60) return `${deltaMinutes}m ago`;
    const deltaHours = Math.floor(deltaMinutes / 60);
    if (deltaHours < 24) return `${deltaHours}h ago`;
    const deltaDays = Math.floor(deltaHours / 24);
    return `${deltaDays}d ago`;
  }
</script>

{#if operations.length > 0 || !hideWhenEmpty}
  <div class={cn(variant === 'strip' ? 'space-y-1' : 'space-y-2', className)}>
    {#if operations.length > 0}
      {#each operations as operation (operation.id)}
        <article
          class={cn(
            'text-[var(--color-foreground)]',
            variant === 'strip'
              ? 'rounded-none border-0 bg-transparent px-0 py-0 shadow-none'
              : variant === 'inline'
                ? 'rounded-[var(--radius-lg)] border border-[var(--color-border)]/80 bg-[color-mix(in_srgb,var(--color-panel),transparent_22%)] px-3 py-3'
                : 'rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[color-mix(in_srgb,var(--color-panel),transparent_8%)] px-3 py-3'
          )}
        >
          <div class={cn('flex gap-3', variant === 'strip' ? 'items-center' : 'items-start')}>
            <div class={cn('min-w-0 flex-1', variant === 'strip' ? 'flex items-center gap-2' : 'space-y-2')}>
              <div class="flex flex-wrap items-center gap-2">
                <OperationStatusBadge status={operation.status} />
                {#if showScope}
                  <span class="rounded-full bg-[var(--color-muted)] px-2 py-1 text-[10px] font-medium uppercase tracking-[0.12em] text-[var(--color-muted-foreground)]">
                    {operation.scope}
                  </span>
                {/if}
                {#if operation.count > 1}
                  <span class="rounded-full bg-[var(--color-muted)] px-2 py-1 text-[10px] font-medium text-[var(--color-foreground)]">
                    x{operation.count}
                  </span>
                {/if}
                <span class="text-[11px] text-[var(--color-muted-foreground)]">
                  {formatRelativeTime(operation.lastAt)}
                </span>
              </div>

              {#if variant === 'strip'}
                <div class="min-w-0 flex-1 truncate text-sm">
                  <span class="font-medium">{operation.title}</span>
                  {#if operation.message}
                    <span class="text-[var(--color-muted-foreground)]">: {operation.message}</span>
                  {/if}
                </div>
              {:else}
                <div class="space-y-1">
                  <p class="text-sm font-semibold leading-5">{operation.title}</p>
                  {#if operation.message}
                    <p class="text-sm leading-5 text-[var(--color-muted-foreground)]">{operation.message}</p>
                  {/if}
                  {#if operation.detail}
                    <p class="text-xs leading-5 text-[var(--color-muted-foreground)]/90">{operation.detail}</p>
                  {/if}
                </div>
              {/if}
            </div>

            {#if operation.cancel}
              <button
                type="button"
                class="rounded-[var(--radius-sm)] border border-[var(--color-border)] px-2 py-1 text-[11px] font-medium text-[var(--color-muted-foreground)] transition hover:border-[var(--color-destructive)]/60 hover:text-[var(--color-destructive)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]"
                onclick={() => operation.cancel?.()}
                aria-label="Cancel operation"
                title="Cancel this queued operation"
              >
                Cancel
              </button>
            {/if}
            {#if operation.retry}
              <button
                type="button"
                class="rounded-[var(--radius-sm)] border border-[var(--color-border)] px-2 py-1 text-[11px] font-medium text-[var(--color-muted-foreground)] transition hover:border-[var(--color-primary)]/60 hover:text-[var(--color-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]"
                onclick={() => operation.retry?.()}
                aria-label="Retry operation"
                title="Retry this failed operation"
              >
                Retry
              </button>
            {/if}
            {#if operation.keepMine || operation.takeTheirs}
              <div class={cn('flex gap-1.5', variant === 'strip' ? '' : 'shrink-0')}>
                {#if operation.keepMine}
                  <button
                    type="button"
                    class="rounded-[var(--radius-sm)] border border-amber-500/40 px-2 py-1 text-[11px] font-medium text-amber-300 transition hover:bg-amber-500/12 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]"
                    onclick={() => operation.keepMine?.()}
                    aria-label="Keep my edit, overwrite the server"
                    title="Force your edit through, overwriting the other change"
                  >
                    Keep mine
                  </button>
                {/if}
                {#if operation.takeTheirs}
                  <button
                    type="button"
                    class="rounded-[var(--radius-sm)] border border-[var(--color-border)] px-2 py-1 text-[11px] font-medium text-[var(--color-muted-foreground)] transition hover:border-amber-500/60 hover:text-amber-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]"
                    onclick={() => operation.takeTheirs?.()}
                    aria-label="Discard my edit, take the server's version"
                    title="Discard your edit and adopt the other change"
                  >
                    Take theirs
                  </button>
                {/if}
              </div>
            {/if}
            {#if operation.dismissible}
              <button
                type="button"
                class="rounded-[var(--radius-sm)] p-1 text-[var(--color-muted-foreground)] transition hover:bg-[var(--color-muted)] hover:text-[var(--color-foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]"
                onclick={() => dismissOperation(operation.id)}
                aria-label="Dismiss operation"
                title="Dismiss operation"
              >
                <X class="size-4" />
              </button>
            {/if}
          </div>
        </article>
      {/each}
    {:else}
      <div
        class={cn(
          'rounded-[var(--radius-lg)] border border-dashed border-[var(--color-border)] px-3 py-6 text-sm text-[var(--color-muted-foreground)]',
          variant === 'inline' || variant === 'strip'
            ? 'bg-[color-mix(in_srgb,var(--color-panel),transparent_50%)]'
            : 'bg-transparent'
        )}
      >
        {emptyMessage}
      </div>
    {/if}
  </div>
{/if}
