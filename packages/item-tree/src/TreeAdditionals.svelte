<script lang="ts">
  import type { AppRuntime } from '@modular-app/module-sdk';
  import { isProgressAdditional } from '@modular-app/module-sdk';

  let {
    additionals = [],
    runtime = null,
    itemId = null,
    placement = 'inline',
    labelFor = null
  }: {
    additionals?: any[];
    runtime?: AppRuntime | null | undefined;
    itemId?: string | null;
    /** 'inline' = compact right-column (truncated, shrink-0); 'below-label' = wrapping row beneath the label. */
    placement?: 'inline' | 'below-label';
    /**
     * Module-supplied labeler. Called first, before the built-in labelForAdditional;
     * a non-null string wins. This is how module-defined additional types (e.g.
     * scripture, publication, food_nutrition) get readable badges without item-tree
     * depending on any module. Return null to defer to the built-in handler.
     */
    labelFor?: ((additional: any) => string | null) | null;
  } = $props();

  function resolveLabel(additional: any): string | null {
    const override = labelFor?.(additional);
    if (override != null) return override;
    return labelForAdditional(additional);
  }

  function formatCurrency(minor: number, currency: string): string {
    const major = (minor / 100).toFixed(2);
    return `${currency} ${major}`;
  }

  /** Universal net: turn a type slug like "timeline_settings" into "Timeline settings"
   *  so every additional type — including module config/metadata types with no value
   *  field — renders *something* rather than vanishing. Module-aware value formatting
   *  is supplied by the consumer via the `labelFor` override (called before this). */
  function humanizeType(type: string): string {
    return type.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
  }

  function labelForAdditional(additional: any): string | null {
    if (typeof additional !== 'object' || additional === null) return null;

    const type = additional.type;

    // Progress is rendered separately in RecordTreeView
    if (type === 'pg') return null;

    // Date additional
    if (type === 'date') {
      const dateInfo = additional.date_info;
      if (dateInfo && typeof dateInfo === 'object') {
        const tr = dateInfo.value;
        if (tr && typeof tr === 'object') {
          if (typeof tr.date === 'string') return tr.date;
          if (typeof tr.start === 'string') return tr.start;
          if (typeof tr.base === 'string') return tr.base;
        }
        if (typeof dateInfo.value === 'string') return dateInfo.value;
      }
      return null;
    }

    // Distance additional
    if (type === 'distance') {
      const val = additional.value;
      const unit = additional.unit;
      if (typeof val === 'number' && typeof unit === 'string') {
        return `${val} ${unit}`;
      }
      const meters = additional.meters;
      if (typeof meters === 'number') {
        return `${meters} m`;
      }
      return null;
    }

    // Duration additional
    if (type === 'duration') {
      const val = additional.value;
      const unit = additional.unit;
      if (typeof val === 'number' && typeof unit === 'string') {
        return `${val} ${unit}`;
      }
      const seconds = additional.seconds;
      if (typeof seconds === 'number') {
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        if (h > 0 && m > 0) return `${h}h ${m}m`;
        if (h > 0) return `${h}h`;
        if (m > 0) return `${m}m`;
        return `${seconds}s`;
      }
      return null;
    }

    // Transaction additional
    if (type === 'transaction') {
      const amount = additional.amount_minor;
      const currency = additional.currency;
      if (typeof amount === 'number' && typeof currency === 'string') {
        const major = (amount / 100).toFixed(2);
        const sign = additional.debit_credit === 'debit' ? '-' : '+';
        return `${sign}${currency} ${major}`;
      }
      return null;
    }

    // Exercise Performance additional
    if (type === 'exercise_performance') {
      const { modality, weight, weight_unit, reps, repeat_count, distance, distance_unit, duration, duration_unit } = additional;
      if (modality === 'Strength' || modality === 'Calisthenics') {
        const parts = [];
        if (weight != null) parts.push(`${weight}${weight_unit || 'kg'}`);
        if (reps != null) parts.push(`${reps} reps`);
        if (repeat_count != null && repeat_count > 1) parts.push(`x ${repeat_count} sets`);
        return parts.length > 0 ? parts.join(' ') : 'Workout logged';
      }
      if (modality === 'Endurance') {
        const parts = [];
        if (distance != null) parts.push(`${distance}${distance_unit || 'km'}`);
        if (duration != null) parts.push(`in ${duration}${duration_unit || 'min'}`);
        return parts.length > 0 ? parts.join(' ') : 'Workout logged';
      }
      return 'Workout logged';
    }

    // Map Element additional
    if (type === 'map_element') {
      const kind = additional.kind || 'Custom';
      const geomType = additional.geometry?.type || 'Element';
      return `[${kind}: ${geomType}]`;
    }

    // Account balance additional
    if (type === 'account_balance') {
      const amount = additional.balance_minor;
      const currency = additional.currency;
      if (typeof amount === 'number' && typeof currency === 'string') {
        return formatCurrency(amount, currency);
      }
      return null;
    }

    // Fallback for generic / legacy shapes
    const value = additional.value ?? additional.name ?? additional.label ?? additional.currency;
    if (typeof value === 'string') {
      const trimmed = value.trim();
      return trimmed.length > 0 ? trimmed : null;
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      return String(value);
    }
    // Universal net (see humanizeType): never render nothing. A type slug is
    // always available on a well-formed additional, so this guarantees coverage
    // of every additional type without item-tree knowing about any module.
    if (typeof type === 'string' && type.length > 0) {
      return humanizeType(type);
    }
    return null;
  }
</script>

{#if additionals && additionals.length > 0}
  <div class={placement === 'below-label' ? 'flex flex-wrap items-center gap-1 mt-1' : 'flex items-center gap-1 overflow-hidden shrink-0'}>
    {#each additionals as add (add.id ?? add.type)}
      {#if !isProgressAdditional(add)}
        {@const label = resolveLabel(add)}
        {#if label}
          <div
            class="text-[0.65rem] px-1.5 py-0.5 rounded bg-[var(--color-muted)] text-[var(--color-foreground)] flex items-center {placement === 'below-label' ? 'max-w-[200px]' : 'max-w-[80px]'} truncate"
            title={add.type}
          >
            <span class="truncate">{label}</span>
          </div>
        {/if}
      {/if}
    {/each}
  </div>
{/if}
