/**
 * What this tab is waiting on another tab for — shown to a person, who may
 * choose to take over. Nothing here decides anything.
 *
 * The coordination model (`election.ts`) never gives up on a holder by the
 * clock, because a clock cannot tell a busy or frozen tab from a dead one, and
 * the actions a wrong guess triggers (stealing, killing a worker) are
 * destructive. The cost is that a tab can wait on a holder that is frozen and
 * did not stand down. This is the other half of that trade: the wait is
 * reported, and a person — who can see the other tab — decides.
 *
 * `REPORT_AFTER_MS` only decides when a wait is worth showing, so an ordinary
 * slow answer does not flash a notice. It changes nothing else.
 */

export const REPORT_AFTER_MS = 4_000;

export type TabWait = {
	/** One per thing waited on, e.g. `vfs-catalog`. */
	readonly id: string;
	/** What is held up, in a person's words: "your files". */
	readonly what: string;
	/** Why, when it is known: "another tab still has the file catalog open". */
	readonly detail?: string;
	readonly since: number;
	/**
	 * Take the role here. Absent when taking over would not help — e.g. the
	 * other tab's files are what is held, and only its thawing releases them.
	 */
	readonly takeOver?: () => void;
};

const waits = new Map<string, TabWait>();
const listeners = new Set<(waits: TabWait[]) => void>();

function publish(): void {
	const list = [...waits.values()].sort((a, b) => a.since - b.since);
	for (const fn of [...listeners]) fn(list);
}

/** Report (or update) a wait. Call once it has lasted `REPORT_AFTER_MS`. */
export function reportTabWait(wait: TabWait): void {
	waits.set(wait.id, wait);
	publish();
}

export function clearTabWait(id: string): void {
	if (waits.delete(id)) publish();
}

export function subscribeTabWaits(fn: (waits: TabWait[]) => void): () => void {
	listeners.add(fn);
	fn([...waits.values()]);
	return () => listeners.delete(fn);
}

export type WaitTracker = {
	/**
	 * Something this tab now waits on another tab for. Call the returned
	 * function when it arrives (or is abandoned); calling it twice is harmless.
	 */
	begin(): () => void;
	/** The reason changed: re-describe the wait if it is on screen. */
	refresh(): void;
	/** Drop every open wait, e.g. the session waiting on them closed. */
	dispose(): void;
};

/**
 * Turn "waits that begin and end" into one reported `TabWait` under `id`,
 * shown once the oldest open wait has lasted `REPORT_AFTER_MS`, cleared when
 * the last one ends. `describe` is read when the notice is (re)shown, so it
 * can reflect who is being waited on at that moment.
 */
export function createWaitTracker(
	id: string,
	describe: () => Omit<TabWait, 'id' | 'since'>,
	opts: { enabled?: () => boolean } = {}
): WaitTracker {
	const open = new Map<symbol, number>();
	let timer: ReturnType<typeof setTimeout> | null = null;
	let shown = false;

	function show(): void {
		if (!open.size) return;
		shown = true;
		reportTabWait({ ...describe(), id, since: Math.min(...open.values()) });
	}

	function settle(): void {
		if (open.size) return;
		if (timer) clearTimeout(timer);
		timer = null;
		if (shown) {
			shown = false;
			clearTabWait(id);
		}
	}

	return {
		begin() {
			const token = Symbol(id);
			open.set(token, Date.now());
			if (!timer && !shown && (opts.enabled?.() ?? true)) {
				// Decides only when a notice is worth showing.
				timer = setTimeout(() => {
					timer = null;
					show();
				}, REPORT_AFTER_MS);
			}
			let ended = false;
			return () => {
				if (ended) return;
				ended = true;
				open.delete(token);
				settle();
			};
		},
		refresh() {
			if (shown) show();
		},
		dispose() {
			open.clear();
			settle();
		}
	};
}
