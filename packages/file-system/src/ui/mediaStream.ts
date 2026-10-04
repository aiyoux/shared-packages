/**
 * Play remote video and audio from a URL the browser can range-read, instead
 * of downloading the whole file into a Blob first.
 *
 * The hub's CSP keeps `<video src>` to its own origin, and the monitor is a
 * different one, so the host supplies a same-origin URL (its service worker
 * forwards each `Range` request to the monitor). The player then fetches only
 * the window it is playing and the part you seek to. Without a proxy the
 * preview falls back to the Blob path and its size cap.
 */
import type { ExplorerDriver, ExplorerEntryId } from './explorerDriver.js';

export type MediaStreamProxy = (rangeUrl: string, name: string) => string | null;

let proxy: MediaStreamProxy | null = null;

/** The host installs this once it knows its proxy is in place. */
export function setMediaStreamProxy(next: MediaStreamProxy | null): void {
	proxy = next;
}

/** Containers a browser cannot play that a monitor can convert. */
const CONVERTIBLE_VIDEO = /\.(avi|wmv|flv|mpe?g|m2ts|mts|3gp|vob)$/i;
// Not `.ts`: that is far more often TypeScript than a transport stream.

/** True for a video only playable through the host's converter. */
export function needsConversion(name: string): boolean {
	return CONVERTIBLE_VIDEO.test(name);
}

/**
 * A same-origin URL for the host's converted stream (`convertedMediaUrl`),
 * for video the browser cannot decode. `null` without a proxy or converter.
 */
export async function convertedMediaSrc(
	driver: Pick<ExplorerDriver, 'convertedMediaUrl'>,
	id: ExplorerEntryId,
	name: string,
	start?: number
): Promise<{ src: string; duration?: number; start?: number } | null> {
	if (!proxy || !driver.convertedMediaUrl) return null;
	const loc = await driver.convertedMediaUrl(id, { start }).catch(() => null);
	const src = loc?.url ? proxy(loc.url, `${name.replace(/\.[^.]+$/, '')}.mp4`) : null;
	return src ? { src, duration: loc?.duration, start: loc?.start } : null;
}

/** A same-origin, range-capable URL for this file, or `null` to use bytes. */
export async function streamableMediaSrc(
	driver: Pick<ExplorerDriver, 'rangeUrl'>,
	id: ExplorerEntryId,
	name: string
): Promise<string | null> {
	if (!proxy || !driver.rangeUrl) return null;
	const loc = await driver.rangeUrl(id).catch(() => null);
	return loc?.url ? proxy(loc.url, name) : null;
}
