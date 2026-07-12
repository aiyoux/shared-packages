<script lang="ts">
  import type { AppRuntime } from '../sync/runtime.ts';
  import type { Item } from '../types.ts';
  import { cn } from '@modular-app/ui';

  let {
    runtime,
    sourceRecordId,
    referenceId,
    class: className = '',
    ...rest
  }: {
    runtime: AppRuntime | null | undefined;
    sourceRecordId: string;
    referenceId: string;
    class?: string;
    [key: string]: any;
  } = $props();

  let isFetching = $state(false);

  $effect(() => {
    const rt = runtime;
    if (!rt || !sourceRecordId) return;

    if (!rt.cache.getItem(sourceRecordId)) {
      isFetching = true;
      rt.fetchAndCache(
        {
          type: 'FetchRecordGraph',
          id: sourceRecordId,
          includeParents: false,
          includeChildren: false
        },
        15000
      )
      .finally(() => {
        isFetching = false;
      });
    }
  });

  let item = $derived(runtime?.cache.getItem(sourceRecordId) as Item | undefined ?? null);

  function getReferenceText(markup: string | undefined, refId: string): string | null {
    if (!markup) return null;
    if (typeof DOMParser !== 'undefined') {
      try {
        const parser = new DOMParser();
        const doc = parser.parseFromString(markup, 'text/html');
        const element = doc.querySelector(`[data-reference-id="${refId}"]`);
        if (element) {
          return element.textContent || '';
        }
      } catch (e) {
        console.error('Error parsing markup for reference ID', e);
      }
    }
    return null;
  }

  let refText = $derived(item ? getReferenceText(item.markup, referenceId) : null);
  let status = $derived.by(() => {
    if (isFetching && !item) return 'loading';
    if (!item) return 'missing_item';
    if (refText === null) return 'missing_reference';
    return 'ok';
  });

  const recordHref = $derived(`/records/${sourceRecordId.replace(/^records:/, '')}`);
</script>

{#if status === 'loading'}
  <span class={cn('animate-pulse text-xs text-[var(--color-muted-foreground)]', className)} {...rest}>
    Loading reference...
  </span>
{:else if status === 'missing_item'}
  <span class={cn('text-xs font-semibold text-[var(--color-destructive,#dc2626)]', className)} {...rest}>
    Item missing
  </span>
{:else if status === 'missing_reference'}
  <a
    href={recordHref}
    class={cn('text-xs font-semibold text-[var(--color-warning,#d97706)] hover:underline decoration-1 underline-offset-2', className)}
    onclick={(e) => e.stopPropagation()}
    {...rest}
  >
    Reference missing - click to view item
  </a>
{:else}
  <a
    href={recordHref}
    class={cn('text-[var(--color-primary)] hover:underline decoration-1 underline-offset-2 font-medium', className)}
    onclick={(e) => e.stopPropagation()}
    {...rest}
  >
    {refText}
  </a>
{/if}
