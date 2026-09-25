import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import {
	CATALOG_LEADER_CHANGED,
	openWorkerEngine,
	resetCatalogElection
} from '../src/catalogEngine.ts';
import { installLockPolyfill, type LockHarness } from './live-locks-harness.ts';

/**
 * A follower's catalog calls, against a stand-in leader tab.
 *
 * Node is not a browser tab, so the engine here only follows the election —
 * the same path an extract worker takes. The leader is played by two plain
 * BroadcastChannels speaking the election and SQL wire formats.
 */

const ELECTION = 'vfs-catalog-sah:election';
const SQL = 'vfs-catalog-sql';

let locks: LockHarness;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Locks = { request(n: string, o: object, cb: () => Promise<void>): Promise<unknown> };

/**
 * Hold the leader's term lock, as a real leader does before it announces:
 * followers read a free term lock as "that leader is gone".
 */
function holdTerm(id: string, term: number): () => void {
	let release: () => void = () => {};
	const locks = (globalThis as unknown as { navigator: { locks: Locks } }).navigator.locks;
	void locks.request(`vfs-catalog-sah:term:${term}:${id}`, {}, () => new Promise<void>((r) => (release = r)));
	return () => release();
}

type FakeLeader = { id: string; term: number; close(): void; calls: number };

function fakeLeader(id: string, term: number, rows: unknown = [{ ok: 1 }]): FakeLeader {
	const election = new BroadcastChannel(ELECTION);
	const sql = new BroadcastChannel(SQL);
	const releaseTerm = holdTerm(id, term);
	const me: FakeLeader = {
		id,
		term,
		calls: 0,
		close() {
			releaseTerm();
			election.close();
			sql.close();
		}
	};
	const announce = () => election.postMessage({ t: 'leader', id, tabId: id, term });
	election.onmessage = (ev) => {
		if ((ev.data as { t?: string })?.t === 'who') announce();
	};
	sql.onmessage = (ev) => {
		const d = ev.data as { type?: string; to?: string; id?: number; session?: string };
		if (d?.type !== 'sql' || d.to !== id) return;
		me.calls += 1;
		sql.postMessage({ type: 'sql-res', id: d.id, session: d.session, ok: true, rows });
	};
	announce();
	return me;
}

/** A leader that is announced but never answers SQL, so calls stay in flight. */
function silentLeader(id: string, term: number): { close(): void } {
	const ch = new BroadcastChannel(ELECTION);
	const releaseTerm = holdTerm(id, term);
	ch.onmessage = (ev) => {
		if ((ev.data as { t?: string })?.t === 'who') ch.postMessage({ t: 'leader', id, tabId: id, term });
	};
	ch.postMessage({ t: 'leader', id, tabId: id, term });
	return {
		close() {
			releaseTerm();
			ch.close();
		}
	};
}


/** Hold this thread the way a page busy hydrating or parsing a document does. */
function block(ms: number): void {
	const until = Date.now() + ms;
	while (Date.now() < until) {
		/* spin */
	}
}

const open: Array<{ close(): void | Promise<void> }> = [];

beforeEach(() => {
	locks = installLockPolyfill();
	resetCatalogElection();
});

afterEach(async () => {
	for (const o of open.splice(0)) await o.close();
	resetCatalogElection();
	locks.reset();
});

test('a follower routes its calls to the announced leader', async () => {
	const leader = fakeLeader('L1', 1_000);
	open.push(leader);
	const eng = (await openWorkerEngine('follower-live'))!;
	open.push(eng);
	assert.deepEqual(await eng.exec('SELECT 1 AS ok'), [{ ok: 1 }]);
	assert.equal(leader.calls, 1);
});

test('a follower that was itself busy still gets its answer — nothing timed out', async () => {
	const leader = fakeLeader('L1', 1_000);
	open.push(leader);
	const eng = (await openWorkerEngine('follower-busy'))!;
	open.push(eng);
	const pending = eng.exec('SELECT 1 AS ok');
	block(3_000);
	assert.deepEqual(await pending, [{ ok: 1 }]);
});

test('with no leader yet, a call waits for one instead of failing', async () => {
	const eng = (await openWorkerEngine('follower-wait'))!;
	open.push(eng);
	let settled = false;
	const pending = eng.exec('SELECT 1 AS ok').finally(() => (settled = true));
	await wait(300);
	assert.equal(settled, false, 'failed or answered with nobody leading');
	const leader = fakeLeader('L1', 1_000);
	open.push(leader);
	assert.deepEqual(await pending, [{ ok: 1 }]);
});

test('a call in flight to a leader that is replaced fails as a leader change', async () => {
	open.push(silentLeader('old', 1_000));
	const eng = (await openWorkerEngine('follower-changed'))!;
	open.push(eng);
	await wait(50);
	const inFlight = eng.exec('SELECT 1 AS ok');
	await wait(50);
	const next = fakeLeader('new', 2_000);
	open.push(next);
	await assert.rejects(inFlight, new RegExp(CATALOG_LEADER_CHANGED));
	assert.deepEqual(await eng.exec('SELECT 1 AS ok'), [{ ok: 1 }]);
	assert.equal(next.calls, 1);
});

test('a leader that says it is gone fails its calls, and the next leader serves', async () => {
	open.push(silentLeader('old', 1_000));
	const eng = (await openWorkerEngine('follower-gone'))!;
	open.push(eng);
	await wait(50);
	const inFlight = eng.exec('SELECT 1 AS ok');
	await wait(50);
	const ch = new BroadcastChannel(ELECTION);
	ch.postMessage({ t: 'gone', id: 'old', tabId: 'old', term: 1_000 });
	ch.close();
	await assert.rejects(inFlight, new RegExp(CATALOG_LEADER_CHANGED));
	const waiting = eng.exec('SELECT 1 AS ok');
	const next = fakeLeader('new', 2_000);
	open.push(next);
	assert.deepEqual(await waiting, [{ ok: 1 }]);
});

test('an older leader announcing late does not win the follower back', async () => {
	const current = fakeLeader('new', 2_000);
	open.push(current);
	const eng = (await openWorkerEngine('follower-fenced'))!;
	open.push(eng);
	await eng.exec('SELECT 1');
	const stale = new BroadcastChannel(ELECTION);
	open.push(stale);
	stale.postMessage({ t: 'leader', id: 'old', tabId: 'old', term: 1_000 });
	await wait(50);
	await eng.exec('SELECT 1');
	assert.equal(current.calls, 2);
});
