// Ported from wisewords crates/calendar_domain/src/helpers/definitions.rs.
//
// Every vague-kind enum has a lookup table: the serialised code (e.g. 'mo'
// for Morning) maps to an inclusive range and a human label. The Rust trait
// exposes a single `get_base()` midpoint used purely for sort ordering — we
// deliberately expose both ends of the range here so the exec landing can
// treat a vague field as a real active window (e.g. a Morning item is
// "active" from 07:00 until 12:00, not just at the 09:00 midpoint).

// ---------------------------------------------------------------------------
// VagueMinute — time of day, 0–1439 minutes from midnight
// ---------------------------------------------------------------------------

/** Serialised codes for VagueMinute variants (matches wisewords `serde` rename). */
export type VagueMinuteCode =
  | 'em' // EarlyMorning
  | 'mo' // Morning
  | 'lm' // LateMorning
  | 'no' // Noon
  | 'ea' // EarlyAfternoon
  | 'af' // Afternoon
  | 'la' // LateAfternoon
  | 'ev' // Evening
  | 'ni'; // Night

export interface VagueMinuteInfo {
  code: VagueMinuteCode;
  label: string;
  /** Inclusive minute range from midnight [start, end]. */
  range: [number, number];
  /** Midpoint minute used for sort ordering (matches Rust `get_base()`). */
  base: number;
}

export const VAGUE_MINUTES: Record<VagueMinuteCode, VagueMinuteInfo> = {
  em: { code: 'em', label: 'Early Morning', range: [300, 480], base: 360 },   // 5–8am
  mo: { code: 'mo', label: 'Morning',       range: [420, 720], base: 540 },   // 7am–12pm
  lm: { code: 'lm', label: 'Late Morning',  range: [600, 720], base: 660 },   // 10am–12pm
  no: { code: 'no', label: 'Noon',          range: [720, 720], base: 720 },   // 12pm
  ea: { code: 'ea', label: 'Early Afternoon', range: [720, 900], base: 810 }, // 12–3pm
  af: { code: 'af', label: 'Afternoon',     range: [720, 1080], base: 900 },  // 12–6pm
  la: { code: 'la', label: 'Late Afternoon', range: [960, 1140], base: 1020 },// 4–7pm
  ev: { code: 'ev', label: 'Evening',       range: [1080, 1320], base: 1140 },// 6–10pm
  ni: { code: 'ni', label: 'Night',         range: [1260, 1440], base: 1320 } // 9pm–12am
};

/** Listing order used by UI pickers. */
export const VAGUE_MINUTE_ORDER: VagueMinuteCode[] = [
  'em', 'mo', 'lm', 'no', 'ea', 'af', 'la', 'ev', 'ni'
];

/**
 * Return the coarse vague bucket a concrete minute-of-day belongs to.
 *
 * Uses a canonical non-overlapping 5-bucket partition of the day for
 * landing-page classification (header badge, later-today grouping). The
 * overlapping fine-grained buckets in `VAGUE_MINUTES` are still valid for
 * data-model usage — this helper just deliberately collapses them so that
 * boundary times like 12:00 / 18:00 / 21:00 map cleanly to afternoon /
 * evening / night respectively.
 *
 * Partition (half-open except the final bucket which closes at 24:00):
 * - `ni` night:      00:00–05:00 and 21:00–24:00
 * - `em` early am:   05:00–07:00
 * - `mo` morning:    07:00–12:00
 * - `af` afternoon:  12:00–18:00
 * - `ev` evening:    18:00–21:00
 */
export function vagueMinuteForMinuteOfDay(minutes: number): VagueMinuteCode | null {
  if (minutes < 0 || minutes > 1439) return null;
  if (minutes < 300) return 'ni';   // 00:00–05:00
  if (minutes < 420) return 'em';   // 05:00–07:00
  if (minutes < 720) return 'mo';   // 07:00–12:00
  if (minutes < 1080) return 'af';  // 12:00–18:00
  if (minutes < 1260) return 'ev';  // 18:00–21:00
  return 'ni';                      // 21:00–24:00
}

/** Human-readable bucket label for a given Date's local time. */
export function currentVagueMinute(now: Date): VagueMinuteCode | null {
  return vagueMinuteForMinuteOfDay(now.getHours() * 60 + now.getMinutes());
}

// ---------------------------------------------------------------------------
// VagueDay — day of month
// ---------------------------------------------------------------------------

export type VagueDayCode = 'em' | 'mm' | 'lm' | 'fh' | 'sh';

export interface VagueDayInfo {
  code: VagueDayCode;
  label: string;
  /** Inclusive day range [start, end]. */
  range: [number, number];
  base: number;
}

export const VAGUE_DAYS: Record<VagueDayCode, VagueDayInfo> = {
  em: { code: 'em', label: 'Early in month', range: [1, 10], base: 5 },
  mm: { code: 'mm', label: 'Mid month',      range: [10, 20], base: 15 },
  lm: { code: 'lm', label: 'Late in month',  range: [20, 31], base: 25 },
  fh: { code: 'fh', label: 'First half',     range: [1, 15], base: 8 },
  sh: { code: 'sh', label: 'Second half',    range: [16, 31], base: 23 }
};

export const VAGUE_DAY_ORDER: VagueDayCode[] = ['em', 'mm', 'lm', 'fh', 'sh'];

// ---------------------------------------------------------------------------
// VagueMonth — quarters / halves / seasons
// ---------------------------------------------------------------------------

export type VagueMonthCode =
  | 'q1' | 'q2' | 'q3' | 'q4'
  | 'fh' | 'sh'
  | 'su' | 'wi' | 'sp' | 'au';

export interface VagueMonthInfo {
  code: VagueMonthCode;
  label: string;
  /** Inclusive month range [start, end]; Winter wraps past year-end. */
  range: [number, number];
  base: number;
  /** Winter (Dec–Feb) is the only wrap-around range. */
  wraps?: boolean;
}

export const VAGUE_MONTHS: Record<VagueMonthCode, VagueMonthInfo> = {
  q1: { code: 'q1', label: 'Q1 (Jan–Mar)', range: [1, 3],  base: 2  },
  q2: { code: 'q2', label: 'Q2 (Apr–Jun)', range: [4, 6],  base: 5  },
  q3: { code: 'q3', label: 'Q3 (Jul–Sep)', range: [7, 9],  base: 8  },
  q4: { code: 'q4', label: 'Q4 (Oct–Dec)', range: [10, 12], base: 11 },
  fh: { code: 'fh', label: 'First half',   range: [1, 6],  base: 4  },
  sh: { code: 'sh', label: 'Second half',  range: [7, 12], base: 10 },
  su: { code: 'su', label: 'Summer',       range: [6, 8],  base: 7  },
  wi: { code: 'wi', label: 'Winter',       range: [12, 2], base: 1, wraps: true },
  sp: { code: 'sp', label: 'Spring',       range: [3, 5],  base: 4  },
  au: { code: 'au', label: 'Autumn',       range: [9, 11], base: 10 }
};

export const VAGUE_MONTH_ORDER: VagueMonthCode[] = [
  'q1', 'q2', 'q3', 'q4', 'fh', 'sh', 'sp', 'su', 'au', 'wi'
];

// ---------------------------------------------------------------------------
// VagueYear — decade ranges (kept for completeness, not surfaced in UI)
// ---------------------------------------------------------------------------

export type VagueYearCode = 'ed' | 'md' | 'ld' | 'fh' | 'sh' | 'dc';

export interface VagueYearInfo {
  code: VagueYearCode;
  label: string;
  /** Year offset from decade start [lo, hi]. */
  range: [number, number];
  base: number;
}

export const VAGUE_YEARS: Record<VagueYearCode, VagueYearInfo> = {
  ed: { code: 'ed', label: 'Early decade',     range: [0, 3], base: 2 },
  md: { code: 'md', label: 'Mid decade',       range: [4, 6], base: 5 },
  ld: { code: 'ld', label: 'Late decade',      range: [7, 9], base: 8 },
  fh: { code: 'fh', label: 'First half decade', range: [0, 4], base: 2 },
  sh: { code: 'sh', label: 'Second half decade', range: [5, 9], base: 7 },
  dc: { code: 'dc', label: 'Entire decade',    range: [0, 9], base: 5 }
};

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Pick which end of a vague range to use when resolving a TimeReference
 * side. `'start'` → low end of range, `'end'` → high end. This is the
 * deliberate deviation from the Rust implementation, which always returns
 * `get_base()` (midpoint) — we want vague items to have a real active
 * window on the exec landing.
 */
export type VagueSide = 'start' | 'end';

export function vagueMinuteValue(code: VagueMinuteCode, side: VagueSide): number {
  const info = VAGUE_MINUTES[code];
  return side === 'start' ? info.range[0] : info.range[1];
}

export function vagueDayValue(code: VagueDayCode, side: VagueSide): number {
  const info = VAGUE_DAYS[code];
  return side === 'start' ? info.range[0] : info.range[1];
}

export function vagueMonthValue(code: VagueMonthCode, side: VagueSide): number {
  const info = VAGUE_MONTHS[code];
  return side === 'start' ? info.range[0] : info.range[1];
}

export function vagueYearValue(code: VagueYearCode, side: VagueSide): number {
  const info = VAGUE_YEARS[code];
  return side === 'start' ? info.range[0] : info.range[1];
}
