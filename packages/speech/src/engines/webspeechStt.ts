/**
 * Web Speech API STT. Chrome 139+ ships the standardized API (plus the
 * on-device mode via `available()`/`install()`/`processLocally`); Safari is
 * prefix-only; Firefox has nothing — `probe()` reports that so the UI can
 * show a disabled card with a reason instead of failing at runtime.
 */

import { SpeechEngineError, type SttEngine, type SttEngineInfo, type SttProbe, type SttResult } from '../types.js';

const info: SttEngineInfo = {
	id: 'webspeech',
	label: 'Browser (Web Speech)',
	description:
		'The browser’s built-in recogniser. Chrome defaults to a server engine — turn on “on-device” for private, offline recognition where supported.',
	supportsMic: true,
	supportsFileInput: false,
	streamingPartials: true,
	languageSelection: true,
	onDevice: true
};

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;
type SpeechRecognitionLike = {
	lang: string;
	continuous: boolean;
	interimResults: boolean;
	processLocally?: boolean;
	onresult: ((event: SpeechRecognitionEventLike) => void) | null;
	onerror: ((e: { error: string }) => void) | null;
	onend: (() => void) | null;
	start(): void;
	stop(): void;
};
type SpeechRecognitionEventLike = {
	resultIndex: number;
	results: {
		length: number;
		[i: number]: { isFinal: boolean; 0: { transcript: string } };
	};
};

function recognitionCtor(): SpeechRecognitionCtor | null {
	const w = window as unknown as {
		SpeechRecognition?: SpeechRecognitionCtor;
		webkitSpeechRecognition?: SpeechRecognitionCtor;
	};
	return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** Chrome 138+ exposes on-device availability/install on the constructor. */
type OnDeviceCtor = {
	available?: (opts?: { langs?: string[]; quality?: string }) => Promise<
		'available' | 'downloadable' | 'downloading' | 'unavailable'
	>;
	install?: (opts?: { langs?: string[]; quality?: string }) => Promise<boolean>;
};

export async function probeWebspeech(lang: string): Promise<SttProbe> {
	if (typeof window === 'undefined' || !recognitionCtor()) {
		return {
			supported: false,
			reason: 'This browser does not ship SpeechRecognition (Firefox has none; Safari is prefix-only and may still work).'
		};
	}
	const ctor = recognitionCtor() as unknown as OnDeviceCtor;
	if (typeof ctor.available === 'function') {
		try {
			const onDeviceAvailable = await ctor.available({ langs: [lang] });
			return { supported: true, onDeviceAvailable };
		} catch {
			return { supported: true };
		}
	}
	return { supported: true };
}

/** Install the on-device language pack (Chrome). Returns success. */
export async function installWebspeechOnDevice(lang: string): Promise<boolean> {
	const ctor = recognitionCtor() as unknown as OnDeviceCtor;
	if (typeof ctor.install !== 'function') return false;
	try {
		return await ctor.install({ langs: [lang] });
	} catch {
		return false;
	}
}

export function createWebspeechStt(): SttEngine {
	let recognition: SpeechRecognitionLike | null = null;
	let finalText = '';

	return {
		info,

		async probe(lang) {
			return probeWebspeech(lang);
		},

		async load() {
			// Nothing to load — the browser provides the recogniser.
		},

		async startListening(opts) {
			const Ctor = recognitionCtor();
			if (!Ctor) throw new SpeechEngineError('UNSUPPORTED_BROWSER', 'SpeechRecognition is unavailable in this browser');
			if (recognition) throw new SpeechEngineError('TRANSCRIBE_FAILED', 'Already listening');
			finalText = '';
			const r = new Ctor();
			if (opts.onDevice) {
				const ctor = Ctor as unknown as OnDeviceCtor;
				if (typeof ctor.available !== 'function') {
					throw new SpeechEngineError(
						'UNSUPPORTED_BROWSER',
						'This browser does not support on-device recognition'
					);
				}
				const state = await ctor.available({ langs: [opts.lang] });
				if (state === 'downloadable') {
					const ok = await installWebspeechOnDevice(opts.lang);
					if (!ok) throw new SpeechEngineError('UNSUPPORTED_BROWSER', 'Could not install the on-device language pack');
				} else if (state === 'unavailable') {
					throw new SpeechEngineError('UNSUPPORTED_BROWSER', `No on-device pack for ${opts.lang}`);
				}
				r.processLocally = true;
			}
			r.lang = opts.lang;
			r.continuous = true;
			r.interimResults = Boolean(opts.onPartial);
			r.onresult = (event) => {
				let interim = '';
				for (let i = event.resultIndex; i < event.results.length; i++) {
					const result = event.results[i];
					if (!result) continue;
					const transcript = result[0]?.transcript ?? '';
					if (result.isFinal) finalText += transcript;
					else interim += transcript;
				}
				opts.onPartial?.(finalText + interim);
			};
			r.onerror = (e) => {
				if (e.error === 'aborted' || e.error === 'no-speech') return;
				recognition = null;
				throw new SpeechEngineError('TRANSCRIBE_FAILED', `Speech recognition error: ${e.error}`);
			};
			recognition = r;
			r.start();
		},

		async stopListening(): Promise<string> {
			const r = recognition;
			recognition = null;
			if (!r) return finalText;
			await new Promise<void>((resolve) => {
				const done = () => resolve();
				r.onend = done;
				r.stop();
				// Some engines never fire onend if no session was active.
				setTimeout(done, 500);
			});
			return finalText.trim();
		},

		async transcribe(): Promise<SttResult> {
			throw new SpeechEngineError('TRANSCRIBE_FAILED', 'The Web Speech engine only listens live — pick a file-based engine to transcribe recordings');
		}
	};
}

export const webspeechStt: SttEngine = createWebspeechStt();