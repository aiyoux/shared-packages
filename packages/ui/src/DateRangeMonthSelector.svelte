<script lang="ts">
  import type { VagueYearCode, VagueMonthCode } from './date';

  let {
    month_selector_open = $bindable(),
    allowVague,
    month_selector_year_mode = $bindable(),
    month_selector_month_mode = $bindable(),
    vagueYear = $bindable(),
    vagueMonth = $bindable(),
    vagueDay = $bindable(),
    exactMonth = $bindable(),
    month_selector_temp_year,
    month_selector_temp_vague_year,
    pending_month_second_click,
    year_range,
    VAGUE_YEAR_ORDER,
    VAGUE_YEARS,
    month_names_short,
    VAGUE_MONTHS,
    handleYearSelect,
    handleVagueYearSelect,
    handleMonthSelect,
    handleVagueMonthSelect,
    handleClearExactMonth,
    monthSelectionFor,
    years_scroll_ref = $bindable(),
    month_selector_months_scroll_ref = $bindable(),
    hovered_month = $bindable()
  }: {
    month_selector_open: boolean;
    allowVague: boolean;
    month_selector_year_mode: 'exact' | 'vague';
    month_selector_month_mode: 'exact' | 'vague';
    vagueYear: string | null;
    vagueMonth: string | null;
    vagueDay: string | null;
    exactMonth: number | null;
    month_selector_temp_year: number | null;
    month_selector_temp_vague_year: string | null;
    pending_month_second_click: boolean;
    year_range: number[];
    VAGUE_YEAR_ORDER: VagueYearCode[];
    VAGUE_YEARS: Record<VagueYearCode, { label: string }>;
    month_names_short: string[];
    VAGUE_MONTHS: Record<VagueMonthCode, { label: string }>;
    handleYearSelect: (year: number) => void;
    handleVagueYearSelect: (code: string) => void;
    handleMonthSelect: (monIdx: number, year?: number) => void;
    handleVagueMonthSelect: (code: string) => void;
    handleClearExactMonth: () => void;
    monthSelectionFor: (point: { year: number; month: number }) => 'single' | 'start' | 'end' | 'preview-start' | 'preview-end' | 'in-range' | 'preview' | 'none';
    years_scroll_ref?: HTMLElement | null;
    month_selector_months_scroll_ref?: HTMLElement | null;
    hovered_month?: { year: number; month: number } | null;
  } = $props();
</script>

{#if month_selector_open}
  <!-- Backdrop overlay -->
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="absolute inset-0 z-[var(--z-sticky)] flex items-center justify-center bg-[var(--color-background)]/60 backdrop-blur-sm p-4 animate-fade-in"
    onclick={() => month_selector_open = false}
  >
    <!-- Modal Card -->
    <div
      class={`w-full ${allowVague ? 'max-w-[520px] h-[min(420px,calc(100%-1rem))]' : 'max-w-[480px] h-[min(390px,calc(100%-1rem))]'} bg-[var(--color-background)] border border-[var(--color-border)] rounded-[var(--radius-lg)] shadow-2xl flex overflow-hidden animate-scale-in`}
      onclick={(e) => e.stopPropagation()}
      role="dialog"
      tabindex="-1"
      aria-label="Select Year and Month"
    >
      <!-- Left Pane: Year List (Scroller) -->
      <div class="w-[100px] border-r border-[var(--color-border)] flex flex-col h-full bg-[var(--color-muted)]/15">
        {#if allowVague}
          <div class="p-1 border-b border-[var(--color-border)] bg-[var(--color-background)] flex gap-0.5 shrink-0">
            <button
              type="button"
              class={`flex-1 py-1 text-[9px] font-bold uppercase rounded-[var(--radius-sm)] transition-all ${
                month_selector_year_mode === 'exact'
                  ? 'bg-[var(--color-muted)] text-[var(--color-foreground)] shadow-xs'
                  : 'text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)]'
              }`}
              onclick={() => {
                month_selector_year_mode = 'exact';
                vagueYear = null;
              }}
            >
              Exact
            </button>
            <button
              type="button"
              class={`flex-1 py-1 text-[9px] font-bold uppercase rounded-[var(--radius-sm)] transition-all ${
                month_selector_year_mode === 'vague'
                  ? 'bg-[var(--color-muted)] text-[var(--color-foreground)] shadow-xs'
                  : 'text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)]'
              }`}
              onclick={() => month_selector_year_mode = 'vague'}
            >
              Approx
            </button>
          </div>
        {:else}
          <div class="px-2 py-2 border-b border-[var(--color-border)] bg-[var(--color-background)] text-center shrink-0">
            <span class="text-[9px] font-bold uppercase tracking-wider text-[var(--color-muted-foreground)]">Year</span>
          </div>
        {/if}

        {#if month_selector_year_mode === 'exact'}
          <div
            bind:this={years_scroll_ref}
            class="flex-1 overflow-y-auto scrollbar-hide py-1"
          >
            {#each year_range as yr}
              {@const isSelected = yr === month_selector_temp_year && !vagueYear}
              <button
                type="button"
                class={`w-full py-1.5 text-center text-xs font-semibold transition-all ${
                  isSelected
                    ? 'bg-[var(--color-primary)] text-[var(--color-primary-foreground)] font-bold shadow-sm'
                    : 'hover:bg-[var(--color-muted)] text-[var(--color-foreground)]'
                }`}
                data-selected={isSelected ? 'true' : 'false'}
                onclick={() => handleYearSelect(yr)}
              >
                {yr}
              </button>
            {/each}
          </div>
        {:else}
          <div class="flex-1 overflow-y-auto scrollbar-hide py-1">
            {#each VAGUE_YEAR_ORDER as yrCode}
              {@const isSelected = yrCode === month_selector_temp_vague_year}
              <button
                type="button"
                class={`w-full py-2 px-1 text-center text-[10px] font-semibold transition-all leading-tight ${
                  isSelected
                    ? 'bg-[var(--color-primary)] text-[var(--color-primary-foreground)] font-bold shadow-sm'
                    : 'hover:bg-[var(--color-muted)] text-[var(--color-foreground)]'
                }`}
                onclick={() => handleVagueYearSelect(yrCode)}
              >
                {VAGUE_YEARS[yrCode].label}
              </button>
            {/each}
          </div>
        {/if}
      </div>

      <!-- Right Pane: Month Selection Grid / List -->
      <div class="flex-1 flex flex-col h-full bg-[var(--color-background)] p-3 min-w-0 relative">
        {#if month_selector_year_mode === 'vague'}
          <!-- Disabled Placeholder for Vague Year Selection -->
          <div class="flex-1 flex flex-col items-center justify-center text-center p-4">
            <div class="rounded-full bg-[var(--color-muted)]/40 p-3 mb-3 text-[var(--color-muted-foreground)]">
              <svg class="size-6" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" d="M18.364 18.364A9 9 0 0 0 5.636 5.636m12.728 12.728A9 9 0 0 1 5.636 5.636m12.728 12.728L5.636 5.636" />
              </svg>
            </div>
            <span class="text-[var(--color-muted-foreground)] text-xs font-semibold leading-relaxed max-w-[180px]">
              Months are not applicable for approximate years.
            </span>
          </div>
          <!-- Header close button -->
          <div class="absolute top-3 right-3 shrink-0">
            <button
              type="button"
              class="text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)] p-1 rounded-full hover:bg-[var(--color-muted)] transition-colors"
              onclick={() => month_selector_open = false}
              aria-label="Close month selector"
            >
              <svg class="size-3.5" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12"/>
              </svg>
            </button>
          </div>
        {:else}
          <!-- Popup Header -->
          <div class="flex items-center justify-between border-b border-[var(--color-border)] pb-1.5 mb-1.5 gap-2 shrink-0">
            {#if allowVague}
              <div class="flex bg-[var(--color-muted)]/40 p-0.5 rounded-[var(--radius-md)] flex-1 max-w-[140px]">
                <button
                  type="button"
                  class={`flex-1 py-0.5 text-[10px] font-bold rounded-[var(--radius-sm)] transition-all ${
                    month_selector_month_mode === 'exact'
                      ? 'bg-[var(--color-background)] text-[var(--color-foreground)] shadow-xs border border-[var(--color-border)]/40'
                      : 'text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)] border border-transparent'
                  }`}
                  onclick={() => month_selector_month_mode = 'exact'}
                >
                  Exact
                </button>
                <button
                  type="button"
                  class={`flex-1 py-0.5 text-[10px] font-bold rounded-[var(--radius-sm)] transition-all ${
                    month_selector_month_mode === 'vague'
                      ? 'bg-[var(--color-background)] text-[var(--color-foreground)] shadow-xs border border-[var(--color-border)]/40'
                      : 'text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)] border border-transparent'
                  }`}
                  onclick={() => month_selector_month_mode = 'vague'}
                >
                  Approx
                </button>
              </div>
            {:else}
              <span class="text-xs font-bold text-[var(--color-foreground)] tracking-wide">
                Select Month ({month_selector_temp_year})
              </span>
            {/if}
            <button
              type="button"
              class="text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)] p-1 rounded-full hover:bg-[var(--color-muted)] transition-colors shrink-0"
              onclick={() => month_selector_open = false}
              aria-label="Close month selector"
            >
              <svg class="size-3.5" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12"/>
              </svg>
            </button>
          </div>

          {#if month_selector_month_mode === 'exact'}
            <div class="mb-2 shrink-0 space-y-1.5">
              {#if allowVague}
                <span class="text-[9px] font-bold uppercase tracking-wider text-[var(--color-muted-foreground)] block">
                  {pending_month_second_click ? 'Choose end month' : 'Choose start month'}
                </span>
              {/if}
              <button
                type="button"
                class={`w-full py-1.5 text-center text-xs font-semibold rounded-[var(--radius-md)] border transition-all ${
                  exactMonth === null && !vagueMonth
                    ? 'bg-[var(--color-primary)] text-[var(--color-primary-foreground)] border-[var(--color-primary)] shadow-sm'
                    : 'bg-[var(--color-background)] hover:bg-[var(--color-muted)] border-[var(--color-border)] text-[var(--color-foreground)] hover:border-transparent'
                }`}
                onclick={handleClearExactMonth}
              >
                No month / whole year
              </button>
            </div>
          {/if}

          <!-- Scrollable List Pane -->
          <div bind:this={month_selector_months_scroll_ref} class="flex-1 overflow-y-auto scrollbar-hide py-0.5 space-y-3 pr-0.5">
            {#if month_selector_month_mode === 'exact'}
              <!-- Months Grid (Exact Months) -->
              <div class="space-y-2">
                <div class="space-y-1.5">
                  {#each year_range as yr}
                    <div class="grid grid-cols-[3.75rem_minmax(0,1fr)] gap-2 rounded-[var(--radius-md)] border border-transparent px-1 py-1" data-year={yr}>
                      <button
                        type="button"
                        class={`self-stretch rounded-[var(--radius-sm)] text-center text-[11px] font-bold transition-all ${
                          yr === month_selector_temp_year && !vagueYear
                            ? 'bg-[var(--color-muted)] text-[var(--color-foreground)]'
                            : 'text-[var(--color-muted-foreground)] hover:bg-[var(--color-muted)] hover:text-[var(--color-foreground)]'
                        }`}
                        onclick={() => handleYearSelect(yr)}
                      >
                        {yr}
                      </button>
                      <div class="grid grid-cols-4 gap-1">
                        {#each month_names_short as monName, monIdx}
                          {@const point = { year: yr, month: monIdx + 1 }}
                          {@const selection = monthSelectionFor(point)}
                          <button
                            type="button"
                            class={`py-1.5 text-center text-xs font-semibold rounded-[var(--radius-md)] border transition-all ${
                              selection === 'single' ||
                              selection === 'start' ||
                              selection === 'end' ||
                              selection === 'preview-start' ||
                              selection === 'preview-end'
                                ? 'bg-[var(--color-primary)] text-[var(--color-primary-foreground)] border-[var(--color-primary)] shadow-sm'
                                : selection === 'in-range' || selection === 'preview'
                                  ? 'bg-[var(--color-primary)]/15 text-[var(--color-foreground)] border-[var(--color-primary)]/30'
                                  : 'bg-[var(--color-background)] hover:bg-[var(--color-muted)] border-[var(--color-border)] text-[var(--color-foreground)] hover:border-transparent'
                            }`}
                            onpointerenter={() => {
                              if (pending_month_second_click) hovered_month = point;
                            }}
                            onclick={() => handleMonthSelect(monIdx, yr)}
                          >
                            {monName}
                          </button>
                        {/each}
                      </div>
                    </div>
                  {/each}
                </div>
              </div>
            {:else}
              <!-- Quarters -->
              <div>
                <span class="text-[9px] font-bold uppercase tracking-wider text-[var(--color-muted-foreground)] mb-1 block">Quarters</span>
                <div class="grid grid-cols-4 gap-1">
                  {#each ['q1', 'q2', 'q3', 'q4'] as code}
                    {@const isSelected = vagueMonth === code && !vagueYear && !vagueDay}
                    <button
                      type="button"
                      class={`py-1.5 text-center text-xs font-semibold rounded-[var(--radius-md)] border transition-all ${
                        isSelected
                          ? 'bg-[var(--color-primary)] text-[var(--color-primary-foreground)] border-[var(--color-primary)] shadow-sm'
                          : 'bg-[var(--color-background)] hover:bg-[var(--color-muted)] border-[var(--color-border)] text-[var(--color-foreground)] hover:border-transparent'
                      }`}
                      onclick={() => handleVagueMonthSelect(code)}
                    >
                      {code.toUpperCase()}
                    </button>
                  {/each}
                </div>
              </div>

              <!-- Halves (Semesters) -->
              <div>
                <span class="text-[9px] font-bold uppercase tracking-wider text-[var(--color-muted-foreground)] mb-1 block">Halves (Semesters)</span>
                <div class="grid grid-cols-2 gap-1.5">
                  {#each ['fh', 'sh'] as code}
                    {@const info = VAGUE_MONTHS[code as VagueMonthCode]}
                    {@const isSelected = vagueMonth === code && !vagueYear && !vagueDay}
                    <button
                      type="button"
                      class={`py-1.5 text-center text-xs font-semibold rounded-[var(--radius-md)] border transition-all ${
                        isSelected
                          ? 'bg-[var(--color-primary)] text-[var(--color-primary-foreground)] border-[var(--color-primary)] shadow-sm'
                          : 'bg-[var(--color-background)] hover:bg-[var(--color-muted)] border-[var(--color-border)] text-[var(--color-foreground)] hover:border-transparent'
                      }`}
                      onclick={() => handleVagueMonthSelect(code)}
                    >
                      {info.label}
                    </button>
                  {/each}
                </div>
              </div>

              <!-- Seasons (Trimesters) -->
              <div>
                <span class="text-[9px] font-bold uppercase tracking-wider text-[var(--color-muted-foreground)] mb-1 block">Seasons (Trimesters)</span>
                <div class="grid grid-cols-2 gap-1.5">
                  {#each ['sp', 'su', 'au', 'wi'] as code}
                    {@const info = VAGUE_MONTHS[code as VagueMonthCode]}
                    {@const isSelected = vagueMonth === code && !vagueYear && !vagueDay}
                    <button
                      type="button"
                      class={`py-1.5 text-center text-xs font-semibold rounded-[var(--radius-md)] border transition-all ${
                        isSelected
                          ? 'bg-[var(--color-primary)] text-[var(--color-primary-foreground)] border-[var(--color-primary)] shadow-sm'
                          : 'bg-[var(--color-background)] hover:bg-[var(--color-muted)] border-[var(--color-border)] text-[var(--color-foreground)] hover:border-transparent font-semibold'
                      }`}
                      onclick={() => handleVagueMonthSelect(code)}
                    >
                      {info.label}
                    </button>
                  {/each}
                </div>
              </div>
            {/if}
          </div>
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .scrollbar-hide {
    scrollbar-width: none;
    -ms-overflow-style: none;
  }
  .scrollbar-hide::-webkit-scrollbar {
    display: none;
  }
</style>
