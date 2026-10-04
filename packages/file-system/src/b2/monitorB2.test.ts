import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { EXPLORER_DOWNLOAD_MAX_BYTES, RemoteChangedError, explorerThumbsAreEager } from '../ui/explorerDriver.js';
import { createMonitorB2Client } from './client.js';
import { createMonitorB2Driver } from './monitorB2Driver.js';
import { acquireB2Driver, b2DriverCacheSize, clearB2DriverCacheForTests, releaseB2Driver } from './b2DriverCache.js';
import { listB2Connections, getB2Connection } from './connections.js';
import { ExplorerB2Error } from './errors.js';
import { parseB2RowId, type B2ConnectionRow } from './types.js';
import {
	closeCredentialsDbForTests as closeMonitors,
	saveProfile as saveMonitor
} from '../monitor/credentials.js';
import { HUB_MONITOR_DB_NAME } from '../monitor/types.js';

const BASE = 'http://127.0.0.1:8300';

type Call = { method: string; url: string; body?: unknown };

/** Fake monitor: a flat key → bytes map under one connection `c1`. */
function fakeMonitor(files: Record<string, string> = {}) {
	const calls: Call[] = [];
	const store = new Map(Object.entries(files));
	const staged = new Map<string, string>();
	const json = (v: unknown, status = 200) =>
		new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
	const ndjson = (lines: unknown[]) =>
		new Response(lines.map((l) => JSON.stringify(l)).join('\n') + '\n', { status: 200 });
	const entry = (k: string) => ({
		id: k,
		name: k.slice(k.replace(/\/$/, '').lastIndexOf('/') + 1).replace(/\/$/, ''),
		kind: k.endsWith('/') ? 'folder' : 'file',
		size: k.endsWith('/') ? undefined : store.get(k)?.length
	});
	const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const u = new URL(String(input));
		const method = init?.method ?? 'GET';
		const body =
			typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
		calls.push({ method, url: u.pathname + u.search, body });
		const p = u.pathname;
		if (p === '/v1/b2/connections') {
			return json({
				connections: [{ id: 'c1', name: 'Photos', keyId: '003a', bucket: 'photos', namePrefix: '' }]
			});
		}
		if (p === '/v1/b2/connections/c1/list') {
			const parent = u.searchParams.get('parent') ?? '';
			const kids = new Set<string>();
			for (const k of store.keys()) {
				if (!k.startsWith(parent)) continue;
				const rest = k.slice(parent.length);
				const i = rest.indexOf('/');
				kids.add(i >= 0 ? parent + rest.slice(0, i + 1) : k);
			}
			return json({ root: '', entries: [...kids].map(entry), truncated: false });
		}
		if (p === '/v1/b2/connections/c1/stat') {
			const k = u.searchParams.get('key')!;
			return store.has(k)
				? json(entry(k))
				: json({ error: { code: 'b2.not_found', message: `${k} was not found` } }, 404);
		}
		if (p === '/v1/b2/connections/c1/rename') {
			const { key, name } = body as { key: string; name: string };
			if (name.includes('/')) {
				return json({ error: { code: 'b2.invalid_name', message: 'That name is not allowed.' } }, 400);
			}
			const dest = key.slice(0, key.lastIndexOf('/') + 1) + name;
			store.set(dest, store.get(key)!);
			store.delete(key);
			return json(entry(dest));
		}
		if (p === '/v1/b2/connections/c1/download') {
			const k = u.searchParams.get('key')!;
			return new Response(store.get(k) ?? '', { status: 200 });
		}
		if (p === '/v1/b2/connections/c1/upload') {
			const { parent, name } = body as { parent: string | null; name: string };
			staged.set('job1', '');
			return json({ jobId: 'job1', token: 't', key: `${parent ?? ''}${name}` });
		}
		if (p === '/v1/b2/upload/job1/chunk') {
			staged.set('job1', staged.get('job1')! + (await new Blob([init!.body as Blob]).text()));
			return json({ received: 1 });
		}
		if (p === '/v1/b2/upload/job1/finish') {
			const k = 'in/new.txt';
			store.set(k, staged.get('job1')!);
			return ndjson([
				{ transferred: 1, size: 2, phase: 'upload' },
				{ done: true, transferred: 2, size: 2, entry: entry(k) }
			]);
		}
		if (p === '/v1/b2/connections/c1/mint-download') {
			return json({ url: 'https://f000.backblazeb2.com/file/photos/a.txt?Authorization=dl', filename: 'a.txt' });
		}
		if (p === '/v1/b2/transfer') {
			return ndjson([{ done: true, transferred: 1, size: 1, error: 'boom', code: 'b2.forbidden' }]);
		}
		throw new Error(`unexpected ${method} ${p}`);
	});
	return { fetchImpl: fetchImpl as unknown as typeof fetch, calls, store };
}

const row: B2ConnectionRow = {
	id: 'c1',
	name: 'Photos',
	keyId: '003a',
	bucket: 'photos',
	namePrefix: '',
	rowId: 'm1.c1',
	monitorProfileId: 'm1',
	monitorName: 'Home',
	monitorBaseUrl: BASE
};

describe('monitor-held B2 driver', () => {
	it('lists folders and files by key; ids are keys, folders end in /', async () => {
		const m = fakeMonitor({ 'a.txt': 'hi', 'trip/b.jpg': 'jpg' });
		const client = createMonitorB2Client({ baseUrl: BASE, fetchImpl: m.fetchImpl });
		const d = await createMonitorB2Driver({ row, client });
		expect(d.id).toBe('b2');
		expect(d.connectionId).toBe('b2:m1.c1');
		expect(d.endpointKey).toBe('b2:monitor:http://127.0.0.1:8300::c1');
		const root = await d.list({ parentId: null });
		expect(root.entries.map((e) => [e.id, e.kind, e.parentId])).toEqual([
			['a.txt', 'file', null],
			['trip/', 'folder', null]
		]);
		const inside = await d.list({ parentId: 'trip/' });
		expect(inside.entries[0]).toMatchObject({ id: 'trip/b.jpg', parentId: 'trip/', fileType: expect.anything() });
		expect((await d.getPath('trip/b.jpg')).map((e) => e.id)).toEqual(['trip/']);
	});

	it('openDownloadStream skips the Blob cap and reads the download body', async () => {
		const body = 'streamed-bytes';
		const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
			const u = new URL(String(input));
			if (u.pathname.endsWith('/list')) {
				return new Response(JSON.stringify({ root: '', entries: [], truncated: false }), {
					status: 200,
					headers: { 'content-type': 'application/json' }
				});
			}
			if (u.pathname.endsWith('/stat')) {
				return new Response(
					JSON.stringify({
						id: 'big.bin',
						name: 'big.bin',
						kind: 'file',
						size: EXPLORER_DOWNLOAD_MAX_BYTES + 1
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } }
				);
			}
			if (u.pathname.endsWith('/download')) {
				return new Response(body, {
					status: 200,
					headers: {
						'content-type': 'application/octet-stream',
						'content-length': String(body.length)
					}
				});
			}
			throw new Error(`unexpected ${u.pathname}`);
		});
		const client = createMonitorB2Client({ baseUrl: BASE, fetchImpl: fetchImpl as unknown as typeof fetch });
		const d = await createMonitorB2Driver({ row, client });
		await expect(d.download!('big.bin')).rejects.toMatchObject({ code: 'B2_TOO_LARGE' });
		const opened = await d.openDownloadStream!('big.bin');
		expect(opened.contentType).toContain('application/octet-stream');
		expect(opened.size).toBe(body.length);
		expect(await new Response(opened.stream).text()).toBe(body);
		expect(fetchImpl.mock.calls.map((c) => new URL(String(c[0])).pathname)).toEqual([
			'/v1/b2/connections/c1/list',
			'/v1/b2/connections/c1/stat',
			'/v1/b2/connections/c1/download'
		]);
		await expect(d.openDownloadStream!('trip/')).rejects.toMatchObject({
			code: 'B2_FOLDER_OP_UNSUPPORTED'
		});
	});

	it('maps monitor error codes to explorer codes', async () => {
		const m = fakeMonitor({ 'a.txt': 'hi' });
		const client = createMonitorB2Client({ baseUrl: BASE, fetchImpl: m.fetchImpl });
		const d = await createMonitorB2Driver({ row, client });
		await expect(d.rename!('a.txt', 'x/y')).rejects.toMatchObject({ code: 'INVALID_NAME' });
		await expect(d.download!('missing.txt')).rejects.toMatchObject({ code: 'B2_NOT_FOUND' });
		await expect(d.move!('trip/', null)).rejects.toMatchObject({ code: 'B2_FOLDER_OP_UNSUPPORTED' });
		const e = await d.rename!('a.txt', 'b.txt');
		expect(e.id).toBe('b.txt');
	});

	it('uploads in chunks through the monitor and reads the finish stream', async () => {
		const m = fakeMonitor();
		const client = createMonitorB2Client({ baseUrl: BASE, fetchImpl: m.fetchImpl });
		const d = await createMonitorB2Driver({ row, client });
		const progress: number[] = [];
		const entry = await d.upload!('in/', new File(['hi'], 'new.txt'), {
			onProgress: (p) => progress.push(p)
		});
		expect(entry.id).toBe('in/new.txt');
		expect(m.store.get('in/new.txt')).toBe('hi');
		expect(progress.at(-1)).toBe(1);
		expect(progress.every((p, i) => i === 0 || p >= progress[i - 1]!)).toBe(true);
		// The key never appears in anything this tab sends.
		expect(JSON.stringify(m.calls)).not.toMatch(/applicationKey|K00/);
	});

	it('writeBack replaces the same key and names the version it expects', async () => {
		const m = fakeMonitor({ 'in/new.txt': 'old' });
		const client = createMonitorB2Client({ baseUrl: BASE, fetchImpl: m.fetchImpl });
		const d = await createMonitorB2Driver({ row, client });
		expect(d.label).toBe('Photos');
		expect((await d.rangeUrl!('in/new.txt'))?.url).toBe(`${BASE}/v1/b2/connections/c1/download?key=in%2Fnew.txt`);
		await d.writeBack!('in/new.txt', new Blob(['hi']), { expectUpdatedAt: 42 });
		const begin = m.calls.find((c) => c.url === '/v1/b2/connections/c1/upload');
		expect(begin?.body).toMatchObject({ parent: 'in/', name: 'new.txt', replace: true, expectUpdatedAt: 42 });
		expect(m.store.get('in/new.txt')).toBe('hi');
	});

	it('previews photos from a monitor render and never loads list thumbnails on its own', async () => {
		const m = fakeMonitor({ 'in/p.jpg': 'jpeg', 'in/a.txt': 'x' });
		const d = await createMonitorB2Driver({ row, client: createMonitorB2Client({ baseUrl: BASE, fetchImpl: m.fetchImpl }) });
		expect((await d.thumbUrl!('in/p.jpg', { maxDim: 2048 }))?.url).toBe(
			`${BASE}/v1/b2/connections/c1/thumb?key=in%2Fp.jpg&size=2048`
		);
		expect(await d.thumbUrl!('in/a.txt')).toBeNull();
		expect(explorerThumbsAreEager(d)).toBe(false);
	});

	it('starts a converted object where the monitor says it really starts', async () => {
		const m = fakeMonitor({ 'v/clip.mkv': 'x' });
		const asked: string[] = [];
		const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const u = new URL(String(input));
			if (u.pathname === '/v1/b2/connections/c1/media-info') {
				asked.push(u.search);
				return new Response(JSON.stringify({ duration: 600, start: 88.088 }), { status: 200 });
			}
			return m.fetchImpl(input, init);
		}) as typeof fetch;
		const d = await createMonitorB2Driver({ row, client: createMonitorB2Client({ baseUrl: BASE, fetchImpl }) });
		expect(await d.convertedMediaUrl!('v/clip.mkv', { start: 90 })).toEqual({
			url: `${BASE}/v1/b2/connections/c1/media?key=v%2Fclip.mkv&t=88.088`,
			duration: 600,
			start: 88.088
		});
		expect(asked).toEqual(['?key=v%2Fclip.mkv&t=90']);
	});

	it('writeBack reports an object changed in the bucket as RemoteChangedError', async () => {
		const m = fakeMonitor({ 'in/new.txt': 'old' });
		const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
			if (String(input).endsWith('/v1/b2/upload/job1/finish')) {
				return new Response(JSON.stringify({ error: { code: 'b2.changed', message: 'changed' } }), { status: 409 });
			}
			return m.fetchImpl(input, init);
		}) as typeof fetch;
		const d = await createMonitorB2Driver({ row, client: createMonitorB2Client({ baseUrl: BASE, fetchImpl }) });
		await expect(d.writeBack!('in/new.txt', new Blob(['hi']), { expectUpdatedAt: 42 })).rejects.toBeInstanceOf(
			RemoteChangedError
		);
		expect(m.store.get('in/new.txt')).toBe('old');
	});

	it('delegates: mints on the source monitor, surfaces transfer failures with codes', async () => {
		const m = fakeMonitor({ 'a.txt': 'hi' });
		const client = createMonitorB2Client({ baseUrl: BASE, fetchImpl: m.fetchImpl });
		const d = await createMonitorB2Driver({ row, client });
		const minted = await d.mintDownloadUrl!('a.txt');
		expect(minted.url).toContain('Authorization=dl');
		await expect(d.pullFromUrl!(minted.url, null, 'a.txt')).rejects.toMatchObject({
			code: 'B2_FORBIDDEN',
			message: 'boom'
		});
		const transfer = m.calls.find((c) => c.url === '/v1/b2/transfer')!;
		expect(transfer.body).toEqual({
			from: { url: minted.url, name: 'a.txt' },
			to: { connection: 'c1', parent: null }
		});
	});

	it('a daemon without the feature reads as unsupported, not broken', async () => {
		const client = createMonitorB2Client({
			baseUrl: BASE,
			fetchImpl: (async () => new Response('', { status: 404 })) as unknown as typeof fetch
		});
		await expect(client.listConnections()).rejects.toBeInstanceOf(ExplorerB2Error);
		await expect(client.listConnections()).rejects.toMatchObject({ code: 'B2_UNSUPPORTED' });
	});
});

describe('B2 connections across monitors', () => {
	beforeEach(async () => {
		await closeMonitors();
		await new Promise<void>((r) => {
			const q = indexedDB.deleteDatabase(HUB_MONITOR_DB_NAME);
			q.onsuccess = q.onerror = q.onblocked = () => r();
		});
	});
	afterEach(async () => {
		vi.unstubAllGlobals();
		clearB2DriverCacheForTests();
		await closeMonitors();
	});

	it('every saved monitor contributes its rows; offline monitors are reported, old ones skipped', async () => {
		await saveMonitor({ id: 'm1', name: 'Home', baseUrl: BASE, rootPath: '/tmp' });
		await saveMonitor({ id: 'm2', name: 'Old', baseUrl: 'http://127.0.0.1:8301', rootPath: '/tmp' });
		await saveMonitor({ id: 'm3', name: 'Off', baseUrl: 'http://127.0.0.1:8302', rootPath: '/tmp' });
		const home = fakeMonitor();
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				if (url.startsWith(BASE)) return home.fetchImpl(input, init);
				if (url.startsWith('http://127.0.0.1:8301')) return new Response('', { status: 404 });
				throw new TypeError('Failed to fetch');
			})
		);
		const listing = await listB2Connections();
		expect(listing.rows.map((r) => [r.rowId, r.monitorName])).toEqual([['m1.c1', 'Home']]);
		expect(listing.unreachable.map((u) => u.monitorName)).toEqual(['Off']);
		expect((await getB2Connection('m1.c1'))?.bucket).toBe('photos');
		expect(parseB2RowId('m1.c1')).toEqual({ monitorProfileId: 'm1', connectionId: 'c1' });
		expect(parseB2RowId('nodot')).toBeNull();
	});

	it('the driver cache shares one driver per row and releases by row id', async () => {
		vi.stubGlobal('fetch', fakeMonitor({ 'a.txt': 'hi' }).fetchImpl);
		const [a, b] = await Promise.all([acquireB2Driver(row), acquireB2Driver(row)]);
		expect(a).toBe(b);
		expect(b2DriverCacheSize()).toBe(1);
		releaseB2Driver(row.rowId);
		releaseB2Driver(row.rowId);
		expect(b2DriverCacheSize()).toBe(1); // held warm, not dropped
	});
});
