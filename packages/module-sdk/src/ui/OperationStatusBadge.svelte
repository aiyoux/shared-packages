<script lang="ts">
  import { LoaderCircle, CheckCircle2, AlertCircle, Ban } from '@lucide/svelte';
  import type { OperationStatus } from './operation-feed.svelte.js';
  import { cn } from '@modular-app/ui';

  let {
    status,
    class: className = ''
  }: {
    status: OperationStatus;
    class?: string;
  } = $props();

  const statusConfig: Record<
    OperationStatus,
    { label: string; className: string; icon: typeof LoaderCircle; iconClass?: string }
  > = {
    queued: {
      label: 'Queued',
      className: 'border-[color-mix(in_srgb,var(--color-primary),transparent_48%)] bg-[color-mix(in_srgb,var(--color-primary),transparent_88%)] text-[var(--color-primary)]',
      icon: LoaderCircle,
      iconClass: 'animate-spin'
    },
    running: {
      label: 'Running',
      className: 'border-[color-mix(in_srgb,var(--color-primary),transparent_42%)] bg-[color-mix(in_srgb,var(--color-primary),transparent_84%)] text-[var(--color-primary)]',
      icon: LoaderCircle,
      iconClass: 'animate-spin'
    },
    succeeded: {
      label: 'Done',
      className: 'border-emerald-500/35 bg-emerald-500/12 text-emerald-300',
      icon: CheckCircle2
    },
    failed: {
      label: 'Failed',
      className: 'border-red-500/40 bg-red-500/12 text-red-300',
      icon: AlertCircle
    },
    canceled: {
      label: 'Canceled',
      className: 'border-[var(--color-border)] bg-[var(--color-muted)] text-[var(--color-muted-foreground)]',
      icon: Ban
    }
  };

  const config = $derived(statusConfig[status]);
  const Icon = $derived(config.icon);
</script>

<span
  class={cn(
    'inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.12em]',
    config.className,
    className
  )}
>
  <Icon class={cn('size-3', config.iconClass)} />
  <span>{config.label}</span>
</span>
