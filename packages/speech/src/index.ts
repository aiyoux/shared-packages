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
	type TtsDevice,
	type TtsEngineInfo,
	type TtsLoadOpts,
	type TtsRender,
	type TtsRenderSegment,
	type TtsSpeakOpts,
	type TtsVoice
} from './types.js';

export {
	KOKORO_82M,
	KOKORO_82M_FP32,
	KOKORO_VOICES,
	MODEL_CATALOG,
	defaultSttModel,
	defaultTtsModel,
	hfResolveUrl,
	kokoroVoice,
	kokoroVoiceDef,
	kokoroVoicePath,
	modelDef,
	sttModelsFor,
	ttsModelForDevice,
	ttsModelsFor,
	type KokoroVoice
} from './models.js';

export { listSttEngines, listTtsEngines, loadSttEngine, loadTtsEngine, listTtsVoices, peekSttEngine, peekTtsEngine } from './engines.js';

export {
	DEFAULT_BRIDGE_BASE_URL,
	bridgeFetchUrl,
	fetchModelFileViaBridge
} from './bridgeFetch.js';

export {
	ModelStore,
	getSpeechModelStore,
	type ImportedModelFile,
	type ImportedModelResult,
	type ModelStoreFileState
} from './modelStore.js';

export {
	MANIFEST_CATALOG_VERSION,
	MANIFEST_NAME,
	MODEL_STORE_ROOT_FOLDER,
	formatModelBytes,
	manifestCovers,
	modelDirPath,
	modelFolderKey,
	modelFolderSegments,
	parseManifest,
	pathSegments,
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
	decodeMono,
	decodeToMono16k,
	quietestCut,
	type AudioChunk,
	type DecodedAudio
} from './audio.js';

export { concatWav, encodeWav, resampleLinear, wavBytesFor } from './wav.js';

export { AI_AUDIO_WAV_MAX_BYTES, checkAiAudioSize } from './aiParts.js';

export {
	createMicRecorder,
	preferredMicMimeType,
	type MicMimeType,
	type MicRecorder
} from './mic.js';

export { probeWebspeech, installWebspeechOnDevice } from './engines/webspeechStt.js';
export { repoPathFromUrl, createVfsCache } from './engines/transformersVfsCache.js';
export { configureTransformersEnv } from './engines/transformersEnv.js';
export { SegmentPlayer, splitSentences } from './engines/playback.js';
export { KOKORO_SAMPLE_RATE } from './engines/kokoroTts.js';
export {
	PIPER_VOICES,
	piperVoice,
	piperVoiceDef,
	piperVoiceIds,
	piperVoiceList,
	piperFileUrl,
	piperConfigPath,
	DEFAULT_PIPER_VOICE,
	type PiperVoice
} from './piperVoices.js';
export { hostedPiperTts as piperTts, initializeSpeechBrowserHost } from './browserHostEngines.js';
export { BROWSER_CHAT_MODEL, initializeBrowserChatHost, runBrowserChat, disposeBrowserChat, type BrowserChatDevice, type BrowserChatTurn } from './engines/browserChat.js';
export { novasrUpsample, disposeNovasr, novasrChunks, NOVASR_IN_RATE, NOVASR_OUT_RATE, NOVASR_MODEL_URL } from './engines/novasr.js';
export { NOVASR_MODEL, inspectNovasrModel, loadNovasrModel, removeNovasrModel } from './engines/novasrModel.js';
