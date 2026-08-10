/**
 * Local monitor service integration for FileExplorer.
 * Import from `@shared-packages/file-system/monitor`.
 */

export {
	createMonitorExplorerDriver,
	type MonitorExplorerDriver,
	type MonitorExplorerDriverOptions
} from './monitorExplorerDriver.js';
export {
	startWatchSession,
	type WatchSession,
	type WatchSessionOptions,
	type WatchSessionStatus,
	type WatchedRoot
} from './watchSession.js';
export { isLoopbackUrl, withLocalAddressSpace } from './localNetwork.js';
export {
	acquireMonitorDriver,
	releaseMonitorDriver,
	clearMonitorDriverCacheForTests,
	monitorDriverCacheSize,
	MONITOR_DRIVER_HOLD_MS,
	type AcquireMonitorDriverOptions
} from './monitorDriverCache.js';
export {
	createMonitorClient,
	type MonitorTransport,
	type MonitorListEntry,
	type MonitorListResult,
	type MonitorStatResult,
	type MonitorWatchedRoot
} from './client.js';
export {
	handleMonitorApiProxy,
	handleMonitorDownloadProxy,
	type MonitorApiBody,
	type MonitorApiResult,
	type MonitorProxyFailure
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
	ExplorerMonitorError,
	formatMonitorErrorMessage,
	mapMonitorError
} from './errors.js';
export {
	baseName,
	breadcrumbChain,
	childId,
	isFolderId,
	parentIdOf,
	relativeIdFromAbsolute,
	toAbsolutePath
} from './pathIds.js';
export {
	DEFAULT_MONITOR_BASE_URL,
	HUB_MONITOR_DB_NAME,
	HUB_MONITOR_META,
	HUB_MONITOR_STORE,
	MONITOR_ALLOWED_PORTS,
	assertMonitorProxyTargetUrl,
	isLoopbackHostname,
	normalizeMonitorRootPath,
	validateMonitorProfileInput,
	type HubMonitorMeta,
	type MonitorConnectionProfileV1
} from './types.js';

export { default as MonitorConnectionForm } from './MonitorConnectionForm.svelte';
