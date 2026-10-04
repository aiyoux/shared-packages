/**
 * Time on a media element, as the person sees it.
 *
 * A file played by ranges starts at 0 and seeks anywhere. A stream the host
 * converts (`/v1/fs/media`) has no ranges: it starts where it was asked to
 * (`start`), its element clock counts from 0 there, and it can only seek
 * within what has arrived. Players show the file's time and run every seek
 * through `planSeek`, so both look and behave the same.
 */

export type MediaTimeline = {
	/** File second the element's 0 corresponds to. */
	start: number;
	/** The file's length when the element cannot know it (a converted stream). */
	duration?: number;
	/** Seeking past what has arrived restarts the stream there. */
	restartable: boolean;
};

export const RANGED: MediaTimeline = { start: 0, restartable: false };

export type SeekPlan = { kind: 'native'; elementTime: number } | { kind: 'restart'; at: number };

/** The file second the element is at. */
export function fileTime(timeline: MediaTimeline, elementTime: number): number {
	return timeline.start + (Number.isFinite(elementTime) ? elementTime : 0);
}

/** The file's length: the timeline's when it knows it, else the element's. */
export function fileDuration(timeline: MediaTimeline, elementDuration: number): number | undefined {
	if (timeline.duration && timeline.duration > 0) return timeline.duration;
	return Number.isFinite(elementDuration) && elementDuration > 0 ? timeline.start + elementDuration : undefined;
}

/**
 * How to reach file second `target`: a plain seek when the element can (a
 * ranged file, or a converted stream that already holds that second), else a
 * restart of the converted stream from there.
 */
export function planSeek(
	timeline: MediaTimeline,
	target: number,
	buffered: ReadonlyArray<readonly [number, number]>,
	duration?: number
): SeekPlan {
	const clamped = Math.max(0, duration ? Math.min(target, duration) : target);
	const elementTime = clamped - timeline.start;
	if (!timeline.restartable) return { kind: 'native', elementTime: Math.max(0, elementTime) };
	// Half a second of slack: the element can play into what is still arriving.
	if (elementTime >= 0 && buffered.some(([from, to]) => elementTime >= from && elementTime <= to + 0.5)) {
		return { kind: 'native', elementTime };
	}
	return { kind: 'restart', at: Math.floor(clamped) };
}

/** An element's buffered ranges as pairs. */
export function bufferedRanges(el: Pick<HTMLMediaElement, 'buffered'>): Array<[number, number]> {
	const out: Array<[number, number]> = [];
	const b = el.buffered;
	for (let i = 0; i < (b?.length ?? 0); i++) out.push([b.start(i), b.end(i)]);
	return out;
}

/** Playback speeds the players step through. */
export const PLAYBACK_RATES = [1, 1.25, 1.5, 2, 0.5, 0.75] as const;

export function nextRate(rate: number): number {
	const i = PLAYBACK_RATES.findIndex((r) => Math.abs(r - rate) < 0.001);
	return PLAYBACK_RATES[(i + 1) % PLAYBACK_RATES.length]!;
}
