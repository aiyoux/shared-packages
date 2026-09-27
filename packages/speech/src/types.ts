export type SttEngineId = 'webspeech' | 'transformers' | 'sherpa' | 'ai';
export type TtsEngineId = 'webspeech' | 'kokoro' | 'piper' | 'sherpa' | 'ai';

export type SpeechTask = 'stt' | 'tts';

/** Where a model's weights are fetched from at download time. */
export type ModelDownloadRoot = 'hf';

export type SpeechModelFile = {
	/** Path inside the repo, e.g. `onnx/encoder_model_quantized.onnx`. */
	path: string;
	/** Expected byte size — sanity check against the downloaded node. */
	bytes?: number;
};

export type SpeechModelDef = {
	id: string;
	task: SpeechTask;
	engine: 'transformers' | 'kokoro' | 'piper' | 'sherpa';
	/** HF repo id, e.g. `onnx-community/whisper-tiny`. */
	repo: string;
	revision: string;
	/** transformers.js dtype hint used for both the catalog and the load call. */
	dtype: 'q8' | 'fp32' | 'fp16' | 'q4';
	files: readonly SpeechModelFile[];
	/** Sum of the default dtype's files — display + download sanity check. */
	sizeBytes: number;
	languages: readonly string[];
	downloadRoot: ModelDownloadRoot;
};

export type ModelDownloadProgress = {
	file: string;
	transferred: number;
	total?: number;
	done: boolean;
};

export type SttSegment = {
	text: string;
	start?: number;
	end?: number;
};

export type SttResult = {
	text: string;
	segments: SttSegment[];
	language?: string;
	durationMs: number;
	engineId: SttEngineId;
	modelId?: string;
};

export type SttProbe = {
	supported: boolean;
	reason?: string;
	/** Chrome's on-device language-pack state, when the API exposes it. */
	onDeviceAvailable?: 'available' | 'downloadable' | 'downloading' | 'unavailable';
};

export type SttEngineInfo = {
	id: SttEngineId;
	label: string;
	description: string;
	/** Live microphone listening. */
	supportsMic: boolean;
	/** Transcribe an uploaded / recorded audio blob. */
	supportsFileInput: boolean;
	/** Interim results while the user is speaking. */
	streamingPartials: boolean;
	languageSelection: boolean;
	/** Audio never leaves the browser. */
	onDevice: boolean;
};

export type TtsVoice = {
	id: string;
	label: string;
	language?: string;
	/** Preview text hint, when the voice has a known good sample sentence. */
	preview?: string;
};

export type TtsEngineInfo = {
	id: TtsEngineId;
	label: string;
	description: string;
	/** Speak through the audio stack right now. */
	livePlayback: boolean;
	/** Can render to buffers / WAV bytes. */
	renderToBuffer: boolean;
	/** e.g. ['wav']; empty = this engine cannot export audio. */
	exportFormats: readonly string[];
	voices: 'builtin' | 'system' | 'model';
	/** false when the engine has no speed control (hide the slider). */
	supportsSpeed?: boolean;
};

export type TtsRenderSegment = {
	samples: Float32Array;
	sampleRate: number;
	text?: string;
};

export type TtsRender = {
	segments: TtsRenderSegment[];
	channels: 1;
};

export type TtsSpeakOpts = {
	voice?: string;
	speed?: number;
	signal?: AbortSignal;
	onProgress?: (p: { text: string; segmentIndex: number }) => void;
};

export type TtsLoadOpts = {
	modelId?: string;
	/** VFS folder the model was imported into (user-chosen; default tree when omitted). */
	dirId?: string;
	device?: 'wasm' | 'webgpu';
	onProgress?: (p: ModelDownloadProgress) => void;
	signal?: AbortSignal;
};

export interface SttEngine {
	readonly info: SttEngineInfo;
	/** Cheap capability check — no model load. Safe to call on every render. */
	probe(language: string): Promise<SttProbe>;
	load(modelId?: string | null, opts?: TtsLoadOpts): Promise<void>;
	/** Live microphone listening. Only when `info.supportsMic`. */
	startListening(opts: {
		lang: string;
		onDevice?: boolean;
		onPartial?: (text: string) => void;
		signal?: AbortSignal;
	}): Promise<void>;
	/** Stop and resolve with the final transcript. */
	stopListening(): Promise<string>;
	/** One-shot transcription of decoded mono 16 kHz audio. Only when `info.supportsFileInput`. */
	transcribe(
		audio: Float32Array,
		sampleRate: number,
		opts?: {
			language?: string;
			/** AI engine: model id (+ daemon profile id) to route the request to. */
			aiModel?: string;
			aiProfileId?: string;
			onProgress?: (p: { doneChunks: number; chunks: number }) => void;
			signal?: AbortSignal;
		}
	): Promise<SttResult>;
}

export interface TtsEngine {
	readonly info: TtsEngineInfo;
	load(opts?: TtsLoadOpts): Promise<void>;
	listVoices(): Promise<TtsVoice[]>;
	/** Full render to buffers. Only when `info.renderToBuffer`. */
	synthesize(
		text: string,
		opts?: {
			voice?: string;
			speed?: number;
			signal?: AbortSignal;
			onProgress?: (p: ModelDownloadProgress) => void;
			/** VFS folder the model was imported into (overrides the load-time choice). */
			dirId?: string;
		}
	): Promise<TtsRender>;
	/** Live speak-and-stream playback (works even without renderToBuffer). */
	speak(text: string, opts?: TtsSpeakOpts): Promise<void>;
	stop(): void;
}

export class SpeechEngineError extends Error {
	constructor(
		public readonly code:
			| 'UNSUPPORTED_BROWSER'
			| 'NO_MODEL'
			| 'DOWNLOAD_FAILED'
			| 'TRANSCRIBE_FAILED'
			| 'SYNTHESIS_FAILED'
			| 'AI_TTS_UNAVAILABLE'
			| 'AI_NO_MONITOR'
			| 'AI_NO_BACKEND'
			| 'AI_NETWORK'
			| 'AI_AUTH'
			| 'AI_NOT_FOUND'
			| 'AI_RATE'
			| 'AI_ERROR'
			| 'AUDIO_TOO_LONG'
			| 'CANCELLED',
		message: string,
		public readonly cause?: unknown
	) {
		super(message);
		this.name = 'SpeechEngineError';
	}
}

export const STT_ENGINE_CATALOG: readonly SttEngineInfo[] = [
	{
		id: 'webspeech',
		label: 'Browser (Web Speech)',
		description:
			'The browser’s built-in recogniser. Chrome defaults to a server engine — turn on “on-device” for private, offline recognition where supported.',
		supportsMic: true,
		supportsFileInput: false,
		streamingPartials: true,
		languageSelection: true,
		onDevice: true
	},
	{
		id: 'transformers',
		label: 'Local model (transformers.js)',
		description:
			'Whisper and Moonshine run fully in this tab via WebAssembly — nothing leaves the browser after the model downloads into Files.',
		supportsMic: true,
		supportsFileInput: true,
		streamingPartials: false,
		languageSelection: true,
		onDevice: true
	},
	{
		id: 'ai',
		label: 'AI connector (monitor)',
		description:
			'Sends the recording to an audio-capable model through your monitor’s AI connection. Needs a connected monitor.',
		supportsMic: false,
		supportsFileInput: true,
		streamingPartials: false,
		languageSelection: false,
		onDevice: false
	}
] as const;

export const TTS_ENGINE_CATALOG: readonly TtsEngineInfo[] = [
	{
		id: 'webspeech',
		label: 'Browser (speechSynthesis)',
		description:
			'The browser’s built-in voices — instant, no download. Reads aloud live; audio export is not available from this engine.',
		livePlayback: true,
		renderToBuffer: false,
		exportFormats: [],
		voices: 'system'
	},
	{
		id: 'kokoro',
		label: 'Kokoro 82M (local)',
		description:
			'Neural TTS running fully in this tab via WebAssembly — 54 voices, exports WAV. Downloads the model into Files on first use.',
		livePlayback: true,
		renderToBuffer: true,
		exportFormats: ['wav'],
		voices: 'model'
	},
	{
		id: 'piper',
		label: 'Piper (local)',
		description:
			'Fast neural voices from the Piper catalog — 100+ language variants, exports WAV. Import a voice pair (.onnx + .onnx.json) into Files, then pick it.',
		livePlayback: true,
		renderToBuffer: true,
		exportFormats: ['wav'],
		voices: 'model',
		supportsSpeed: false
	}
] as const;

export const DEFAULT_STT_ENGINE: SttEngineId = 'webspeech';
export const DEFAULT_TTS_ENGINE: TtsEngineId = 'webspeech';

export function sttEngineInfo(id: SttEngineId): SttEngineInfo {
	const found = STT_ENGINE_CATALOG.find((e) => e.id === id);
	if (!found) throw new Error(`Unknown STT engine: ${id}`);
	return found;
}

export function ttsEngineInfo(id: TtsEngineId): TtsEngineInfo {
	const found = TTS_ENGINE_CATALOG.find((e) => e.id === id);
	if (!found) throw new Error(`Unknown TTS engine: ${id}`);
	return found;
}