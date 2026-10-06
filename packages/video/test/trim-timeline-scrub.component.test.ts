/**
 * The trim timeline scrubs like the preview player: drag moves coalesce on
 * an animation frame, an in-flight seek decodes before it is replaced,
 * playback pauses for the drag and resumes at the release point, and both
 * playheads track the drag live.
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import VideoTimeline from '../src/VideoTimeline.svelte';

/** Svelte 5 flushes state in a microtask. */
const afterDispatch = () => new Promise((r) => setTimeout(r, 0));

/** jsdom's PointerEvent drops clientX/button — dispatch a MouseEvent instead. */
function firePointer(
	type: 'pointerdown' | 'pointermove' | 'pointerup',
	target: EventTarget,
	init: { clientX: number; clientY?: number }
) {
	const e = new MouseEvent(type, {
		bubbles: true,
		cancelable: true,
		clientX: init.clientX,
		clientY: init.clientY ?? 10,
		button: 0
	});
	Object.defineProperty(e, 'pointerId', { value: 1 });
	Object.defineProperty(e, 'pointerType', { value: 'mouse' });
	target.dispatchEvent(e);
}

type MediaStub = {
	media: HTMLMediaElement;
	calls: { sets: number[]; pauses: number; plays: number };
	state: { currentTime: number; paused: boolean; ended: boolean; seeking: boolean };
};

/** A media element the test fully drives: seeks, pause state and `seeking`. */
function fakeMedia(playing: boolean): MediaStub {
	const calls = { sets: [] as number[], pauses: 0, plays: 0 };
	const state = { currentTime: 0, paused: !playing, ended: false, seeking: false };
	// NB: plain assignment would flatten the accessors — define them so the
	// engine's reads and writes stay observable.
	const media = new EventTarget() as EventTarget & {
		currentTime: number;
		paused: boolean;
		ended: boolean;
		seeking: boolean;
		readyState: number;
		pause(): void;
		play(): Promise<void>;
	};
	Object.defineProperties(media, {
		currentTime: {
			get: () => state.currentTime,
			set: (v: number) => {
				calls.sets.push(v);
				state.currentTime = v;
			},
			configurable: true
		},
		paused: { get: () => state.paused, configurable: true },
		ended: { get: () => state.ended, configurable: true },
		seeking: {
			get: () => state.seeking,
			set: (v: boolean) => {
				state.seeking = v;
			},
			configurable: true
		},
		readyState: { get: () => 4, configurable: true }
	});
	media.pause = () => {
		calls.pauses += 1;
		state.paused = true;
	};
	media.play = () => {
		calls.plays += 1;
		state.paused = false;
		return Promise.resolve();
	};
	return { media: media as unknown as HTMLMediaElement, calls, state };
}

const VIEW = { left: 111, width: 378 };

function stubLayout(container: HTMLElement) {
	const viewEl = container.querySelector('.timeline-view') as HTMLElement;
	const scrollEl = container.querySelector('.timeline-scroll') as HTMLElement;
	Object.defineProperty(viewEl, 'clientWidth', { value: VIEW.width, configurable: true });
	viewEl.getBoundingClientRect = () =>
		({
			left: VIEW.left,
			top: 0,
			right: VIEW.left + VIEW.width,
			bottom: 40,
			width: VIEW.width,
			height: 40,
			x: VIEW.left,
			y: 0,
			toJSON: () => {}
		}) as DOMRect;
	return { viewEl, scrollEl };
}

function mountTimeline(media: HTMLMediaElement) {
	const rendered = render(VideoTimeline, {
		props: {
			duration: 10,
			currentTime: 2,
			trimStart: 1,
			trimEnd: 9,
			videoRef: media,
			sourceUrl: null
		}
	});
	const container = rendered.container as HTMLElement;
	return { container, ...stubLayout(container) };
}

describe('trim timeline smooth scrub', () => {
	it('pauses for a playhead drag and resumes at the release point', async () => {
		const { media, calls } = fakeMedia(true);
		const { container, scrollEl: scroll } = mountTimeline(media);
		expect(container.querySelector('.timeline-scroll')).toBeTruthy();
		await afterDispatch();

		firePointer('pointerdown', scroll, { clientX: 200 });
		await afterDispatch();
		expect(calls.pauses).toBe(1);

		// Far right clamps to the clip end; the release applies exactly it.
		firePointer('pointerup', scroll, { clientX: 10000 });
		await afterDispatch();
		expect(media.currentTime).toBe(10);
		expect(calls.plays).toBe(1);
	});

	it('coalesces rapid moves into one seek instead of one per move', async () => {
		const { media, calls } = fakeMedia(true);
		const { scrollEl: scroll } = mountTimeline(media);
		await afterDispatch();

		firePointer('pointerdown', scroll, { clientX: 200 });
		firePointer('pointermove', scroll, { clientX: 400 });
		firePointer('pointermove', scroll, { clientX: 600 });
		firePointer('pointermove', scroll, { clientX: 800 });
		await new Promise((r) => setTimeout(r, 60));

		// Down issues immediately, the four queued moves flush once.
		expect(calls.sets.length).toBe(2);
		expect(calls.sets[1]).toBeGreaterThan(calls.sets[0]!);
		expect(calls.plays).toBe(0);
		firePointer('pointerup', scroll, { clientX: 800 });
		await afterDispatch();
		expect(calls.plays).toBe(1);
	});

	it('defers while a seek is in flight and lands on seeked', async () => {
		const { media, calls, state } = fakeMedia(false);
		const { scrollEl: scroll } = mountTimeline(media);
		await afterDispatch();

		state.seeking = true;
		firePointer('pointerdown', scroll, { clientX: 200 });
		firePointer('pointermove', scroll, { clientX: 10000 });
		await new Promise((r) => setTimeout(r, 60));
		// Nothing replaces the unfinished seek.
		expect(calls.sets).toEqual([]);

		state.seeking = false;
		media.dispatchEvent(new Event('seeked'));
		await new Promise((r) => setTimeout(r, 60));
		expect(calls.sets).toEqual([10]);
	});

	it('tracks the drag live on the minimap playhead', async () => {
		const { media } = fakeMedia(false);
		const { scrollEl: scroll } = mountTimeline(media);
		const minimap = await screen.findByTestId('video-trim-minimap');
		const marker = () => minimap.querySelector('.tl-minimap-playhead') as HTMLElement;
		expect(marker().style.left).toBe('20%');

		firePointer('pointerdown', scroll, { clientX: 10000 });
		firePointer('pointermove', scroll, { clientX: 10000 });
		await afterDispatch();
		// The element has not caught up, but the marker already shows the drag.
		expect(marker().style.left).toBe('100%');
	});
});
