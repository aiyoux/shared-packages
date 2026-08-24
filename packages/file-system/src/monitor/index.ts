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
	createMonitorWatchStream,
	parseSseChunk,
	type MonitorWatchStream,
	type MonitorWatchStreamOptions,
	type WatchStreamStatus
} from './watchStream.js';
export { createCoalescer, type Coalescer, type CoalesceOptions } from './coalesce.js';
export {
	addressSpaceFor,
	isLoopbackUrl,
	withLocalAddressSpace,
	type TargetAddressSpace
} from './localNetwork.js';
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
	coerceGitSnapshot,
	coerceHostSnapshot,
	coerceInoDev,
	coerceListResult,
	coerceMonitorCapabilities,
	coerceMonitorMeta,
	coerceStatResult,
	type MonitorCapabilities,
	type MonitorMeta,
	type MonitorTransport,
	type MonitorListEntry,
	type MonitorListResult,
	type MonitorStatResult,
	type MonitorSubsRequest,
	type MonitorSubsResult,
	type MonitorWatchedRoot,
	type MonitorHostDisk,
	type MonitorHostSnapshot,
	type MonitorGitLogEntry,
	type MonitorGitSnapshot
} from './client.js';
export { getHostStream, abortHostStream, abortAllHostStreams, type HostStream } from './hostStream.js';
export { getGitStream, abortGitStream, abortAllGitStreams, type GitStream } from './gitStream.js';
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
	normalizeMonitorRootPath,
	validateMonitorProfileInput,
	type HubMonitorMeta,
	type MonitorConnectionProfileV1
} from './types.js';

export { default as MonitorConnectionForm } from './MonitorConnectionForm.svelte';
