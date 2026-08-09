import { describe, it, expect } from 'vitest';
import {
	baseName,
	breadcrumbChain,
	childId,
	isFolderId,
	parentIdOf,
	sanitizeSegment,
	toRemoteParam
} from './pathIds.js';

describe('rclone pathIds', () => {
	it('childId builds file and folder ids under parent', () => {
		expect(childId(null, 'a.txt', false)).toBe('a.txt');
		expect(childId(null, 'docs', true)).toBe('docs/');
		expect(childId('docs/', 'note.txt', false)).toBe('docs/note.txt');
		expect(childId('docs/', '2026', true)).toBe('docs/2026/');
	});

	it('toRemoteParam joins rootPath', () => {
		expect(toRemoteParam('', null)).toBe('');
		expect(toRemoteParam('team', null)).toBe('team');
		expect(toRemoteParam('team', 'docs/')).toBe('team/docs/');
		expect(toRemoteParam('team', 'docs/a.txt')).toBe('team/docs/a.txt');
		expect(toRemoteParam('', 'docs/a.txt')).toBe('docs/a.txt');
	});

	it('rejects .. segments', () => {
		expect(() => childId(null, '..', false)).toThrow();
		expect(() => toRemoteParam('', '../x')).toThrow();
	});

	it('parentIdOf and baseName', () => {
		expect(parentIdOf('a.txt')).toBeNull();
		expect(parentIdOf('docs/a.txt')).toBe('docs/');
		expect(parentIdOf('docs/2026/')).toBe('docs/');
		expect(baseName('docs/a.txt')).toBe('a.txt');
		expect(baseName('docs/2026/')).toBe('2026');
		expect(isFolderId('docs/')).toBe(true);
		expect(isFolderId('a.txt')).toBe(false);
	});

	it('breadcrumbChain under root', () => {
		const path = breadcrumbChain('docs/2026/');
		expect(path.map((p) => p.name)).toEqual(['docs', '2026']);
		expect(path[0]?.parentId).toBeNull();
		// file path → parent folders only
		const filePath = breadcrumbChain('docs/a.txt');
		expect(filePath.map((p) => p.name)).toEqual(['docs']);
	});

	it('sanitizeSegment', () => {
		expect(sanitizeSegment(' ok ')).toBe('ok');
		expect(() => sanitizeSegment('a/b')).toThrow();
		expect(() => sanitizeSegment('..')).toThrow();
	});

	it('unicode round-trip name', () => {
		const id = childId(null, 'фото.txt', false);
		expect(baseName(id)).toBe('фото.txt');
		expect(toRemoteParam('root', id)).toBe('root/фото.txt');
	});
});
