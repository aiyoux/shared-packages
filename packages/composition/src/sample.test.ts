import { describe, expect, it } from 'vitest';
import { sample } from './sample.js';
import type { Clip, CompositionDoc } from './types.js';

function clip(partial: Partial<Clip> & Pick<Clip, 'id'>): Clip {
	return {
		kind: 'igfx',
		startMs: 0,
		durationMs: 8_000,
		offsetMs: 0,
		payload: null,
		...partial
	};
}

const comp: CompositionDoc = {
	durationMs: 10_000,
	width: 1920,
	height: 1080,
	tracks: [
		{
			id: 'media',
			role: 'media',
			clips: [clip({ id: 'bed', kind: 'media', durationMs: 8_000, offsetMs: 250 })]
		},
		{
			id: 'graphics',
			role: 'graphics',
			// Caller stretches the graphics clip to the composition span — do not hold last pixels.
			clips: [clip({ id: 'igfx-main', kind: 'igfx', durationMs: 10_000, offsetMs: 0 })]
		}
	]
};

describe('sample', () => {
	it('pre-adjusts localMs as tMs - startMs + offsetMs', () => {
		const at = sample(comp, 1_000);
		expect(at).toHaveLength(2);
		expect(at[0]).toMatchObject({ clip: { id: 'bed' }, localMs: 1_250 });
		expect(at[1]).toMatchObject({ clip: { id: 'igfx-main' }, localMs: 1_000 });
	});

	it('keeps a spannable graphics clip after media ends', () => {
		const at = sample(comp, 9_000);
		expect(at.map((s) => s.clip.id)).toEqual(['igfx-main']);
		expect(at[0].localMs).toBe(9_000);
	});

	it('lets later overlapping clips win', () => {
		const overlapped: CompositionDoc = {
			durationMs: 8_000,
			width: 64,
			height: 64,
			tracks: [
				{
					id: 'graphics',
					role: 'graphics',
					clips: [
						clip({ id: 'a', startMs: 0, durationMs: 5_000, offsetMs: 0 }),
						clip({ id: 'b', startMs: 4_000, durationMs: 2_000, offsetMs: 100 })
					]
				}
			]
		};
		const at = sample(overlapped, 4_500);
		expect(at).toHaveLength(1);
		expect(at[0].clip.id).toBe('b');
		expect(at[0].localMs).toBe(600);
	});
});
