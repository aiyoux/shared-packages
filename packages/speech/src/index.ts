export {
	DEFAULT_STT_ENGINE,
	DEFAULT_TTS_ENGINE,
	STT_ENGINE_CATALOG,
	TTS_ENGINE_CATALOG,
	SpeechEngineError,
	sttEngineInfo,
	ttsEngineInfo,
	type ModelDownloadProgress,
	type SpeechModelDef,
	type SpeechTask,
	type SttEngine,
	type SttEngineId,
	type SttEngineInfo,
	type SttProbe,
	type SttResult,
	type SttSegment,
	type TtsEngine,
	type TtsEngineId,
	type TtsEngineInfo,
	type TtsLoadOpts,
	type TtsRender,
	type TtsRenderSegment,
	type TtsSpeakOpts,
	type TtsVoice
} from './types.js';

export {
	KOKORO_82M,
	KOKORO_VOICES,
	MODEL_CATALOG,
	defaultSttModel,
	defaultTtsModel,
	hfResolveUrl,
	kokoroVoice,
	kokoroVoicePath,
	modelDef,
	sttModelsFor,
	ttsModelsFor,
	type KokoroVoice
} from './models.js';

export { listSttEngines, listTtsEngines, loadSttEngine, loadTtsEngine, peekSttEngine, peekTtsEngine } from './engines.js';

export {
	ModelStore,
	getSpeechModelStore,
	type EnsureModelResult,
	type ModelStoreFileState
} from './modelStore.js';

export {
	MANIFEST_CATALOG_VERSION,
	MANIFEST_NAME,
	MODEL_STORE_ROOT_FOLDER,
	formatModelBytes,
	modelDirPath,
	modelFolderKey,
	modelFolderSegments,
	parseManifest,
	sizeMatches,
	storedName,
	type SpeechModelManifest,
	type SpeechModelManifestFile
} from './modelStore.manifest.js';

export {
	CHUNK_OVERLAP_SECONDS,
	CHUNK_SECONDS,
	DURATION_MAX_MS,
	DURATION_WARN_MS,
	TARGET_SAMPLE_RATE,
	base64FromBytes,
	chunkAudio,
	decodeToMono16k,
	quietestCut,
	type AudioChunk,
	type DecodedAudio
} from './audio.js';

export { concatWav, encodeWav, resampleLinear, wavBytesFor } from './wav.js';

export {
	AI_AUDIO_WAV_MAX_BYTES,
	DEFAULT_STT_PROMPT,
	aiStatusToCode,
	buildSttAudioMessages,
	checkAiAudioSize,
	looksAudioCapable,
	rankModelsForAudio,
	type SttChatMessages
} from './aiParts.js';

export {
	createMicRecorder,
	preferredMicMimeType,
	type MicMimeType,
	type MicRecorder
} from './mic.js';

export { probeWebspeech, installWebspeechOnDevice } from './engines/webspeechStt.js';
export { resolveAiBackend } from './engines/aiStt.js';
export { repoPathFromUrl, createVfsCache } from './engines/transformersVfsCache.js';
export { configureTransformersEnv } from './engines/transformersEnv.js';
export { KOKORO_SAMPLE_RATE } from './engines/kokoroTts.js';