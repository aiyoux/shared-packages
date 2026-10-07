/** Chip shapes for ConnectionSwitcher's profile dropdowns. Lives as plain TS
 *  so plain-`tsc` consumers (git's transitive check) can import the types —
 *  a `.svelte` module is opaque to them. */
export type B2ProfileChip = {
	id: string;
	/** Short button label */
	name: string;
	/** Secondary line / title */
	detail?: string;
};

/** Same chip shape as B2; kept as alias for callers wiring monitor. */
export type MonitorProfileChip = B2ProfileChip;