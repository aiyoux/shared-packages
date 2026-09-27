/**
 * Pure helpers for the AI-connector STT engine — message shape, model
 * heuristics, payload caps. Node-testable.
 */

import { wavBytesFor } from './wav.js';

/** Most upstreams reject large bodies; ~20 MB of base64 WAV ≈ 10 min audio. */
export const AI_AUDIO_WAV_MAX_BYTES = 20 * 1024 * 1024;

export const DEFAULT_STT_PROMPT = 'Transcribe this audio. Return only the transcript.';

export type SttChatMessages = {
	model: string;
	messages: Array<{
		role: 'user';
		content: Array<
			| { type: 'text'; text: string }
			| { type: 'input_audio'; input_audio: { data: string; format: 'wav' } }
		>;
	}>;
};

export function buildSttAudioMessages(model: string, base64Wav: string, prompt = DEFAULT_STT_PROMPT): SttChatMessages {
	return {
		model,
		messages: [
			{
				role: 'user',
				content: [
					{ type: 'text', text: prompt },
					{ type: 'input_audio', input_audio: { data: base64Wav, format: 'wav' } }
				]
			}
		]
	};
}

/**
 * There is no capability metadata for monitor AI models, so guess from the
 * id. The full list is always offered as a fallback — this only ranks.
 */
export function looksAudioCapable(modelId: string): boolean {
	return /gpt-4o|audio|omni|gemini|qwen.*audio|realtime|piper|whisper|voxtral|parakeet/i.test(modelId);
}

export function rankModelsForAudio(models: readonly string[]): string[] {
	return [...models].sort((a, b) => Number(looksAudioCapable(b)) - Number(looksAudioCapable(a)));
}

/** WAV bytes for a duration, and whether it clears the payload cap. */
export function checkAiAudioSize(durationMs: number): {
	wavBytes: number;
	tooLarge: boolean;
	maxDurationMs: number;
} {
	const wavBytes = wavBytesFor(durationMs);
	return {
		wavBytes,
		tooLarge: wavBytes > AI_AUDIO_WAV_MAX_BYTES,
		maxDurationMs: Math.floor((AI_AUDIO_WAV_MAX_BYTES / (wavBytesFor(1000) - 44)) * 1000)
	};
}

/** Map an HTTP status to the AI error code taxonomy used by the hub. */
export function aiStatusToCode(
	status: number
): 'AI_AUTH' | 'AI_NOT_FOUND' | 'AI_RATE' | 'AI_ERROR' {
	if (status === 401 || status === 403) return 'AI_AUTH';
	if (status === 404) return 'AI_NOT_FOUND';
	if (status === 429) return 'AI_RATE';
	return 'AI_ERROR';
}