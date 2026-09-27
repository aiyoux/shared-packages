/**
 * speechSynthesis TTS — instant OS voices, live read-aloud only. Capturing
 * the synthesis output for export is not reliably possible from any
 * browser, so `renderToBuffer` is false and the page hides export.
 */

import { SpeechEngineError, type TtsEngine, type TtsEngineInfo, type TtsVoice } from '../types.js';

const info: TtsEngineInfo = {
	id: 'webspeech',
	label: 'Browser (speechSynthesis)',
	description:
		'The browser’s built-in voices — instant, no download. Reads aloud live; audio export is not available from this engine.',
	livePlayback: true,
	renderToBuffer: false,
	exportFormats: [],
	voices: 'system'
};

export function listSystemVoices(): TtsVoice[] {
	if (typeof speechSynthesis === 'undefined') return [];
	return speechSynthesis.getVoices().map((v) => ({
		id: v.voiceURI,
		label: `${v.name} (${v.lang})`,
		language: v.lang,
		preview: 'The quick brown fox jumps over the lazy dog.'
	}));
}

/** OS voices populate late on some platforms — resolve via event + poll. */
export function systemVoices(): Promise<TtsVoice[]> {
	if (typeof speechSynthesis === 'undefined') return Promise.resolve([]);
	const immediate = listSystemVoices();
	if (immediate.length) return Promise.resolve(immediate);
	return new Promise((resolve) => {
		let settled = false;
		const finish = (voices: TtsVoice[]) => {
			if (settled) return;
			settled = true;
			speechSynthesis.onvoiceschanged = null;
			resolve(voices);
		};
		speechSynthesis.onvoiceschanged = () => {
			const voices = listSystemVoices();
			if (voices.length) finish(voices);
		};
		setTimeout(() => finish(listSystemVoices()), 1500);
	});
}

export function createWebspeechTts(): TtsEngine {
	return {
		info,

		async load() {
			// Nothing to load — the browser provides the voices.
		},

		async listVoices() {
			return systemVoices();
		},

		async synthesize() {
			throw new SpeechEngineError(
				'SYNTHESIS_FAILED',
				'The browser engine cannot render audio to a file — pick a local model engine to export WAV'
			);
		},

		async speak(text, opts) {
			if (typeof speechSynthesis === 'undefined') {
				throw new SpeechEngineError('UNSUPPORTED_BROWSER', 'speechSynthesis is unavailable');
			}
			speechSynthesis.cancel();
			const utterance = new SpeechSynthesisUtterance(text);
			if (opts?.voice) {
				const voice = speechSynthesis.getVoices().find((v) => v.voiceURI === opts.voice);
				if (voice) utterance.voice = voice;
			}
			if (opts?.speed) utterance.rate = Math.max(0.1, Math.min(10, opts.speed));
			if (opts?.signal) {
				opts.signal.addEventListener('abort', () => speechSynthesis.cancel(), { once: true });
			}
			await new Promise<void>((resolve, reject) => {
				utterance.onend = () => resolve();
				utterance.onerror = (e) => {
					if (e.error === 'interrupted' || e.error === 'canceled') resolve();
					else reject(new SpeechEngineError('SYNTHESIS_FAILED', `Speech error: ${e.error}`));
				};
				speechSynthesis.speak(utterance);
			});
		},

		stop() {
			if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
		}
	};
}

export const webspeechTts: TtsEngine = createWebspeechTts();