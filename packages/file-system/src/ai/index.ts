/**
 * AI via the monitor daemon (`/v1/ai/**`).
 *
 * Keys live monitor-side (see monitor docs/design/ai-feature.md); the browser
 * makes keyless requests through its monitor connection. The task surface is
 * deliberately narrow: resolve a monitor, list models/profiles, install or
 * update a profile (key sent once, never stored here), chat (text or SSE),
 * and bind a client session an agent can list and invoke.
 */
import { formatAiErrorMessage } from './errors.js';

export {
	listAiOffers,
	resolveNativeAiMonitor,
	runAiNativeJob,
	type AiCatalog,
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
	closeSelectionDbForTests,
	DEFAULT_SELECTION,
	getAiSelection,
	setAiSelection
} from './monitorSelection.js';
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
	AI_SESSION_HEARTBEAT_MS,
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
	type AiMonitorSelectionV2,
	type AiProfileListResult,
	type AiProfileSummary
} from './types.js';
export { HUB_AI_PROFILES_CHANNEL } from '../crossTab.js';

export { formatAiErrorMessage as formatAiError };
