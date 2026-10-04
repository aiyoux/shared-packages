<script lang="ts">
  import { cn } from './utils.ts';
  import { onMount, tick } from 'svelte';
  import type { TabItem } from './tabs.ts';

  let {
    items = [],
    value = $bindable<string>(),
    onChange,
    variant = 'underline',
    class: className = '',
    tabClass = '',
    indicatorClass = '',
    style = '',
    activeIndicatorStyle = ''
  }: {
    items: TabItem[];
    value: string;
    onChange?: (newValue: string) => void;
    variant?: 'underline' | 'pill';
    class?: string;
    tabClass?: string;
    indicatorClass?: string;
    style?: string;
    activeIndicatorStyle?: string;
  } = $props();

  let containerRef = $state<HTMLElement | null>(null);
  let indicatorStyle = $state({ left: 0, width: 0, opacity: 0 });
  let indicatorHasMeasured = $state(false);
  let resizeObserver: ResizeObserver | null = null;
  let rafId: number | null = null;

  function updateIndicator() {
    if (!containerRef) return;
    const activeItem = containerRef.querySelector(
      `[data-tab-item][data-value="${value}"]`
    ) as HTMLElement | null;
    if (activeItem) {
      const containerRect = containerRef.getBoundingClientRect();
      const itemRect = activeItem.getBoundingClientRect();
      indicatorStyle = {
        left: itemRect.left - containerRect.left,
        width: itemRect.width,
        opacity: 1
      };
      indicatorHasMeasured = true;
    } else {
      indicatorStyle = { ...indicatorStyle, opacity: 0 };
    }
  }

  async function scheduleIndicatorUpdate() {
    await tick();
    if (rafId !== null) cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(() => {
      updateIndicator();
      rafId = null;
    });
  }

  $effect(() => {
    value;
    items;
    void scheduleIndicatorUpdate();
  });

  onMount(() => {
    void scheduleIndicatorUpdate();

    resizeObserver = new ResizeObserver(() => {
      void scheduleIndicatorUpdate();
    });

    if (containerRef) resizeObserver.observe(containerRef);
    window.addEventListener('resize', scheduleIndicatorUpdate);

    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener('resize', scheduleIndicatorUpdate);
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  });

  function selectTab(newValue: string, disabled = false) {
    if (disabled) return;
    value = newValue;
    onChange?.(newValue);
  }
</script>

<div
  bind:this={containerRef}
  data-variant={variant}
  class={cn(
    'ui-tabs',
    variant === 'pill'
      ? 'relative inline-flex items-center gap-1 rounded-[var(--radius-lg)] border border-[var(--color-border)]/60 bg-[var(--color-muted)] p-1'
      : 'relative flex items-center border-b border-[var(--color-border)]/50',
    className
  )}
  style={style}
  role="tablist"
>
  {#each items as item (item.value)}
    {@const isSelected = value === item.value}
    <div class="ui-tab-item relative flex items-center group/tab" data-tab-item data-value={item.value}>
      <button
        type="button"
        role="tab"
        aria-selected={isSelected}
        disabled={item.disabled}
        data-testid={item.testId}
        class={cn(
          'ui-tab',
          variant === 'pill'
            ? 'relative rounded-[var(--radius-md)] px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-2'
            : 'relative py-3 px-4 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-2',
          variant === 'pill'
            ? isSelected
              ? 'bg-[var(--color-panel)] text-[var(--color-foreground)] shadow-sm'
              : 'text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)]'
            : isSelected
              ? 'text-foreground'
              : 'text-muted-foreground hover:text-foreground',
          tabClass
        )}
        onclick={() => selectTab(item.value, item.disabled)}
      >
        {#if item.icon}
          {@const Icon = item.icon}
          <Icon class="ui-tab-icon size-4" />
        {/if}
        {item.label}
      </button>

      {#if item.onClose}
        <button
          type="button"
          class="ui-tab-close size-5 flex items-center justify-center rounded-full hover:bg-muted text-muted-foreground hover:text-foreground transition-all mr-2 -ml-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
          onclick={(e) => {
            e.stopPropagation();
            item.onClose?.();
          }}
          aria-label="Close tab"
          title="Close tab"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2.5"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M18 6 6 18" />
            <path d="m6 6 12 12" />
          </svg>
        </button>
      {/if}
    </div>
  {/each}

  <!-- Sliding Indicator -->
  {#if variant === 'underline'}
    <div
      class={cn(
        'ui-tab-indicator absolute bottom-0 h-0.5 bg-primary ease-out',
        indicatorHasMeasured
          ? 'transition-[left,width,opacity] duration-200'
          : 'transition-none',
        indicatorClass
      )}
      class:measured={indicatorHasMeasured}
      style="left: {indicatorStyle.left}px; width: {indicatorStyle.width}px; opacity: {indicatorStyle.opacity};{activeIndicatorStyle ? ' ' + activeIndicatorStyle : ''}"
    ></div>
  {/if}
</div>


<style>
  /* Tabs also render in hosts without Tailwind. Utilities remain available
     for callers to override these defaults through the existing class props. */
  @layer primitives {
    .ui-tabs {
      position: relative;
      display: flex;
      align-items: center;
      min-width: 0;
      border-bottom: 1px solid var(--color-border);
    }

    .ui-tabs[data-variant='pill'] {
      display: inline-flex;
      flex-wrap: wrap;
      gap: 4px;
      padding: 4px;
      border: 1px solid var(--color-border);
      border-radius: var(--radius-lg);
      background: var(--color-muted);
    }

    .ui-tab-item {
      position: relative;
      display: flex;
      align-items: center;
      flex-shrink: 0;
    }

    .ui-tab {
      position: relative;
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 12px 16px;
      border: 0;
      background: transparent;
      color: var(--color-muted-foreground);
      font: inherit;
      font-size: 0.875rem;
      font-weight: 500;
      white-space: nowrap;
      cursor: pointer;
      transition: color var(--dur-fast), background-color var(--dur-fast);
    }

    .ui-tabs[data-variant='pill'] .ui-tab {
      padding: 8px 12px;
      border-radius: var(--radius-md);
    }

    .ui-tab[aria-selected='true'],
    .ui-tab:hover:not(:disabled),
    .ui-tab-close:hover {
      color: var(--color-foreground);
    }

    .ui-tabs[data-variant='pill'] .ui-tab[aria-selected='true'] {
      background: var(--color-panel);
    }

    .ui-tab:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }

    .ui-tab:focus-visible,
    .ui-tab-close:focus-visible {
      outline: 2px solid var(--color-primary);
      outline-offset: 2px;
    }

    .ui-tab :global(.ui-tab-icon) {
      width: 1rem;
      height: 1rem;
      flex-shrink: 0;
    }

    .ui-tab-close {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 20px;
      height: 20px;
      margin: 0 8px 0 -4px;
      padding: 0;
      border: 0;
      border-radius: var(--radius-full);
      background: transparent;
      color: var(--color-muted-foreground);
      cursor: pointer;
    }

    .ui-tab-close:hover {
      background: var(--color-muted);
    }

    .ui-tab-indicator {
      position: absolute;
      bottom: 0;
      height: 2px;
      background: var(--color-primary);
    }

    .ui-tab-indicator.measured {
      transition: left 200ms ease-out, width 200ms ease-out, opacity 200ms ease-out;
    }
  }
</style>
