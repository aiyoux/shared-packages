<script lang="ts">
  /**
   * Design-system level meter — generalizes sign-dictionary's StrengthSelector
   * (5 bars, 4px wide, ascending 4/7/10/13/16px) to strength / confidence /
   * signal / progress. Wireframe bars, active ones take the accent.
   */
  let {
    value = 0,
    max = 5,
    label,
    /** Override the active-bar color, e.g. by severity: (i) => value <= 2 ? 'var(--text-muted)' : 'var(--accent)' */
    barColor,
    class: className = ''
  }: {
    value?: number;
    max?: number;
    label?: string;
    barColor?: (index: number) => string;
    class?: string;
  } = $props();
</script>

<div
  class="ds-level-meter {className}"
  role="meter"
  aria-valuenow={value}
  aria-valuemin={0}
  aria-valuemax={max}
  aria-label={label}
>
  {#if label}<span class="ds-level-meter__label">{label}</span>{/if}
  <div class="ds-level-meter__bars">
    {#each Array(max) as _, i}
      <span
        class="ds-level-meter__bar {i < value ? 'is-active' : ''}"
        style={i < value && barColor ? `background: ${barColor(i)}; border-color: ${barColor(i)};` : ''}
      ></span>
    {/each}
  </div>
</div>

<style>
  .ds-level-meter {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .ds-level-meter__label {
    font-size: 0.85rem;
    color: var(--text-secondary);
  }
  .ds-level-meter__bars {
    display: flex;
    align-items: flex-end;
    gap: 4px;
  }
  .ds-level-meter__bar {
    width: 4px;
    border-radius: 2px;
    background: var(--surface-2);
    border: 1px solid var(--line-strong);
  }
  .ds-level-meter__bar:nth-child(1) { height: 4px; }
  .ds-level-meter__bar:nth-child(2) { height: 7px; }
  .ds-level-meter__bar:nth-child(3) { height: 10px; }
  .ds-level-meter__bar:nth-child(4) { height: 13px; }
  .ds-level-meter__bar:nth-child(5) { height: 16px; }
  .ds-level-meter__bar.is-active {
    background: var(--accent);
    border-color: var(--accent);
  }
</style>
