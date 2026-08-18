<script lang="ts">
  /**
   * Design-system sidebar — a hover-expand desktop rail + slide-in mobile
   * overlay, driven by a flat list of nav items. Generalized from
   * sign-dictionary's Sidebar.svelte (the design-system plan's "Replace"
   * target) and the visual pattern modular-app's AppSidebar/SidebarNavTree
   * established (26px-scale rows, icon+label, rail affordances).
   *
   * modular-app's own sidebar is not adopted directly — it's deeply coupled
   * to that app's domain (activity feed, reminders, connection state, ~50
   * props) and isn't a portable component as it stands. This primitive
   * captures the reusable shape (item list → rail/overlay) any app can
   * drive; a future modular-app pass that decouples its own component could
   * consume this instead of maintaining a parallel implementation.
   */
  import type { Component } from 'svelte';

  export type SidebarNavItem = {
    id: string;
    href: string;
    label: string;
    icon: Component<{ size?: number }>;
    show?: boolean;
    active?: boolean;
    onclick?: (event: MouseEvent) => void;
  };

  let {
    items,
    isMobile = false,
    isOpen = $bindable(false),
    title,
    /** Fixed-position offset from the viewport top, e.g. below a sticky header. */
    offsetTop = 0,
    /** Stacking order — pass the app's own scale if it has one. */
    zIndex = 40,
    class: className = ''
  }: {
    items: SidebarNavItem[];
    isMobile?: boolean;
    isOpen?: boolean;
    title?: string;
    offsetTop?: number;
    zIndex?: number;
    class?: string;
  } = $props();

  let isExpanded = $state(false);
  const visibleItems = $derived(items.filter((item) => item.show !== false));
</script>

{#if isMobile}
  {#if isOpen}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <button
      type="button"
      class="ds-sidebar-overlay"
      style:z-index={zIndex - 1}
      aria-label="Close menu"
      onclick={() => (isOpen = false)}
      onkeydown={(e) => {
        if (e.key === 'Escape') isOpen = false;
      }}
    ></button>
  {/if}

  <aside
    class="ds-sidebar ds-sidebar--mobile {className}"
    class:is-open={isOpen}
    style:z-index={zIndex}
    aria-hidden={!isOpen}
  >
    {#if title}
      <div class="ds-sidebar__header">
        <span class="ds-sidebar__title">{title}</span>
        <button class="ds-sidebar__close" onclick={() => (isOpen = false)} aria-label="Close menu">✕</button>
      </div>
    {/if}
    <nav class="ds-sidebar__nav" aria-label="Main">
      {#each visibleItems as item (item.id)}
        <a href={item.href} class="ds-sidebar__item" class:is-active={item.active} onclick={item.onclick}>
          <span class="ds-sidebar__icon"><item.icon size={20} /></span>
          <span class="ds-sidebar__label is-visible">{item.label}</span>
        </a>
      {/each}
    </nav>
  </aside>
{:else}
  <aside
    class="ds-sidebar ds-sidebar--desktop {className}"
    class:is-expanded={isExpanded}
    style:top="{offsetTop}px"
    style:z-index={zIndex}
    onmouseenter={() => (isExpanded = true)}
    onmouseleave={() => (isExpanded = false)}
    onfocusin={() => (isExpanded = true)}
    onfocusout={(e) => {
      const next = e.relatedTarget as Node | null;
      if (!e.currentTarget.contains(next)) isExpanded = false;
    }}
  >
    <nav class="ds-sidebar__nav" aria-label="Main">
      {#each visibleItems as item (item.id)}
        <a
          href={item.href}
          class="ds-sidebar__item"
          class:is-active={item.active}
          onclick={item.onclick}
          title={!isExpanded ? item.label : ''}
        >
          <span class="ds-sidebar__icon"><item.icon size={20} /></span>
          <span class="ds-sidebar__label" class:is-visible={isExpanded}>{item.label}</span>
        </a>
      {/each}
    </nav>
  </aside>
{/if}

<style>
  .ds-sidebar {
    background: var(--surface-1);
    backdrop-filter: blur(20px);
    -webkit-backdrop-filter: blur(20px);
    border-right: 1px solid var(--line-hairline);
    display: flex;
    flex-direction: column;
    transition:
      width var(--dur) var(--ease),
      transform var(--dur) var(--ease);
  }

  .ds-sidebar--desktop {
    position: fixed;
    top: 0;
    left: 0;
    bottom: 0;
    width: 64px;
  }

  .ds-sidebar--desktop.is-expanded {
    width: 200px;
    box-shadow: 20px 0 50px rgb(0 0 0 / 0.5);
  }

  .ds-sidebar--mobile {
    position: fixed;
    top: 0;
    left: 0;
    bottom: 0;
    width: 280px;
    transform: translateX(-100%);
  }

  .ds-sidebar--mobile.is-open {
    transform: translateX(0);
    box-shadow: 20px 0 50px rgb(0 0 0 / 0.5);
  }

  .ds-sidebar-overlay {
    position: fixed;
    inset: 0;
    background: rgb(0 0 0 / 0.6);
    backdrop-filter: blur(4px);
    border: none;
    padding: 0;
    cursor: default;
  }

  .ds-sidebar__header {
    height: 56px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 16px;
    border-bottom: 1px solid var(--line-hairline);
  }

  .ds-sidebar__title {
    font-weight: 700;
    font-size: var(--text-lg);
    color: var(--text-primary);
  }

  .ds-sidebar__close {
    background: transparent;
    border: none;
    color: var(--text-muted);
    cursor: pointer;
    padding: 8px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: var(--radius-full);
    transition: all var(--dur-fast) var(--ease);
  }

  .ds-sidebar__close:hover {
    background: var(--surface-2);
    color: var(--text-primary);
  }

  .ds-sidebar__nav {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-4) var(--space-3);
  }

  .ds-sidebar__item {
    display: flex;
    align-items: center;
    width: 100%;
    height: 48px;
    border: none;
    background: transparent;
    color: var(--text-secondary);
    cursor: pointer;
    border-radius: var(--radius-md);
    transition: all var(--dur-fast) var(--ease);
    overflow: hidden;
    padding: 0;
    text-decoration: none;
  }

  .ds-sidebar__item:hover {
    background: var(--surface-2);
    color: var(--text-primary);
  }

  .ds-sidebar__item.is-active {
    background: var(--accent-glow);
    color: var(--accent);
  }

  .ds-sidebar__icon {
    width: 40px;
    min-width: 40px;
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .ds-sidebar__label {
    font-size: var(--text-base);
    font-weight: 600;
    white-space: nowrap;
    opacity: 0;
    transition: opacity var(--dur-fast) var(--ease);
    margin-left: var(--space-3);
  }

  .ds-sidebar__label.is-visible {
    opacity: 1;
  }

  .ds-sidebar--desktop:not(.is-expanded) .ds-sidebar__label {
    pointer-events: none;
    width: 0;
    margin-left: 0;
  }

  @media (max-width: 768px) {
    .ds-sidebar--desktop {
      display: none;
    }
  }
</style>
