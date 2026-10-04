import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
	MAX_EDIT_PIXELS,
	copyRemoteForOpen,
	listRemoteCopies,
	runRemoteOpen,
	trimRemoteCopies,
	getRemoteCopy,
	openRemoteWorkingCopy,
	planRemoteOpen,
	sendRemoteCopy,
	setRemoteCopiesForTest,
	startRemoteCopySync,
	type RemoteCopyVfs
} from '../src/services/remoteCopies.ts';
import { recordLinkTransfer, resetLinkSpeedForTest } from '../src/linkSpeed.ts';
import { RemoteChangedError, type ExplorerDriver, type ExplorerEntry } from '../src/ui/explorerDriver.ts';
import type { VfsNode } from '../src/types.ts';
import { installLockPolyfill } from './live-locks-harness.ts';

// Sends queue on a Web Lock, as in a browser.
const locks = installLockPolyfill();

type FakeNode = VfsNode & { bytes?: Uint8Array };

/** The VFS surface remoteCopies uses, in memory. */
class FakeVfs implements RemoteCopyVfs {
	nodes = new Map<string, FakeNode>();
	meta = new Map<string, unknown>();
	listeners = new Set<() => void>();
	private next = 1;
	async get(id: string) {
		return this.nodes.get(id);
	}
	async getMeta<T>(key: string) {
		return this.meta.get(key) as T | undefined;
	}
	async setMeta(key: string, value: unknown) {
		this.meta.set(key, value);
	}
	async deleteMeta(key: string) {
		this.meta.delete(key);
	}
	async readBlob(id: string) {
		return new Blob([new Uint8Array(this.nodes.get(id)!.bytes ?? [])]);
	}
	subscribe(listener: () => void) {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	async childByName(parentId: string | null, name: string) {
		return [...this.nodes.values()].find((n) => n.parentId === parentId && n.name === name && n.deletedAt == null);
	}
	private add(parentId: string | null, name: string, kind: 'file' | 'folder', bytes?: Uint8Array): FakeNode {
		const node: FakeNode = {
			id: `n${this.next++}`,
			parentId,
			name,
			kind,
			createdAt: 0,
			updatedAt: 0,
			generation: 1,
			size: bytes?.byteLength,
			bytes
		};
		this.nodes.set(node.id, node);
		return node;
	}
	async mkdir(parentId: string | null, name: string) {
		return this.add(parentId, name, 'folder');
	}
	async ensureUniqueName(_parentId: string | null, name: string) {
		return name;
	}
	async writeFileStream(
		input: { parentId: string | null; name: string },
		stream: ReadableStream<Uint8Array>
	) {
		const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
		const node = this.add(input.parentId, input.name, 'file', bytes);
		this.notify();
		return node;
	}
	async trash(id: string) {
		const node = this.nodes.get(id);
		if (node) node.deletedAt = Date.now();
	}
	async permanentDelete(id: string) {
		this.nodes.delete(id);
	}
	/** What an app's Save does to a file: new bytes, next generation. */
	save(id: string, text: string) {
		const node = this.nodes.get(id)!;
		node.bytes = new TextEncoder().encode(text);
		node.size = node.bytes.byteLength;
		node.generation += 1;
		this.notify();
	}
	notify() {
		for (const fn of this.listeners) fn();
	}
}

type RemoteFile = { bytes: Uint8Array; updatedAt: number };

function remoteDriver(files: Map<string, RemoteFile>, extra: Partial<ExplorerDriver> = {}) {
	let clock = 1000;
	const writes: Array<{ id: string; text: string; expect?: number }> = [];
	const driver: ExplorerDriver = {
		id: 'monitor',
		label: 'Office PC',
		connectionId: 'monitor:p1',
		capabilities: {} as ExplorerDriver['capabilities'],
		ready: async () => {},
		list: async () => ({ entries: [], truncated: false }),
		getPath: async () => [],
		delete: async () => {},
		async rangeUrl(id) {
			return { url: `http://127.0.0.1:8300/v1/fs/read?path=${encodeURIComponent(id)}` };
		},
		async openDownloadStream(id) {
			const file = files.get(id)!;
			return { stream: new Blob([new Uint8Array(file.bytes)]).stream(), size: file.bytes.byteLength };
		},
		async writeBack(id, body, opts) {
			const text = await body.text();
			writes.push({ id, text, expect: opts?.expectUpdatedAt });
			const current = files.get(id);
			if (opts?.expectUpdatedAt !== undefined && current?.updatedAt !== opts.expectUpdatedAt) {
				throw new RemoteChangedError();
			}
			clock += 1;
			files.set(id, { bytes: new TextEncoder().encode(text), updatedAt: clock });
			return { updatedAt: clock, size: body.size };
		},
		...extra
	};
	return { driver, writes, touch: (id: string) => (files.get(id)!.updatedAt = ++clock) };
}

function entryOf(id: string, file: RemoteFile, extra: Partial<ExplorerEntry> = {}): ExplorerEntry {
	return {
		id,
		parentId: null,
		name: id.split('/').pop()!,
		kind: 'file',
		size: file.bytes.byteLength,
		updatedAt: file.updatedAt,
		...extra
	};
}

const text = (s: string) => new TextEncoder().encode(s);
const flush = async () => {
	for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};

let fs: FakeVfs;
let realFetch: typeof fetch;

beforeEach(() => {
	locks.reset();
	fs = new FakeVfs();
	resetLinkSpeedForTest();
	realFetch = globalThis.fetch;
	// A probe must not reach the network in a test.
	globalThis.fetch = (async () => {
		throw new TypeError('offline');
	}) as typeof fetch;
	setRemoteCopiesForTest({
		vfs: fs,
		resolveDriver: async () => null,
		startOp: async () => {
			throw new Error('no ops in this test');
		},
		isOpen: () => false
	});
});

afterEach(() => {
	globalThis.fetch = realFetch;
	setRemoteCopiesForTest({});
});

describe('remote open plan', () => {
	it('asks on an unmeasured link above 1 MiB, and not below it', async () => {
		const files = new Map([
			['big.bin', { bytes: new Uint8Array(2 * 1024 * 1024), updatedAt: 1 }],
			['small.txt', { bytes: text('hi'), updatedAt: 1 }]
		]);
		const { driver } = remoteDriver(files);
		const big = await planRemoteOpen(driver, entryOf('big.bin', files.get('big.bin')!));
		assert.equal(big.action, 'copy');
		assert.equal(big.ask, true);
		assert.equal(big.copyMs, undefined);
		const small = await planRemoteOpen(driver, entryOf('small.txt', files.get('small.txt')!));
		assert.equal(small.ask, false);
	});

	it('asks from the measured speed, so a fast link never asks and a slow one does', async () => {
		const files = new Map([['clip.mp4', { bytes: new Uint8Array(50 * 1024 * 1024), updatedAt: 1 }]]);
		const { driver } = remoteDriver(files);
		const entry = entryOf('clip.mp4', files.get('clip.mp4')!);
		// Same computer: 1 GB/s.
		recordLinkTransfer('http://127.0.0.1:8300/x', 1e9, 1000);
		const fast = await planRemoteOpen(driver, entry);
		assert.equal(fast.ask, false);
		assert.ok(fast.copyMs! < 100);
		// A slow tunnel: the smoothed rate drops far enough to ask.
		resetLinkSpeedForTest();
		recordLinkTransfer('http://127.0.0.1:8300/x', 1024 * 1024, 10_000);
		const slow = await planRemoteOpen(driver, entry);
		assert.equal(slow.ask, true);
		assert.ok(slow.copyMs! > 100_000);
	});

	it('blocks a photo with more pixels than a canvas holds', async () => {
		const files = new Map([['huge.png', { bytes: text('png'), updatedAt: 1 }]]);
		const { driver } = remoteDriver(files, {
			imageInfo: async () => ({ width: 20_000, height: 20_000, format: 'png' })
		});
		assert.ok(20_000 * 20_000 > MAX_EDIT_PIXELS);
		const plan = await planRemoteOpen(driver, entryOf('huge.png', files.get('huge.png')!), { image: true });
		assert.match(plan.blocked ?? '', /20,000 × 20,000 pixels/);
	});

	it('reuses the copy here when the remote has not changed', async () => {
		const files = new Map([['notes.txt', { bytes: text('one'), updatedAt: 5 }]]);
		const { driver } = remoteDriver(files);
		const entry = entryOf('notes.txt', files.get('notes.txt')!);
		const nodeId = await copyRemoteForOpen(driver, entry);
		const plan = await planRemoteOpen(driver, entry);
		assert.deepEqual([plan.action, plan.nodeId, plan.ask], ['reuse', nodeId, false]);
	});

	it('opens this device\'s copy, marked as a conflict, when both sides changed', async () => {
		const files = new Map([['notes.txt', { bytes: text('one'), updatedAt: 5 }]]);
		const { driver, touch } = remoteDriver(files);
		const nodeId = await copyRemoteForOpen(driver, entryOf('notes.txt', files.get('notes.txt')!));
		fs.save(nodeId, 'mine');
		touch('notes.txt');
		const entry = entryOf('notes.txt', files.get('notes.txt')!);
		const plan = await planRemoteOpen(driver, entry);
		assert.deepEqual([plan.action, plan.conflict], ['reuse', true]);
		assert.equal(await openRemoteWorkingCopy(driver, entry, plan), nodeId);
		assert.equal((await getRemoteCopy(nodeId))?.state, 'conflict');
	});
});

describe('working copy send-back', () => {
	it('copies in and records the remote version', async () => {
		const files = new Map([['docs/a.txt', { bytes: text('hello'), updatedAt: 7 }]]);
		const { driver } = remoteDriver(files);
		const nodeId = await copyRemoteForOpen(driver, entryOf('docs/a.txt', files.get('docs/a.txt')!));
		assert.equal(new TextDecoder().decode(fs.nodes.get(nodeId)!.bytes), 'hello');
		const copy = await getRemoteCopy(nodeId);
		assert.deepEqual(copy?.base, { updatedAt: 7, size: 5 });
		assert.equal(copy?.state, 'synced');
		const folder = fs.nodes.get(fs.nodes.get(nodeId)!.parentId!)!;
		assert.equal(folder.name, 'Office PC');
	});

	it('sends a Save back only if the remote is still the version it came from', async () => {
		const files = new Map([['a.txt', { bytes: text('one'), updatedAt: 7 }]]);
		const { driver, writes } = remoteDriver(files);
		setRemoteCopiesForTest({ vfs: fs, resolveDriver: async () => ({ driver, release: () => {} }), startOp: async () => { throw new Error('none'); } });
		const nodeId = await copyRemoteForOpen(driver, entryOf('a.txt', files.get('a.txt')!));
		fs.save(nodeId, 'two');
		await sendRemoteCopy(nodeId);
		assert.deepEqual(writes, [{ id: 'a.txt', text: 'two', expect: 7 }]);
		const copy = await getRemoteCopy(nodeId);
		assert.equal(copy?.state, 'synced');
		assert.equal(copy?.syncedGeneration, 2);
		assert.equal(copy?.base.updatedAt, files.get('a.txt')!.updatedAt);
		// Nothing new saved: nothing sent.
		await sendRemoteCopy(nodeId);
		assert.equal(writes.length, 1);
	});

	it('marks a conflict instead of overwriting a remote that moved on, then resolves it', async () => {
		const files = new Map([['a.txt', { bytes: text('one'), updatedAt: 7 }]]);
		const { driver, writes, touch } = remoteDriver(files);
		setRemoteCopiesForTest({ vfs: fs, resolveDriver: async () => ({ driver, release: () => {} }), startOp: async () => { throw new Error('none'); } });
		const nodeId = await copyRemoteForOpen(driver, entryOf('a.txt', files.get('a.txt')!));
		touch('a.txt');
		fs.save(nodeId, 'mine');
		await sendRemoteCopy(nodeId);
		assert.equal((await getRemoteCopy(nodeId))?.state, 'conflict');
		assert.equal(new TextDecoder().decode(files.get('a.txt')!.bytes), 'one');
		// A conflict waits for a choice: a plain send does nothing.
		await sendRemoteCopy(nodeId);
		assert.equal(writes.length, 1);

		await sendRemoteCopy(nodeId, 'new-file');
		const copy = await getRemoteCopy(nodeId);
		assert.equal(copy?.state, 'synced');
		assert.equal(copy?.source.remoteId, 'a (this device).txt');
		assert.equal(new TextDecoder().decode(files.get('a (this device).txt')!.bytes), 'mine');
		assert.equal(new TextDecoder().decode(files.get('a.txt')!.bytes), 'one');
	});

	it('overwrite replaces the remote when the person chooses it', async () => {
		const files = new Map([['a.txt', { bytes: text('one'), updatedAt: 7 }]]);
		const { driver, touch } = remoteDriver(files);
		setRemoteCopiesForTest({ vfs: fs, resolveDriver: async () => ({ driver, release: () => {} }), startOp: async () => { throw new Error('none'); } });
		const nodeId = await copyRemoteForOpen(driver, entryOf('a.txt', files.get('a.txt')!));
		touch('a.txt');
		fs.save(nodeId, 'mine');
		await sendRemoteCopy(nodeId);
		await sendRemoteCopy(nodeId, 'overwrite');
		assert.equal((await getRemoteCopy(nodeId))?.state, 'synced');
		assert.equal(new TextDecoder().decode(files.get('a.txt')!.bytes), 'mine');
	});

	it('a failed send waits for the next Save instead of retrying on every change', async () => {
		const files = new Map([['a.txt', { bytes: text('one'), updatedAt: 7 }]]);
		let fail = true;
		const { driver, writes } = remoteDriver(files);
		const flaky: ExplorerDriver = {
			...driver,
			async writeBack(id, body, opts) {
				if (fail) throw new Error('connection dropped');
				return driver.writeBack!(id, body, opts);
			}
		};
		setRemoteCopiesForTest({ vfs: fs, resolveDriver: async () => ({ driver: flaky, release: () => {} }), startOp: async () => { throw new Error('none'); } });
		const nodeId = await copyRemoteForOpen(driver, entryOf('a.txt', files.get('a.txt')!));
		startRemoteCopySync();
		fs.save(nodeId, 'two');
		await flush();
		const failed = await getRemoteCopy(nodeId);
		assert.equal(failed?.state, 'failed');
		assert.equal(failed?.failedGeneration, 2);
		fail = false;
		fs.notify();
		await flush();
		assert.equal(writes.length, 0, 'an unrelated change does not retry');
		fs.save(nodeId, 'three');
		await flush();
		assert.equal((await getRemoteCopy(nodeId))?.state, 'synced');
		assert.equal(new TextDecoder().decode(files.get('a.txt')!.bytes), 'three');
	});

	it('a copy opened live never sends back', async () => {
		const files = new Map([['page.kb', { bytes: text('{}'), updatedAt: 7 }]]);
		const { driver, writes } = remoteDriver(files);
		setRemoteCopiesForTest({ vfs: fs, resolveDriver: async () => ({ driver, release: () => {} }), startOp: async () => { throw new Error('none'); }, isOpen: () => false });
		const nodeId = await copyRemoteForOpen(driver, entryOf('page.kb', files.get('page.kb')!), { track: false });
		assert.equal((await getRemoteCopy(nodeId))?.sendBack, false);
		fs.save(nodeId, '{"edited":true}');
		await sendRemoteCopy(nodeId);
		assert.equal(writes.length, 0);
	});
});

describe('working copy cleanup', () => {
	const sized = (n: number) => new Uint8Array(n);

	it('frees space from the least recently opened copies that are safe to drop', async () => {
		const files = new Map([
			['old.bin', { bytes: sized(400), updatedAt: 1 }],
			['edited.bin', { bytes: sized(400), updatedAt: 1 }],
			['open.bin', { bytes: sized(400), updatedAt: 1 }],
			['new.bin', { bytes: sized(400), updatedAt: 1 }]
		]);
		const { driver } = remoteDriver(files);
		const ids: Record<string, string> = {};
		for (const name of ['old.bin', 'edited.bin', 'open.bin', 'new.bin']) {
			ids[name] = await copyRemoteForOpen(driver, entryOf(name, files.get(name)!));
			await new Promise((r) => setTimeout(r, 2));
		}
		fs.save(ids['edited.bin']!, 'unsent');
		setRemoteCopiesForTest({
			vfs: fs,
			resolveDriver: async () => null,
			startOp: async () => { throw new Error('none'); },
			isOpen: (id) => id === ids['open.bin']
		});
		const removed = await trimRemoteCopies({ budget: 900, keep: ids['new.bin'] });
		assert.deepEqual(removed, [ids['old.bin']]);
		assert.equal(fs.nodes.has(ids['old.bin']!), false);
		assert.equal(await getRemoteCopy(ids['old.bin']!), undefined);
		// Unsent edits, an open window and the one just opened all stay.
		assert.equal((await listRemoteCopies()).length, 3);
	});

	it('forgets a copy whose file was deleted for good', async () => {
		const files = new Map([['a.txt', { bytes: text('one'), updatedAt: 1 }]]);
		const { driver } = remoteDriver(files);
		const nodeId = await copyRemoteForOpen(driver, entryOf('a.txt', files.get('a.txt')!));
		startRemoteCopySync();
		await fs.permanentDelete(nodeId);
		fs.notify();
		await flush();
		assert.equal(await getRemoteCopy(nodeId), undefined);
		assert.equal(fs.meta.has('remote-copy-src:monitor:p1|a.txt'), false);
	});

	it('a live page gets a folder of its own, and reopening replaces its copy', async () => {
		const files = new Map([['Notes.kb', { bytes: text('{}'), updatedAt: 1 }]]);
		const { driver } = remoteDriver(files);
		const first = await copyRemoteForOpen(driver, entryOf('Notes.kb', files.get('Notes.kb')!), { track: false });
		const folder = fs.nodes.get(fs.nodes.get(first)!.parentId!)!;
		assert.equal(folder.name, 'Notes (live)');
		assert.equal(fs.nodes.get(folder.parentId!)!.name, 'Office PC');
		const second = await copyRemoteForOpen(driver, entryOf('Notes.kb', files.get('Notes.kb')!), { track: false });
		assert.equal(fs.nodes.get(second)!.parentId, folder.id);
		assert.equal(fs.nodes.has(first), false, 'the earlier live copy is gone, not in the trash');
		// Neither is a working copy a normal Open would reuse.
		const plan = await planRemoteOpen(driver, entryOf('Notes.kb', files.get('Notes.kb')!));
		assert.equal(plan.action, 'copy');
	});
});

describe('replaced copies', () => {
	it('deletes a replaced copy for good, unless a window still shows it', async () => {
		const files = new Map([['a.txt', { bytes: text('one'), updatedAt: 1 }]]);
		const { driver, touch } = remoteDriver(files);
		const first = await copyRemoteForOpen(driver, entryOf('a.txt', files.get('a.txt')!));
		touch('a.txt');
		const second = await copyRemoteForOpen(driver, entryOf('a.txt', files.get('a.txt')!));
		assert.notEqual(second, first);
		assert.equal(fs.nodes.has(first), false);

		setRemoteCopiesForTest({
			vfs: fs,
			resolveDriver: async () => null,
			startOp: async () => { throw new Error('none'); },
			isOpen: (id) => id === second
		});
		touch('a.txt');
		const third = await copyRemoteForOpen(driver, entryOf('a.txt', files.get('a.txt')!));
		assert.ok(fs.nodes.get(second)?.deletedAt, 'shown in a window: kept, in the trash');
		assert.equal((await getRemoteCopy(third))?.state, 'synced');
	});
});

describe('the Open flow', () => {
	const alt = { id: 'live', label: 'Open live on Office PC', detail: 'live' };

	it('copies and opens without asking when there is no choice to make', async () => {
		const files = new Map([['a.txt', { bytes: text('hi'), updatedAt: 1 }]]);
		const { driver } = remoteDriver(files);
		const opened: string[] = [];
		let asked = 0;
		const outcome = await runRemoteOpen({
			driver,
			entry: entryOf('a.txt', files.get('a.txt')!),
			ask: async () => {
				asked++;
				return 'copy';
			},
			open: (node) => void opened.push(node.name)
		});
		assert.equal(outcome.kind, 'opened');
		assert.equal(asked, 0);
		assert.deepEqual(opened, ['a.txt']);
	});

	it('asks when there is another way to open it, and runs the one chosen', async () => {
		const files = new Map([['Notes.kb', { bytes: text('{}'), updatedAt: 1 }]]);
		const { driver } = remoteDriver(files);
		const ran: string[] = [];
		const outcome = await runRemoteOpen({
			driver,
			entry: entryOf('Notes.kb', files.get('Notes.kb')!),
			alternativesFor: () => [alt],
			ask: async (_plan, alternatives) => {
				assert.deepEqual(alternatives, [alt]);
				return { alternative: 'live' };
			},
			onAlternative: (id) => void ran.push(id),
			open: () => assert.fail('the copy is not opened')
		});
		assert.deepEqual(outcome, { kind: 'alternative', id: 'live' });
		assert.deepEqual(ran, ['live']);
		assert.equal((await listRemoteCopies()).length, 0, 'nothing was copied');
	});

	it('cancel copies nothing, and a blocked file never opens', async () => {
		const files = new Map([['big.bin', { bytes: new Uint8Array(2 * 1024 * 1024), updatedAt: 1 }]]);
		const { driver } = remoteDriver(files);
		const cancelled = await runRemoteOpen({
			driver,
			entry: entryOf('big.bin', files.get('big.bin')!),
			ask: async (plan) => {
				assert.equal(plan.ask, true);
				return 'cancel';
			},
			open: () => assert.fail('not opened')
		});
		assert.deepEqual(cancelled, { kind: 'cancelled' });

		const photo = new Map([['huge.png', { bytes: text('png'), updatedAt: 1 }]]);
		const { driver: d2 } = remoteDriver(photo, { imageInfo: async () => ({ width: 40000, height: 40000, format: 'png' }) });
		const blocked = await runRemoteOpen({
			driver: d2,
			entry: entryOf('huge.png', photo.get('huge.png')!),
			image: true,
			alternativesFor: () => [alt],
			ask: async (plan, alternatives) => {
				assert.ok(plan.blocked);
				assert.deepEqual(alternatives, [], 'no alternatives for a file that cannot open');
				return 'copy';
			},
			open: () => assert.fail('not opened')
		});
		assert.deepEqual(blocked, { kind: 'cancelled' });
	});
});
