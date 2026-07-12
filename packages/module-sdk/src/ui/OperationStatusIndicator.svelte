<script lang="ts">
  import { CheckCircle2, AlertCircle, X } from '@lucide/svelte';
  import { Popover } from '@modular-app/ui';
  import OperationFeedList from './OperationFeedList.svelte';
  import { getOperations, isOperationActiveStatus, type OperationRecord } from './operation-feed.svelte.js';
  import { cn } from '@modular-app/ui';

  let {
    scope,
    context,
    class: className = '',
    placement = 'bottom-end'
  }: {
    scope?: string;
    context?: string;
    class?: string;
    placement?: 'top-start' | 'top-end' | 'bottom-start' | 'bottom-end' | 'left' | 'right';
  } = $props();

  let open = $state(false);

  const queryOperations = $derived.by(() => {
    return getOperations({ scope, context });
  });

  const status = $derived.by(() => {
    const operations = queryOperations;
    const hasFailed = operations.some(op => op.status === 'failed');
    const hasActive = operations.some(op => isOperationActiveStatus(op.status));
    
    if (hasFailed) return 'failed';
    if (hasActive) return 'active';
    if (operations.length === 0) return 'idle';
    return 'success';
  });

  const Icon = $derived.by(() => {
    const s = status;
    if (s === 'failed') return AlertCircle;
    return CheckCircle2;
  });

  const buttonClasses = $derived.by(() => {
    const s = status;
    return cn(
      'inline-flex items-center justify-center rounded-full p-1.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]',
      s === 'failed' 
        ? 'bg-red-500/15 text-red-400 hover:bg-red-500/25' 
        : s === 'active'
          ? 'bg-[var(--color-primary)]/15 text-[var(--color-primary)] animate-pulse'
          : 'bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25',
      className
    );
  });
</script>

<Popover
  bind:open
  {placement}
  contentClass="rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-panel)] p-4 shadow-lg w-80 max-h-[400px] overflow-y-auto"
>
  {#snippet trigger({ ref })}
    <button
      type="button"
      use:ref
      class={buttonClasses}
      aria-label="View operation status"
      title={status === 'failed' ? 'Some operations failed' : status === 'active' ? 'Operations in progress' : 'All operations successful'}
      onclick={() => open = !open}
    >
      {#if status === 'failed'}
        <AlertCircle class="size-4" />
      {:else}
        <CheckCircle2 class="size-4" />
      {/if}
    </button>
  {/snippet}

  {#snippet content()}
    <div class="space-y-3">
      <div class="flex items-center justify-between">
        <span class="text-sm font-semibold">Operations</span>
        <button
          type="button"
          class="rounded-[var(--radius-sm)] p-1 text-[var(--color-muted-foreground)] transition hover:bg-[var(--color-muted)] hover:text-[var(--color-foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]"
          onclick={() => open = false}
          aria-label="Close"
        >
          <X class="size-4" />
        </button>
      </div>
      <OperationFeedList
        operations={queryOperations}
        variant="inline"
        emptyMessage="No recent operations."
      />
    </div>
  {/snippet}
</Popover>
