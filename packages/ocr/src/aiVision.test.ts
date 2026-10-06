import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AI_VISION_ENGINE_ID, aiVisionMessages, buildAiVisionPrompt, createAiVisionEngine, type AiVisionChatMessage } from './aiVision.ts';

describe('AI vision prompt and messages', () => {
	it('keeps the prompt transcription-only, naming the language when given', () => {
		expect(buildAiVisionPrompt()).toContain('reading order');
		expect(buildAiVisionPrompt()).not.toContain('Japanese');
		expect(buildAiVisionPrompt('jpn')).toContain('Japanese');
		expect(buildAiVisionPrompt('eng')).not.toContain('Japanese');
	});

	it('sends the prompt part first, then the image', () => {
		const messages = aiVisionMessages('data:image/jpeg;base64,AABB', buildAiVisionPrompt('jpn'));
		expect(messages).toHaveLength(1);
		expect(messages[0]!.role).toBe('user');
		const content = messages[0]!.content;
		expect(content[0]).toEqual({ type: 'text', text: buildAiVisionPrompt('jpn') });
		expect(content[1]).toEqual({ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AABB' } });
	});
});

describe('createAiVisionEngine', () => {
	// The engine converts any input through a canvas — a minimal DOM stub so
	// the real conversion path runs in node.
	const dataUrlOut = 'data:image/jpeg;base64,STUB';
	let created = 0;

	beforeEach(() => {
		created = 0;
		// Stub `document.createElement('canvas')` …
		class StubCanvas {
			width = 0;
			height = 0;
			getContext() {
				return {
					fillStyle: '',
					fillRect: () => undefined,
					putImageData: () => undefined,
					getImageData: () => new ImageDataStub(4, 4),
					drawImage: () => undefined
				};
			}
			toBlob(cb: (blob: Blob | null) => void) {
				cb(new Blob([new Uint8Array([1])]));
			}
			toDataURL() {
				return dataUrlOut;
			}
		}
		class ImageDataStub {
			width: number;
			height: number;
			data: Uint8ClampedArray;
			constructor(width: number, height: number) {
				this.width = width;
				this.height = height;
				this.data = new Uint8ClampedArray(width * height * 4).fill(255);
			}
		}
		let id = 0;
		vi.stubGlobal('document', {
			createElement: (tag: string) => {
				if (tag !== 'canvas') throw new Error(`unexpected ${tag}`);
				created += 1;
				return new StubCanvas();
			}
		});
		vi.stubGlobal('ImageData', ImageDataStub);
		vi.stubGlobal('HTMLCanvasElement', StubCanvas);
		vi.stubGlobal('createImageBitmap', (_blob: Blob) => {
			id += 1;
			if (id > 1) throw new Error('only one bitmap expected');
			return Promise.resolve({ width: 4, height: 4, close: () => undefined });
		});
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('passes the data URL through the chat transport and trims the reply', async () => {
		const chat = vi.fn(async (_messages: readonly AiVisionChatMessage[]) => '  HELLO  ');
		const engine = createAiVisionEngine({ chat });
		expect(engine.id).toBe(AI_VISION_ENGINE_ID);
		const result = await engine.recognize(new Blob(['image']));
		expect(result).toEqual({ text: 'HELLO', regions: [] });
		const sent = chat.mock.calls[0]?.[0] as readonly AiVisionChatMessage[];
		expect(sent[0]!.content[0]!.type).toBe('text');
		expect(sent[0]!.content[1]).toEqual({ type: 'image_url', image_url: { url: dataUrlOut } });
	});

	it('fails loudly on an empty reply instead of returning empty text', async () => {
		const engine = createAiVisionEngine({ chat: async () => '   ' });
		await expect(engine.recognize(new Blob(['image']))).rejects.toThrow(/returned no text/);
	});
});