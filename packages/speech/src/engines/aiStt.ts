/**
 * STT through the monitor's AI connection. The monitor's
 * `/v1/ai/chat/completions` forwards the body unmodified, so OpenAI-style
 * `input_audio` content parts reach audio-capable upstreams without any
 * daemon change. Keys stay daemon-side; requests are keyless.
 */

import { resolveAiMonitor, requestAiChatCompletion, AiCredentialsError, type AiMonitor } from '@shared-packages/file-system/ai';
import { SpeechEngineError, type SttEngine, type SttEngineInfo, type SttResult } from '../types.js';
import { base64FromBytes, decodeToMono16k, DURATION_MAX_MS, TARGET_SAMPLE_RATE } from '../audio.js';
import { encodeWav } from '../wav.js';
import { buildSttAudioMessages, checkAiAudioSize } from '../aiParts.js';

const info: SttEngineInfo = {
	id: 'ai',
	label: 'AI connector (monitor)',
	description:
		'Sends the recording to an audio-capable model through your monitor’s AI connection. Needs a connected monitor.',
	supportsMic: false,
	supportsFileInput: true,
	streamingPartials: false,
	languageSelection: false,
	onDevice: false
};

export async function resolveAiBackend(): Promise<AiMonitor | null> {
	return resolveAiMonitor();
}

export function createAiStt(): SttEngine {
	return {
		info,

		async probe() {
			const monitor = await resolveAiBackend();
			return {
				supported: monitor != null,
				reason: monitor == null ? 'No monitor with an AI connection is reachable' : undefined
			};
		},

		async load() {
			const monitor = await resolveAiBackend();
			if (!monitor) {
				throw new SpeechEngineError('AI_NO_BACKEND', 'No monitor with an AI connection is reachable');
			}
		},

		async startListening() {
			throw new SpeechEngineError(
				'UNSUPPORTED_BROWSER',
				'The AI engine transcribes recordings, not live listening — record first, or use another engine'
			);
		},

		async stopListening() {
			return '';
		},

		async transcribe(audio, sampleRate, opts): Promise<SttResult> {
			if (sampleRate !== TARGET_SAMPLE_RATE) {
				throw new SpeechEngineError('TRANSCRIBE_FAILED', `Expected ${TARGET_SAMPLE_RATE} Hz audio, got ${sampleRate}`);
			}
			const monitor = await resolveAiBackend();
			if (!monitor) {
				throw new SpeechEngineError(
					'AI_NO_BACKEND',
					'No monitor with an AI connection is reachable — connect one in Connections'
				);
			}
			const durationMs = Math.round((audio.length / sampleRate) * 1000);
			const size = checkAiAudioSize(durationMs);
			if (durationMs > DURATION_MAX_MS || size.tooLarge) {
				throw new SpeechEngineError(
					'AUDIO_TOO_LONG',
					`Recording is too large for the AI connector (about ${Math.round(size.maxDurationMs / 60000)} min max)`
				);
			}
			const chosen = opts?.aiModel;
			if (!chosen) throw new SpeechEngineError('NO_MODEL', 'Pick a model first');

			// base64 WAV inflates 4/3; the payload cap bounds both sides.
			const wav = encodeWav(audio, sampleRate, 1);
			const body = buildSttAudioMessages(chosen, base64FromBytes(wav));

			let json: {
				choices?: Array<{ message?: { content?: string | Array<{ type: string; text?: string }> } }>;
			};
			try {
				json = await requestAiChatCompletion(monitor.baseUrl, body, opts?.aiProfileId, opts?.signal) as typeof json;
			} catch (error) {
				if (error instanceof AiCredentialsError) {
					if (error.code === 'AI_ABORTED') throw new DOMException('Request aborted', 'AbortError');
					const code = ['AI_AUTH', 'AI_NOT_FOUND', 'AI_RATE', 'AI_NETWORK'].includes(error.code)
						? error.code as 'AI_AUTH' | 'AI_NOT_FOUND' | 'AI_RATE' | 'AI_NETWORK' : 'AI_ERROR';
					throw new SpeechEngineError(code, error.message, error);
				}
				throw error;
			}
			const message = json.choices?.[0]?.message?.content;
			const text =
				typeof message === 'string'
					? message
					: Array.isArray(message)
						? message.map((part) => (part.type === 'text' ? (part.text ?? '') : '')).join('')
						: '';
			return {
				text: text.trim(),
				segments: text.trim() ? [{ text: text.trim() }] : [],
				durationMs,
				engineId: 'ai',
				modelId: chosen
			};
		}
	};
}

export const aiStt: SttEngine = createAiStt();