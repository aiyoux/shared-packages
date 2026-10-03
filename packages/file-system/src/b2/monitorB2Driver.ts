/**
 * ExplorerDriver for one B2 connection held by a monitor.
 *
 * Every operation is a call to that monitor's `/v1/b2` routes; the monitor
 * holds the key and talks to Backblaze. Ids are object keys; folder ids are
 * prefixes ending in `/` (same shape the retired browser driver used).
 */
import { inferFileTypeFromName } from '../index.js';
import {
	EXPLORER_DOWNLOAD_MAX_BYTES,
	type ExplorerCapabilities,
	type ExplorerDriver,
	type ExplorerEntry,
	type ExplorerEntryId
} from '../ui/explorerDriver.js';
import { createMonitorB2Client, type MonitorB2Client, type MonitorB2Entry } from './client.js';
import { ExplorerB2Error } from './errors.js';
import { b2RowId, type B2ConnectionRow } from './types.js';

export const B2_CAPS: ExplorerCapabilities = {
	supportsTrash: false,
	supportsSoftDelete: false,
	supportsRename: true,
	supportsMove: true,
	supportsCopy: true,
	supportsFolderCopy: false,
	supportsMkdir: true,
	supportsUpload: true,
	supportsDownload: true,
	supportsSiblingOrder: false,
	supportsDragOut: true
};

function parentOf(key: string, root: string): ExplorerEntryId | null {
	const trimmed = key.replace(/\/$/, '');
	const i = trimmed.lastIndexOf('/');
	const parent = i >= 0 ? trimmed.slice(0, i + 1) : '';
	return parent === root || parent.length < root.length ? null : parent;
}

/** Normalized host key, same shape as the monitor fs driver's `endpointKey`. */
export function monitorHostKey(baseUrl: string): string {
	try {
		const u = new URL(baseUrl);
		u.hash = '';
		u.search = '';
		return `monitor:${u.href.replace(/\/+$/, '').toLowerCase()}`;
	} catch {
		return `monitor:${baseUrl.replace(/\/+$/, '').toLowerCase()}`;
	}
}

export type MonitorB2DriverOptions = {
	row: B2ConnectionRow;
	/** Inject for tests. */
	client?: MonitorB2Client;
};

export async function createMonitorB2Driver(opts: MonitorB2DriverOptions): Promise<ExplorerDriver> {
	const { row } = opts;
	const client = opts.client ?? createMonitorB2Client({ baseUrl: row.monitorBaseUrl });
	const cid = row.id;
	// First list proves the monitor, the connection and the key all work, and
	// tells us the effective root (the key may carry its own prefix).
	const first = await client.list(cid, null);
	const root = first.root;

	const toEntry = (e: MonitorB2Entry): ExplorerEntry => ({
		id: e.id,
		parentId: parentOf(e.id, root),
		name: e.name,
		kind: e.kind,
		size: e.size,
		updatedAt: e.updatedAt,
		contentType: e.contentType,
		fileType: e.kind === 'file' ? inferFileTypeFromName(e.name) : undefined
	});

	const folderOnly = (op: string) =>
		new ExplorerB2Error('B2_FOLDER_OP_UNSUPPORTED', `Folder ${op} is not supported on B2`);

	const driver: ExplorerDriver = {
		id: 'b2',
		connectionId: `b2:${b2RowId(row.monitorProfileId, row.id)}`,
		// Two panes on the same connection share this, and only this.
		endpointKey: `b2:${monitorHostKey(row.monitorBaseUrl)}::${row.id}`,
		capabilities: B2_CAPS,

		async ready() {
			/* the first list at create already proved the connection */
		},

		async getPath(id) {
			if (!id.startsWith(root)) return [];
			let rel = id.slice(root.length);
			if (rel && !rel.endsWith('/')) {
				const slash = rel.lastIndexOf('/');
				rel = slash >= 0 ? rel.slice(0, slash + 1) : '';
			}
			const segments = rel.replace(/\/$/, '').split('/').filter(Boolean);
			const chain: ExplorerEntry[] = [];
			let acc = root;
			for (let i = 0; i < segments.length; i++) {
				const parentId = i === 0 ? null : acc;
				acc = `${acc}${segments[i]}/`;
				chain.push({ id: acc, parentId, name: segments[i]!, kind: 'folder' });
			}
			return chain;
		},

		async list({ parentId }) {
			const listing = await client.list(cid, parentId);
			return { entries: listing.entries.map(toEntry), truncated: listing.truncated };
		},

		async mkdir(parentId, name) {
			return toEntry(await client.mkdir(cid, parentId, name));
		},

		async delete(id) {
			await client.remove(cid, id);
		},

		async rename(id, name) {
			return toEntry(await client.rename(cid, id, name));
		},

		async move(id, newParentId) {
			if (id.endsWith('/')) throw folderOnly('move');
			return toEntry(await client.move(cid, id, newParentId));
		},

		/** Same-connection copy: `b2_copy_file`, no bytes move. */
		async copy(id, newParentId) {
			if (id.endsWith('/')) throw folderOnly('copy');
			return toEntry(await client.copy(cid, id, newParentId));
		},

		async upload(parentId, file, uOpts) {
			return toEntry(await client.upload(cid, parentId, file, file.name, uOpts));
		},

		async download(id, dOpts) {
			const info = await client.stat(cid, id);
			if ((info.size ?? 0) > EXPLORER_DOWNLOAD_MAX_BYTES) {
				throw new ExplorerB2Error(
					'B2_TOO_LARGE',
					`File exceeds ${EXPLORER_DOWNLOAD_MAX_BYTES} byte download limit`
				);
			}
			return client.download(cid, id, dOpts);
		},

		/** The monitor streams it; no size cap (the browser download manager takes it). */
		async downloadUrl(id) {
			if (id.endsWith('/')) return null;
			const name = id.slice(id.lastIndexOf('/') + 1);
			return { url: client.downloadUrl(cid, id), filename: name };
		},

		// ── delegated copies: another monitor (or this one) talks to B2 ─────

		async mintDownloadUrl(id) {
			const m = await client.mintDownload(cid, id);
			return { url: m.url, filename: m.filename, expiresAt: m.expiresAt };
		},

		async mintUploadUrl(parentId, fileName) {
			return client.mintUpload(cid, parentId, fileName);
		},

		/** Pull a URL another connection minted into this bucket (via this monitor). */
		async pullFromUrl(url, destParentId, sourceName, pOpts) {
			await client.transfer(
				{ url, name: sourceName },
				{ connection: cid, parent: destParentId },
				pOpts
			);
		}
	};
	return driver;
}
