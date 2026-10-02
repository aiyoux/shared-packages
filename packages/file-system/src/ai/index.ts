/**
 * AI via the monitor daemon (`/v1/ai/**`).
 *
 * Keys live monitor-side (see monitor docs/design/ai-feature.md); the browser
 * makes keyless requests through its monitor connection. Shared task clients
 * cover offer discovery, chat, speech/image media, and bound agent sessions.
 */
import { formatAiErrorMessage } from './errors.js';

export {
	listAiOffers,
	completeAiChat,
	streamAiChat,
	requestAiChatCompletion,
	resolveNativeAiMonitor,
	runAiMedia,
	runAiNativeJob,
	runAiTranscription,
	type AiCatalog,
	type AiChatMessage,
	type AiDeviceClass,
	type AiLocation,
	type AiNativeProgress,
	type AiOffer,
	type AiTask
} from './catalog.js';

export {
	AiCredentialsError,
	formatAiErrorMessage,
	toAiCredentialsError
} from './errors.js';
export {
	addAiNativeModel,
	deleteAiNativeModel,
	installAiLibraryModel,
	listAiLibrary,
	listAiNativeModels,
	removeAiLibraryModel,
	type AiLibraryEntry,
	type AiLibraryListResult,
	type AiNativeModelInput,
	type AiNativeFlux2Config,
	type AiNativeOmniSvgConfig,
	type AiNativeModelRow
} from './library.js';
export {
	closeSelectionDbForTests,
	EMPTY_SELECTION_MAP,
	getAiSelectionMap,
	matchAiModelRef,
	offerAiRef,
	resolveAiModelRef,
	setAiModelRef,
	setAiSelectionMap,
	subscribeAiSelection,
	type AiModelRef,
	type AiSelectionMap,
	type AiTaskKey
} from './selection.js';
export {
	aiChatStream,
	aiChatText,
	deleteAiProfile,
	installAiProfile,
	listAiModels,
	listAiProfiles,
	resolveAiMonitor,
	type AiCapabilities,
	type AiMonitor
} from './monitor.js';
export {
	AiInvokeUnsupported,
	aiSessionDeleteUrl,
	answerSessionInvoke,
	bindAiSession,
	coerceAiSession,
	connectAiSession,
	deleteAiSession,
	listAiSessions,
	registerAiSession,
	sendSessionArtifact,
	type AiSessionAgent,
	type AiSessionArtifact,
	type AiSessionArtifactUpload,
	type AiSessionBinding,
	type AiSessionDocument,
	type AiSessionInfo,
	type AiSessionInvokeHandler,
	type AiSessionRegisterInput
} from './sessions.js';
export {
	HUB_AI_DB_NAME,
	HUB_AI_META,
	HUB_AI_STORE,
	hostOf,
	normalizeAiBaseUrl,
	validateAiProfileInput,
	type AiChatRequest,
	type AiChatResponse,
	type AiInstallProfileInput,
	type AiModelEntry,
	type AiModelListResult,
	type AiProfileListResult,
	type AiProfileSummary
} from './types.js';
export {
	listAiLibrarySources,
	registerAiLibrarySources,
	type AiLibraryModelRow,
	type AiLibraryModelStatus,
	type AiModelSection,
	type AiTaskSurface
} from './modelRegistry.js';
export { HUB_AI_PROFILES_CHANNEL } from '../crossTab.js';

export { formatAiErrorMessage as formatAiError };
export { browserAiHost, configureBrowserAiHost, registerBrowserAiHandler, runBrowserAi, checkBrowserAiCapabilities, type BrowserAiHandler, type BrowserAiOutput, type BrowserAiRunOptions, type BrowserModelState, type BrowserHostContext } from './browserHost.js';
