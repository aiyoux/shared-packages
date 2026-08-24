import { describe, expect, it } from 'vitest';
import {
	baseName,
	breadcrumbChain,
	childId,
	parentIdOf,
	relativeIdFromAbsolute,
	sanitizeSegment,
	toAbsolutePath
} from './pathIds.js';

describe('monitor pathIds', () => {
	it('toAbsolutePath joins root + relative', () => {
		expect(toAbsolutePath('/tmp', null)).toBe('/tmp');
		expect(toAbsolutePath('/tmp', 'a/')).toBe('/tmp/a');
		expect(toAbsolutePath('/tmp', 'a/b.txt')).toBe('/tmp/a/b.txt');
		expect(toAbsolutePath('/', 'etc/hosts')).toBe('/etc/hosts');
	});

	it('relativeIdFromAbsolute under root', () => {
		expect(relativeIdFromAbsolute('/tmp', '/tmp/foo', true)).toBe('foo/');
		expect(relativeIdFromAbsolute('/tmp', '/tmp/foo/bar.txt', false)).toBe('foo/bar.txt');
	});

	it('childId / parentIdOf / baseName', () => {
		expect(childId(null, 'x', true)).toBe('x/');
		expect(childId('a/', 'b', false)).toBe('a/b');
		expect(parentIdOf('a/b.txt')).toBe('a/');
		expect(baseName('a/b/')).toBe('b');
	});

	it('breadcrumbChain for nested folder', () => {
		const c = breadcrumbChain('a/b/');
		expect(c.map((x) => x.id)).toEqual(['a/', 'a/b/']);
		expect(c[0]!.parentId).toBeNull();
	});

	it('sanitizeSegment trims and rejects empty / . / .. / slash', () => {
		expect(sanitizeSegment(' ok ')).toBe('ok');
		expect(sanitizeSegment('a.png')).toBe('a.png');
		expect(() => sanitizeSegment('')).toThrow(/INVALID_NAME/);
		expect(() => sanitizeSegment('..')).toThrow(/INVALID_NAME/);
		expect(() => sanitizeSegment('foo/bar.png')).toThrow(/INVALID_NAME/);
	});
});
