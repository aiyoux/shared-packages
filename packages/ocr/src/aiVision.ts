import { inputToCanvas } from './pixels.js';
import type { OcrEngine, OcrInput, OcrLang, OcrResult } from './types.js';

/**
 * AI-vision OCR: a recognizer whose "weights" are the model a monitor serves.
 * This package has no transport opinion — callers inject the chat function
 * (the hub wires it to `completeAiChat` with `image_url` parts), so the
 * package can't reach the network by itself.
 */

export const AI_VISION_ENGINE_ID = 'ai-vision';

export const AI_VISION_PROMPT_BASE =
	'Transcribe ALL text visible in this image, in reading order, one visual line per output line.';

export function buildAiVisionPrompt(lang?: OcrLang): string {
	const language = lang && lang !== 'eng' ? ` The text is ${lang === 'jpn' ? 'Japanese' : lang} — transcribe it exactly.` : '';
	return `${AI_VISION_PROMPT_BASE}${language} Output only the transcription with no commentary.`;
}

export type AiVisionPart =
	| { type: 'text'; text: string }
	| { type: 'image_url'; image_url: { url: string } };

export type AiVisionChatMessage = { role: 'user'; content: AiVisionPart[] };

export type AiVisionTransport = (messages: readonly AiVisionChatMessage[]) => Promise<string>;

/** The one request shape: the prompt part first, the image second. */
export function aiVisionMessages(dataUrl: string, promptText: string): AiVisionChatMessage[] {
	return [
		{
			role: 'user',
			content: [
				{ type: 'text', text: promptText },
				{ type: 'image_url', image_url: { url: dataUrl } }
			]
		}
	];
}

export function createAiVisionEngine({
	chat,
	prompt = buildAiVisionPrompt
}: {
	chat: AiVisionTransport;
	prompt?: (lang?: OcrLang) => string;
}): OcrEngine {
	return {
		id: AI_VISION_ENGINE_ID,
		async recognize(input: OcrInput, options: { lang?: OcrLang } = {}): Promise<OcrResult> {
			const dataUrl = await inputToDataUrl(input);
			const text = (await chat(aiVisionMessages(dataUrl, prompt(options.lang)))).trim();
			if (!text) throw new Error('The AI model returned no text.');
			return { text: text, regions: [] };
		}
	};
}

/** Any engine input as a JPEG data URL, downscaled hard — vision models
 * waste tokens on pixels they can't read and choke on huge screenshots. */
export async function inputToDataUrl(
	source: OcrInput,
	maxEdge = 1536
): Promise<string> {
	const canvas = await inputToCanvas(source);
	const scale = Math.min(1, maxEdge / Math.max(canvas.width, canvas.height));
	const width = Math.max(1, Math.round(canvas.width * scale));
	const height = Math.max(1, Math.round(canvas.height * scale));
	const resized = document.createElement('canvas');
	resized.width = width;
	resized.height = height;
	const ctx = resized.getContext('2d');
	if (!ctx) throw new Error('Could not create a 2D canvas for the AI vision request.');
	ctx.fillStyle = '#fff';
	ctx.fillRect(0, 0, width, height);
	ctx.drawImage(canvas, 0, 0, width, height);
	return resized.toDataURL('image/jpeg', 0.85);
}