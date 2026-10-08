/** A burst gets one refresh; changes during that read get one trailing refresh. */
export function createListingRefresh(run: () => Promise<void>, intervalMs = 500) {
	let dirty = false;
	let running = false;
	let stopped = false;
	let lastStarted = 0;
	let timer: ReturnType<typeof setTimeout> | null = null;
	function schedule() {
		if (stopped || running || timer || !dirty) return;
		timer = setTimeout(async () => {
			timer = null;
			if (stopped) return;
			dirty = false;
			running = true;
			lastStarted = Date.now();
			try { await run(); } catch { /* the refresh callback reports its own errors */ }
			finally { running = false; schedule(); }
		}, Math.max(120, intervalMs - (Date.now() - lastStarted)));
	}
	return {
		request() { dirty = true; schedule(); },
		stop() { stopped = true; dirty = false; if (timer) clearTimeout(timer); timer = null; }
	};
}
