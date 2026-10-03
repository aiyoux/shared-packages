/**
 * Where a browser model's files can be loaded from, besides this device:
 * a folder on the browser's Files, on a saved monitor or on a B2 connection,
 * or "online" through a monitor the user picks (platform-services D-24: no
 * implicit monitor). Every remote source is named and chosen; nothing here
 * picks one.
 */
import {
	matchModelFiles,
	type ModelDef,
	type ModelFileMatch,
	type ModelSourceFile
} from '@shared-packages/model-store';
import type { ExplorerDriver, ExplorerEntryId } from '../ui/explorerDriver.js';
import { listProfiles } from '../monitor/credentials.js';
import { acquireMonitorDriver, releaseMonitorDriver } from '../monitor/monitorDriverCache.js';
import { withLocalAddressSpace } from '../monitor/localNetwork.js';
import { acquireB2Driver, releaseB2Driver } from '../b2/b2DriverCache.js';
import { listB2Connections } from '../b2/connections.js';

/** A connection whose folders the card can browse (the folder picker runs on its driver). */
export type ModelFolderSource = {
	id: string;
	label: string;
	acquire(): Promise<ExplorerDriver>;
	release(): void;
};

/** A monitor whose `/v1/tools/fetch` retrieves from `hosts`. */
export type ModelOnlineSource = { id: string; label: string; baseUrl: string; hosts: readonly string[] };

/** Saved monitors' files, from the local profile list (no network). */
export async function monitorFolderSources(): Promise<ModelFolderSource[]> {
	return (await listProfiles()).map((profile) => ({
		id: `monitor:${profile.id}`,
		label: profile.name,
		acquire: () => acquireMonitorDriver(profile),
		release: () => releaseMonitorDriver(profile.id)
	}));
}

/**
 * One discovery per set of saved monitors, shared by every card on the page
 * (the AI models tab mounts one per model). A failed discovery is not kept,
 * so the next card asks again; a changed profile list is a new set.
 */
const discovered = new Map<string, Promise<unknown>>();
async function perProfileSet<T>(kind: string, discover: () => Promise<T>): Promise<T> {
	const key = `${kind}|${(await listProfiles()).map((profile) => `${profile.id}=${profile.baseUrl}`).join(',')}`;
	let pending = discovered.get(key) as Promise<T> | undefined;
	if (!pending) {
		pending = discover();
		discovered.set(key, pending);
		pending.catch(() => discovered.delete(key));
	}
	return pending;
}

/** B2 connections held by saved monitors; unreachable monitors add none. */
export function b2FolderSources(): Promise<ModelFolderSource[]> {
	return perProfileSet('b2', b2Discovery);
}
async function b2Discovery(): Promise<ModelFolderSource[]> {
	const { rows } = await listB2Connections();
	return rows.map((row) => ({
		id: `b2:${row.rowId}`,
		label: `${row.name} (B2 via ${row.monitorName})`,
		acquire: () => acquireB2Driver(row),
		release: () => releaseB2Driver(row.rowId)
	}));
}

/**
 * Monitors that advertise the fetch proxy and its hosts. A monitor that does
 * not answer simply is not listed; one without the capability (an older
 * daemon) cannot fetch.
 */
export function onlineSources(): Promise<ModelOnlineSource[]> {
	return perProfileSet('online', onlineDiscovery);
}
async function onlineDiscovery(): Promise<ModelOnlineSource[]> {
	const profiles = await listProfiles();
	const found = await Promise.all(profiles.map(async (profile): Promise<ModelOnlineSource | null> => {
		try {
			const url = `${profile.baseUrl.replace(/\/+$/, '')}/v1/meta`;
			const res = await fetch(url, withLocalAddressSpace(url));
			if (!res.ok) return null;
			const meta = (await res.json()) as { capabilities?: { tools?: { fetch?: { hosts?: unknown } } } };
			const hosts = meta.capabilities?.tools?.fetch?.hosts;
			if (!Array.isArray(hosts) || !hosts.every((host) => typeof host === 'string')) return null;
			return { id: `online:${profile.id}`, label: profile.name, baseUrl: profile.baseUrl, hosts };
		} catch {
			return null;
		}
	}));
	return found.filter((source): source is ModelOnlineSource => source !== null);
}

/** Stream one entry: a driver's direct URL (monitor read, B2 via its monitor) has no size cap. */
async function entryStream(driver: ExplorerDriver, id: ExplorerEntryId, signal: AbortSignal): Promise<ReadableStream<Uint8Array>> {
	signal.throwIfAborted();
	if (driver.readBlob) return (await driver.readBlob(id)).stream();
	const link = await driver.downloadUrl?.(id);
	if (link) {
		const res = await fetch(link.url, withLocalAddressSpace(link.url, { signal }));
		if (!res.ok || !res.body) throw new Error(`${link.filename}: the source answered ${res.status}`);
		return res.body;
	}
	if (!driver.download) throw new Error('This source cannot read files');
	return (await driver.download(id, { signal })).stream();
}

/**
 * The def's files under `folderId`, walking only the folders its paths name
 * (not a large unrelated tree), then matched by relative path.
 */
export async function folderModelFiles(def: ModelDef, driver: ExplorerDriver, folderId: ExplorerEntryId | null): Promise<ModelFileMatch[]> {
	const listing = new Map<ExplorerEntryId | null, Awaited<ReturnType<ExplorerDriver['list']>>>();
	const files: ModelSourceFile[] = [];
	for (const required of def.files) {
		let parent = folderId;
		const parts = required.path.split('/');
		for (let index = 0; index < parts.length; index++) {
			let result = listing.get(parent);
			if (!result) {
				result = await driver.list({ parentId: parent });
				listing.set(parent, result);
			}
			if (result.truncated) throw new Error('This folder has too many entries to match safely. Choose a smaller model folder.');
			const leaf = index === parts.length - 1;
			const entry = result.entries.find((item) => item.name === parts[index] && item.kind === (leaf ? 'file' : 'folder'));
			if (!entry) break;
			if (!leaf) parent = entry.id;
			else files.push({ path: required.path, bytes: entry.size ?? -1, open: (signal) => entryStream(driver, entry.id, signal) });
		}
	}
	return matchModelFiles(def, files);
}

/** The URL a def's file is retrieved from online, when it has one. */
export function onlineUrl(def: ModelDef, path: string): string | null {
	const file = def.files.find((candidate) => candidate.path === path);
	if (file?.url) return file.url;
	return def.origin.kind === 'hf' ? `https://huggingface.co/${def.origin.repo}/resolve/${def.origin.revision}/${path}` : null;
}

/**
 * Every file through one monitor's fetch proxy. A file without a URL, or on
 * a host that monitor does not retrieve from, is `not-fetchable` up front
 * rather than failing mid-load.
 */
export function onlineModelFiles(def: ModelDef, source: ModelOnlineSource): ModelFileMatch[] {
	const base = source.baseUrl.replace(/\/+$/, '');
	return def.files.map((file): ModelFileMatch => {
		const url = onlineUrl(def, file.path);
		let host = '';
		try { host = url ? new URL(url).host : ''; } catch { /* unparseable: not fetchable */ }
		if (!url || !source.hosts.includes(host)) return { file, state: 'not-fetchable' };
		return {
			file,
			state: 'found',
			source: {
				path: file.path,
				bytes: file.bytes ?? -1,
				async open(signal) {
					const proxied = `${base}/v1/tools/fetch?url=${encodeURIComponent(url)}`;
					const res = await fetch(proxied, withLocalAddressSpace(proxied, { signal }));
					if (!res.ok || !res.body) throw new Error(`${file.path}: ${source.label} answered ${res.status}`);
					return res.body;
				}
			}
		};
	});
}

/**
 * A live device link that can offer its stored models (platform-services
 * device links; the hub registers them). `offered` asks the far device what
 * it holds of one model; `copy` asks it to send those files, which its user
 * allows or denies there, and lands each one in this browser's store.
 */
export type ModelDeviceSource = {
	id: string;
	label: string;
	offered(def: ModelDef, signal: AbortSignal): Promise<ReadonlyArray<{ path: string; bytes: number; blake3: string }>>;
	copy(def: ModelDef, paths: readonly string[], opts: { signal: AbortSignal; onProgress: (path: string, bytes: number) => void }): Promise<void>;
};
type DeviceSourceProvider = { list(): ModelDeviceSource[]; subscribe(fn: () => void): () => void };
let deviceProvider: DeviceSourceProvider | null = null;
const deviceListeners = new Set<() => void>();
let unProvider: (() => void) | null = null;
/** The hub's live links. A consumer that never registers has no device sources. */
export function registerModelDeviceSources(provider: DeviceSourceProvider | null): void {
	unProvider?.();
	deviceProvider = provider;
	unProvider = provider?.subscribe(() => { for (const fn of [...deviceListeners]) fn(); }) ?? null;
	for (const fn of [...deviceListeners]) fn();
}
export function modelDeviceSources(): ModelDeviceSource[] {
	return deviceProvider?.list() ?? [];
}
export function onDeviceSourcesChange(fn: () => void): () => void {
	deviceListeners.add(fn);
	return () => deviceListeners.delete(fn);
}

/** The hub's pair-a-device flow. The model card's "Another device" button calls it. */
let deviceConnect: (() => void) | null = null;
export function registerModelDeviceConnect(connect: (() => void) | null): void {
	deviceConnect = connect;
}
/** Start pairing. Returns false when this app has not registered a connect flow. */
export function connectModelDevice(): boolean {
	if (!deviceConnect) return false;
	deviceConnect();
	return true;
}

/** What a device offers, against the def: a file counts only with the def's size and hash. */
export function linkedDeviceFiles(def: ModelDef, offered: ReadonlyArray<{ path: string; bytes: number; blake3: string }>): ModelFileMatch[] {
	return def.files.map((file): ModelFileMatch => {
		const have = offered.find((row) => row.path === file.path);
		if (!have) return { file, state: 'missing' };
		if (file.bytes != null && have.bytes !== file.bytes) return { file, state: 'size-mismatch' };
		if (file.blake3 && have.blake3 !== file.blake3.toLowerCase()) return { file, state: 'hash-mismatch' };
		return { file, state: 'found' };
	});
}
