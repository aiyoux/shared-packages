<script lang="ts">
  import { fade, scale } from 'svelte/transition';
  import X from '@lucide/svelte/icons/x';
  import type { Snippet } from 'svelte';
  import { overlay } from '@shared-packages/design-system';
  import { nextDialogTitleId } from './dialogStack.ts';

  interface Props {
    open?: boolean;
    title?: string;
    description?: string;
    /** alertdialog for destructive confirms */
    role?: 'dialog' | 'alertdialog';
    size?: 'sm' | 'md' | 'lg' | 'xl' | 'full';
    closeOnBackdrop?: boolean;
    closeOnEscape?: boolean;
    showClose?: boolean;
    /** Accessible label for the close button; default English — apps pass i18n */
    closeLabel?: string;
    onClose: () => void;
    children?: Snippet;
    footer?: Snippet;
    /** Custom header (wizard eyebrow, secondary actions). Replaces default title block. */
    header?: Snippet;
    /** Optional labelledby override id; default is a unique generated id */
    titleId?: string;
    /** Default true — portal to document.body so layout overflow cannot trap the modal */
    portal?: boolean;
  }

  let {
    open = false,
    title = '',
    description = '',
    role = 'dialog',
    size = 'md',
    closeOnBackdrop = true,
    closeOnEscape = true,
    showClose = true,
    closeLabel = 'Close dialog',
    onClose,
    children,
    footer,
    header,
    titleId,
    portal = true
  }: Props = $props();

  const autoTitleId = nextDialogTitleId();
  const resolvedTitleId = $derived(titleId ?? autoTitleId);
  const sizeClass = $derived(`dialog-size-${size}`);

  /** Move backdrop to document.body when portal is enabled. */
  function portalAction(node: HTMLElement) {
    if (typeof document === 'undefined' || !portal) return;
    document.body.appendChild(node);
    return {
      destroy() {
        if (node.parentNode) {
          node.parentNode.removeChild(node);
        }
      }
    };
  }

</script>

{#if open}
  <div
    class="dialog-backdrop"
    use:overlay={{ kind: 'modal', panel: '.dialog-panel', onClose, closeOnBackdrop, closeOnEscape }}
    use:portalAction
    transition:fade={{ duration: 150 }}
    role="presentation"
  >
    <div
      class="dialog-panel {sizeClass}"
      {role}
      aria-modal="true"
      aria-labelledby={title || titleId ? resolvedTitleId : undefined}
      aria-describedby={description && !header ? `${resolvedTitleId}-desc` : undefined}
      tabindex="-1"
      transition:scale={{ duration: 180, start: 0.97 }}
      onclick={(e) => e.stopPropagation()}
    >
      {#if header || title || showClose}
        <div class="dialog-header">
          <div class="dialog-heading">
            {#if header}
              {@render header()}
            {:else}
              {#if title}
                <h2 id={resolvedTitleId} class="dialog-title">{title}</h2>
              {/if}
              {#if description}
                <p id="{resolvedTitleId}-desc" class="dialog-desc">{description}</p>
              {/if}
            {/if}
          </div>
          {#if showClose}
            <button
              type="button"
              class="dialog-close"
              onclick={onClose}
              aria-label={closeLabel}
            >
              <X size={18} />
            </button>
          {/if}
        </div>
      {/if}

      <div class="dialog-body">
        {#if children}
          {@render children()}
        {/if}
      </div>

      {#if footer}
        <div class="dialog-footer">
          {@render footer()}
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .dialog-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.6);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    display: flex;
    align-items: center;
    justify-content: center;
    /* z-index set inline from nest depth: base + depth * 10 */
    padding: 24px;
  }

  /* Self-contained panel styles (former glass-card + panel). CSS vars with fallbacks. */
  .dialog-panel {
    width: 100%;
    background: var(--bg-secondary, #121218);
    box-shadow: 0 20px 50px rgba(0, 0, 0, 0.45);
    display: flex;
    flex-direction: column;
    max-height: min(90vh, 900px);
    outline: none;
    border: 1px solid var(--border, rgba(255, 255, 255, 0.08));
    border-radius: var(--radius-lg, 8px);
    color: var(--text-primary, #ffffff);
    transition: border-color 0.15s ease, background 0.15s ease;
  }

  .dialog-size-sm {
    max-width: 400px;
  }
  .dialog-size-md {
    max-width: 520px;
  }
  .dialog-size-lg {
    max-width: 720px;
  }
  .dialog-size-xl {
    max-width: 960px;
  }
  .dialog-size-full {
    max-width: min(1100px, 96vw);
    max-height: 94vh;
  }

  .dialog-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    padding: 20px 20px 0;
  }

  .dialog-heading {
    min-width: 0;
    flex: 1;
  }

  .dialog-title {
    margin: 0;
    font-size: 1.15rem;
    font-weight: 700;
    letter-spacing: -0.02em;
  }

  .dialog-desc {
    margin: 6px 0 0;
    color: var(--text-secondary, #9a9ab0);
    font-size: 0.9rem;
    line-height: 1.45;
  }

  /* Self-contained close control (former btn-icon). */
  .dialog-close {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 36px;
    height: 36px;
    padding: 0;
    border-radius: var(--radius-md, 6px);
    background: rgba(255, 255, 255, 0.03);
    border: 1px solid rgba(255, 255, 255, 0.08);
    color: var(--text-secondary, #9a9ab0);
    cursor: pointer;
    transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease;
  }

  .dialog-close:hover {
    background: rgba(255, 255, 255, 0.08);
    color: var(--text-primary, #ffffff);
    border-color: rgba(255, 255, 255, 0.18);
  }

  .dialog-body {
    padding: 16px 20px 20px;
    overflow: auto;
    flex: 1;
    min-height: 0;
  }

  .dialog-footer {
    display: flex;
    justify-content: flex-end;
    gap: 10px;
    padding: 0 20px 20px;
    border-top: 1px solid var(--border, rgba(255, 255, 255, 0.08));
    padding-top: 16px;
  }

  @media (max-width: 640px) {
    .dialog-backdrop {
      padding: 0;
      align-items: stretch;
    }
    .dialog-panel {
      max-width: 100%;
      max-height: 100%;
      height: 100%;
      border-radius: 0;
    }
  }
</style>
