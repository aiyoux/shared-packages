/**
 * Pure helpers for the monitor STT engine — payload caps. Node-testable.
 * The old chat-completions `input_audio` path and its model-name heuristics
 * are gone: transcription offers come from the monitor's catalog.
 */

import { wavBytesFor } from './wav.js';

/**
 * The monitor accepts up to 32 MiB of request body, and base64 inflates WAV
 * by 4/3 — so about 24 MiB of WAV (~13 min) is the honest client cap.
 */
export const AI_AUDIO_WAV_MAX_BYTES = 24 * 1024 * 1024;

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