/**
 * STT through the monitor connection. The run goes to the transcription offer
 * picked from the monitor's catalog: a configured runtime on the monitor PC
 * (cancellable job) or a declared transcription API reached through it. Keys
 * stay daemon-side; requests are keyless.
 */

import { listSavedMonitors, runAiTranscription, AiCredentialsError } from '@shared-packages/file-system/ai';
import { SpeechEngineError, type SttEngine, type SttEngineInfo, type SttResult } from '../types.js';
import { base64FromBytes, DURATION_MAX_MS, TARGET_SAMPLE_RATE } from '../audio.js';
import { checkAiAudioSize } from '../aiParts.js';
import { encodeWav } from '../wav.js';

const info: SttEngineInfo = {
	id: 'ai',
	label: 'Monitor (AI models)',
	description:
		'Transcribes with a model on one of your monitors, or an API profile reached through it. The model list names the monitor each model runs on.',
	supportsMic: false,
	supportsFileInput: true,
	streamingPartials: false,
	languageSelection: true,
	onDevice: false
};

/** The engine is usable once a monitor is saved; which one runs a file is
 * part of the picked model (`opts.aiMonitor`), never looked up here. */
async function hasMonitor(): Promise<boolean> {
	return (await listSavedMonitors().catch(() => [])).length > 0;
}

export function createAiStt(): SttEngine {
	return {
		info,

		async probe() {
			const saved = await hasMonitor();
			return {
				supported: saved,
				reason: saved ? undefined : 'Add a monitor in Connections to use its models'
			};
		},

		async load() {
			if (!(await hasMonitor())) {
				throw new SpeechEngineError('AI_NO_BACKEND', 'Add a monitor in Connections to use its models');
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
			const monitor = opts?.aiMonitor;
			const offer = opts?.aiOffer;
			if (!offer || !monitor) throw new SpeechEngineError('NO_MODEL', 'Pick a monitor model first');

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
					{ signal: opts?.signal, op: opts?.opHandle, monitor }
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
