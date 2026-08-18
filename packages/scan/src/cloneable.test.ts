import { describe, expect, it } from 'vitest';
import { plainQuad, workerPayload } from './cloneable.js';
import { orderCorners } from './geometry.js';

function proxied<T extends object>(value: T): T {
	return new Proxy(value, {
		get(target, prop, receiver) {
			return Reflect.get(target, prop, receiver);
		}
	});
}

describe('plainQuad', () => {
	it('unwraps a proxied quad into something structuredClone can send', () => {
		const raw = orderCorners([
			{ x: 10, y: 10 },
			{ x: 90, y: 10 },
			{ x: 90, y: 90 },
			{ x: 10, y: 90 }
		]);
		const reactive = proxied(
			raw.map((p) => proxied({ x: p.x, y: p.y })) as unknown as typeof raw
		);
		expect(() => structuredClone(reactive)).toThrow();
		const plain = plainQuad(reactive);
		expect(() => structuredClone(plain)).not.toThrow();
		expect(plain).toEqual(raw);
	});
});

describe('workerPayload', () => {
	it('keeps the pixel buffer and clones the rest through JSON', () => {
		const buffer = new Uint8ClampedArray([1, 2, 3, 4]).buffer;
		const quad = proxied([{ x: 1, y: 2 }, { x: 3, y: 4 }, { x: 5, y: 6 }, { x: 7, y: 8 }]);
		const payload = workerPayload({
			type: 'warp',
			buffer,
			width: 2,
			height: 1,
			quad,
			opts: proxied({ maxEdge: 800 })
		});
		expect(payload.buffer).toBe(buffer);
		expect(payload.quad).toEqual([
			{ x: 1, y: 2 },
			{ x: 3, y: 4 },
			{ x: 5, y: 6 },
			{ x: 7, y: 8 }
		]);
		expect(payload.opts).toEqual({ maxEdge: 800 });
		expect(() => structuredClone(payload)).not.toThrow();
	});
});
