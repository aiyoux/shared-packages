/**
 * STT through the monitor's AI connection. The monitor's
 * `/v1/ai/chat/completions` forwards the body unmodified, so OpenAI-style
 * `input_audio` content parts reach audio-capable upstreams without any
 * daemon change. Keys stay daemon-side; requests are keyless.
 */

import { resolveAiMonitor, type AiMonitor } from '@shared-packages/file-system/ai';
import { SpeechEngineError, type SttEngine, type SttEngineInfo, type SttResult } from '../types.js';
import { base64FromBytes, decodeToMono16k, DURATION_MAX_MS, TARGET_SAMPLE_RATE } from '../audio.js';
import { encodeWav } from '../wav.js';
import { aiStatusToCode, buildSttAudioMessages, checkAiAudioSize } from '../aiParts.js';

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

			const url =
				`${monitor.baseUrl}/v1/ai/chat/completions` +
				(opts?.aiProfileId ? `?profile=${encodeURIComponent(opts.aiProfileId)}` : '');
			let res: Response;
			try {
				res = await fetch(url, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(body),
					signal: opts?.signal
				});
			} catch (error) {
				if (error instanceof DOMException && error.name === 'AbortError') throw error;
				throw new SpeechEngineError('AI_NETWORK', 'Could not reach the monitor', error);
			}
			if (!res.ok) {
				const detail = await res.text().catch(() => '');
				if (res.status === 400 || res.status === 404) {
					throw new SpeechEngineError(
						'AI_NOT_FOUND',
						`Model “${chosen}” may not accept audio input (${res.status})`,
						detail
					);
				}
				throw new SpeechEngineError(aiStatusToCode(res.status), `AI request failed (${res.status})`, detail);
			}
			const json = (await res.json()) as {
				choices?: Array<{ message?: { content?: string | Array<{ type: string; text?: string }> } }>;
			};
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