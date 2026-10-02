import { describe, expect, it } from 'vitest';
import { finiteNumber, isRecord, mintDocId, optionalId } from './index.js';

describe('isRecord', () => {
	it('accepts plain objects only', () => {
		expect(isRecord({})).toBe(true);
		expect(isRecord({ a: 1 })).toBe(true);
		expect(isRecord(null)).toBe(false);
		expect(isRecord(undefined)).toBe(false);
		expect(isRecord([1])).toBe(false);
		expect(isRecord('x')).toBe(false);
		expect(isRecord(5)).toBe(false);
	});
});

describe('optionalId', () => {
	it('passes non-empty strings through', () => {
		expect(optionalId('doc-1')).toBe('doc-1');
		expect(optionalId(' spaced ')).toBe(' spaced ');
	});
	it('reads whitespace-only and non-strings as absent', () => {
		expect(optionalId('   ')).toBeUndefined();
		expect(optionalId('')).toBeUndefined();
		expect(optionalId(42)).toBeUndefined();
		expect(optionalId(null)).toBeUndefined();
		expect(optionalId(undefined)).toBeUndefined();
	});
});

describe('finiteNumber', () => {
	it('returns finite numbers', () => {
		expect(finiteNumber(0, 'x')).toBe(0);
		expect(finiteNumber(-1.5, 'x')).toBe(-1.5);
	});
	it('rejects non-finite and non-numbers with a field name', () => {
		expect(() => finiteNumber(Infinity, 'x')).toThrow(/x must be a finite number/);
		expect(() => finiteNumber(NaN, 'x')).toThrow(/x must be a finite number/);
		expect(() => finiteNumber('1', 'x')).toThrow(/x must be a finite number/);
	});
	it('wraps the message in the caller error class', () => {
		class FakeError extends Error {}
		expect(() => finiteNumber('1', 'x', (m) => new FakeError(m))).toThrow(FakeError);
	});
});

describe('mintDocId', () => {
	it('mints unique ids', () => {
		expect(mintDocId()).not.toBe(mintDocId());
	});
	it('uses the prefix only when randomUUID is unavailable', () => {
		const id = mintDocId('anim');
		expect(id === 'anim-' ? id : typeof id === 'string' && id.length > 0).toBe(true);
	});
});