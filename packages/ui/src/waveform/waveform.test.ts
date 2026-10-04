import { describe, expect, it } from 'vitest';
import { drawPeakBars, drawPlayheadHandle, formatClock, peaksFromAudioBuffer, peaksFromChannel, resamplePeaks } from './index.js';

/** Records rects per fill colour, and what the playhead drew. */
function fakeCtx() {
	const fills: Array<{ color: string; rects: number[][] }> = [];
	let rects: number[][] = [];
	const ctx = {
		fillStyle: '',
		font: '',
		textAlign: '',
		textBaseline: '',
		beginPath: () => (rects = []),
		rect: (...r: number[]) => rects.push(r),
		fill: () => fills.push({ color: ctx.fillStyle, rects }),
		fillRect: (...r: number[]) => fills.push({ color: ctx.fillStyle, rects: [r] }),
		measureText: (t: string) => ({ width: t.length * 6 }),
		moveTo: () => {},
		lineTo: () => {},
		quadraticCurveTo: () => {},
		closePath: () => {},
		texts: [] as string[],
		fillText(t: string) {
			this.texts.push(t);
		}
	};
	return { ctx: ctx as unknown as CanvasRenderingContext2D & { texts: string[] }, fills };
}

describe('waveform peaks', () => {
	it('takes the loudest sample of each slice', () => {
		expect(peaksFromChannel([0.1, -0.5, 0.2, 0.9, -0.3], 2)).toEqual([0.5, 0.9, 0.3]);
	});

	it('reads peaks per second from a decoded buffer', () => {
		const data = new Float32Array(1000).map((_, i) => (i < 500 ? 0.25 : -0.75));
		const out = peaksFromAudioBuffer({ getChannelData: () => data, sampleRate: 1000, duration: 1 }, 4);
		expect(out).toEqual({ samples: [0.25, 0.25, 0.75, 0.75], duration: 1 });
	});

	it('resamples to an exact count without losing a short peak', () => {
		const peaks = new Array(1000).fill(0.1);
		peaks[537] = 0.95;
		const out = resamplePeaks(peaks, 10);
		expect(out).toHaveLength(10);
		expect(out[5]).toBe(0.95);
		expect(resamplePeaks([0.3, 0.6], 4)).toEqual([0.3, 0.3, 0.6, 0.6]);
		expect(resamplePeaks([], 3)).toEqual([0, 0, 0]);
	});
});

describe('waveform drawing', () => {
	it('fills played bars in one colour and the rest in another', () => {
		const { ctx, fills } = fakeCtx();
		drawPeakBars(ctx, 40, 20, [1, 0, 0.5, 0.5], 0.5, { barWidth: 3, gap: 1, playedColor: 'P', restColor: 'R' });
		expect(fills.map((f) => [f.color, f.rects.length])).toEqual([
			['P', 5],
			['R', 5]
		]);
		// A full peak is 80% of the height, centred; silence keeps a 2px line.
		expect(fills[0]!.rects[0]).toEqual([0, 2, 3, 16]);
		expect(fills[0]!.rects[3]![3]).toBe(2);
	});

	it('keeps the playhead tag inside the canvas and labels it', () => {
		const { ctx, fills } = fakeCtx();
		drawPlayheadHandle(ctx, 198, 200, 40, '1:05', { color: 'red', textColor: 'white' });
		expect(fills[0]).toEqual({ color: 'red', rects: [[198, 0, 2, 40]] });
		expect(ctx.texts).toEqual(['1:05']);
	});

	it('formats clock times', () => {
		expect(formatClock(5)).toBe('0:05');
		expect(formatClock(754.9)).toBe('12:34');
		expect(formatClock(3725)).toBe('1:02:05');
		expect(formatClock(NaN)).toBe('0:00');
	});
});
