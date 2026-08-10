import { VfsError } from './types.js';

const INVALID = /[\\/:\0\u0000-\u001f]/g;

export function sanitizeName(raw: string): string {
	let n = raw.trim().normalize('NFC');
	n = n.replace(INVALID, '_');
	if (n === '' || n === '.' || n === '..') {
		throw new VfsError('INVALID_NAME', `Invalid name: ${JSON.stringify(raw)}`);
	}
	if (n.length > 255) n = n.slice(0, 255);
	return n;
}

/** Split base + extension for suffix insertion: "Foo.skch" → ["Foo", ".skch"] */
export function splitNameExt(name: string): { base: string; ext: string } {
	const i = name.lastIndexOf('.');
	if (i <= 0) return { base: name, ext: '' };
	return { base: name.slice(0, i), ext: name.slice(i) };
}

export function withNumericSuffix(name: string, n: number): string {
	const { base, ext } = splitNameExt(name);
	return `${base} (${n})${ext}`;
}
