import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import type { ComponentProps } from 'svelte';
import FeVideoPlayer from '../src/ui/FeVideoPlayer.svelte';
import FeAudioPlayer from '../src/ui/FeAudioPlayer.svelte';

let play: ReturnType<typeof vi.fn>;
let pause: ReturnType<typeof vi.fn>;

beforeEach(() => {
	play = vi.fn(function (this: HTMLMediaElement) {
		Object.defineProperty(this, 'paused', { value: false, configurable: true });
		this.dispatchEvent(new Event('play'));
		return Promise.resolve();
	});
	pause = vi.fn(function (this: HTMLMediaElement) {
		Object.defineProperty(this, 'paused', { value: true, configurable: true });
		this.dispatchEvent(new Event('pause'));
	});
	vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(play as never);
	vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(pause as never);
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

describe('video player', () => {
	it('draws its own controls instead of the browser\'s, and plays and pauses', async () => {
		render(FeVideoPlayer, { props: { src: 'blob:clip', name: 'clip.mp4' } });
		const video = document.querySelector('video')!;
		expect(video.hasAttribute('controls')).toBe(false);
		await fireEvent.click(screen.getByTestId('fe-vp-play'));
		expect(play).toHaveBeenCalledTimes(1);
		expect(screen.getByTestId('fe-vp-play').getAttribute('aria-label')).toBe('Pause');
		await fireEvent.click(screen.getByTestId('fe-vp-play'));
		expect(pause).toHaveBeenCalledTimes(1);
	});

	it('shows file time on a converted stream and restarts it past what has arrived', async () => {
		const onRestart = vi.fn();
		render(FeVideoPlayer, {
			props: {
				src: '/__media/stream?n=a.mp4',
				name: 'a.avi',
				timeline: { start: 120, duration: 600, restartable: true },
				onRestart
			}
		});
		expect(screen.getByTestId('fe-vp-time').textContent).toBe('2:00 / 10:00');
		await fireEvent.keyDown(screen.getByTestId('fe-vp-track'), { key: 'ArrowRight' });
		expect(onRestart).toHaveBeenCalledWith(125);
	});

	it('steps the playback speed', async () => {
		render(FeVideoPlayer, { props: { src: 'blob:clip', name: 'clip.mp4' } });
		const video = document.querySelector('video')!;
		await fireEvent.click(screen.getByTestId('fe-vp-rate'));
		expect(video.playbackRate).toBe(1.25);
	});
});

describe('live video scrubbing', () => {
	function animationFrames() {
		let id = 0;
		const callbacks = new Map<number, FrameRequestCallback>();
		vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((callback) => {
			callbacks.set(++id, callback);
			return id;
		});
		vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation((frame) => { callbacks.delete(frame); });
		return {
			callbacks,
			async flush() {
				await act(() => {
					const queued = [...callbacks.values()];
					callbacks.clear();
					for (const callback of queued) callback(0);
				});
			}
		};
	}

	async function mount(props: Partial<ComponentProps<typeof FeVideoPlayer>> = {}) {
		const view = render(FeVideoPlayer, { props: { src: 'blob:clip', name: 'clip.mp4', ...props } });
		const video = document.querySelector('video')!;
		const track = screen.getByTestId('fe-vp-track');
		let time = 0;
		let seeking = false;
		const seeks = vi.fn((target: number) => { time = target; seeking = true; });
		Object.defineProperties(video, {
			duration: { configurable: true, value: 100 },
			readyState: { configurable: true, value: 1 },
			currentTime: { configurable: true, get: () => time, set: seeks },
			seeking: { configurable: true, get: () => seeking }
		});
		vi.spyOn(track, 'getBoundingClientRect').mockReturnValue({ left: 100, width: 200 } as DOMRect);
		await fireEvent.loadedMetadata(video);
		return {
			view, video, track, seeks,
			async pointer(type: string, clientX: number, pointerId = 1, button = 0) {
				const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX, button });
				Object.defineProperty(event, 'pointerId', { value: pointerId });
				await fireEvent(track, event);
			},
			async decoded() {
				seeking = false;
				await fireEvent.seeked(video);
			}
		};
	}

	it('updates frames in both directions before release without aborting the frame being decoded', async () => {
		const frames = animationFrames();
		const player = await mount();
		await player.pointer('pointerdown', 140);
		expect(player.video.currentTime).toBe(20);
		expect(document.activeElement).toBe(player.track);
		await player.pointer('pointermove', 160);
		await player.pointer('pointermove', 180);
		await frames.flush();
		expect(player.seeks).toHaveBeenCalledTimes(1);
		expect(player.track.getAttribute('aria-valuenow')).toBe('40');
		await player.decoded();
		await frames.flush();
		expect(player.video.currentTime).toBe(40);
		await player.pointer('pointermove', 120);
		await player.decoded();
		await frames.flush();
		expect(player.video.currentTime).toBe(10);
		await player.pointer('pointerup', 175);
		expect(player.video.currentTime).toBe(37.5);
		await frames.flush();
		expect(player.video.currentTime).toBe(37.5);
		expect(play).not.toHaveBeenCalled();
	});

	it('combines rapid moves into the latest target for each animation frame', async () => {
		const frames = animationFrames();
		const player = await mount();
		await player.pointer('pointerdown', 140);
		await player.decoded();
		await player.pointer('pointermove', 180);
		await player.pointer('pointermove', 160);
		await player.pointer('pointermove', 130);
		expect(frames.callbacks.size).toBe(1);
		await frames.flush();
		expect(player.seeks.mock.calls.map(([target]) => target)).toEqual([20, 15]);
	});

	it('pauses during a drag and resumes playback only when it ends', async () => {
		animationFrames();
		const player = await mount();
		await fireEvent.click(screen.getByTestId('fe-vp-play'));
		await player.pointer('pointerdown', 140);
		expect(pause).toHaveBeenCalledTimes(1);
		expect(player.video.paused).toBe(true);
		expect(document.querySelector('.fe-vp-bigplay')).toBeNull();
		await player.pointer('pointermove', 180);
		expect(play).toHaveBeenCalledTimes(1);
		await player.pointer('pointerup', 180);
		expect(play).toHaveBeenCalledTimes(2);
		expect(player.video.paused).toBe(false);
	});

	it.each(['pointercancel', 'lostpointercapture'])('ends a drag on %s and ignores later moves', async (event) => {
		const frames = animationFrames();
		const player = await mount();
		await fireEvent.click(screen.getByTestId('fe-vp-play'));
		await player.pointer('pointerdown', 140);
		await player.pointer('pointermove', 160);
		await player.pointer(event, 160);
		expect(player.video.currentTime).toBe(30);
		expect(player.video.paused).toBe(false);
		await player.pointer('pointermove', 180);
		await frames.flush();
		expect(player.video.currentTime).toBe(30);
	});

	it('ignores other pointers and secondary buttons and clamps captured drags outside the track', async () => {
		animationFrames();
		const player = await mount();
		await player.pointer('pointerdown', 140, 2, 2);
		expect(player.seeks).not.toHaveBeenCalled();
		await player.pointer('pointerdown', 140);
		await player.pointer('pointerup', 300, 2);
		expect(player.video.currentTime).toBe(20);
		await player.pointer('pointerup', 500);
		expect(player.video.currentTime).toBe(100);
		await player.pointer('pointerdown', 140);
		await player.pointer('pointerup', -100);
		expect(player.video.currentTime).toBe(0);
	});

	it('discards queued seeks when another source opens', async () => {
		const frames = animationFrames();
		const player = await mount();
		await player.pointer('pointerdown', 140);
		await player.pointer('pointermove', 180);
		await player.view.rerender({ src: 'blob:next' });
		await player.decoded();
		await frames.flush();
		expect(player.seeks).toHaveBeenCalledTimes(1);
		await player.pointer('pointermove', 200);
		await frames.flush();
		expect(player.seeks).toHaveBeenCalledTimes(1);
	});

	it('cancels queued frame work when the player closes', async () => {
		const frames = animationFrames();
		const player = await mount();
		await player.pointer('pointerdown', 140);
		await player.pointer('pointermove', 180);
		await player.view.unmount();
		expect(frames.callbacks.size).toBe(0);
		await frames.flush();
		expect(player.seeks).toHaveBeenCalledTimes(1);
	});

	it('serializes converted-stream restarts and applies the latest drag target as frames arrive', async () => {
		const frames = animationFrames();
		let release!: () => void;
		const pending = new Promise<void>((resolve) => { release = resolve; });
		const onRestart = vi.fn(() => pending);
		const player = await mount({ mediaKey: 'clip', timeline: { start: 0, duration: 100, restartable: true }, onRestart });
		await player.pointer('pointerdown', 140);
		expect(onRestart).toHaveBeenCalledExactlyOnceWith(20);
		await player.pointer('pointermove', 160);
		await player.pointer('pointermove', 180);
		await frames.flush();
		expect(onRestart).toHaveBeenCalledTimes(1);
		Object.defineProperty(player.video, 'buffered', { configurable: true, value: { length: 1, start: () => 0, end: () => 50 } });
		await player.view.rerender({ src: 'blob:converted', timeline: { start: 20, duration: 100, restartable: true } });
		await act(async () => { release(); await pending; });
		await fireEvent.loadedMetadata(player.video);
		await frames.flush();
		expect(onRestart).toHaveBeenCalledTimes(1);
		expect(player.video.currentTime).toBe(20);
		expect(player.track.getAttribute('aria-valuenow')).toBe('40');
		await player.pointer('pointerup', 180);
		expect(play).not.toHaveBeenCalled();
	});

	it('resumes at the release position after a converted-stream restart finishes', async () => {
		const frames = animationFrames();
		let release!: () => void;
		const pending = new Promise<void>((resolve) => { release = resolve; });
		const onRestart = vi.fn(() => pending);
		const player = await mount({ mediaKey: 'clip', timeline: { start: 0, duration: 100, restartable: true }, onRestart });
		await fireEvent.click(screen.getByTestId('fe-vp-play'));
		await player.pointer('pointerdown', 140);
		await player.pointer('pointermove', 180);
		await player.pointer('pointerup', 190);
		expect(player.video.paused).toBe(true);
		expect(onRestart).toHaveBeenCalledExactlyOnceWith(20);
		Object.defineProperty(player.video, 'buffered', { configurable: true, value: { length: 1, start: () => 0, end: () => 50 } });
		await player.view.rerender({ src: 'blob:converted', timeline: { start: 20, duration: 100, restartable: true } });
		await act(async () => { release(); await pending; });
		await fireEvent.loadedMetadata(player.video);
		await frames.flush();
		expect(player.video.currentTime).toBe(25);
		expect(player.track.getAttribute('aria-valuenow')).toBe('45');
		expect(player.video.paused).toBe(false);
		expect(play).toHaveBeenCalledTimes(2);
		expect(onRestart).toHaveBeenCalledTimes(1);
	});

	it('ignores a converted-stream completion after another file opens', async () => {
		const frames = animationFrames();
		let release!: () => void;
		const pending = new Promise<void>((resolve) => { release = resolve; });
		const onRestart = vi.fn(() => pending);
		const player = await mount({ mediaKey: 'clip', timeline: { start: 0, duration: 100, restartable: true }, onRestart });
		await fireEvent.click(screen.getByTestId('fe-vp-play'));
		await player.pointer('pointerdown', 140);
		await player.pointer('pointermove', 180);
		await player.view.rerender({ src: 'blob:next', mediaKey: 'next', timeline: { start: 0, restartable: false } });
		await act(async () => { release(); await pending; });
		await frames.flush();
		expect(player.seeks).not.toHaveBeenCalled();
		expect(onRestart).toHaveBeenCalledTimes(1);
		expect(play).toHaveBeenCalledTimes(1);
	});
});

describe('audio player', () => {
	it('draws a waveform it can seek on, with its own play button', async () => {
		render(FeAudioPlayer, { props: { src: 'blob:song', name: 'song.mp3', peaks: [0.2, 0.9, 0.4] } });
		expect(document.querySelector('audio')!.hasAttribute('controls')).toBe(false);
		expect(screen.getByTestId('fe-ap-wave').getAttribute('data-has-peaks')).toBe('true');
		expect(screen.getByTestId('fe-ap-wave').querySelector('canvas')).toBeTruthy();
		await fireEvent.click(screen.getByTestId('fe-ap-play'));
		expect(play).toHaveBeenCalledTimes(1);
	});

	it('marks the waveform as loading while peaks are on their way', () => {
		render(FeAudioPlayer, { props: { src: 'blob:song', name: 'song.mp3', peaksLoading: true } });
		expect(screen.getByTestId('fe-ap-wave').classList.contains('fe-ap-wave--loading')).toBe(true);
		expect(screen.getByTestId('fe-ap-wave').hasAttribute('data-has-peaks')).toBe(false);
	});

	it('jumps a converted stream from the keyboard, in file time', async () => {
		const onRestart = vi.fn();
		render(FeAudioPlayer, {
			props: {
				src: '/__media/stream?n=a.mp4',
				name: 'talk.wma',
				timeline: { start: 0, duration: 3600, restartable: true },
				onRestart
			}
		});
		expect(screen.getByTestId('fe-ap-time').textContent).toBe('0:00 / 1:00:00');
		await fireEvent.keyDown(screen.getByTestId('fe-ap-wave'), { key: 'ArrowRight' });
		expect(onRestart).toHaveBeenCalledWith(5);
	});
});
