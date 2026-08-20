import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
	imageNameForType,
	looksLikeUrl,
	payloadFromDataTransfer,
	payloadFromText,
	textFileName
} from '../src/ui/systemClipboard.ts';

describe('systemClipboard', () => {
	it('detects http(s) and mailto links', () => {
		assert.equal(looksLikeUrl('https://example.com/a'), true);
		assert.equal(looksLikeUrl('http://localhost:7990'), true);
		assert.equal(looksLikeUrl('mailto:hi@example.com'), true);
		assert.equal(looksLikeUrl('not a link'), false);
		assert.equal(looksLikeUrl('https://example.com and more'), false);
	});

	it('names link and text clips as .txt', () => {
		assert.equal(textFileName('https://www.example.com/path', true), 'example.com.txt');
		assert.equal(textFileName('hello world\nmore', false), 'hello world.txt');
		const link = payloadFromText('https://example.com/x');
		assert.equal(link?.kind, 'link');
		assert.equal(link?.files[0]?.name, 'example.com.txt');
		assert.equal(link?.files[0]?.type, 'text/plain');
		const text = payloadFromText('just a note');
		assert.equal(text?.kind, 'text');
		assert.equal(text?.files[0]?.name, 'just a note.txt');
	});

	it('picks image filenames from mime type', () => {
		assert.equal(imageNameForType('image/png'), 'clipboard.png');
		assert.equal(imageNameForType('image/jpeg'), 'clipboard.jpg');
		assert.equal(imageNameForType('image/webp'), 'clipboard.webp');
	});

	it('reads files and text from a DataTransfer-like object', () => {
		const file = new File(['x'], 'photo.png', { type: 'image/png' });
		const fromFile = payloadFromDataTransfer({
			files: { length: 1, item: (i: number) => (i === 0 ? file : null) },
			items: { length: 0 },
			getData: () => ''
		} as unknown as DataTransfer);
		assert.equal(fromFile?.kind, 'image');
		assert.equal(fromFile?.files[0]?.name, 'photo.png');
		const fromText = payloadFromDataTransfer({
			files: { length: 0 },
			items: { length: 0 },
			getData: (t: string) => (t === 'text/plain' ? 'hello' : '')
		} as unknown as DataTransfer);
		assert.equal(fromText?.kind, 'text');
		assert.equal(fromText?.files[0]?.name, 'hello.txt');
	});
});
