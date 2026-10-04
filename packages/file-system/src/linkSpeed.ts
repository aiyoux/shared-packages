/**
 * How fast bytes move between this tab and a remote host, per origin.
 *
 * Open uses this to say how long a copy will take ("about 2 min on this
 * connection") and to skip the question when the answer is "a moment": a
 * monitor on this computer moves hundreds of MB a second, one over an SSH
 * tunnel may move a few hundred KB. The URL cannot tell those apart (both are
 * `127.0.0.1`), so the only honest source is transfers that already ran.
 *
 * It only reports. Nothing here decides liveness, ownership or completion;
 * the person still chooses whether to copy.
 */

/** Below this a transfer is mostly latency, so it says little about bandwidth. */
const MIN_SAMPLE_BYTES = 64 * 1024;
/** Weight of the newest sample. Recent link conditions matter most. */
const SMOOTHING = 0.4;

const rates = new Map<string, number>();

/** Origin of a URL, or the string itself when it is already a key. */
export function linkKeyOf(url: string): string {
	try {
		return new URL(url).origin;
	} catch {
		return url;
	}
}

/** Record one finished transfer of `bytes` that took `ms`. */
export function recordLinkTransfer(url: string, bytes: number, ms: number): void {
	if (!Number.isFinite(bytes) || !Number.isFinite(ms) || bytes < MIN_SAMPLE_BYTES || ms <= 0) return;
	const key = linkKeyOf(url);
	const sample = (bytes * 1000) / ms;
	const prev = rates.get(key);
	rates.set(key, prev === undefined ? sample : prev * (1 - SMOOTHING) + sample * SMOOTHING);
}

/** Smoothed bytes per second, or `undefined` before any transfer was measured. */
export function linkBytesPerSecond(url: string): number | undefined {
	return rates.get(linkKeyOf(url));
}

/** Milliseconds to move `bytes` over this link, or `undefined` when unmeasured. */
export function estimateTransferMs(url: string, bytes: number): number | undefined {
	const bps = linkBytesPerSecond(url);
	if (!bps || bps <= 0) return undefined;
	return (Math.max(0, bytes) * 1000) / bps;
}

/** Time a transfer and record it when it succeeds. */
export async function measureTransfer<T>(
	url: string,
	run: () => Promise<T>,
	bytesOf: (result: T) => number
): Promise<T> {
	const started = performance.now();
	const result = await run();
	recordLinkTransfer(url, bytesOf(result), performance.now() - started);
	return result;
}

/** "a moment", "about 40 s", "about 3 min", "about 2 h". */
export function describeDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms < 1500) return 'a moment';
	const s = Math.round(ms / 1000);
	if (s < 90) return `about ${s} s`;
	const min = Math.round(s / 60);
	if (min < 90) return `about ${min} min`;
	return `about ${Math.round(min / 60)} h`;
}

export function resetLinkSpeedForTest(): void {
	rates.clear();
}
