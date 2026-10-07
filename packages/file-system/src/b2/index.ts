/**
 * Backblaze B2 for the hub File Explorer — held by monitor daemons.
 *
 * Keys live on the monitor you add them to (write-only over the wire); this
 * module lists connections across saved monitors and drives them through
 * each monitor's `/v1/b2` routes. Nothing about B2 is stored in the browser.
 */
export {
	createMonitorB2Driver,
	monitorHostKey,
	B2_CAPS,
	type MonitorB2DriverOptions
} from './monitorB2Driver.js';
export {
	acquireB2Driver,
	releaseB2Driver,
	clearB2DriverCacheForTests,
	evictAllB2Drivers,
	b2DriverCacheSize,
	B2_DRIVER_HOLD_MS
} from './b2DriverCache.js';
export {
	createMonitorB2Client,
	type MonitorB2Client,
	type MonitorB2Entry,
	type MonitorB2Listing,
	type MonitorB2From,
	type MonitorB2To
} from './client.js';
export {
	listB2Connections,
	getB2Connection,
	createB2Connection,
	updateB2Connection,
	deleteB2Connection,
	getActiveB2RowId,
	setActiveB2RowId,
	type B2ConnectionListing
} from './connections.js';
export { ExplorerB2Error, b2ErrorFromWire, formatB2ErrorMessage, mapB2Error } from './errors.js';
export {
	b2RowId,
	parseB2RowId,
	normalizeNamePrefix,
	validateB2Input,
	type B2ConnectionInput,
	type B2ConnectionRow,
	type MonitorB2Connection
} from './types.js';

export { default as B2ConnectionForm } from './B2ConnectionForm.svelte';
export { default as ConnectionSwitcher } from './ConnectionSwitcher.svelte';
// The types are plain-TS imports, not re-exports from the `.svelte` module: a
// raw tsc consumer (git's transitive check) cannot see types inside a svelte
// module, and the union lives canonically in ui/connectionInfo.
export type { ConnectionKind } from '../ui/connectionInfo.js';
export type { B2ProfileChip, MonitorProfileChip } from './switcherTypes.js';
