import { describe, expect, it } from 'vitest';
import { normalizeSpans } from './normalize.js';
import {
	isPaletteId,
	nearestPaletteId,
	paintMarkFromCss,
	parseCssColor,
	sanitizeHex
} from './palette.js';

describe('sanitizeHex / parseCssColor', () => {
	it('canonicalizes #rgb and #rrggbb, with or without hash', () => {
		expect(sanitizeHex('#F00')).toBe('#ff0000');
		expect(sanitizeHex('ef4444')).toBe('#ef4444');
		expect(sanitizeHex('#EF4444')).toBe('#ef4444');
		expect(sanitizeHex('not-a-color')).toBeNull();
		expect(sanitizeHex('#ff00')).toBeNull();
	});

	it('parses rgb() and drops named colors', () => {
		expect(parseCssColor('rgb(239, 68, 68)')).toBe('#ef4444');
		expect(parseCssColor('rgba(239, 68, 68, 0.5)')).toBe('#ef4444');
		expect(parseCssColor('red')).toBeNull();
		expect(parseCssColor('var(--accent)')).toBeNull();
	});
});

describe('nearestPaletteId / paintMarkFromCss', () => {
	it('snaps exact paper hex and close aliases', () => {
		expect(nearestPaletteId('#ef4444')).toBe('red');
		expect(nearestPaletteId('#ff0000')).toBe('red');
		expect(nearestPaletteId('#ffff00')).toBe('yellow');
		expect(isPaletteId('sky')).toBe(true);
		expect(isPaletteId('navy')).toBe(false);
	});

	it('keeps far hex as a custom mark', () => {
		const mark = paintMarkFromCss('color', '#123456');
		expect(mark).toEqual({ type: 'color', hex: '#123456' });
		expect(paintMarkFromCss('highlight', '#eab308')).toEqual({ type: 'highlight', color: 'yellow' });
	});
});

describe('normalize color marks', () => {
	it('keeps palette ids and canonical hex, drops junk', () => {
		expect(
			normalizeSpans([
				{
					type: 'text',
					text: 'x',
					marks: [
						{ type: 'color', color: 'red' },
						{ type: 'highlight', hex: '#FF00FF' }
					]
				}
			])[0]!.marks
		).toEqual([
			{ type: 'color', color: 'red' },
			{ type: 'highlight', hex: '#ff00ff' }
		]);
	});
});
