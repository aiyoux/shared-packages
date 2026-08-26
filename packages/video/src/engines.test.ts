import { describe, expect, it } from 'vitest';
import { listEngines, peekEngine } from './engines.js';
import { DEFAULT_ENGINE, engineSupports } from './types.js';
import { detectFormatFromName, suggestOutputName } from './detect.js';

describe('video engines catalog', () => {
	it('lists only WebCodecs', () => {
		expect(listEngines().map((e) => e.id)).toEqual(['native']);
		expect(peekEngine('native')).toBeNull();
	});

	it('defaults to WebCodecs and is MP4-only', () => {
		expect(DEFAULT_ENGINE).toBe('native');
		expect(engineSupports('native', 'mp4')).toBe(true);
		expect(engineSupports('native', 'webm')).toBe(false);
	});
});

describe('detectFormatFromName', () => {
	it('maps common suffixes', () => {
		expect(detectFormatFromName('notes.txt')).toBeNull();
		expect(detectFormatFromName('clip.webm')).toBe('webm');
		expect(detectFormatFromName('clip.MP4')).toBe('mp4');
		expect(detectFormatFromName('clip.mov')).toBe('mp4');
	});
});

describe('suggestOutputName', () => {
	it('swaps the extension', () => {
		expect(suggestOutputName('holiday.mov', 'webm')).toBe('holiday.webm');
		expect(suggestOutputName('holiday', 'mp4')).toBe('holiday.mp4');
	});
});
