import { describe, expect, it } from 'vitest';
import { scanicCornersToQuad } from './scanic.js';

describe('scanicCornersToQuad', () => {
	it('accepts named corners and canonicalizes order', () => {
		const quad = scanicCornersToQuad({
			topRight: { x: 300, y: 10 },
			bottomLeft: { x: 10, y: 400 },
			topLeft: { x: 10, y: 10 },
			bottomRight: { x: 300, y: 400 }
		});
		expect(quad).not.toBeNull();
		const [tl, tr, br, bl] = quad!;
		expect(tl).toEqual({ x: 10, y: 10 });
		expect(tr).toEqual({ x: 300, y: 10 });
		expect(br).toEqual({ x: 300, y: 400 });
		expect(bl).toEqual({ x: 10, y: 400 });
	});

	it('rejects missing or malformed corners without throwing', () => {
		expect(scanicCornersToQuad(null)).toBeNull();
		expect(scanicCornersToQuad(undefined)).toBeNull();
		expect(
			scanicCornersToQuad({
				topLeft: { x: 10, y: 10 },
				topRight: { x: 300, y: 10 },
				bottomRight: { x: 300, y: 400 },
				bottomLeft: { x: '400', y: 400 }
			} as unknown as Parameters<typeof scanicCornersToQuad>[0])
		).toBeNull();
	});
});
