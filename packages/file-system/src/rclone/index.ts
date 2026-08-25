/**
 * rclone RC integration for FileExplorer (driver, credentials, simulator).
 *
 * Import from `@shared-packages/file-system/rclone` so local-only apps never pull RC client.
 */

export {
	createRcloneExplorerDriver,
	type RcloneExplorerDriverOptions
} from './rcloneExplorerDriver.js';
export {
	acquireRcloneDriver,
	releaseRcloneDriver,
	clearRcloneDriverCacheForTests,
	evictAllRcloneDrivers,
	rcloneDriverCacheSize,
	RCLONE_DRIVER_HOLD_MS,
	type AcquireRcloneDriverOptions
} from './rcloneDriverCache.js';
export {
	RcloneSimulator,
	type RcloneTransport,
	type RcloneCallResult,
	type SimNode
} from './rcloneSimulator.js';
export {
	createRcClient,
	type CreateRcClientOptions,
	type RcloneProxyPaths
} from './rcClient.js';
export {
	assertRcloneProxyTargetUrl,
	isAllowedRcMethod,
	isLoopbackTarget,
	DEFAULT_RCLONE_RC_PROXY_PATH,
	DEFAULT_RCLONE_UPLOAD_PROXY_PATH,
	DEFAULT_RCLONE_DOWNLOAD_PROXY_PATH,
	RCLONE_ALLOWED_RC_METHODS,
	RCLONE_DENIED_RC_METHODS
} from './rcAllowlist.js';
export {
	handleRcloneRcProxy,
	handleRcloneUploadProxy,
	handleRcloneDownloadProxy,
	RCLONE_RC_MAX_JSON_BYTES,
	type RcloneRcProxyBody,
	type RcloneRcProxyResult,
	type RcloneProxyFailure
} from './proxyHandler.js';
export {
	closeCredentialsDbForTests,
	deleteProfile,
	getActiveProfileId,
	getProfile,
	listProfiles,
	listStoredProfiles,
	redactProfile,
	revealRcPass,
	saveProfile,
	setActiveProfileId
} from './credentials.js';
export {
	ExplorerRcloneError,
	formatRcloneErrorMessage,
	mapRcloneError,
	scrubSecrets
} from './errors.js';
export {
	baseName,
	breadcrumbChain,
	childId,
	encodePathId,
	isFolderId,
	parentIdOf,
	sanitizeSegment,
	toRemoteParam
} from './pathIds.js';
export {
	DEFAULT_RCLONE_BASE_URL,
	HUB_RCLONE_DB_NAME,
	HUB_RCLONE_META,
	HUB_RCLONE_STORE,
	RCLONE_ALLOWED_PORTS,
	isLoopbackHostname,
	normalizeRootPath,
	validateProfileInput,
	type HubRcloneMeta,
	type RcloneConnectionProfileV1
} from './types.js';

export { default as RcloneConnectionForm } from './RcloneConnectionForm.svelte';
/** Re-export multi-backend switcher (lives under b2 surface; preserves conn-b2*). */
export {
	default as ConnectionSwitcher,
	type ConnectionKind,
	type B2ProfileChip,
	type RcloneProfileChip
} from '../b2/ConnectionSwitcher.svelte';
