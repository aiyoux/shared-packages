/**
 * STT through the monitor connection. The run goes to the transcription offer
 * picked from the monitor's catalog: a configured runtime on the monitor PC
 * (cancellable job) or a declared transcription API reached through it. Keys
 * stay daemon-side; requests are keyless.
 */

import { resolveAiMonitor, runAiTranscription, AiCredentialsError, type AiMonitor } from '@shared-packages/file-system/ai';
import { SpeechEngineError, type SttEngine, type SttEngineInfo, type SttResult } from '../types.js';
import { base64FromBytes, DURATION_MAX_MS, TARGET_SAMPLE_RATE } from '../audio.js';
import { checkAiAudioSize } from '../aiParts.js';
import { encodeWav } from '../wav.js';

const info: SttEngineInfo = {
	id: 'ai',
	label: 'Monitor (AI models)',
	description:
		'Transcribes with a model that runs on the monitor PC, or one on a configured API profile reached through it. Needs a connected monitor; the model list comes from the monitor’s catalog.',
	supportsMic: false,
	supportsFileInput: true,
	streamingPartials: false,
	languageSelection: true,
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
				'The monitor engine transcribes recordings, not live listening — record first, or use another engine'
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
			if (opts?.aiMonitorBaseUrl && monitor.baseUrl !== opts.aiMonitorBaseUrl) {
				throw new SpeechEngineError(
					'AI_NO_BACKEND',
					'The active monitor changed — refresh the model list and try again'
				);
			}
			const offer = opts?.aiOffer;
			if (!offer) throw new SpeechEngineError('NO_MODEL', 'Pick a model from the monitor’s catalog first');

			const durationMs = Math.round((audio.length / sampleRate) * 1000);
			const size = checkAiAudioSize(durationMs);
			if (durationMs > DURATION_MAX_MS || size.tooLarge) {
				throw new SpeechEngineError(
					'AUDIO_TOO_LONG',
					`Recording is too large for the monitor engine (about ${Math.round(size.maxDurationMs / 60000)} min max)`
				);
			}

			// base64 WAV inflates 4/3; the payload cap bounds both sides.
			const wav = encodeWav(audio, sampleRate, 1);
			const language = opts?.language && opts.language !== 'auto' ? opts.language : undefined;

			try {
				const { text } = await runAiTranscription(
					monitor.baseUrl,
					{ id: offer.id, location: offer.location, task: 'transcription' },
					{ audioBase64: base64FromBytes(wav), language },
     { signal: opts?.signal, op: opts?.opHandle, monitor: { profileId: monitor.monitorProfileId, name: 'Monitor', baseUrl: monitor.baseUrl } }
				);
				const trimmed = text.trim();
				return {
					text: trimmed,
					segments: trimmed ? [{ text: trimmed }] : [],
					durationMs,
					engineId: 'ai',
					modelId: offer.id
				};
			} catch (error) {
				if (error instanceof AiCredentialsError) {
					if (error.code === 'AI_ABORTED') throw new DOMException('Request aborted', 'AbortError');
					const known = ['AI_AUTH', 'AI_NOT_FOUND', 'AI_RATE', 'AI_NETWORK', 'AI_BUSY', 'AI_UNSUPPORTED'] as const;
					const code = (known as readonly string[]).includes(error.code)
						? (error.code as (typeof known)[number])
						: 'AI_ERROR';
					throw new SpeechEngineError(code, error.message, error);
				}
				throw error;
			}
		}
	};
}

export const aiStt: SttEngine = createAiStt();
