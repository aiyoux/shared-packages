import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { SvgElement, SvgTextElement } from '../src/types';

describe('SvgTextElement', () => {
	it('is a valid SvgElement when type is text', () => {
		const text: SvgTextElement = {
			type: 'text',
			id: 'text-1',
			x: 12,
			y: 24,
			text: 'Hello',
			fontFamily: 'sans-serif',
			fontSize: 16,
			fill: '#111'
		};
		const elements: SvgElement[] = [text];
		const el = elements[0];
		assert.equal(el.type, 'text');
		assert.equal(el.id, 'text-1');
		assert.ok('x' in el && el.x === 12);
		assert.ok('y' in el && el.y === 24);
		assert.ok('text' in el && el.text === 'Hello');
		assert.ok('fontFamily' in el && el.fontFamily === 'sans-serif');
		assert.ok('fontSize' in el && el.fontSize === 16);
		assert.ok('fill' in el && el.fill === '#111');
	});
});
