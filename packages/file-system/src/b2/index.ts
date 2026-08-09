/**
 * Backblaze B2 integration for FileExplorer (driver, credentials, hybrid transport, UI).
 *
 * Import from `@shared-packages/file-system/b2` so local-only apps never pull the B2 SDK.
 */

export {
	createB2ExplorerDriver,
	type B2ExplorerDriverOptions
} from './b2ExplorerDriver.js';
export {
	acquireB2Driver,
	releaseB2Driver,
	clearB2DriverCacheForTests,
	b2DriverCacheSize,
	B2_DRIVER_HOLD_MS
} from './b2DriverCache.js';
export {
	createHybridB2Transport,
	DEFAULT_B2_PROXY_PATH,
	type HybridB2TransportOptions
} from './hybridTransport.js';
export {
	assertB2ControlPlaneUrl,
	isB2ControlPlaneUrl,
	isB2DataPlaneUrl
} from './controlPlane.js';
export {
	handleB2ControlPlaneProxy,
	B2_PROXY_MAX_BODY_BYTES,
	B2_PROXY_ALLOWED_METHODS,
	type B2ProxyRequestBody,
	type B2ProxyResult,
	type B2ProxySuccess,
	type B2ProxyFailure
} from './proxyHandler.js';
export {
	closeCredentialsDbForTests,
	deleteProfile,
	getActiveProfileId,
	getProfile,
	listProfiles,
	redactProfile,
	saveProfile,
	setActiveProfileId
} from './credentials.js';
export {
	ExplorerB2Error,
	formatB2ErrorMessage,
	mapB2Error
} from './errors.js';
export {
	baseNameFromKey,
	baseNameFromPrefix,
	directChildFolderFromMarker,
	isFolderMarkerKey,
	markerKeyForFolderPrefix,
	sanitizeSegment
} from './folderMarkers.js';
export {
	HUB_B2_DB_NAME,
	normalizeNamePrefix,
	validateProfileInput,
	type B2ConnectionProfileV1
} from './types.js';

export { default as B2ConnectionForm } from './B2ConnectionForm.svelte';
export { default as ConnectionSwitcher } from './ConnectionSwitcher.svelte';
