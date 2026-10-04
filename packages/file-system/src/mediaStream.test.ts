import { afterEach, describe, expect, it } from 'vitest';
import { convertedMediaSrc, needsConversion, setMediaStreamProxy, streamableMediaSrc } from './ui/mediaStream.js';

describe('media stream sources', () => {
	afterEach(() => setMediaStreamProxy(null));

	it('knows which containers need the converter, and leaves TypeScript alone', () => {
		expect(needsConversion('Holiday.AVI')).toBe(true);
		expect(needsConversion('talk.wmv')).toBe(true);
		expect(needsConversion('index.ts')).toBe(false);
		expect(needsConversion('clip.mp4')).toBe(false);
	});

	it('uses bytes when the host has no proxy', async () => {
		const driver = {
			rangeUrl: async () => ({ url: 'http://m/v1/fs/read?path=a' }),
			convertedMediaUrl: async () => ({ url: 'http://m/v1/fs/media?path=a' })
		};
		expect(await streamableMediaSrc(driver, 'a', 'a.mp4')).toBeNull();
		expect(await convertedMediaSrc(driver, 'a', 'a.avi')).toBeNull();
	});

	it('names the converted stream as MP4 for the proxy', async () => {
		const seen: string[] = [];
		setMediaStreamProxy((url, name) => {
			seen.push(`${url} ${name}`);
			return `/__media/stream?n=${name}`;
		});
		const driver = { convertedMediaUrl: async () => ({ url: 'http://m/v1/fs/media?path=a' }) };
		expect(await convertedMediaSrc(driver, 'a', 'Holiday.avi')).toEqual({
			src: '/__media/stream?n=Holiday.mp4',
			duration: undefined
		});
		expect(seen).toEqual(['http://m/v1/fs/media?path=a Holiday.mp4']);
	});

	it('asks the driver for a stream that starts where the person jumped to', async () => {
		setMediaStreamProxy((url) => url);
		const asked: Array<number | undefined> = [];
		const driver = {
			convertedMediaUrl: async (_id: string, opts?: { start?: number }) => {
				asked.push(opts?.start);
				return { url: `http://m/v1/fs/media?path=a&t=${opts?.start ?? 0}`, duration: 600 };
			}
		};
		expect(await convertedMediaSrc(driver, 'a', 'a.avi', 90)).toEqual({
			src: 'http://m/v1/fs/media?path=a&t=90',
			duration: 600
		});
		expect(asked).toEqual([90]);
	});
});
