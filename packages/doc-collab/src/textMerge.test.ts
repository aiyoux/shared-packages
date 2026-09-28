import { describe, expect, it } from 'vitest';
import { mergeTextChanges } from './textMerge.js';

describe('shared text merge', () => {
	it('preserves disjoint character edits in either sequencing order', () => {
		expect(mergeTextChanges('one two', 'ONE two', 'one TWO')).toBe('ONE TWO');
		expect(mergeTextChanges('one two', 'one TWO', 'ONE two')).toBe('ONE TWO');
	});
	it('preserves a peer edit between two changes in one submission', () => {
		expect(mergeTextChanges('aa bb cc', 'AA bb CC', 'aa BB cc')).toBe(
			'AA BB CC'
		);
	});
	it('uses incoming text only in overlapping regions', () => {
		expect(mergeTextChanges('abc tail', 'aYc tail', 'aXc TAIL')).toBe(
			'aYc TAIL'
		);
	});
	it('includes identical concurrent inserts once', () => {
		expect(mergeTextChanges('ab', 'aXb', 'aXb')).toBe('aXb');
	});
	it('orders different inserts at the same anchor by the sequencer', () => {
		expect(mergeTextChanges('ab', 'aXb', 'aYb')).toBe('aXb');
	});
	it('keeps inserts at deletion boundaries', () => {
		expect(mergeTextChanges('abc', 'ac', 'aXbcY')).toBe('aXcY');
	});
	it('keeps a remote change beside emoji', () => {
		expect(mergeTextChanges('a😀b', 'A😀b', 'a😀B')).toBe('A😀B');
	});
});
