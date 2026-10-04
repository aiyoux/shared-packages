import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
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
