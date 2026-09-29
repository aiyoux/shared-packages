/**
 * The hub's view of B2: every connection held by every saved monitor.
 *
 * Nothing about B2 is stored in this browser except which row was last used.
 * Adding a monitor makes its connections appear; a connection added from any
 * device appears everywhere that monitor is saved.
 */
import { HUB_B2_PROFILES_CHANNEL, notifyTabChannel } from '../crossTab.js';
import { getProfile as getMonitorProfile, listProfiles as listMonitorProfiles } from '../monitor/credentials.js';
import type { MonitorConnectionProfileV1 } from '../monitor/types.js';
import { createMonitorB2Client, type MonitorB2Client } from './client.js';
import { ExplorerB2Error } from './errors.js';
import {
	b2RowId,
	parseB2RowId,
	type B2ConnectionInput,
	type B2ConnectionRow,
	type MonitorB2Connection
} from './types.js';

const ACTIVE_KEY = 'hub:b2:activeRow';

export type B2ConnectionListing = {
	rows: B2ConnectionRow[];
	/** Monitors that could not be asked (offline, CORS). Old daemons are skipped silently. */
	unreachable: Array<{ monitorProfileId: string; monitorName: string; message: string }>;
};

export function b2ClientFor(monitor: MonitorConnectionProfileV1): MonitorB2Client {
	return createMonitorB2Client({ baseUrl: monitor.baseUrl });
}

function toRow(monitor: MonitorConnectionProfileV1, c: MonitorB2Connection): B2ConnectionRow {
	return {
		...c,
		rowId: b2RowId(monitor.id, c.id),
		monitorProfileId: monitor.id,
		monitorName: monitor.name,
		monitorBaseUrl: monitor.baseUrl
	};
}

export async function listB2Connections(): Promise<B2ConnectionListing> {
	const monitors = await listMonitorProfiles();
	const out: B2ConnectionListing = { rows: [], unreachable: [] };
	await Promise.all(
		monitors.map(async (m) => {
			try {
				const conns = await b2ClientFor(m).listConnections();
				out.rows.push(...conns.map((c) => toRow(m, c)));
			} catch (e) {
				if (e instanceof ExplorerB2Error && e.code === 'B2_UNSUPPORTED') return;
				out.unreachable.push({
					monitorProfileId: m.id,
					monitorName: m.name,
					message: e instanceof Error ? e.message : String(e)
				});
			}
		})
	);
	// Stable order regardless of which monitor answered first.
	const order = new Map(monitors.map((m, i) => [m.id, i]));
	out.rows.sort(
		(a, b) =>
			(order.get(a.monitorProfileId) ?? 0) - (order.get(b.monitorProfileId) ?? 0) ||
			a.name.localeCompare(b.name)
	);
	return out;
}

/** One row, asked of its own monitor (so it is fresh). */
export async function getB2Connection(rowId: string): Promise<B2ConnectionRow | undefined> {
	const ids = parseB2RowId(rowId);
	if (!ids) return undefined;
	const monitor = await getMonitorProfile(ids.monitorProfileId);
	if (!monitor) return undefined;
	const conns = await b2ClientFor(monitor).listConnections();
	const c = conns.find((x) => x.id === ids.connectionId);
	return c ? toRow(monitor, c) : undefined;
}

async function monitorOrThrow(monitorProfileId: string): Promise<MonitorConnectionProfileV1> {
	const monitor = await getMonitorProfile(monitorProfileId);
	if (!monitor) throw new ExplorerB2Error('B2_NOT_FOUND', 'That monitor is no longer saved.');
	return monitor;
}

export async function createB2Connection(
	monitorProfileId: string,
	input: B2ConnectionInput
): Promise<B2ConnectionRow> {
	const monitor = await monitorOrThrow(monitorProfileId);
	const created = await b2ClientFor(monitor).createConnection(input);
	notifyTabChannel(HUB_B2_PROFILES_CHANNEL);
	return toRow(monitor, created);
}

/** An empty `key` keeps the one the monitor holds. */
export async function updateB2Connection(
	rowId: string,
	patch: Partial<B2ConnectionInput>
): Promise<B2ConnectionRow> {
	const ids = parseB2RowId(rowId);
	if (!ids) throw new ExplorerB2Error('B2_NOT_FOUND', 'Unknown B2 connection');
	const monitor = await monitorOrThrow(ids.monitorProfileId);
	const updated = await b2ClientFor(monitor).updateConnection(ids.connectionId, patch);
	notifyTabChannel(HUB_B2_PROFILES_CHANNEL);
	return toRow(monitor, updated);
}

export async function deleteB2Connection(rowId: string): Promise<void> {
	const ids = parseB2RowId(rowId);
	if (!ids) return;
	const monitor = await monitorOrThrow(ids.monitorProfileId);
	await b2ClientFor(monitor).deleteConnection(ids.connectionId);
	if (getActiveB2RowId() === rowId) setActiveB2RowId(null);
	notifyTabChannel(HUB_B2_PROFILES_CHANNEL);
}

/** Last-used row (a per-browser convenience, never a secret). */
export function getActiveB2RowId(): string | null {
	try {
		return localStorage.getItem(ACTIVE_KEY);
	} catch {
		return null;
	}
}

export function setActiveB2RowId(rowId: string | null): void {
	try {
		if (rowId) localStorage.setItem(ACTIVE_KEY, rowId);
		else localStorage.removeItem(ACTIVE_KEY);
	} catch {
		/* storage unavailable — the choice is just not remembered */
	}
}
