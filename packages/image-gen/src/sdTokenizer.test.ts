import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSdTokenizer, encodeSdPrompt } from './sdTokenizer.js';

// Small CLIP-format vocabulary with two ranked merges and UTF-8 byte tokens.
const vocab = {
	'!': 0, 'c': 1, 'a': 2, 't</w>': 3, 'ca': 4, 'cat</w>': 5,
	'!</w>': 6, 'Ã': 7, '©</w>': 8,
	'<|startoftext|>': 49406, '<|endoftext|>': 49407
};

function storedFiles(): Map<string, ArrayBuffer> {
	const bytes = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer;
	return new Map([
		['tokenizer/vocab.json', bytes(JSON.stringify(vocab))],
		['tokenizer/merges.txt', bytes('#version: 0.2\r\nc a\r\nca t</w>\r\n')]
	]);
}

afterEach(() => vi.unstubAllGlobals());

describe('stored SD tokenizer', () => {
	it('loads vocab/merges without tokenizer.json or any network access', () => {
		const fetch = vi.fn(() => { throw new Error('Unexpected download'); });
		vi.stubGlobal('fetch', fetch);
		const tokenizer = createSdTokenizer(storedFiles());
		expect(tokenizer.encode('  CAT\tcat!  ')).toEqual([49406, 5, 5, 6, 49407]);
		expect(fetch).not.toHaveBeenCalled();
	});

	it('encodes Unicode as UTF-8 bytes after NFC normalization', () => {
		const tokenizer = createSdTokenizer(storedFiles());
		expect(tokenizer.encode('E\u0301')).toEqual([49406, 7, 8, 49407]);
	});

	it('pads short and empty prompts to the text encoder length with zeroes', () => {
		const tokenizer = createSdTokenizer(storedFiles());
		const ids = encodeSdPrompt(tokenizer, 'cat');
		expect(ids).toHaveLength(77);
		expect(ids.slice(0, 3)).toEqual([49406, 5, 49407]);
		expect(ids.slice(3)).toEqual(Array(74).fill(0));
		expect(encodeSdPrompt(tokenizer, '')).toEqual([49406, 49407, ...Array(75).fill(0)]);
	});

	it('truncates long prompts to the fixed attention length', () => {
		const tokenizer = createSdTokenizer(storedFiles());
		const ids = encodeSdPrompt(tokenizer, 'cat '.repeat(100));
		expect(ids).toHaveLength(77);
		expect(ids[0]).toBe(49406);
		expect(ids.slice(1)).toEqual(Array(76).fill(5));
	});

	it.each(['tokenizer/vocab.json', 'tokenizer/merges.txt'])('reports a missing stored %s', (path) => {
		const files = storedFiles();
		files.delete(path);
		expect(() => createSdTokenizer(files)).toThrow(`Model files are missing ${path}`);
	});

	it('rejects a vocabulary without CLIP special tokens', () => {
		const files = storedFiles();
		files.set('tokenizer/vocab.json', new TextEncoder().encode('{}').buffer as ArrayBuffer);
		expect(() => createSdTokenizer(files)).toThrow('CLIP vocabulary is missing its start/end tokens');
	});
});
